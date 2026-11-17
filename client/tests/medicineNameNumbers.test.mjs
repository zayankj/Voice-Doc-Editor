// Numbers that are part of a medicine NAME ("Vitamin B12", "D3", "CoQ10") are not invented quantities (src/lib/verify.js).
// Reported: "Add capsule Vitamin B12 500 mcg after food for 10 days." -> "contains 12, which was not in your command".
// The digits of a letters-then-digits name word count as said ONLY when the person said that same word; every other
// number (strength, dose, duration, quantity) is checked exactly as before. Both checks (as App.jsx runs them).
// Dummy data only.  Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { checkMedicineEdits, checkTableEdits, withDuplicateChoice } from '../src/lib/verify.js';

const schema = getSchema([StarterKit]);
const p = (s, bold) => schema.node('paragraph', null, [schema.text(s, bold ? [schema.marks.bold.create()] : undefined)]);
const doc = schema.node('doc', null, [
  p('DIAGNOSIS', true), p('ANAEMIA'), p('ADVICE', true), // B0 B1 B2
  p('TAB. PAN 40 MG — ONCE DAILY'), // B3
  p('Drink plenty of water.'), p('FOLLOW UP', true), p('Review in OPD after 1 week.'),
]);
const add = (line) => [{ block_id: 'B3', operation: 'insert_after', new_value: line, field_label: 'Advice' }];
const both = (said, line) => {
  const med = checkMedicineEdits(doc, { said, edits: add(line) });
  assert.equal(med.reject, undefined, `${said}: ${med.reject}`);
  const table = checkTableEdits(doc, said, withDuplicateChoice(med.edits, med.newEntries));
  assert.deepEqual(table.blocked, [], `${said}: second check blocked ${table.blocked}`);
  return table.edits.map((e) => e.new_value);
};
const no = (said, line, re) => {
  const med = checkMedicineEdits(doc, { said, edits: add(line) });
  assert.ok(med.reject, `${said} / ${line}: should be refused`);
  assert.match(med.reject, re, med.reject);
  assert.match(med.reject, /Nothing was changed/);
  // the second check refuses it on its own too (it never relies on the first one)
  const table = checkTableEdits(doc, said, add(line));
  assert.equal(table.edits.length, 0, `${line}: second check let it through`);
};

const B12 = 'Add capsule Vitamin B12 500 mcg after food for 10 days.';

test('1 + 6. REPORTED: Vitamin B12 500 mcg, correct name, strength and duration -> accepted unchanged', () => {
  assert.deepEqual(both(B12, 'CAP. VITAMIN B12 500 MCG — AFTER FOOD — 10 DAYS'), ['CAP. VITAMIN B12 500 MCG — AFTER FOOD — 10 DAYS']);
  assert.deepEqual(both('add capsule vitamin b-12 500 mcg after food for 10 days', 'Cap. VITAMIN B12 500 mcg — After Food — 10 days'), ['Cap. VITAMIN B12 500 mcg — After Food — 10 days']);
  // spoken as separate words / number words: accepted as before
  assert.deepEqual(both('add capsule vitamin b twelve 500 mcg after food for 10 days', 'Cap. VITAMIN B12 500 mcg — After Food — 10 days'), ['Cap. VITAMIN B12 500 mcg — After Food — 10 days']);
});

test('2-5. Vitamin B6 100 mg, Vitamin D3 1000 IU, CoQ10 100 mg, B-Complex B12', () => {
  assert.deepEqual(both('Add tablet Vitamin B6 100 mg once daily.', 'TAB. VITAMIN B6 100 MG — ONCE DAILY'), ['TAB. VITAMIN B6 100 MG — ONCE DAILY']);
  assert.deepEqual(both('Add tablet Vitamin D3 1000 IU once daily for 30 days.', 'Tab. VITAMIN D3 1000 IU — Once Daily — 30 days'), ['Tab. VITAMIN D3 1000 IU — Once Daily — 30 days']);
  assert.deepEqual(both('Add capsule CoQ10 100 mg once daily.', 'Cap. COQ10 100 mg — Once Daily'), ['Cap. COQ10 100 mg — Once Daily']);
  assert.deepEqual(both('Add tablet B-Complex B12 for 10 days.', 'Tab. B-COMPLEX B12 — 10 days'), ['Tab. B-COMPLEX B12 — 10 days']);
});

test('7. incorrect strength: refused', () => {
  no(B12, 'CAP. VITAMIN B12 1000 MCG — AFTER FOOD — 10 DAYS', /contains 1000, which was not in your command/);
  no('Add tablet Vitamin D3 1000 IU once daily.', 'Tab. VITAMIN D3 60000 IU — Once Daily', /contains 60000/);
  no('Add capsule CoQ10 100 mg once daily.', 'Cap. COQ10 200 mg — Once Daily', /contains 200/);
});

test('8. incorrect duration: refused', () => {
  no(B12, 'CAP. VITAMIN B12 500 MCG — AFTER FOOD — 15 DAYS', /contains 15, which was not in your command/);
});

test('9. an invented quantity or dose: refused', () => {
  no(B12, 'CAP. VITAMIN B12 500 MCG — 2 CAPSULES — AFTER FOOD — 10 DAYS', /contains 2, which was not in your command/);
  no('Add capsule Vitamin B12 after food.', 'CAP. VITAMIN B12 500 MCG — AFTER FOOD', /contains 500/);
});

test('a name number that was NOT said is still checked as a number (never trusted from the AI)', () => {
  // "vitamin B" said, the AI wrote B12: 12 was not said
  no('Add capsule vitamin B 500 mcg after food for 10 days.', 'CAP. VITAMIN B12 500 MCG — AFTER FOOD — 10 DAYS', /contains 12/);
  // B12 said, the AI wrote B6: 6 was not said
  no(B12, 'CAP. VITAMIN B6 500 MCG — AFTER FOOD — 10 DAYS', /contains 6/);
  // D3 said, the AI wrote D3 and a made-up "X5" code: 5 was not said
  no('Add tablet Vitamin D3 1000 IU once daily.', 'Tab. VITAMIN D3 X5 1000 IU — Once Daily', /contains 5/);
  // a strength glued to the name is never hidden by a said name word: "B12" said, "B12500" is checked
  no(B12, 'CAP. VITAMIN B12500 MCG — AFTER FOOD — 10 DAYS', /contains 12500/);
});
