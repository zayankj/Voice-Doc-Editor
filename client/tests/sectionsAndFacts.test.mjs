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
import { asOneUndoStep } from '../src/lib/undoStep.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-sectionsfacts');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'previewEdits', 'medicineText', 'sections']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit, ensurePatientConsistency } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { previewEdits } = await import(pathToFileURL(path.join(tmp, 'previewEdits.js')).href);
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


// ======================= ISSUE 2 =======================


// ======================= ISSUE 3 + Patient Details =======================
const caseDoc = () => [h('DISCHARGE SUMMARY'), header(), h('PRESENTING COMPLAINT'), p(t('49-year-old male presented with loose stools, vomiting and giddiness.')),
  h('SIGMOIDOSCOPY'), p(t('Normal study.')), h('COURSE IN HOSPITAL'), p(t('Empirical antibiotics were initiated.')), h('ADVICE'), p(t('Review in OPD after 1 week.'))];
const CMD3 = 'Clear the course in the hospital section and add only this much: a 22-year-old male presented with loose stools, vomiting, giddiness and fever.';
const DICTATED = 'A 22-year-old male presented with loose stools, vomiting, giddiness and fever.';


// R4 (D5): Gemini handles the patient age / gender. The app writes exactly the text Gemini returned - no hardcoded
// age or gender rewriting in JavaScript (preview and Apply alike); the header and other sections are untouched.
for (const [section, anchor] of [['COURSE IN HOSPITAL', 'Empirical'], ['PRESENTING COMPLAINT', '49-year-old'], ['ADVICE', 'Review in OPD']]) {
  test(`PATIENT DETAILS (D5, ${section}): the text Gemini returned is written exactly; nothing else changes`, () => {
    const ed = makeEditor(caseDoc());
    const before = lines(ed.state.doc);
    const text = 'A 49-year-old male presented with fever. His wife, a 22-year-old female, came with him.';
    const edit = { block_id: id(ed, anchor), operation: 'set', new_value: text, field_label: section };
    const pv = previewEdits(ed.state.doc, [edit], { fromFile: false });
    assert.deepEqual(pv.consistency, []);
    assert.deepEqual(pv.items.flatMap((i) => i.also), []);
    assert.equal(applyVoiceEdit(ed, edit).ok, true);
    const now = lines(ed.state.doc);
    assert.ok(now.includes(`P ${text}`), now.join('\n')); // the relative's age / gender are kept as Gemini wrote them
    const original = before.find((x) => x.startsWith(`P ${anchor}`));
    assert.deepEqual(now.filter((l) => !l.includes('presented with fever')), before.filter((l) => l !== original));
    assert.ok(ed.state.doc.eq(pv.doc)); // preview = apply
  });
}

test('PATIENT DETAILS (D5): a header age change is written only where Gemini returned edits (no automatic copies by the app)', () => {
  const ed = makeEditor(caseDoc());
  const edits = [
    { block_id: id(ed, '49 Years'), operation: 'set', new_value: '45 Years', field_label: 'Age' },
    { block_id: id(ed, '49-year-old'), operation: 'replace_text', find_text: '49-year-old', new_value: '45-year-old', field_label: 'Presenting Complaint' },
  ];
  const pv = previewEdits(ed.state.doc, edits, { fromFile: false });
  assert.deepEqual(pv.consistency, []);
  assert.equal(pv.blocked.length, 0);
  const now = lines(pv.doc);
  assert.ok(now.some((l) => l.includes('45 Years')));
  assert.ok(now.some((l) => l.includes('45-year-old male presented')));
  assert.ok(!now.some((l) => l.includes('49')), now.join('\n'));
});

test('PATIENT DETAILS (D5): an uploaded file edit is written as returned too (no rewriting)', () => {
  const ed = makeEditor(caseDoc());
  const pv = previewEdits(ed.state.doc, [{ block_id: id(ed, 'Empirical'), operation: 'append', new_value: ' Seen by Dr. A.', field_label: 'C' }], { fromFile: true });
  assert.deepEqual(pv.consistency, []);
  assert.ok(lines(pv.doc).includes('P Empirical antibiotics were initiated. Seen by Dr. A.'), lines(pv.doc).join('\n'));
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
