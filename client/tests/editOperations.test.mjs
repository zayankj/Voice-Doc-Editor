// General editing operations (MOCKED AI edits on real TipTap documents - no Gemini call here). Dummy data only.
// Covers: format, change_case, to_list, unlist, new lines / new medicines in both Advice layouts (one paragraph per
// line, and one paragraph with line breaks), removing one line, moving between sections, the existing
// capitalization behaviour, medicine safety, uploads and Undo.
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
import { checkNamedSection, checkTableEdits } from '../src/lib/verify.js';
import { classifyCommand } from '../src/lib/commandIntent.js';
import { asOneUndoStep } from '../src/lib/undoStep.js';

// voiceEdit.js imports its neighbours without ".js": a temporary copy with the endings added
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-editops');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'previewEdits', 'medicineText', 'sections']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { medicinesLostByEdits, previewEdits } = await import(pathToFileURL(path.join(tmp, 'previewEdits.js')).href);
const { getBlocks, buildOutline } = await import(pathToFileURL(path.join(tmp, 'outline.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell]);
const t = (s, m) => schema.text(s, m);
const p = (...k) => schema.node('paragraph', null, k);
const bold = () => [schema.marks.bold.create()];
const h = (s) => p(t(s, bold()));
const br = () => schema.nodes.hardBreak.create();
const ul = (...items) => schema.node('bulletList', null, items.map((s) => schema.node('listItem', null, [p(t(s))])));
const cell = (s) => schema.node('tableCell', null, [p(...(s ? [t(s)] : []))]);
const row = (...xs) => schema.node('tableRow', null, xs.map(cell));

const CIPLOX = 'Tab. CIPLOX (Ciprofloxacin) 500 mg — Oral — Twice Daily (1-0-1) — 5 days';
const SYP = 'Syp. INSTARAFT (Antacid) 10 ml — Oral — Three Times Daily — 5 days';
const DOLO = 'Tab. DOLO (Paracetamol) 650 mg — Oral — As Needed (SOS)';
const PAN = 'Tab. PAN (Pantoprazole) 40 mg — Oral — Once Daily before food — 5 days';
const RING = 'Ointment for Ringworm — Apply before going to sleep';
const WATER = 'Drink plenty of water.';
const ADVICE = [CIPLOX, SYP, DOLO, PAN, RING, WATER];
const HEAD = () => [
  h('DISCHARGE SUMMARY'),
  schema.node('table', null, [row('Name', 'DUMMY PATIENT', 'Age', '40 Years'), row('Gender', 'Male', 'IP No', 'IP000123')]),
  h('DIAGNOSIS'), p(t('ENTERIC FEVER')),
  h('PRESENTING COMPLAINTS'), p(t('Fever for 5 days. Headache and body pain.')),
  h('COURSE IN HOSPITAL'), p(t('Patient was admitted with '), t('high grade', bold()), t(' fever. Started on IV antibiotics.')),
];
const TAIL = () => [h('DIET INSTRUCTIONS'), ul('Soft diet for one week', 'Avoid spicy food'), h('FOLLOW UP'), p(t('Review in OPD after 1 week.'))];
// A: one paragraph per Advice line.  B: ONE paragraph with line breaks
const LAYOUT = {
  A: () => [...HEAD(), h('ADVICE'), ...ADVICE.map((l) => p(t(l))), ...TAIL()],
  B: () => [...HEAD(), h('ADVICE'), p(...ADVICE.flatMap((l, i) => (i ? [br(), t(l)] : [t(l)]))), ...TAIL()],
};

function makeEditor(kids) {
  const doc = schema.node('doc', null, kids);
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), schema, isDestroyed: false, dryRun: true };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
}
// block id of the first block whose text starts with s (as the AI would read it in the outline)
const id = (ed, s) => {
  const b = getBlocks(ed.state.doc).find((x) => x.node.textContent.startsWith(s));
  assert.ok(b, `no block starting with ${s}`);
  return `B${b.index}`;
};
// the document as lines: "P text" / "OL<n> text" / "UL text"; bold = **x**, italic = _x_; line breaks = ↵
function lines(doc) {
  const txt = (n) => { let s = ''; n.forEach((c) => {
    if (c.type.name === 'hardBreak') { s += '↵'; return; }
    let x = c.text; const m = c.marks.map((k) => k.type.name);
    if (m.includes('italic')) x = `_${x}_`; if (m.includes('bold')) x = `**${x}**`; s += x; }); return s; };
  const out = [];
  doc.forEach((n) => {
    if (n.type.name === 'orderedList') { let k = n.attrs.start || 1; n.forEach((li) => { out.push(`OL${k++} ${txt(li.firstChild)}`); }); }
    else if (n.type.name === 'bulletList') n.forEach((li) => out.push(`UL ${txt(li.firstChild)}`));
    else if (n.type.name === 'table') n.forEach((r) => { const cs = []; r.forEach((c) => cs.push(txt(c.firstChild))); out.push(`TR ${cs.join(' | ')}`); });
    else out.push(`P ${txt(n)}`);
  });
  return out;
}
// the lines of one section (between its heading and the next heading)
function section(doc, title) {
  const all = lines(doc);
  const i = all.indexOf(`P **${title}**`);
  const j = all.findIndex((l, k) => k > i && /^P \*\*[A-Z ]+\*\*$/.test(l));
  return all.slice(i + 1, j === -1 ? undefined : j);
}
// every section except `names` is exactly as before
function othersSame(before, afterDoc, names) {
  const b = lines(before); const a = lines(afterDoc);
  const heads = b.filter((l) => /^P \*\*[A-Z ]+\*\*$/.test(l)).map((l) => l.slice(4, -2));
  for (const s of heads) if (!names.includes(s) && s !== 'DISCHARGE SUMMARY') assert.deepEqual(section(afterDoc, s), section(before, s), `section ${s} changed`);
  if (!names.includes('DISCHARGE SUMMARY')) assert.deepEqual(a.filter((l) => l.startsWith('TR')), b.filter((l) => l.startsWith('TR')), 'header table changed');
}
const plainLines = (sec) => sec.flatMap((l) => l.replace(/^\S+ /, '').split('↵')).map((x) => x.replace(/\*\*|_/g, ''));

// ================= Issue 1: "all the tablets in a numeric list" =================
for (const L of ['A', 'B']) {
  test(`ISSUE 1 (layout ${L}): only the tablets become a numbered list 1, 2, 3; texts, order and other lines unchanged`, () => {
    const ed = makeEditor(LAYOUT[L]());
    const before = ed.state.doc;
    const edit = { block_id: id(ed, 'Tab. CIPLOX'), operation: 'to_list', list_type: 'ordered', lines: [CIPLOX, DOLO, PAN], field_label: 'Advice' };
    assert.equal(medicinesLostByEdits(before, [edit]), 0); // the medicine safety check sees no medicine lost
    const r = applyVoiceEdit(ed, edit, { allowGender: false });
    assert.equal(r.ok, true, r.error);
    const adv = section(ed.state.doc, 'ADVICE');
    assert.deepEqual(adv.filter((l) => l.startsWith('OL')), [`OL1 ${CIPLOX}`, `OL2 ${DOLO}`, `OL3 ${PAN}`]);
    assert.deepEqual(plainLines(adv), ADVICE, 'same lines, same order');
    // the syrup, the ointment and the water line are NOT numbered
    for (const x of [SYP, RING, WATER]) assert.ok(adv.some((l) => l.startsWith('P ') && l.includes(x)), x);
    if (L === 'B') assert.ok(adv.includes(`P ${RING}↵${WATER}`), 'the remaining lines keep their line break');
    othersSame(before, ed.state.doc, ['ADVICE']);
  });
}

test('to_list: bullet list; whole Advice numbered; a line that is not in the section -> refused, nothing changes', () => {
  const ed = makeEditor(LAYOUT.A());
  let r = applyVoiceEdit(ed, { block_id: id(ed, 'Tab. CIPLOX'), operation: 'to_list', list_type: 'ordered', lines: ADVICE, field_label: 'Advice' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(section(ed.state.doc, 'ADVICE'), ADVICE.map((x, i) => `OL${i + 1} ${x}`));
  const ed2 = makeEditor(LAYOUT.A());
  const before = ed2.state.doc;
  r = applyVoiceEdit(ed2, { block_id: id(ed2, 'Tab. CIPLOX'), operation: 'to_list', list_type: 'bullet', lines: [CIPLOX, 'Tab. NOTHERE 5 mg'], field_label: 'Advice' });
  assert.equal(r.ok, false);
  assert.ok(ed2.state.doc.eq(before));
  const ed3 = makeEditor(LAYOUT.B());
  r = applyVoiceEdit(ed3, { block_id: id(ed3, 'Tab. CIPLOX'), operation: 'to_list', list_type: 'bullet', lines: [SYP], field_label: 'Advice' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(section(ed3.state.doc, 'ADVICE'), [`P ${CIPLOX}`, `UL ${SYP}`, `P ${DOLO}↵${PAN}↵${RING}↵${WATER}`]);
});

test('to_list keeps bold / italic inside the lines; an existing bullet list becomes numbered; unlist gives paragraphs back', () => {
  const ed = makeEditor([h('TREATMENT GIVEN'), p(t('Inj. CEFTRIAXONE', bold()), t(' 1 g IV BD')), p(t('Inj. PANTOP 40 mg IV OD')), h('FOLLOW UP'), p(t('Review'))]);
  let r = applyVoiceEdit(ed, { block_id: 'B1', operation: 'to_list', list_type: 'bullet', lines: ['Inj. CEFTRIAXONE 1 g IV BD', 'Inj. PANTOP 40 mg IV OD'], field_label: 'Treatment' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(section(ed.state.doc, 'TREATMENT GIVEN'), ['UL **Inj. CEFTRIAXONE** 1 g IV BD', 'UL Inj. PANTOP 40 mg IV OD']);
  r = applyVoiceEdit(ed, { block_id: 'B1', operation: 'to_list', list_type: 'ordered', lines: ['Inj. CEFTRIAXONE 1 g IV BD', 'Inj. PANTOP 40 mg IV OD'], field_label: 'Treatment' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(section(ed.state.doc, 'TREATMENT GIVEN'), ['OL1 **Inj. CEFTRIAXONE** 1 g IV BD', 'OL2 Inj. PANTOP 40 mg IV OD']);
  r = applyVoiceEdit(ed, { block_id: 'B2', operation: 'unlist', field_label: 'Treatment' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(section(ed.state.doc, 'TREATMENT GIVEN'), ['P **Inj. CEFTRIAXONE** 1 g IV BD', 'P Inj. PANTOP 40 mg IV OD']);
  // the diet list of the sample document -> paragraphs, same text (not merged into one)
  const ed2 = makeEditor(LAYOUT.A());
  r = applyVoiceEdit(ed2, { block_id: id(ed2, 'Soft diet'), operation: 'unlist', field_label: 'Diet' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(section(ed2.state.doc, 'DIET INSTRUCTIONS'), ['P Soft diet for one week', 'P Avoid spicy food']);
  assert.equal(applyVoiceEdit(ed2, { block_id: id(ed2, 'ENTERIC'), operation: 'unlist', field_label: 'x' }).ok, false); // not a list
});

// ================= format (the words never change) =================
for (const L of ['A', 'B']) {
  test(`format (layout ${L}): one line bold, only the medicine names bold, a whole section italic; text unchanged`, () => {
    const ed = makeEditor(LAYOUT[L]());
    const before = ed.state.doc;
    const advice = id(ed, 'Tab. CIPLOX');
    // one line: block (layout A) or that line inside the paragraph (layout B)
    const dolo = L === 'A' ? { block_id: id(ed, 'Tab. DOLO') } : { block_id: advice, find_text: DOLO };
    let r = applyVoiceEdit(ed, { ...dolo, operation: 'format', style: 'bold', field_label: 'Advice' });
    assert.equal(r.ok, true, r.error);
    assert.ok(section(ed.state.doc, 'ADVICE').join('↵').includes(`**${DOLO}**`));
    assert.deepEqual(plainLines(section(ed.state.doc, 'ADVICE')), ADVICE);
    for (const n of ['CIPLOX', 'INSTARAFT', 'PAN']) {
      const b = L === 'A' ? id(ed, `${n === 'INSTARAFT' ? 'Syp' : 'Tab'}. ${n}`) : advice;
      r = applyVoiceEdit(ed, { block_id: b, operation: 'format', style: 'bold', find_text: n, field_label: 'Advice' });
      assert.equal(r.ok, true, r.error);
    }
    const adv = section(ed.state.doc, 'ADVICE').join('↵');
    for (const n of ['CIPLOX', 'INSTARAFT', 'PAN']) assert.ok(adv.includes(`. **${n}** (`), n);
    assert.ok(!adv.includes('**Tab') || adv.includes(`**${DOLO}**`));
    othersSame(before, ed.state.doc, ['ADVICE']);
    // the whole Course in Hospital section: one edit; the bold words stay bold; then bold removed again
    const c = id(ed, 'Patient was admitted');
    r = applyVoiceEdit(ed, { block_id: c, operation: 'format', style: 'italic', field_label: 'Course in Hospital' });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(section(ed.state.doc, 'COURSE IN HOSPITAL'), ['P _Patient was admitted with _**_high grade_**_ fever. Started on IV antibiotics._']);
    r = applyVoiceEdit(ed, { block_id: c, operation: 'format', style: 'not_bold', field_label: 'Course in Hospital' });
    assert.deepEqual(section(ed.state.doc, 'COURSE IN HOSPITAL'), ['P _Patient was admitted with high grade fever. Started on IV antibiotics._']);
    assert.equal(applyVoiceEdit(ed, { block_id: c, operation: 'format', style: 'blink', field_label: 'x' }).ok, false);
    assert.equal(applyVoiceEdit(ed, { block_id: c, operation: 'format', style: 'bold', find_text: 'not in it', field_label: 'x' }).ok, false);
  });
}

// ================= the AI aims at a section HEADING (seen with the real model) =================
test('format / change_case / unlist aimed at a HEADING mean the text under it; the heading stays (unless find_text names it)', () => {
  let ed = makeEditor(LAYOUT.A());
  const before = ed.state.doc;
  // "make the follow up text italic" -> the AI gave the heading block
  let r = applyVoiceEdit(ed, { block_id: id(ed, 'FOLLOW UP'), operation: 'format', style: 'italic', field_label: 'Follow Up' });
  assert.equal(r.ok, true, r.error);
  assert.ok(lines(ed.state.doc).includes('P **FOLLOW UP**'), 'heading unchanged');
  assert.deepEqual(section(ed.state.doc, 'FOLLOW UP'), ['P _Review in OPD after 1 week._']);
  // "make the course in hospital section lowercase" -> a range that starts at the heading
  r = applyVoiceEdit(ed, { block_id: id(ed, 'COURSE IN HOSPITAL'), last_block_id: id(ed, 'Patient was'), operation: 'change_case', case: 'lower', field_label: 'Course' });
  assert.equal(r.ok, true, r.error);
  assert.ok(lines(ed.state.doc).includes('P **COURSE IN HOSPITAL**'), 'heading unchanged');
  assert.deepEqual(section(ed.state.doc, 'COURSE IN HOSPITAL'), ['P patient was admitted with **high grade** fever. started on iv antibiotics.']);
  othersSame(before, ed.state.doc, ['FOLLOW UP', 'COURSE IN HOSPITAL']);
  // "convert the diet instructions list into normal paragraphs" -> the AI gave the heading block
  r = applyVoiceEdit(ed, { block_id: id(ed, 'DIET INSTRUCTIONS'), operation: 'unlist', field_label: 'Diet' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(section(ed.state.doc, 'DIET INSTRUCTIONS'), ['P Soft diet for one week', 'P Avoid spicy food']);
  // the heading itself: only with find_text = its words
  r = applyVoiceEdit(ed, { block_id: id(ed, 'FOLLOW UP'), operation: 'format', style: 'italic', find_text: 'FOLLOW UP', field_label: 'Follow Up' });
  assert.ok(lines(ed.state.doc).includes('P **_FOLLOW UP_**'));
  // capital-letter CONTENT ("ENTERIC FEVER") is not a heading: the edit stays on it
  ed = makeEditor(LAYOUT.A());
  r = applyVoiceEdit(ed, { block_id: id(ed, 'ENTERIC FEVER'), operation: 'format', style: 'bold', field_label: 'Diagnosis' });
  assert.equal(r.ok, true, r.error);
  const all = lines(ed.state.doc);
  assert.equal(all[all.indexOf('P **DIAGNOSIS**') + 1], 'P **ENTERIC FEVER**');
  assert.ok(all.includes('P Fever for 5 days. Headache and body pain.'), 'the next section untouched');
  // the whole document (a range beyond one section) includes the headings
  ed = makeEditor(LAYOUT.A());
  r = applyVoiceEdit(ed, { block_id: 'B0', last_block_id: `B${getBlocks(ed.state.doc).length - 1}`, operation: 'change_case', case: 'lower', field_label: 'Document' });
  assert.ok(lines(ed.state.doc).includes('P **follow up**'));
});

test('to_list without the lines -> refused with a question (nothing is guessed, nothing changes)', () => {
  const ed = makeEditor(LAYOUT.A());
  const before = ed.state.doc;
  const r = applyVoiceEdit(ed, { block_id: id(ed, 'Tab. CIPLOX'), operation: 'to_list', list_type: 'ordered', field_label: 'Advice' });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true); // shown to the person with its reason
  assert.match(r.error, /not clear which lines should be in the list.*Nothing was changed/);
  assert.ok(ed.state.doc.eq(before));
});

// ================= capitalization: the existing behaviour, and change_case =================
test('EXISTING capitalization through "set" still works exactly as before (one section lower / upper; one word)', () => {
  const ed = makeEditor(LAYOUT.A());
  const before = ed.state.doc;
  const fu = id(ed, 'Review in OPD');
  assert.equal(applyVoiceEdit(ed, { block_id: fu, operation: 'set', new_value: 'REVIEW IN OPD AFTER 1 WEEK.', field_label: 'Follow Up' }).ok, true);
  assert.deepEqual(section(ed.state.doc, 'FOLLOW UP'), ['P REVIEW IN OPD AFTER 1 WEEK.']);
  const pc = id(ed, 'Fever for 5');
  assert.equal(applyVoiceEdit(ed, { block_id: pc, operation: 'set', new_value: 'fever for 5 days. headache and body pain.', field_label: 'PC' }).ok, true);
  assert.deepEqual(section(ed.state.doc, 'PRESENTING COMPLAINTS'), ['P fever for 5 days. headache and body pain.']);
  assert.equal(applyVoiceEdit(ed, { block_id: id(ed, 'Patient was'), operation: 'replace_text', find_text: 'antibiotics', new_value: 'ANTIBIOTICS', field_label: 'C' }).ok, true);
  assert.ok(section(ed.state.doc, 'COURSE IN HOSPITAL')[0].includes('IV ANTIBIOTICS.'));
  othersSame(before, ed.state.doc, ['FOLLOW UP', 'PRESENTING COMPLAINTS', 'COURSE IN HOSPITAL']);
});

test('change_case: one section upper / lower / title / sentence; bold stays bold; only that section changes', () => {
  for (const [kase, want] of [
    ['upper', 'P PATIENT WAS ADMITTED WITH **HIGH GRADE** FEVER. STARTED ON IV ANTIBIOTICS.'],
    ['lower', 'P patient was admitted with **high grade** fever. started on iv antibiotics.'],
    ['title', 'P Patient Was Admitted With **High Grade** Fever. Started On Iv Antibiotics.'],
    ['sentence', 'P Patient was admitted with **high grade** fever. Started on iv antibiotics.'],
  ]) {
    const ed = makeEditor(LAYOUT.A());
    const before = ed.state.doc;
    const r = applyVoiceEdit(ed, { block_id: id(ed, 'Patient was'), operation: 'change_case', case: kase, field_label: 'Course in Hospital' });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(section(ed.state.doc, 'COURSE IN HOSPITAL'), [want], kase);
    othersSame(before, ed.state.doc, ['COURSE IN HOSPITAL']);
  }
});

test('change_case: one word only; a list section stays a list; Advice with line breaks keeps its breaks and medicines', () => {
  let ed = makeEditor(LAYOUT.A());
  let r = applyVoiceEdit(ed, { block_id: id(ed, 'Fever for'), operation: 'change_case', case: 'upper', find_text: 'headache', field_label: 'PC' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(section(ed.state.doc, 'PRESENTING COMPLAINTS'), ['P Fever for 5 days. HEADACHE and body pain.']);
  r = applyVoiceEdit(ed, { block_id: id(ed, 'Soft diet'), last_block_id: id(ed, 'Avoid spicy'), operation: 'change_case', case: 'upper', field_label: 'Diet' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(section(ed.state.doc, 'DIET INSTRUCTIONS'), ['UL SOFT DIET FOR ONE WEEK', 'UL AVOID SPICY FOOD']);
  ed = makeEditor(LAYOUT.B());
  const before = ed.state.doc;
  const edit = { block_id: id(ed, 'Tab. CIPLOX'), operation: 'change_case', case: 'lower', field_label: 'Advice' };
  assert.equal(medicinesLostByEdits(before, [edit]), 0);
  r = applyVoiceEdit(ed, edit);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(section(ed.state.doc, 'ADVICE'), [`P ${ADVICE.map((x) => x.toLowerCase()).join('↵')}`]);
  othersSame(before, ed.state.doc, ['ADVICE']);
});

test('change_case: the whole document in ONE edit - every text, table and list; structure, bold and "—" kept', () => {
  for (const kase of ['upper', 'lower']) {
    const ed = makeEditor(LAYOUT.B());
    const before = lines(ed.state.doc);
    const blocks = getBlocks(ed.state.doc);
    const edits = [{ block_id: 'B0', last_block_id: `B${blocks.length - 1}`, operation: 'change_case', case: kase, field_label: 'Document' }];
    // the table check does not stop a case change (it changes no row and no number)
    assert.deepEqual(checkTableEdits(ed.state.doc, 'make the entire document uppercase', edits).edits, edits);
    const r = applyVoiceEdit(ed, edits[0]);
    assert.equal(r.ok, true, r.error);
    const f = (s) => (kase === 'upper' ? s.toUpperCase() : s.toLowerCase());
    assert.deepEqual(lines(ed.state.doc), before.map((l) => l.replace(/^(\S+ )(.*)$/, (_, a, b) => a + f(b).replace(/\*\*/g, '**'))), kase);
    assert.ok(lines(ed.state.doc).join('\n').includes('—'), 'dashes kept');
  }
});

test('change_case on a table value and a label: only the letters change (numbers and units kept)', () => {
  const ed = makeEditor(LAYOUT.A());
  const r = applyVoiceEdit(ed, { block_id: id(ed, '40 Years'), operation: 'change_case', case: 'upper', field_label: 'Age' });
  assert.equal(r.ok, true, r.error);
  assert.ok(lines(ed.state.doc).includes('TR Name | DUMMY PATIENT | Age | 40 YEARS'));
  assert.equal(applyVoiceEdit(ed, { block_id: id(ed, 'Gender'), operation: 'change_case', case: 'upper', field_label: 'x' }).ok, true);
  assert.ok(lines(ed.state.doc).includes('TR GENDER | Male | IP No | IP000123'));
});

// ================= Issue 2 and the medicine insertion rules =================
for (const L of ['A', 'B']) {
  // (approved rule) a new medicine goes right after the LAST MEDICINE entry - before "Drink plenty of water."
  test(`ISSUE 2 (layout ${L}): a new medicine is its OWN line after the last medicine of Advice; the Ringworm line and every medicine unchanged`, () => {
    const ed = makeEditor(LAYOUT[L]());
    const before = ed.state.doc;
    const lastId = L === 'A' ? id(ed, 'Drink plenty') : id(ed, 'Tab. CIPLOX');
    // the AI may use insert_after or (wrongly) append: both give a separate line
    for (const operation of ['insert_after', 'append']) {
      const e2 = makeEditor(LAYOUT[L]());
      const r = applyVoiceEdit(e2, { block_id: lastId, operation, new_value: 'Tab. ZINCOVIT — At night — Daily', field_label: 'Advice' });
      assert.equal(r.ok, true, r.error);
      assert.deepEqual(plainLines(section(e2.state.doc, 'ADVICE')), [CIPLOX, SYP, DOLO, PAN, RING, 'Tab. ZINCOVIT — At night — Daily', WATER], operation);
      othersSame(before, e2.state.doc, ['ADVICE']);
    }
    // a non-medicine instruction appended after the last line: also its own line (never "Drink plenty of water. Avoid alcohol.")
    const e3 = makeEditor(LAYOUT[L]());
    assert.equal(applyVoiceEdit(e3, { block_id: lastId, operation: 'append', new_value: '\nAvoid alcohol.', field_label: 'Advice' }).ok, true);
    assert.deepEqual(plainLines(section(e3.state.doc, 'ADVICE')), [...ADVICE, 'Avoid alcohol.']);
    void ed;
  });

  test(`medicine at a position (layout ${L}): "after DOLO" and "before PAN" land exactly there`, () => {
    const ed = makeEditor(LAYOUT[L]());
    const edit = L === 'A'
      ? { block_id: id(ed, 'Tab. DOLO'), operation: 'insert_after', new_value: 'Tab. ZINCOVIT — Once Daily', field_label: 'Advice' }
      : { block_id: id(ed, 'Tab. CIPLOX'), operation: 'insert_after', find_text: 'Tab. DOLO', new_value: 'Tab. ZINCOVIT — Once Daily', field_label: 'Advice' };
    const r = applyVoiceEdit(ed, edit);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(plainLines(section(ed.state.doc, 'ADVICE')), [CIPLOX, SYP, DOLO, 'Tab. ZINCOVIT — Once Daily', PAN, RING, WATER]);
    if (L === 'B') assert.equal(section(ed.state.doc, 'ADVICE').length, 1, 'still ONE paragraph with line breaks');
  });

  test(`a medicine already in the section (layout ${L}) -> a question, nothing changes; duplicate_ok -> added as a new line`, () => {
    const ed = makeEditor(LAYOUT[L]());
    const before = ed.state.doc;
    const lastId = L === 'A' ? id(ed, 'Drink plenty') : id(ed, 'Tab. CIPLOX');
    const edit = { block_id: lastId, operation: 'insert_after', new_value: 'Tab. DOLO (Paracetamol) — At night — Daily', field_label: 'Advice' };
    const r = applyVoiceEdit(ed, edit);
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
    assert.match(r.error, /DOLO is already in this section\. Do you want to change the existing entry, or add another DOLO entry\?/);
    assert.ok(ed.state.doc.eq(before));
    assert.equal(applyVoiceEdit(ed, { ...edit, operation: 'append' }).ok, false); // append too
    assert.equal(applyVoiceEdit(ed, { ...edit, duplicate_ok: true }).ok, true);
    assert.deepEqual(plainLines(section(ed.state.doc, 'ADVICE')), [CIPLOX, SYP, DOLO, PAN, RING, 'Tab. DOLO (Paracetamol) — At night — Daily', WATER]);
  });

  test(`an instruction "after the DOLO line" is a NEW line (layout ${L}), never glued onto DOLO; a continuation still appends`, () => {
    const ed = makeEditor(LAYOUT[L]());
    const target = L === 'A' ? id(ed, 'Tab. DOLO') : id(ed, 'Tab. CIPLOX');
    const r = applyVoiceEdit(ed, { block_id: target, operation: 'insert_after', ...(L === 'B' ? { find_text: DOLO } : {}), new_value: 'Take only if the temperature is above 100 F', field_label: 'Advice' });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(plainLines(section(ed.state.doc, 'ADVICE')), [CIPLOX, SYP, DOLO, 'Take only if the temperature is above 100 F', PAN, RING, WATER]);
    if (L === 'A') {
      // the AI used append on the DOLO line with a sentence: a new line, not "... (SOS) Take only if ..."
      const e2 = makeEditor(LAYOUT.A());
      assert.equal(applyVoiceEdit(e2, { block_id: id(e2, 'Tab. DOLO'), operation: 'append', new_value: 'Take only if the temperature is above 100 F', field_label: 'Advice' }).ok, true);
      assert.deepEqual(plainLines(section(e2.state.doc, 'ADVICE')).slice(2, 4), [DOLO, 'Take only if the temperature is above 100 F']);
      // a continuation of the same line ("— 3 days") is still appended to it
      const e3 = makeEditor(LAYOUT.A());
      assert.equal(applyVoiceEdit(e3, { block_id: id(e3, 'Tab. DOLO'), operation: 'append', new_value: '— 3 days', field_label: 'Advice' }).ok, true);
      assert.ok(plainLines(section(e3.state.doc, 'ADVICE')).includes(`${DOLO} — 3 days`));
    }
  });

  test(`removing one instruction line (layout ${L}): no empty line left, neighbours not joined, medicines kept`, () => {
    const ed = makeEditor(LAYOUT[L]());
    const before = ed.state.doc;
    const edit = L === 'A'
      ? { block_id: id(ed, 'Drink plenty'), operation: 'clear', field_label: 'Advice' }
      : { block_id: id(ed, 'Tab. CIPLOX'), operation: 'replace_text', find_text: WATER, new_value: '', field_label: 'Advice' };
    assert.equal(medicinesLostByEdits(before, [edit]), 0);
    assert.equal(applyVoiceEdit(ed, edit).ok, true);
    assert.deepEqual(plainLines(section(ed.state.doc, 'ADVICE')), ADVICE.slice(0, 5));
    // a line in the middle (layout B): its break goes with it
    if (L === 'B') {
      const e2 = makeEditor(LAYOUT.B());
      assert.equal(applyVoiceEdit(e2, { block_id: id(e2, 'Tab. CIPLOX'), operation: 'replace_text', find_text: RING, new_value: '', field_label: 'Advice' }).ok, true);
      assert.deepEqual(section(e2.state.doc, 'ADVICE'), [`P ${[CIPLOX, SYP, DOLO, PAN, WATER].join('↵')}`]);
    }
    othersSame(before, ed.state.doc, ['ADVICE']);
  });
}

test('a whole sentence appended to a medicine line after a dash is a NEW line; short medicine parts after a dash still append', () => {
  const ed = makeEditor(LAYOUT.A());
  assert.equal(applyVoiceEdit(ed, { block_id: id(ed, 'Tab. DOLO'), operation: 'append', new_value: ' — Take only if the temperature is above 100 F', field_label: 'Advice' }).ok, true);
  assert.deepEqual(plainLines(section(ed.state.doc, 'ADVICE')).slice(2, 4), [DOLO, 'Take only if the temperature is above 100 F']);
  for (const part of ['— Once Daily before food', '— As Needed (SOS) — 3 days', '— 5 days']) {
    const e2 = makeEditor(LAYOUT.A());
    assert.equal(applyVoiceEdit(e2, { block_id: id(e2, 'Tab. PAN'), operation: 'append', new_value: part, field_label: 'Advice' }).ok, true);
    assert.ok(plainLines(section(e2.state.doc, 'ADVICE')).includes(`${PAN} ${part}`), part);
  }
});

test('a NEW medicine line from a command: every number in it must have been said (no invented strength / duration)', () => {
  const doc = schema.node('doc', null, LAYOUT.A());
  const ed = makeEditor(LAYOUT.A());
  const at = id(ed, 'Drink plenty');
  const made = { block_id: at, operation: 'insert_after', new_value: 'Tab. DOLO (Paracetamol) 650 mg — Oral — At Night Daily — 5 days', field_label: 'Advice' };
  let c = checkTableEdits(doc, 'Add a tablet Dolo Paracetamol in the night daily in the advice section.', [made]);
  assert.equal(c.edits.length, 0);
  assert.match(c.blocked[0], /contains 650, 5, which was not in your command, so it was not added/);
  // the numbers WERE said -> allowed (digits or words)
  c = checkTableEdits(doc, 'add tablet dolo 650 mg at night for 5 days in advice', [made]);
  assert.equal(c.edits.length, 1);
  c = checkTableEdits(doc, 'add tablet dolo six fifty mg at night for five days', [{ ...made, new_value: 'Tab. DOLO 650 mg — 5 days' }]);
  assert.equal(c.edits.length, 0, 'spoken "six fifty" is read as 6 and 50, not 650: refused, never guessed');
  // a new line without numbers, and a plain instruction, are not affected; nor other sections
  assert.equal(checkTableEdits(doc, 'add zincovit at night', [{ ...made, new_value: 'Tab. ZINCOVIT — At night' }]).edits.length, 1);
  assert.equal(checkTableEdits(doc, 'add avoid oily food', [{ ...made, new_value: 'Avoid oily food for 2 weeks' }]).edits.length, 1);
  assert.equal(checkTableEdits(doc, 'add fever', [{ block_id: id(ed, 'Fever for'), operation: 'append', new_value: 'Tab. X 5 mg', field_label: 'PC' }]).edits.length, 1);
});

test('a new line inside a list becomes a new list item (numbering continues)', () => {
  const ed = makeEditor(LAYOUT.A());
  applyVoiceEdit(ed, { block_id: id(ed, 'Tab. CIPLOX'), operation: 'to_list', list_type: 'ordered', lines: [CIPLOX, DOLO, PAN], field_label: 'Advice' });
  const r = applyVoiceEdit(ed, { block_id: id(ed, 'Tab. PAN'), operation: 'insert_after', new_value: 'Tab. ZINCOVIT — Once Daily', field_label: 'Advice' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(section(ed.state.doc, 'ADVICE').filter((l) => l.startsWith('OL')), [`OL1 ${CIPLOX}`, `OL2 ${DOLO}`, `OL3 ${PAN}`, 'OL4 Tab. ZINCOVIT — Once Daily']);
});

test('a medicine added to a department-template section (MEDICATIONS, one paragraph per line) is its own line', () => {
  const ed = makeEditor([h('NURSING NOTES'), p(t('Stable')), h('MEDICATIONS'), p(t('Inj. PANTOP 40 mg IV OD')), p(t('Tab. DOLO 650 mg SOS')), h('REMARKS'), p(t('None'))]);
  const r = applyVoiceEdit(ed, { block_id: 'B4', operation: 'append', new_value: 'Tab. ZINCOVIT Once Daily', field_label: 'Medications' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(section(ed.state.doc, 'MEDICATIONS'), ['P Inj. PANTOP 40 mg IV OD', 'P Tab. DOLO 650 mg SOS', 'P Tab. ZINCOVIT Once Daily']);
});

// ================= moving text between sections =================
test('move "from <section> to <section>": the removal in the source is allowed; other sections still refused', () => {
  const ed = makeEditor(LAYOUT.A());
  const doc = ed.state.doc;
  const pc = id(ed, 'Fever for');
  const course = id(ed, 'Patient was');
  const edits = [
    { block_id: pc, operation: 'replace_text', find_text: ' Headache and body pain.', new_value: '', field_label: 'PC' },
    { block_id: course, operation: 'append', new_value: 'Headache and body pain.', field_label: 'Course' },
  ];
  const cmd = "move 'Headache and body pain.' from the presenting complaints to the course in hospital";
  const c = checkNamedSection(doc, cmd, edits);
  assert.ok(!c.reject, c.reject);
  for (const e of c.edits) assert.equal(applyVoiceEdit(ed, e).ok, true);
  assert.deepEqual(section(ed.state.doc, 'PRESENTING COMPLAINTS'), ['P Fever for 5 days.']);
  assert.ok(section(ed.state.doc, 'COURSE IN HOSPITAL')[0].endsWith('IV antibiotics. Headache and body pain.'));
  othersSame(doc, ed.state.doc, ['PRESENTING COMPLAINTS', 'COURSE IN HOSPITAL']);
  // without "from <that section>", a change in another section is still refused (existing protection)
  assert.ok(checkNamedSection(doc, 'add headache and body pain to the course in hospital', edits).reject);
  assert.ok(checkNamedSection(doc, "move 'x' from the diagnosis to the course in hospital", edits).reject);
});

// ================= safety, uploads, Undo =================
test('look-only edits never come from an uploaded file; a file may still add a medicine that exists (compared later)', () => {
  const ed = makeEditor(LAYOUT.A());
  const before = ed.state.doc;
  for (const e of [
    { block_id: id(ed, 'Tab. DOLO'), operation: 'format', style: 'bold', field_label: 'x' },
    { block_id: id(ed, 'Tab. DOLO'), operation: 'change_case', case: 'upper', field_label: 'x' },
    { block_id: id(ed, 'Tab. DOLO'), operation: 'to_list', list_type: 'ordered', lines: [DOLO], field_label: 'x' },
  ]) {
    const r = applyVoiceEdit(ed, e, { fromFile: true });
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
  }
  assert.ok(ed.state.doc.eq(before));
  const prev = previewEdits(before, [{ block_id: id(ed, 'Drink plenty'), operation: 'insert_after', new_value: 'Tab. DOLO 500 mg', field_label: 'Advice' }]);
  assert.equal(prev.items.length, 1); // uploads: no duplicate question (unchanged behaviour)
});

test('one Undo brings back the document after a list / format / case change made as ONE step', () => {
  const ed = makeEditor(LAYOUT.B());
  const before = ed.state.doc;
  asOneUndoStep(ed.view, () => {
    applyVoiceEdit(ed, { block_id: id(ed, 'Tab. CIPLOX'), operation: 'to_list', list_type: 'ordered', lines: [CIPLOX, DOLO, PAN], field_label: 'Advice' });
    applyVoiceEdit(ed, { block_id: id(ed, 'Tab. DOLO'), operation: 'format', style: 'bold', field_label: 'Advice' });
    applyVoiceEdit(ed, { block_id: id(ed, 'Review in OPD'), operation: 'change_case', case: 'upper', field_label: 'Follow Up' });
  });
  assert.ok(!ed.state.doc.eq(before));
  undo(ed.state, (tr) => { ed.state = ed.state.apply(tr); });
  assert.ok(ed.state.doc.eq(before), 'one Undo restores everything');
});

test('the outline the AI reads still lists every line (list items appear as blocks)', () => {
  const ed = makeEditor(LAYOUT.A());
  applyVoiceEdit(ed, { block_id: id(ed, 'Tab. CIPLOX'), operation: 'to_list', list_type: 'ordered', lines: [CIPLOX, DOLO, PAN], field_label: 'Advice' });
  const o = buildOutline(ed.state.doc);
  for (const x of ADVICE) assert.ok(o.includes(x), x);
});

// ================= quoted phrase in Advice (approved change in commandIntent.js) =================
test('remove a QUOTED plain instruction from Advice -> normal AI editing; medicine parts keep the confirmation window', () => {
  const doc = schema.node('doc', null, LAYOUT.A());
  assert.equal(classifyCommand(doc, "remove 'Drink plenty of water' from the advice").type, 'ai');
  const oral = classifyCommand(doc, "remove 'Oral' from all medicines in the advice");
  assert.equal(oral.type, 'remove'); // still the medicine window
  assert.equal(classifyCommand(doc, "remove 'Bed rest' from the advice").type, 'ask'); // not in Advice: still asks
  assert.equal(classifyCommand(doc, 'remove all medicines from advice').type, 'remove');
});
