// R3 (D1, D4, D5, D6): Gemini's edits are applied as Gemini returned them. No keyword parser, no section / medicine /
// number / table / duplicate / gender rules, no language window, no age / gender rewriting by the app. Only the
// technical checks (R1 missing text, the block exists, the text to replace exists, locked headings / labels) and the
// technical formatting (separate entries, line breaks, lists). Dummy data, mocked Gemini answers.
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

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-r3');
fs.mkdirSync(tmp, { recursive: true });
for (const f of fs.readdirSync(path.join(here, '../src/lib')).filter((x) => x.endsWith('.js'))) {
  fs.writeFileSync(path.join(tmp, f), fs.readFileSync(path.join(here, '../src/lib', f), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'"));
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { previewEdits } = await import(pathToFileURL(path.join(tmp, 'previewEdits.js')).href);
const { getBlocks } = await import(pathToFileURL(path.join(tmp, 'outline.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit, Table, TableRow, TableHeader, TableCell]);
const t = (s) => schema.text(s);
const p = (...k) => schema.node('paragraph', null, k);
const tp = (s) => p(t(s));
const h = (s) => p(schema.text(s, [schema.marks.bold.create()]));
const br = () => schema.nodes.hardBreak.create();
const cell = (s) => schema.node('tableCell', null, [tp(s)]);
const row = (...xs) => schema.node('tableRow', null, xs.map(cell));
const kids = () => [h('DISCHARGE SUMMARY'), schema.node('table', null, [row('Name', 'DUMMY PATIENT', 'Age', '40 Years'), row('Gender', 'Male', 'IP No', 'IP000123')]),
  h('DIAGNOSIS'), tp('TYPHOID'), h('PRESENTING COMPLAINTS'), tp('A 40-year-old male presented with fever for 5 days. His mother is a 60-year-old diabetic.'),
  h('COURSE IN HOSPITAL'), tp('Patient was admited with fever.'),
  h('ADVICE'), p(t('Tab. CIPLOX 500 mg — Twice Daily — 5 days'), br(), t('Tab. CROCIN (Paracetamol) 650 mg — SOS'), br(), t('Tab. PAN 40 mg — Once Daily — 5 days')),
  tp('Drink plenty of water.'), h('FOLLOW UP'), tp('Review in OPD after 1 week.')];
const editorOf = () => {
  const ed = { state: EditorState.create({ doc: schema.node('doc', null, kids()) }), schema, isDestroyed: false, dryRun: true };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
};
const lines = (ed) => getBlocks(ed.state.doc).flatMap((b) => b.node.textBetween(0, b.node.content.size, '\n', '\n').split('\n'));
const id = (ed, start) => `B${getBlocks(ed.state.doc).findIndex((b) => b.node.textContent.startsWith(start))}`;
// the App.jsx flow for a command: a batch (2+ edits) is checked by the dry run first (all or nothing), then applied
function run(ed, edits) {
  const ordered = [...edits].map((e, i) => ({ e, i })).sort((a, b) => parseInt(b.e.block_id.slice(1), 10) - parseInt(a.e.block_id.slice(1), 10) || b.i - a.i).map((x) => x.e);
  if (ordered.length > 1) {
    const dry = previewEdits(ed.state.doc, ordered, { fromFile: false });
    if (dry.blocked.length) return { applied: false, blocked: dry.blocked };
  }
  const results = ordered.map((e) => applyVoiceEdit(ed, e, {}));
  return { applied: results.every((r) => r.ok), results };
}

test('R3: medicine edits the old rules refused are applied as Gemini returned them', () => {
  for (const [why, edits, want] of [
    ['"make pan 20" (unit not said)', (ed) => [{ block_id: id(ed, 'Tab. CIPLOX'), operation: 'replace_text', find_text: '40 mg', new_value: '20 mg', field_label: 'Advice' }], 'Tab. PAN 20 mg — Once Daily — 5 days'],
    ['"continue pan for a week" (7 days)', (ed) => [{ block_id: id(ed, 'Tab. CIPLOX'), operation: 'replace_text', find_text: 'Once Daily — 5 days', new_value: 'Once Daily — 7 days', field_label: 'Advice' }], 'Tab. PAN 40 mg — Once Daily — 7 days'],
    ['"give pan at night instead"', (ed) => [{ block_id: id(ed, 'Tab. CIPLOX'), operation: 'replace_text', find_text: 'Once Daily', new_value: 'At Night (0-0-1)', field_label: 'Advice' }], 'Tab. PAN 40 mg — At Night (0-0-1) — 5 days'],
    ['add a medicine without a form, with details', (ed) => [{ block_id: id(ed, 'Tab. CIPLOX'), operation: 'insert_after', find_text: 'Tab. PAN 40 mg — Once Daily — 5 days', new_value: 'DOLO 650 — In the Morning', field_label: 'Advice' }], 'DOLO 650 — In the Morning'],
    ['add the same medicine again (no duplicate question)', (ed) => [{ block_id: id(ed, 'Tab. CIPLOX'), operation: 'insert_after', find_text: 'Tab. PAN 40 mg — Once Daily — 5 days', new_value: 'Tab. PAN 20 mg — At Night', field_label: 'Advice' }], 'Tab. PAN 20 mg — At Night'],
    ['replace one medicine with another', (ed) => [{ block_id: id(ed, 'Tab. CIPLOX'), operation: 'replace_text', find_text: 'Tab. CROCIN (Paracetamol) 650 mg — SOS', new_value: 'Tab. DOLO 650 mg — SOS', field_label: 'Advice' }], 'Tab. DOLO 650 mg — SOS'],
  ]) {
    const ed = editorOf();
    const r = run(ed, edits(ed));
    assert.equal(r.applied, true, `${why}: ${JSON.stringify(r.blocked || r.results)}`);
    assert.ok(lines(ed).includes(want), `${why}: ${lines(ed).join(' | ')}`);
  }
});

test('R3: removals by Gemini - one line, one detail, and a paragraph holding several medicines (no 2+ medicine refusal)', () => {
  let ed = editorOf();
  assert.equal(run(ed, [{ block_id: id(ed, 'Tab. CIPLOX'), operation: 'replace_text', find_text: 'Tab. CROCIN (Paracetamol) 650 mg — SOS', new_value: '', field_label: 'Advice' }]).applied, true);
  assert.deepEqual(lines(ed).filter((l) => l.startsWith('Tab.')), ['Tab. CIPLOX 500 mg — Twice Daily — 5 days', 'Tab. PAN 40 mg — Once Daily — 5 days'], 'the line and its break go, neighbours not joined');
  ed = editorOf();
  assert.equal(run(ed, [{ block_id: id(ed, 'Tab. CIPLOX'), operation: 'replace_text', find_text: ' (Paracetamol)', new_value: '', field_label: 'Advice' }]).applied, true);
  assert.ok(lines(ed).includes('Tab. CROCIN 650 mg — SOS'), 'only the generic name removed');
  ed = editorOf();
  assert.equal(run(ed, [{ block_id: id(ed, 'Tab. CIPLOX'), operation: 'clear', field_label: 'Advice' }]).applied, true);
  assert.ok(!lines(ed).some((l) => l.startsWith('Tab.')), 'the whole multi-medicine paragraph cleared (deletion confirmation comes in R4)');
});

test('R3: several requests across sections, medicines included, applied together as Gemini returned them', () => {
  const ed = editorOf();
  const r = run(ed, [
    { block_id: id(ed, 'TYPHOID'), operation: 'append', new_value: ', FEVER', field_label: 'Diagnosis' },
    { block_id: id(ed, 'Patient was'), operation: 'replace_text', find_text: 'admited', new_value: 'admitted', field_label: 'Course in Hospital' },
    { block_id: id(ed, 'Tab. CIPLOX'), operation: 'replace_text', find_text: '40 mg', new_value: '20 mg', field_label: 'Advice' },
    { block_id: id(ed, 'Review'), operation: 'replace_text', find_text: '1 week', new_value: '2 weeks', field_label: 'Follow Up' },
  ]);
  assert.equal(r.applied, true, JSON.stringify(r.blocked));
  for (const l of ['TYPHOID, FEVER', 'Patient was admitted with fever.', 'Tab. PAN 20 mg — Once Daily — 5 days', 'Review in OPD after 2 weeks.']) assert.ok(lines(ed).includes(l), l);
});

test('R3 (D5): age / gender edits are exactly Gemini\'s - the app does not rewrite other places or relatives', () => {
  const ed = editorOf();
  const r = run(ed, [
    { block_id: id(ed, '40 Years'), operation: 'set', new_value: '45 Years', field_label: 'Age' },
    { block_id: id(ed, 'A 40-year-old'), operation: 'replace_text', find_text: '40-year-old male', new_value: '45-year-old male', field_label: 'Presenting Complaints' },
  ]);
  assert.equal(r.applied, true);
  assert.ok(lines(ed).includes('45 Years'));
  assert.ok(lines(ed).includes('A 45-year-old male presented with fever for 5 days. His mother is a 60-year-old diabetic.'), 'the mother\'s age untouched');
  // a pronoun in Gemini's new text is applied (no gender guard)
  const ed2 = editorOf();
  assert.equal(run(ed2, [{ block_id: id(ed2, 'Patient was'), operation: 'insert_after', new_value: 'He was afebrile from day 3.', field_label: 'Course' }]).applied, true);
  assert.ok(lines(ed2).includes('He was afebrile from day 3.'));
});

test('R3: kept technical checks - missing text (R1), unknown text, a locked heading; one blocked edit stops the batch', () => {
  const ed = editorOf();
  const before = ed.state.doc;
  for (const e of [
    { block_id: id(ed, 'TYPHOID'), operation: 'set', field_label: 'Diagnosis' },
    { block_id: id(ed, 'TYPHOID'), operation: 'replace_text', find_text: 'MALARIA', new_value: 'X', field_label: 'Diagnosis' },
    { block_id: id(ed, 'DIAGNOSIS'), operation: 'replace_text', find_text: 'DIAGNOSIS', new_value: 'FINAL DIAGNOSIS', field_label: 'Diagnosis' },
  ]) assert.equal(applyVoiceEdit(ed, e, {}).ok, false, JSON.stringify(e));
  assert.ok(ed.state.doc.eq(before));
  const r = run(ed, [{ block_id: id(ed, 'TYPHOID'), operation: 'append', new_value: ', FEVER', field_label: 'Diagnosis' },
    { block_id: id(ed, 'Review'), operation: 'set', field_label: 'Follow Up' }]);
  assert.equal(r.applied, false);
  assert.ok(ed.state.doc.eq(before), 'nothing of the batch applied');
});

test('R3 (D6): technical formatting - new entries on their own lines; "\\n" becomes real line breaks', () => {
  const ed = editorOf();
  assert.equal(run(ed, [{ block_id: id(ed, 'Tab. CIPLOX'), operation: 'append', new_value: ', Tab. ZINC 20 mg — At Night', field_label: 'Advice' }]).applied, true);
  assert.equal(lines(ed).filter((l) => l.startsWith('Tab. ZINC')).length, 1);
  assert.ok(lines(ed).includes('Tab. ZINC 20 mg — At Night'), 'its own line, no comma');
  const ed2 = editorOf();
  assert.equal(run(ed2, [{ block_id: id(ed2, 'Drink plenty'), operation: 'set', new_value: 'Drink plenty of water.\nAvoid oily food.', field_label: 'Advice' }]).applied, true);
  assert.ok(lines(ed2).includes('Drink plenty of water.') && lines(ed2).includes('Avoid oily food.'), 'two real lines, no raw \\n');
});

test('R3: App.jsx runEdits calls none of the removed checks; typed, voice and streamed answers take the same path', () => {
  const app = fs.readFileSync(path.join(here, '../src/App.jsx'), 'utf8');
  const run = app.slice(app.indexOf('async function runEdits('), app.indexOf('async function runAndReport('));
  for (const gone of ['runCodeCommand(', 'needsPreview(', 'malayalamStop(', 'checkInterpretation(', 'checkNamedSection(', 'checkMedicineEdits(',
    'withDuplicateChoice(', 'checkTableEdits(', 'medicinesLostByEdits(', 'wholeSectionReplacement(', 'genderChangeAllowed(']) assert.ok(!run.includes(gone), gone);
  assert.ok(run.indexOf('bottomUp(aiEdits)') < run.indexOf('previewEdits(') && run.indexOf('previewEdits(') < run.indexOf('applyAiEdits('));
  // no age / gender rewriting after an edit
  const apply = app.slice(app.indexOf('function applyAiEdits('), app.indexOf('function showUploadPreview('));
  for (const gone of ['ensurePatientConsistency(', 'applyPatientConsistency(']) assert.ok(!apply.includes(gone), gone);
});

// R5 (found with real Gemini): find_text ended with a line break that is not in the block -> the whole batch was refused
test('R5: replace_text whose find_text ends with a line break / spaces still finds the text (technical tolerance)', () => {
  const ed = editorOf();
  const adv = id(ed, 'Tab. CIPLOX');
  const r = run(ed, [
    { block_id: adv, operation: 'replace_text', find_text: 'Tab. CROCIN (Paracetamol) 650 mg — SOS\n', new_value: '' },
    { block_id: adv, operation: 'replace_text', find_text: '  40 mg ', new_value: '20 mg' },
  ]);
  assert.equal(r.applied, true, JSON.stringify(r.blocked || r.results));
  const now = lines(ed);
  assert.ok(!now.some((l) => l.includes('CROCIN')), now.join('\n'));
  assert.ok(now.includes('Tab. PAN 20 mg — Once Daily — 5 days'), now.join('\n'));
  assert.ok(now.includes('Tab. CIPLOX 500 mg — Twice Daily — 5 days'));
  // text that is really not there is still refused
  assert.equal(applyVoiceEdit(editorOf(), { block_id: adv, operation: 'replace_text', find_text: 'DOLO\n', new_value: 'x' }, {}).ok, false);
});

// R5 (found with real Gemini, flash-lite on an upload): new text that copies the app's outline markup is never applied
test('R5: new text holding the outline markup ("TABLE ROW: [B35] (P) ...") is not applied; ordinary text with brackets is', () => {
  const ed = editorOf();
  const before = ed.state.doc;
  const bad = [
    { block_id: id(ed, 'TYPHOID'), operation: 'insert_after', new_value: 'TABLE ROW: [B35] (P) "CRP" | [B36] (P) "48 mg/L"' },
    { block_id: id(ed, 'TYPHOID'), operation: 'set', new_value: '[B14] (P) "TYPHOID, FEVER"' },
    { block_id: id(ed, 'TYPHOID'), operation: 'append', new_value: 'x\n[B3] (H2) "y"' },
  ];
  for (const e of bad) {
    const r = applyVoiceEdit(ed, e, {});
    assert.equal(r.ok, false, JSON.stringify(e));
    assert.match(r.error, /internal block labels/);
  }
  assert.ok(ed.state.doc.eq(before));
  assert.equal(applyVoiceEdit(ed, { block_id: id(ed, 'TYPHOID'), operation: 'append', new_value: '[B] cell (P) note' }, {}).ok, true);
  assert.equal(run(editorOf(), [bad[0], { block_id: id(ed, 'Review'), operation: 'set', new_value: 'Review after 2 weeks.' }]).applied, false); // batch: nothing
});
