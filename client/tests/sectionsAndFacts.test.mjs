// Regression tests for the four reported issues (MOCKED AI edits on real TipTap documents - no Gemini here).
// Dummy data only.
//   1. a new medicine goes right after the LAST medicine entry (the next item of a numbered list), never after Review
//   2. dosing patterns: "001" / "0-0-1" / "0 0 1" / "zero zero one" = (0-0-1); invented strengths still blocked
//   3. Patient Details are the source of age / gender: dictated text follows them; other sections and the header are
//      not changed because of it; a warning instead
//   4. headings stay locked; the content under them stays editable (separate paragraphs, same paragraph, first line)
// Run:  cd client  &&  node --test tests/
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { EditorState } from '@tiptap/pm/state';
import { history, undo } from '@tiptap/pm/history';
import { checkNamedSection, checkTableEdits, patternsSaid } from '../src/lib/verify.js';
import { asOneUndoStep } from '../src/lib/undoStep.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-sectionsfacts');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'previewEdits', 'medicineText', 'sections']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit, ensurePatientConsistency } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { previewEdits, medicinesLostByEdits } = await import(pathToFileURL(path.join(tmp, 'previewEdits.js')).href);
const { getBlocks } = await import(pathToFileURL(path.join(tmp, 'outline.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell]);
const t = (s, m) => schema.text(s, m);
const p = (...k) => schema.node('paragraph', null, k);
const B = () => [schema.marks.bold.create()];
const h = (s) => p(t(s, B()));
const br = () => schema.nodes.hardBreak.create();
const ol = (items) => schema.node('orderedList', { start: 1 }, items.map((s) => schema.node('listItem', null, [p(t(s))])));
const cell = (s) => schema.node('tableCell', null, [p(...(s ? [t(s)] : []))]);
const row = (...xs) => schema.node('tableRow', null, xs.map(cell));
const header = () => schema.node('table', null, [row('Name', 'DUMMY PATIENT', 'Age', '49 Years'), row('Sex', 'Male', 'IP No', 'IP000999')]);
function makeEditor(kids) {
  const doc = schema.node('doc', null, kids);
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), schema, isDestroyed: false, dryRun: true };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
}
const id = (ed, s) => `B${getBlocks(ed.state.doc).find((x) => x.node.textContent.startsWith(s)).index}`;
// the document as lines: "P text" / "OL<n> text" / "TR a | b"; line breaks ↵
function lines(doc) {
  const txt = (n) => { let s = ''; n.forEach((c) => { s += c.type.name === 'hardBreak' ? '↵' : c.text; }); return s; };
  const out = [];
  doc.forEach((n) => {
    if (n.type.name === 'orderedList') { let k = n.attrs.start || 1; n.forEach((li) => out.push(`OL${k++} ${txt(li.firstChild)}`)); }
    else if (n.type.name === 'table') n.forEach((r) => { const cs = []; r.forEach((c) => cs.push(txt(c.firstChild))); out.push(`TR ${cs.join(' | ')}`); });
    else out.push(`P ${txt(n)}`);
  });
  return out;
}

// ======================= ISSUE 1 =======================
const MEDS = ['TAB.CIPLOX 200MG 1-0-1 FOR 2 DAYS', 'TAB.METRONIDAZOLE 500MG 1-1-1 FOR 2 DAYS', 'SYP.INSTARAFT 10ML 1-1-1 (10 MINS AFTER FOOD) FOR 5 DAYS',
  'TAB.ZINCOVIT 1-0-0 FOR 14 DAYS', 'TAB.BACTOGUT 1-0-0 FOR 7 DAYS', 'TAB.DOLO 650MG SOS', 'AZIPROPROTEIN POWDER (2 SCOOPS) IN 1 GLASS OF WATER 1-0-1 FOR 1 WEEK'];
const REVIEW = 'REVIEW AFTER 1 WEEK (06/11/26) IN GENERAL MEDICINE OPD WITH CBC ,LFT ,SODIUM ,POTASSIUM.';
const dischargeAdvice = () => [h('COURSE IN HOSPITAL'), p(t('HEMODYNAMICALLY STABLE')), h('DISCHARGE ADVICE :'), ol(MEDS), p(t(REVIEW)), h('WHEN TO OBTAIN MEDICAL EMERGENCY :'), p(t('FEVER ,'))];
const RING = 'Ointment for Ringworm — Apply before sleeping';
const numbered = (doc) => lines(doc).filter((l) => l.startsWith('OL'));

test('ISSUE 1: the AI aims at the Review line / the heading / appends to Review -> item 8 right after AZIPROPROTEIN', () => {
  for (const make of [
    (ed) => ({ block_id: id(ed, 'REVIEW'), operation: 'insert_after', new_value: RING, field_label: 'Advice' }), // what Gemini sent
    (ed) => ({ block_id: id(ed, 'DISCHARGE ADVICE'), operation: 'insert_after', new_value: RING, field_label: 'Advice' }),
    (ed) => ({ block_id: id(ed, 'REVIEW'), operation: 'append', new_value: `\n${RING}`, field_label: 'Advice' }),
    (ed) => ({ block_id: id(ed, 'REVIEW'), operation: 'append', new_value: `, ${RING}`, field_label: 'Advice' }),
  ]) {
    const ed = makeEditor(dischargeAdvice());
    const before = lines(ed.state.doc);
    const r = applyVoiceEdit(ed, make(ed));
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(numbered(ed.state.doc), [...MEDS, RING].map((l, i) => `OL${i + 1} ${l}`));
    // Review, the other sections and every existing item unchanged
    assert.deepEqual(lines(ed.state.doc).filter((l) => !l.startsWith('OL')), before.filter((l) => !l.startsWith('OL')));
  }
});

test('ISSUE 1: a second medicine after the list was formatted -> item 9; "after TAB.ZINCOVIT" -> right after it; one Undo', () => {
  const ed = makeEditor(dischargeAdvice());
  const before = ed.state.doc;
  asOneUndoStep(ed.view, () => {
    assert.equal(applyVoiceEdit(ed, { block_id: id(ed, 'REVIEW'), operation: 'insert_after', new_value: RING, field_label: 'Advice' }).ok, true);
  });
  assert.equal(applyVoiceEdit(ed, { block_id: id(ed, 'REVIEW'), operation: 'insert_after', new_value: 'TAB.PANTOP 40MG ONCE DAILY', field_label: 'Advice' }).ok, true);
  assert.deepEqual(numbered(ed.state.doc).slice(-2), [`OL8 ${RING}`, 'OL9 TAB.PANTOP 40MG ONCE DAILY']);
  // a named position that IS a medicine entry is kept
  const e2 = makeEditor(dischargeAdvice());
  assert.equal(applyVoiceEdit(e2, { block_id: id(e2, 'TAB.ZINCOVIT'), operation: 'insert_after', new_value: 'TAB.PANTOP 40MG ONCE DAILY', field_label: 'Advice' }).ok, true);
  assert.deepEqual(numbered(e2.state.doc).map((l) => l.replace(/^OL\d+ /, '')), [...MEDS.slice(0, 4), 'TAB.PANTOP 40MG ONCE DAILY', ...MEDS.slice(4)]);
  // undo the second, then the first: the original document
  undo(ed.state, (tr) => { ed.state = ed.state.apply(tr); });
  undo(ed.state, (tr) => { ed.state = ed.state.apply(tr); });
  assert.ok(ed.state.doc.eq(before));
});

test('ISSUE 1: paragraph layouts - after the last medicine, before the Review line (one paragraph each, and line breaks)', () => {
  let ed = makeEditor([h('ADVICE'), p(t('Tab. CIPLOX 200 mg — 2 days')), p(t('Syp. BENADRYL — Daily')), p(t('Review after 1 week.')), h('FOLLOW UP'), p(t('OPD'))]);
  assert.equal(applyVoiceEdit(ed, { block_id: id(ed, 'Review after'), operation: 'insert_after', new_value: 'Tab. DOLO — Daily Night (0-0-1)', field_label: 'Advice' }).ok, true);
  assert.deepEqual(lines(ed.state.doc).slice(1, 5), ['P Tab. CIPLOX 200 mg — 2 days', 'P Syp. BENADRYL — Daily', 'P Tab. DOLO — Daily Night (0-0-1)', 'P Review after 1 week.']);
  ed = makeEditor([h('ADVICE'), p(t('Tab. CIPLOX 200 mg — 2 days'), br(), t('Syp. BENADRYL — Daily'), br(), t('Review after 1 week.')), h('FOLLOW UP'), p(t('OPD'))]);
  assert.equal(applyVoiceEdit(ed, { block_id: id(ed, 'Tab. CIPLOX'), operation: 'insert_after', new_value: 'Tab. DOLO — Daily Night (0-0-1)', field_label: 'Advice' }).ok, true);
  assert.deepEqual(lines(ed.state.doc)[1], 'P Tab. CIPLOX 200 mg — 2 days↵Syp. BENADRYL — Daily↵Tab. DOLO — Daily Night (0-0-1)↵Review after 1 week.');
  // a department template (MEDICATIONS) with a numbered list and a note under it
  ed = makeEditor([h('NURSING NOTES'), p(t('Stable')), h('MEDICATIONS'), ol(['Inj. PANTOP 40 mg IV OD', 'Tab. DOLO 650 mg SOS']), p(t('Continue as advised.')), h('REMARKS'), p(t('None'))]);
  assert.equal(applyVoiceEdit(ed, { block_id: id(ed, 'Continue'), operation: 'insert_after', new_value: 'Tab. ZINCOVIT Once Daily', field_label: 'Medications' }).ok, true);
  assert.deepEqual(numbered(ed.state.doc), ['OL1 Inj. PANTOP 40 mg IV OD', 'OL2 Tab. DOLO 650 mg SOS', 'OL3 Tab. ZINCOVIT Once Daily']);
});

test('ISSUE 1: "TAB.CIPLOX" (no space after the dot) is a medicine line for the new-line and number checks', () => {
  const ed = makeEditor(dischargeAdvice());
  const doc = ed.state.doc;
  const c = checkTableEdits(doc, 'add tab pantop once daily', [{ block_id: id(ed, 'TAB.DOLO'), operation: 'insert_after', new_value: 'TAB.PANTOP 40MG ONCE DAILY', field_label: 'Advice' }]);
  assert.match(c.blocked[0], /contains 40, which was not in your command/);
  assert.equal(medicinesLostByEdits(doc, [{ block_id: id(ed, 'TAB.DOLO'), operation: 'insert_after', new_value: 'TAB.PANTOP ONCE DAILY', field_label: 'Advice' }]), 0);
});

// ======================= ISSUE 2 =======================
test('ISSUE 2: "001", "0-0-1", "0 0 1", "zero zero one" are the pattern (0-0-1); "500" is never a pattern', () => {
  for (const c of ['daily night 001', 'daily night 001.', 'daily night 0-0-1', 'daily night 0 0 1', 'daily night zero zero one']) assert.deepEqual([...patternsSaid(c)], ['001'], c);
  assert.deepEqual([...patternsSaid('dolo 500 mg')], []);
  assert.deepEqual([...patternsSaid('1-0-0-1 for 5 days')], ['1001']);
});

for (const layout of ['list', 'paragraphs']) {
  test(`ISSUE 2 (${layout}): the reported command adds DOLO (0-0-1); an invented strength is still blocked; an unsaid pattern is blocked`, () => {
    const kids = layout === 'list'
      ? [h('ADVICE'), ol(['Tab. CIPLOX 200 mg — (1-0-1) — 2 days', 'Ointment for Ringworm — Apply before going to sleep']), p(t('Signed By: Dr. DUMMY', B()))]
      : [h('ADVICE'), p(t('Tab. CIPLOX 200 mg — (1-0-1) — 2 days')), p(t('Ointment for Ringworm — Apply before going to sleep')), p(t('Signed By: Dr. DUMMY', B()))];
    const ed = makeEditor(kids);
    const doc = ed.state.doc;
    const cmd = 'Now inside the advice add a tablet Dolo paracetamol daily night 001.';
    const add = (value) => [{ block_id: id(ed, 'Ointment'), operation: 'insert_after', new_value: value, field_label: 'Advice' }];
    assert.equal(checkTableEdits(doc, cmd, add('Tab. DOLO (Paracetamol) — Daily Night (0-0-1)')).edits.length, 1);
    for (const said of ['add dolo daily night 0-0-1', 'add dolo daily night 0 0 1', 'add dolo daily night zero zero one']) {
      assert.equal(checkTableEdits(doc, said, add('Tab. DOLO — Daily Night (0-0-1)')).edits.length, 1, said);
    }
    let c = checkTableEdits(doc, cmd, add('Tab. DOLO (Paracetamol) 500 mg — Daily Night (0-0-1)'));
    assert.match(c.blocked[0], /contains 500, which was not in your command/); // the invented strength only
    c = checkTableEdits(doc, cmd, add('Tab. DOLO 650 mg — Daily Night (0-0-1) — 5 days'));
    assert.match(c.blocked[0], /contains 650, 5,/);
    // a pattern that was not said is refused as a pattern, even when its digits appear elsewhere ("1 tablet")
    c = checkTableEdits(doc, 'add dolo 1 tablet at night', add('Tab. DOLO — (1-0-1)'));
    assert.match(c.blocked[0], /contains 1-0-1, which was not in your command/);
    // strength and pattern both said -> allowed
    assert.equal(checkTableEdits(doc, 'add dolo 650 mg 1-0-1', add('Tab. DOLO 650 mg — (1-0-1)')).edits.length, 1);
  });
}

// ======================= ISSUE 3 + Patient Details =======================
const caseDoc = () => [h('DISCHARGE SUMMARY'), header(), h('PRESENTING COMPLAINT'), p(t('49-year-old male presented with loose stools, vomiting and giddiness.')),
  h('SIGMOIDOSCOPY'), p(t('Normal study.')), h('COURSE IN HOSPITAL'), p(t('Empirical antibiotics were initiated.')), h('ADVICE'), p(t('Review in OPD after 1 week.'))];
const CMD3 = 'Clear the course in the hospital section and add only this much: a 22-year-old male presented with loose stools, vomiting, giddiness and fever.';
const DICTATED = 'A 22-year-old male presented with loose stools, vomiting, giddiness and fever.';

test('ISSUE 3: the AI also "fixes" Presenting Complaint and the header Age -> those are skipped (not applied), the command is NOT rejected', () => {
  const ed = makeEditor(caseDoc());
  const doc = ed.state.doc;
  const edits = [
    { block_id: id(ed, 'Empirical'), operation: 'set', new_value: DICTATED, field_label: 'Course in Hospital' },
    { block_id: id(ed, '49-year-old'), operation: 'replace_text', find_text: '49-year-old', new_value: '22-year-old', field_label: 'Presenting Complaint' },
    { block_id: id(ed, '49 Years'), operation: 'set', new_value: '22 Years', field_label: 'Age' },
  ];
  const c = checkNamedSection(doc, CMD3, edits);
  assert.ok(!c.reject, c.reject);
  assert.deepEqual(c.edits, [edits[0]]);
  assert.deepEqual(c.skipped, ['Presenting Complaint', 'Age']);
  // any OTHER change in another section is still refused, as before
  assert.ok(checkNamedSection(doc, CMD3, [edits[0], { block_id: id(ed, 'Normal study'), operation: 'set', new_value: 'Polyp seen.', field_label: 'x' }]).reject);
  // an explicit age change together with another section keeps working ("change the age to 45 and add vomiting to PC")
  const m01 = checkNamedSection(doc, 'change the age to 45 and add vomiting to the presenting complaint', [
    { block_id: id(ed, '49 Years'), operation: 'set', new_value: '45 Years', field_label: 'Age' },
    { block_id: id(ed, '49-year-old'), operation: 'append', new_value: ' Vomiting.', field_label: 'PC' }]);
  assert.equal(m01.edits.length, 2);
  assert.deepEqual(m01.skipped, []);
});

for (const [section, anchor] of [['COURSE IN HOSPITAL', 'Empirical'], ['PRESENTING COMPLAINT', '49-year-old'], ['ADVICE', 'Review in OPD']]) {
  test(`PATIENT DETAILS (${section}): the dictated 22-year-old / female is written as 49-year-old male; header and other sections untouched`, () => {
    const ed = makeEditor(caseDoc());
    const before = lines(ed.state.doc);
    const edit = { block_id: id(ed, anchor), operation: 'set', new_value: 'A 22-year-old female presented with fever. She was admitted previously.', field_label: section };
    // the preview (= what Apply does): only the new text follows Patient Details
    const pv = previewEdits(ed.state.doc, [edit], { allowGender: true, fromFile: false });
    assert.deepEqual(pv.consistency.map((x) => x.after), ['A 49-year-old male presented with fever. He was admitted previously.']);
    // Apply (App.jsx: the edit, then the age / gender step limited to the text the command wrote)
    const oldTexts = new Set(getBlocks(ed.state.doc).map((b) => b.node.textContent));
    assert.equal(applyVoiceEdit(ed, edit, { allowGender: true }).ok, true);
    ensurePatientConsistency(ed, null, (node) => !oldTexts.has(node.textContent));
    const now = lines(ed.state.doc);
    assert.ok(now.includes('P A 49-year-old male presented with fever. He was admitted previously.'), now.join('\n'));
    // everything else exactly as before (header Age / Sex, the other sections)
    const original = before.find((x) => x.startsWith(`P ${anchor}`));
    assert.deepEqual(now.filter((l) => !l.includes('presented with fever')), before.filter((l) => l !== original));
  });
}

test('PATIENT DETAILS: other dictated clinical facts unchanged; the header is never changed; missing details are never invented', () => {
  const ed = makeEditor(caseDoc());
  const oldTexts = new Set(getBlocks(ed.state.doc).map((b) => b.node.textContent));
  applyVoiceEdit(ed, { block_id: id(ed, 'Empirical'), operation: 'set', new_value: 'A 22-year-old male, BP 120/80, creatinine 1.4, given 2 units of blood.', field_label: 'C' });
  ensurePatientConsistency(ed, null, (node) => !oldTexts.has(node.textContent));
  assert.ok(lines(ed.state.doc).includes('P A 49-year-old male, BP 120/80, creatinine 1.4, given 2 units of blood.'));
  assert.ok(lines(ed.state.doc).includes('TR Name | DUMMY PATIENT | Age | 49 Years'));
  assert.ok(lines(ed.state.doc).includes('TR Sex | Male | IP No | IP000999'));
  // no Patient Details in the document: the dictated age / sex stay as said (nothing invented, nothing removed)
  const e2 = makeEditor([h('COURSE IN HOSPITAL'), p(t('Old text.')), h('ADVICE'), p(t('x'))]);
  const old2 = new Set(getBlocks(e2.state.doc).map((b) => b.node.textContent));
  applyVoiceEdit(e2, { block_id: 'B1', operation: 'set', new_value: 'A 22-year-old female was admitted.', field_label: 'C' });
  assert.deepEqual(ensurePatientConsistency(e2, null, (node) => !old2.has(node.textContent)), []);
  assert.ok(lines(e2.state.doc).includes('P A 22-year-old female was admitted.'));
});

test('PATIENT DETAILS: an explicit change of the header age still updates every place (existing workflow); a department template header too', () => {
  const ed = makeEditor(caseDoc());
  const edit = { block_id: id(ed, '49 Years'), operation: 'set', new_value: '45 Years', field_label: 'Age' };
  const pv = previewEdits(ed.state.doc, [edit], { allowGender: false, fromFile: false });
  assert.deepEqual(pv.items[0].also.map((x) => x.after), ['45-year-old male presented with loose stools, vomiting and giddiness.']);
  // a template with "Age : 30 Years" / "Gender : Female" lines
  const tpl = makeEditor([p(t('Age : 30 Years')), p(t('Gender : Female')), h('NURSING NOTES'), p(t('Stable.')), h('REMARKS'), p(t('None'))]);
  const old = new Set(getBlocks(tpl.state.doc).map((b) => b.node.textContent));
  applyVoiceEdit(tpl, { block_id: id(tpl, 'Stable'), operation: 'set', new_value: 'A 60-year-old male patient, stable. He walked.', field_label: 'Notes' });
  ensurePatientConsistency(tpl, null, (node) => !old.has(node.textContent));
  assert.ok(lines(tpl.state.doc).includes('P A 30-year-old female patient, stable. She walked.'));
  assert.ok(lines(tpl.state.doc).includes('P Age : 30 Years') && lines(tpl.state.doc).includes('P Gender : Female'));
});

test('PATIENT DETAILS: an uploaded file preview follows the same rule (only the new text, header unticked stays)', () => {
  const ed = makeEditor(caseDoc());
  const pv = previewEdits(ed.state.doc, [{ block_id: id(ed, 'Empirical'), operation: 'append', new_value: ' A 22-year-old female was seen.', field_label: 'C' }], { allowGender: true, fromFile: true });
  assert.deepEqual(pv.consistency.map((x) => x.after), ['Empirical antibiotics were initiated. A 49-year-old male was seen.']);
});

// ======================= ISSUE 4: headings locked, content editable =======================
const course = () => [h('COURSE IN HOSPITAL'), p(t('Empirical antibiotics.')), h('ADVICE'), p(t('Review'))];
test('ISSUE 4: set / clear aimed at the HEADING change the content under it; the heading stays exactly', () => {
  let ed = makeEditor(course());
  let r = applyVoiceEdit(ed, { block_id: 'B0', operation: 'set', new_value: 'Patient improved with IV fluids.', field_label: 'Course' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(lines(ed.state.doc), ['P COURSE IN HOSPITAL', 'P Patient improved with IV fluids.', 'P ADVICE', 'P Review']);
  // the AI repeated the heading in front of the text: not written twice
  ed = makeEditor(course());
  applyVoiceEdit(ed, { block_id: 'B0', operation: 'set', new_value: 'COURSE IN HOSPITAL: Patient improved.', field_label: 'Course' });
  assert.deepEqual(lines(ed.state.doc).slice(0, 2), ['P COURSE IN HOSPITAL', 'P Patient improved.']);
  ed = makeEditor(course());
  r = applyVoiceEdit(ed, { block_id: 'B0', operation: 'clear', field_label: 'Course' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(lines(ed.state.doc), ['P COURSE IN HOSPITAL', 'P ', 'P ADVICE', 'P Review']);
  // several paragraphs under the heading: replaced in ONE step, the next section untouched; one Undo
  ed = makeEditor([h('COURSE IN HOSPITAL'), p(t('Day 1: fever.')), p(t('Day 2: better.')), p(t('Day 3: stable.')), h('ADVICE'), p(t('Review'))]);
  const before = ed.state.doc;
  asOneUndoStep(ed.view, () => assert.equal(applyVoiceEdit(ed, { block_id: 'B0', operation: 'set', new_value: 'Patient improved.', field_label: 'Course' }).ok, true));
  assert.deepEqual(lines(ed.state.doc), ['P COURSE IN HOSPITAL', 'P Patient improved.', 'P ADVICE', 'P Review']);
  undo(ed.state, (tr) => { ed.state = ed.state.apply(tr); });
  assert.ok(ed.state.doc.eq(before));
});

test('ISSUE 4: heading and content in the SAME paragraph ("Label : text", "HEADING↵text") - the label stays, its bold too', () => {
  let ed = makeEditor([p(t('Course in Hospital : ', B()), t('Empirical antibiotics.')), p(t('Advice : Review'))]);
  assert.equal(applyVoiceEdit(ed, { block_id: 'B0', operation: 'set', new_value: 'Patient improved.', field_label: 'Course' }).ok, true);
  assert.equal(lines(ed.state.doc)[0], 'P Course in Hospital : Patient improved.');
  let first = ed.state.doc.child(0).firstChild;
  assert.ok(first.marks.some((m) => m.type.name === 'bold') && first.text === 'Course in Hospital : ', 'label kept with its bold');
  assert.ok(!ed.state.doc.child(0).child(1).marks.length, 'new text not bold');
  ed = makeEditor([p(t('Course in Hospital : ', B()), t('Empirical antibiotics.')), p(t('Advice : Review'))]);
  assert.equal(applyVoiceEdit(ed, { block_id: 'B0', operation: 'clear', field_label: 'Course' }).ok, true);
  assert.equal(lines(ed.state.doc)[0], 'P Course in Hospital : ');
  ed = makeEditor([p(t('COURSE IN HOSPITAL', B()), br(), t('Empirical antibiotics.')), p(t('x'))]);
  assert.equal(applyVoiceEdit(ed, { block_id: 'B0', operation: 'set', new_value: 'Patient improved.\nDischarged stable.', field_label: 'Course' }).ok, true);
  assert.equal(lines(ed.state.doc)[0], 'P COURSE IN HOSPITAL↵Patient improved.↵Discharged stable.');
  first = ed.state.doc.child(0).firstChild;
  assert.ok(first.marks.some((m) => m.type.name === 'bold'));
  ed = makeEditor([p(t('COURSE IN HOSPITAL', B()), br(), t('Empirical antibiotics.')), p(t('x'))]);
  assert.equal(applyVoiceEdit(ed, { block_id: 'B0', operation: 'clear', field_label: 'Course' }).ok, true);
  assert.equal(lines(ed.state.doc)[0], 'P COURSE IN HOSPITAL');
  // content edits inside the section keep working as before
  ed = makeEditor(course());
  assert.equal(applyVoiceEdit(ed, { block_id: 'B1', operation: 'replace_text', find_text: 'Empirical', new_value: 'Broad-spectrum', field_label: 'C' }).ok, true);
  assert.equal(lines(ed.state.doc)[1], 'P Broad-spectrum antibiotics.');
});

test('ISSUE 4: what stays protected - heading words, table labels, medicines (confirmation), uploads, unasked gender', () => {
  // the heading itself is never renamed or removed
  let ed = makeEditor(course());
  applyVoiceEdit(ed, { block_id: 'B0', operation: 'set', new_value: 'Patient improved.', field_label: 'Course' });
  assert.equal(lines(ed.state.doc)[0], 'P COURSE IN HOSPITAL');
  // a table label stays locked (the value cell next to it changes, as before)
  ed = makeEditor([header()]);
  const r = applyVoiceEdit(ed, { block_id: 'B2', operation: 'set', new_value: '50 Years', field_label: 'Age' });
  assert.equal(r.ok, true);
  assert.ok(lines(ed.state.doc).includes('TR Name | DUMMY PATIENT | Age | 50 Years'));
  // Advice with medicines: clearing / rewriting it through the heading is still refused (confirmation window only)
  for (const kids of [
    [h('ADVICE'), p(t('Tab. DOLO 650 mg')), p(t('Syp. BENADRYL 5 ml')), h('FOLLOW UP'), p(t('x'))],
    [p(t('ADVICE', B()), br(), t('Tab. DOLO 650 mg'), br(), t('Syp. BENADRYL 5 ml')), p(t('x'))],
    [p(t('Advice : ', B()), t('Tab. DOLO 650 mg')), p(t('x'))],
  ]) {
    ed = makeEditor(kids);
    const doc = ed.state.doc;
    for (const operation of ['clear', 'set']) {
      const out = applyVoiceEdit(ed, { block_id: 'B0', operation, new_value: 'Rest.', field_label: 'Advice' });
      assert.equal(out.ok, false, operation);
      assert.ok(ed.state.doc.eq(doc));
    }
  }
  // an uploaded file still cannot delete content through a heading
  ed = makeEditor(course());
  assert.equal(applyVoiceEdit(ed, { block_id: 'B0', operation: 'clear', field_label: 'Course' }, { fromFile: true }).ok, false);
  // an unasked gender change through a heading is refused
  ed = makeEditor([h('COURSE IN HOSPITAL'), p(t('He improved.')), h('ADVICE'), p(t('x'))]);
  assert.equal(applyVoiceEdit(ed, { block_id: 'B0', operation: 'set', new_value: 'She improved.', field_label: 'C' }, { allowGender: false }).ok, false);
});
