// Regression tests for src/lib/verify.js (named-section check: the malaria / Course in Hospital bug)
// Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { EditorState } from '@tiptap/pm/state';
import { checkNamedSection } from '../src/lib/verify.js';
import { getBlocks } from '../src/lib/outline.js';

const schema = getSchema([StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell]);
const p = (t) => schema.node('paragraph', null, t ? [schema.text(t)] : []);
const bold = (t) => schema.node('paragraph', null, [schema.text(t, [schema.marks.bold.create()])]);
const th = (t) => schema.node('tableHeader', null, [p(t)]);
const row = (...ts) => schema.node('tableRow', null, ts.map(th));

const DIAG = 'ENTERIC FEVER (A01.0: Typhoid fever), SEPSIS- SEPTIC SHOCK - RESOLVED';
const COURSE = '60-year-old female presented with loose stools. Patient is currently stable and discharged.';
const ADVICE = 'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — Twice Daily (1-0-1) — 2 days';

// Shaped like the real discharge summary
function makeDoc() {
  return schema.node('doc', null, [
    bold('DISCHARGE SUMMARY'),
    schema.node('table', null, [row('Name', 'MRS.SUJATHA K', 'AGE', '30 Y'), row('Address', 'NASTAR', 'SEX', 'FEMALE')]),
    bold('DIAGNOSIS'), p(DIAG),
    bold('PRESENTING COMPLAINT'), p('60-year-old female presented with loose stools.'),
    bold('SIGMOIDOSCOPY'),
    bold('COURSE IN HOSPITAL'), p(COURSE),
    bold('ADVICE'), p(ADVICE),
  ]);
}
const texts = (doc) => getBlocks(doc).map((b) => b.node.textContent);
const id = (doc, text) => `B${texts(doc).indexOf(text)}`;
const between = (doc, from, to) => { const t = texts(doc); return t.slice(t.indexOf(from) + 1, to ? t.indexOf(to) : undefined); };

// Applies the checked edits the same way the app does (bottom of the document first)
function apply(doc, edits) {
  let state = EditorState.create({ doc });
  const ordered = [...edits].sort((a, b) => parseInt(b.block_id.slice(1), 10) - parseInt(a.block_id.slice(1), 10));
  for (const e of ordered) {
    const b = getBlocks(state.doc)[parseInt(e.block_id.slice(1), 10)];
    const end = b.pos + b.node.nodeSize;
    let tr = state.tr;
    if (e.operation === 'insert_after') tr = tr.insert(end, p(e.new_value));
    else if (e.operation === 'append') tr = tr.insertText(` ${e.new_value}`, end - 1);
    else if (e.operation === 'set') tr = tr.insertText(e.new_value, b.pos + 1, end - 1);
    state = state.apply(tr);
  }
  return state.doc;
}

const CMD = 'Inside COURSE IN THE HOSPITAL, add that the patient was diagnosed with malaria.';

test('YOUR EXACT CASE: the AI appended ", MALARIA" to Diagnosis -> moved to Course in Hospital', () => {
  const doc = makeDoc();
  const r = checkNamedSection(doc, CMD, [{ block_id: id(doc, DIAG), operation: 'append', new_value: ', MALARIA', field_label: 'Diagnosis' }]);
  assert.equal(r.reject, undefined);
  assert.deepEqual(r.moved, [{ section: 'Course In Hospital' }]);
  const after = apply(doc, r.edits);
  assert.deepEqual(between(after, 'DIAGNOSIS', 'PRESENTING COMPLAINT'), [DIAG]); // Diagnosis unchanged
  assert.deepEqual(between(after, 'COURSE IN HOSPITAL', 'ADVICE'), [COURSE, 'The patient was diagnosed with malaria.']);
  assert.deepEqual(between(after, 'ADVICE'), [ADVICE]); // other sections unchanged
});

test('the AI chose Course in Hospital itself -> left exactly as it is', () => {
  const doc = makeDoc();
  const edit = { block_id: id(doc, COURSE), operation: 'append', new_value: 'The patient was diagnosed with malaria.', field_label: 'Course in Hospital' };
  const r = checkNamedSection(doc, CMD, [edit]);
  assert.deepEqual(r.edits, [edit]);
  assert.deepEqual(r.moved, []);
});

