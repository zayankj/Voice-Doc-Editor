// STAGE R1 (dummy data only, mocked AI answers): the minimum technical check of an edit. An edit whose text is
// MISSING never changes the document; one such edit in a batch means nothing of the batch is applied. Nothing here is
// about the words of the command or about medicines.  Run:  cd client  &&  node --test tests/
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
const tmp = path.join(here, '.build-r1');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'previewEdits', 'medicineText', 'sections']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit, incompleteEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { previewEdits } = await import(pathToFileURL(path.join(tmp, 'previewEdits.js')).href);
const { getBlocks } = await import(pathToFileURL(path.join(tmp, 'outline.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit, Table, TableRow, TableHeader, TableCell]);
const t = (s) => schema.text(s);
const p = (s) => schema.node('paragraph', null, s ? [t(s)] : []);
const h = (s) => schema.node('paragraph', null, [schema.text(s, [schema.marks.bold.create()])]);
const cell = (s) => schema.node('tableCell', null, [p(s)]);
const row = (...xs) => schema.node('tableRow', null, xs.map(cell));
const kids = () => [h('DISCHARGE SUMMARY'),
  schema.node('table', null, [row('Name', 'DUMMY PATIENT', 'Age', '40 Years'), row('Date of Admission', '01-11-2026', 'Date of Discharge', '06-11-2026')]),
  h('DIAGNOSIS'), p('TYPHOID'), h('COURSE IN HOSPITAL'), p('Patient was admitted with fever.'),
  h('ADVICE'), p('Tab. PAN 40 mg — Once Daily — 5 days'), p('Drink plenty of water.'), h('FOLLOW UP'), p('Review in OPD after 1 week.')];
const editorOf = () => {
  const ed = { state: EditorState.create({ doc: schema.node('doc', null, kids()) }), schema, isDestroyed: false, dryRun: true };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
};
const doc0 = editorOf().state.doc;
const id = (start) => `B${getBlocks(doc0).findIndex((b) => b.node.textContent.startsWith(start))}`;
const text = (ed) => getBlocks(ed.state.doc).map((b) => b.node.textContent);

test('R1. incompleteEdit: a MISSING text or find_text is incomplete; an explicit "" keeps its existing meaning', () => {
  const b = 'B1';
  for (const e of [
    { block_id: b, operation: 'set' }, { block_id: b, operation: 'set', new_value: null }, { block_id: b, operation: 'set', new_value: 5 },
    { block_id: b, operation: 'append' }, { block_id: b, operation: 'append', new_value: '' }, { block_id: b, operation: 'append', new_value: '   ' },
    { block_id: b, operation: 'insert_after' }, { block_id: b, operation: 'insert_after', new_value: ' \n ' },
    { block_id: b, operation: 'replace_text', new_value: 'x' }, { block_id: b, operation: 'replace_text', find_text: '', new_value: 'x' },
    { block_id: b, operation: 'replace_text', find_text: 'TYPHOID' },
  ]) assert.match(incompleteEdit(e), /was not applied/, JSON.stringify(e));
  for (const e of [
    { block_id: b, operation: 'set', new_value: 'New text.' },
    { block_id: b, operation: 'set', new_value: '' }, // explicit "": the existing deletion of a line (unchanged)
    { block_id: b, operation: 'append', new_value: ', FEVER' },
    { block_id: b, operation: 'insert_after', new_value: 'A new line.' },
    { block_id: b, operation: 'replace_text', find_text: 'TYPHOID', new_value: 'ENTERIC FEVER' },
    { block_id: b, operation: 'replace_text', find_text: ' for 5 days', new_value: '' }, // remove the found text (unchanged)
    { block_id: b, operation: 'clear' }, { block_id: b, operation: 'format', style: 'bold' }, { block_id: b, operation: 'change_case', case: 'upper' },
  ]) assert.equal(incompleteEdit(e), '', JSON.stringify(e));
});

test('R1. the real 18 Nov answer: two `set` edits WITHOUT new_value on the patient dates -> both dates stay (before: emptied)', () => {
  const ed = editorOf();
  const before = ed.state.doc;
  for (const e of [{ block_id: id('01-11-2026'), operation: 'set', field_label: 'Date of Admission' }, { block_id: id('06-11-2026'), operation: 'set', field_label: 'Date of Discharge' }]) {
    const r = applyVoiceEdit(ed, e, {});
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
    assert.match(r.error, /no new text for this change \(set\)/);
  }
  assert.ok(ed.state.doc.eq(before), 'nothing changed');
  assert.ok(text(ed).includes('01-11-2026') && text(ed).includes('06-11-2026'));
});

test('R1. other missing texts never change the document (append, insert_after, replace_text, age, medicine line)', () => {
  for (const e of [
    { block_id: id('Patient was'), operation: 'append', field_label: 'Course' },
    { block_id: id('Patient was'), operation: 'insert_after', new_value: '  ', field_label: 'Course' },
    { block_id: id('40 Years'), operation: 'set', field_label: 'Age' },
    { block_id: id('Tab. PAN'), operation: 'replace_text', find_text: '40 mg', field_label: 'Advice' }, // before: "40 mg" deleted
    { block_id: id('Tab. PAN'), operation: 'replace_text', new_value: '20 mg', field_label: 'Advice' },
    { block_id: id('TYPHOID'), operation: 'set', field_label: 'Diagnosis' },
  ]) {
    const ed = editorOf();
    const before = ed.state.doc;
    const r = applyVoiceEdit(ed, e, {});
    assert.equal(r.ok, false, JSON.stringify(e));
    assert.ok(ed.state.doc.eq(before), `unchanged: ${JSON.stringify(e)}`);
  }
});

test('R1. a batch with ONE incomplete edit: the dry run reports it, so nothing of the batch is applied', () => {
  // the same dry run App.jsx runs before applying a batch (2+ edits) or a medicine command: one blocked = nothing
  const batch = [
    { block_id: id('TYPHOID'), operation: 'append', new_value: ', FEVER', field_label: 'Diagnosis' },
    { block_id: id('Review in OPD'), operation: 'replace_text', find_text: '1 week', field_label: 'Follow Up' }, // no new_value
  ];
  const dry = previewEdits(doc0, [...batch].reverse(), { allowGender: false, fromFile: false });
  assert.equal(dry.blocked.length, 1);
  assert.match(dry.blocked[0].reason, /no new text for this change \(replace_text\)/);
  // App.jsx: a batch is all or nothing (the dry run in runEdits), so the valid Diagnosis edit is not applied either
  const app = fs.readFileSync(path.join(here, '../src/App.jsx'), 'utf8');
  assert.match(app, /if \(ordered\.length > 1\) \{\r?\n\s+const batchDry = previewEdits\(doc, ordered, \{ fromFile \}\);/);
  assert.match(app, /if \(batchDry\.blocked\.length\) \{\r?\n\s+setNote\(`🔒 Nothing was changed: /);
});

test('R1. uploads: an incomplete edit from a file is never applied (it shows as not applied in the preview)', () => {
  const dry = previewEdits(doc0, [{ block_id: id('01-11-2026'), operation: 'set', field_label: 'Date of Admission' }], { allowGender: true, fromFile: true });
  assert.equal(dry.items.length, 0);
  assert.equal(dry.blocked.length, 1);
  assert.match(dry.blocked[0].reason, /no new text/);
});

test('R1. KEPT: complete edits apply exactly as before (set, append, insert_after, replace_text, set "" deletion)', () => {
  const ed = editorOf();
  assert.equal(applyVoiceEdit(ed, { block_id: id('TYPHOID'), operation: 'append', new_value: ', FEVER', field_label: 'Diagnosis' }, {}).ok, true);
  assert.equal(applyVoiceEdit(ed, { block_id: id('Tab. PAN'), operation: 'replace_text', find_text: '40 mg', new_value: '20 mg', field_label: 'Advice' }, {}).ok, true);
  assert.equal(applyVoiceEdit(ed, { block_id: id('Patient was'), operation: 'insert_after', new_value: 'Afebrile from day 3.', field_label: 'Course' }, {}).ok, true);
  assert.equal(applyVoiceEdit(ed, { block_id: id('01-11-2026'), operation: 'set', new_value: '02-11-2026', field_label: 'Date of Admission' }, {}).ok, true);
  const now = text(ed);
  for (const l of ['TYPHOID, FEVER', 'Tab. PAN 20 mg — Once Daily — 5 days', 'Afebrile from day 3.', '02-11-2026']) assert.ok(now.includes(l), l);
  // an explicit "" on a medicine line: the existing deletion of that line (tested elsewhere too) still works
  const ed2 = editorOf();
  assert.equal(applyVoiceEdit(ed2, { block_id: id('Tab. PAN'), operation: 'set', new_value: '', field_label: 'Advice' }, {}).ok, true);
  assert.ok(!text(ed2).some((l) => l.startsWith('Tab. PAN')));
});
