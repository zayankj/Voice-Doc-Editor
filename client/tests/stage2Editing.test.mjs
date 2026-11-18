// STAGE 2 regression tests kept after R6: the Validate menu age / gender fix (consistency.js, a manual action) never
// changes a RELATIVE's age, sex or pronouns to the patient's. (The command-path tests of Stage 2 were removed with
// the code-run commands and checks - R6.) Dummy data only; no AI, no network.
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
import { history } from '@tiptap/pm/history';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-stage2');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'previewEdits', 'medicineText', 'sections']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { previewEdits } = await import(pathToFileURL(path.join(tmp, 'previewEdits.js')).href);
const { getBlocks } = await import(pathToFileURL(path.join(tmp, 'outline.js')).href);
const { syncPatientFacts } = await import(pathToFileURL(path.join(tmp, 'consistency.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit, Table, TableRow, TableHeader, TableCell]);
const t = (s) => schema.text(s);
const p = (s) => schema.node('paragraph', null, s ? [t(s)] : []);
const h = (s) => schema.node('paragraph', null, [schema.text(s, [schema.marks.bold.create()])]);
const br = () => schema.nodes.hardBreak.create();
const cell = (s) => schema.node('tableCell', null, [p(s)]);
const row = (...xs) => schema.node('tableRow', null, xs.map(cell));
const header = () => schema.node('table', null, [row('Name', 'DUMMY PATIENT', 'Age', '40 Years'), row('Gender', 'Male', 'IP No', 'IP000123')]);
const MAIN = () => [h('DISCHARGE SUMMARY'), header(), h('DIAGNOSIS'), p('ENTERIC FEVER'), h('PRESENTING COMPLAINTS'),
  p('A 40-year-old male presented with fever for 5 days.'), h('HISTORY'), p('Known diabetic for 6 years.'), h('SYSTEMIC EXAMINATION'),
  p('CVS: S1 S2 heard.'), h('COURSE IN HOSPITAL'), p('Admitted with fever.'), h('TREATMENT GIVEN'), p('Inj. CEFTRIAXONE 1 g IV BD for 5 days'),
  p('IV NS 500 ml 8th hourly for 3 days'), h('ADVICE'), p('Tab. CIPLOX 500 mg — Twice Daily — 5 days'), p('Tab. PAN 40 mg — Once Daily — 5 days'),
  p('Drink plenty of water.'), h('FOLLOW UP'), p('Review in OPD after 1 week.')];
// only ONE medicine section (so a medicine command never has to ask which section)
const ADVICE_ONLY = () => [h('DIAGNOSIS'), p('ENTERIC FEVER'), h('ADVICE'), p('Tab. CIPLOX 500 mg — Oral — Twice Daily — 5 days'),
  p('Tab. PAN 40 mg — Oral — Once Daily — 5 days'), p('Drink plenty of water.'), h('FOLLOW UP'), p('Review in OPD after 1 week.')];
function editorOf(kids) {
  const ed = { state: EditorState.create({ doc: schema.node('doc', null, kids), plugins: [history()] }), schema, isDestroyed: false, dryRun: true };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
}
const docOf = (kids) => editorOf(kids).state.doc;
const idIn = (doc, start) => { const i = getBlocks(doc).findIndex((b) => b.node.textContent.startsWith(start)); assert.ok(i >= 0, start); return `B${i}`; };
const textOf = (doc) => getBlocks(doc).map((b) => b.node.textContent);

// ---------------- 1. "clear" ----------------

// ---------------- 2. relatives ----------------
function writeAndSync(text, facts = { age: '40', gender: 'male' }) {
  const ed = editorOf(MAIN());
  const at = idIn(ed.state.doc, 'Known diabetic');
  assert.equal(applyVoiceEdit(ed, { block_id: at, operation: 'insert_after', new_value: text, field_label: 'History' }).ok, true);
  const i = getBlocks(ed.state.doc).findIndex((b) => b.node.textContent === text);
  const node = getBlocks(ed.state.doc)[i].node;
  syncPatientFacts(ed, facts, () => {}, (n) => n === node);
  return getBlocks(ed.state.doc)[i].node.textContent;
}
test('2. a RELATIVE\'s age, sex and pronouns are never changed to the patient\'s; the patient\'s own still are', () => {
  for (const s of ['Mother is a 60 year old female with diabetes.', 'Mother is diabetic. She takes insulin.', 'His mother is a 62 year old lady.',
    'Wife: a 35 year old woman, she is the attender.', 'Elder brother, a 45-year-old man, had tuberculosis.']) {
    assert.equal(writeAndSync(s), s, s);
  }
  // the patient's own words still follow Patient Details (40, male)
  assert.equal(writeAndSync('A 30 year old female patient; her mother is diabetic.'), 'A 40 year old male patient; his mother is diabetic.');
  assert.equal(writeAndSync('Her father, a 70-year-old man, is hypertensive.'), 'His father, a 70-year-old man, is hypertensive.');
  assert.equal(writeAndSync('She was admitted with fever.'), 'He was admitted with fever.');
  assert.equal(writeAndSync('A 22-year-old female presented with vomiting.'), 'A 40-year-old male presented with vomiting.');
});
test('2. document-wide (Patient Details changed): relatives untouched, every patient phrase follows', () => {
  const ed = editorOf([h('PATIENT'), p('A 40-year-old male presented with fever.'), h('FAMILY HISTORY'), p('Mother is a 60 year old female with diabetes. She takes insulin.')]);
  syncPatientFacts(ed, { age: '45', gender: 'female' }, () => {});
  assert.deepEqual(textOf(ed.state.doc).slice(1), ['A 45-year-old female presented with fever.', 'FAMILY HISTORY', 'Mother is a 60 year old female with diabetes. She takes insulin.']);
});

// ---------------- 3. the command parser ----------------

// ---------------- 5 / 7. sections ----------------
const add = (block_id, new_value, operation = 'append') => ({ block_id, operation, new_value, field_label: 'x' });

// ---------------- 4. whole-section replacement ----------------
const adviceReplace = (doc, value = 'Take complete rest.') => [
  { block_id: idIn(doc, 'Tab. CIPLOX'), operation: 'set', new_value: value, field_label: 'Advice' },
  { block_id: idIn(doc, 'Tab. PAN'), operation: 'clear', field_label: 'Advice' },
  { block_id: idIn(doc, 'Drink plenty'), operation: 'clear', field_label: 'Advice' }];