// Tests for src/lib/guards.js
// Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { changesGender, genderChangeAllowed, lockReason } from '../src/lib/guards.js';
import { getBlocks } from '../src/lib/outline.js';

// ---------- gender: removing is fine, adding or swapping is not ----------
const PC = '60-year-old female presented with multiple episodes of loose stools. She was dehydrated.';

test('clearing a section that mentions the gender is NOT a gender change', () => {
  assert.equal(changesGender(PC, ''), false);
});

test('deleting part of the text (with the gender words) is NOT a gender change', () => {
  assert.equal(changesGender(PC, 'Presented with multiple episodes of loose stools.'), false);
});

test('swapping female -> male IS a gender change', () => {
  assert.equal(changesGender(PC, PC.replace('female', 'male')), true);
  assert.equal(changesGender(PC, PC.replace('She', 'He')), true);
});

test('adding gender words IS a gender change', () => {
  assert.equal(changesGender('Patient presented with fever.', '20 year old male presented with fever.'), true);
  assert.equal(changesGender('', 'He was advised rest.'), true);
});

test('changing other words while keeping the gender words is fine', () => {
  assert.equal(changesGender(PC, PC.replace('loose stools', 'vomiting')), false);
  assert.equal(changesGender('MUHAMMAD ZAYAN', 'Fatima Safa'), false);
});

test('your ways of changing the gender are allowed', () => {
  for (const c of ['change female to male', 'the patient is male', 'change the gender to male', 'he is a 20 year old male',
    'change her to him', 'make it a boy']) {
    assert.equal(genderChangeAllowed({ heard: c }), true, c);
  }
});

test('gender may change only when the command talks about it', () => {
  assert.equal(genderChangeAllowed({ heard: 'remove all the content from the presenting complaint' }), false);
  assert.equal(genderChangeAllowed({ instruction: 'change the gender to female' }), true);
});

// ---------- labels stay locked, values (address) stay editable ----------
const schema = getSchema([StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell]);
const p = (t) => schema.node('paragraph', null, t ? [schema.text(t)] : []);
const th = (t) => schema.node('tableHeader', null, [p(t)]);
const row = (...ts) => schema.node('tableRow', null, ts.map(th));
const doc = schema.node('doc', null, [
  schema.node('table', null, [row('Name', 'MRS.SUJATHA K', 'AGE', '30 Y'), row('Address', 'Athipotta - 678544', 'SEX', 'FEMALE')]),
  p('PRESENTING COMPLAINT'), p(PC),
]);
const block = (text) => getBlocks(doc).find((b) => b.node.textContent === text);

test('labels and section headings are still locked', () => {
  assert.ok(lockReason(doc, block('SEX'), 'set', 'FEMALE'));
  assert.ok(lockReason(doc, block('Address'), 'set', 'x'));
  assert.ok(lockReason(doc, block('PRESENTING COMPLAINT'), 'clear', ''));
});

test('the address VALUE and section text can be changed or cleared', () => {
  assert.equal(lockReason(doc, block('Athipotta - 678544'), 'set', '12 MG Road, Kozhikode'), '');
  assert.equal(lockReason(doc, block(PC), 'clear', ''), '');
});