test('the AI tries to REWRITE Diagnosis -> refused, nothing applied', () => {
  const doc = makeDoc();
  const r = checkNamedSection(doc, CMD, [{ block_id: id(doc, DIAG), operation: 'set', new_value: 'ENTERIC FEVER, MALARIA', field_label: 'Diagnosis' }]);
  assert.match(r.reject, /You asked about Course In Hospital, but the change was for Diagnosis/);
  assert.equal(r.edits, undefined);
});

test('ADDRESS BUG GUARD: a plain address change (no section named) passes unchanged', () => {
  const doc = makeDoc();
  const edit = { block_id: id(doc, 'NASTAR'), operation: 'set', new_value: '12 MG Road, Kozhikode', field_label: 'Address' };
  const r = checkNamedSection(doc, 'change the address to 12 MG Road, Kozhikode', [edit]);
  assert.deepEqual(r.edits, [edit]);
});

test('header field changes are allowed together with a named section', () => {
  const doc = makeDoc();
  const r = checkNamedSection(doc, 'in the course in hospital add that she is stable and change age to 31', [
    { block_id: id(doc, '30 Y'), operation: 'set', new_value: '31 Y', field_label: 'Age' },
    { block_id: id(doc, ADVICE), operation: 'insert_after', new_value: 'She is stable.', field_label: 'Advice' },
  ]);
  const after = apply(doc, r.edits);
  assert.equal(texts(after)[texts(after).indexOf('AGE') + 1], '31 Y');
  assert.deepEqual(between(after, 'COURSE IN HOSPITAL', 'ADVICE'), [COURSE, 'She is stable.']); // not the second command
  assert.deepEqual(between(after, 'ADVICE'), [ADVICE]);
});

test('"add ... to the course in the hospital" with a fragment from the AI -> the user\'s own words are used', () => {
  const doc = makeDoc();
  const r = checkNamedSection(doc, 'add patient was diagnosed with dengue fever on 10th October 2026 to the course in the hospital', [
    { block_id: id(doc, DIAG), operation: 'append', new_value: ', DENGUE', field_label: 'Diagnosis' },
  ]);
  const after = apply(doc, r.edits);
  assert.deepEqual(between(after, 'COURSE IN HOSPITAL', 'ADVICE'), [COURSE, 'Patient was diagnosed with dengue fever on 10th October 2026.']);
  assert.deepEqual(between(after, 'DIAGNOSIS', 'PRESENTING COMPLAINT'), [DIAG]);
});

test('empty named section -> the new line goes directly under its heading', () => {
  const doc = makeDoc();
  const r = checkNamedSection(doc, 'in sigmoidoscopy add that it was not done', [
    { block_id: id(doc, DIAG), operation: 'append', new_value: 'Not done.', field_label: 'Diagnosis' },
  ]);
  assert.equal(r.edits[0].block_id, id(doc, 'SIGMOIDOSCOPY'));
  const after = apply(doc, r.edits);
  assert.deepEqual(between(after, 'SIGMOIDOSCOPY', 'COURSE IN HOSPITAL'), ['It was not done.']);
});

test('unclear section name while adding -> asks, nothing applied', () => {
  const doc = schema.node('doc', null, [bold('PHYSICAL EXAMINATION'), p('a'), bold('SYSTEMIC EXAMINATION'), p('b')]);
  const r = checkNamedSection(doc, 'in the examination add pallor present', [{ block_id: 'B1', operation: 'append', new_value: 'Pallor present.' }]);
  assert.match(r.reject, /Which section did you mean: Physical Examination or Systemic Examination\?/);
});

test('a CONTENT word that matches two sections does not trigger a question', () => {
  const doc = schema.node('doc', null, [bold('PAST MEDICAL HISTORY'), p('RA'), bold('FAMILY HISTORY'), p('nil'), bold('COURSE IN HOSPITAL'), p('x')]);
  const edit = { block_id: 'B5', operation: 'append', new_value: 'Patient has history of fever.' };
  const r = checkNamedSection(doc, 'add that the patient has history of fever', [edit]);
  assert.equal(r.reject, undefined);
  assert.deepEqual(r.edits, [edit]);
});

test('no command text (e.g. file upload only) -> edits unchanged', () => {
  const doc = makeDoc();
  const edits = [{ block_id: id(doc, DIAG), operation: 'append', new_value: ', MALARIA' }];
  assert.deepEqual(checkNamedSection(doc, '', edits).edits, edits);
});
