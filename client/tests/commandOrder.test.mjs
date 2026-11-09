// Tests for the order in which App.jsx (runCodeCommand) recognises commands:
//   1. clear a section  2. remove generic names (B)  3. remove listed phrases (A)  4. otherwise the AI (+ check C)
// Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { findClearSectionCommand } from '../src/lib/sectionCommands.js';
import { detectMedicineCommand } from '../src/lib/medicineText.js';

const schema = getSchema([StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell]);
const p = (t) => schema.node('paragraph', null, [schema.text(t)]);
const bold = (t) => schema.node('paragraph', null, [schema.text(t, [schema.marks.bold.create()])]);
const th = (t) => schema.node('tableHeader', null, [p(t)]);
const doc = schema.node('doc', null, [
  bold('DISCHARGE SUMMARY'),
  schema.node('table', null, [schema.node('tableRow', null, ['Name', 'MRS.SUJATHA K', 'Address', 'NASTAR'].map(th))]),
  bold('DIAGNOSIS'), p('ENTERIC FEVER'),
  bold('PRESENTING COMPLAINT'), p('60-year-old female presented with loose stools.'),
  bold('COURSE IN HOSPITAL'), p('Patient is stable. Oral intake improved.'),
  bold('ADVICE'),
  p('Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — Twice Daily (1-0-1) — 2 days'),
  p('Tab. DOLO (Paracetamol) 650 mg — Oral — As Needed (SOS)'),
]);

// The same order as runCodeCommand() in App.jsx
function route(command) {
  const clear = findClearSectionCommand(doc, command);
  if (clear?.ambiguous || clear?.section) return 'clear';
  const med = detectMedicineCommand(doc, command);
  if (!med) return 'ai';
  if (med.ask) return 'ask';
  return med.kind; // 'generic' | 'phrases'
}

test('clear section is checked first', () => {
  assert.equal(route('remove everything from the course in hospital'), 'clear');
  assert.equal(route('remove all the content from the presenting complaint and make it blank'), 'clear');
  assert.equal(route('remove everything from advice'), 'clear'); // not mistaken for a phrase list
});

test('B (generic names) comes before A (phrases)', () => {
  assert.equal(route('Remove all generic medicine names from Advice'), 'generic');
  assert.equal(route('Remove the generic names of all tablets.'), 'generic');
  assert.equal(route('Remove the generic names from tablets and syrups.'), 'generic'); // has "and", still B
});

test('A (phrases)', () => {
  assert.equal(route('Inside the Advice section, remove phrases such as Oral, Twice Daily, Once Daily, Three Times Daily.'), 'phrases');
  assert.equal(route('Remove Oral, Twice Daily, Thrice daily, Three times daily and Once Daily from Advice.'), 'phrases');
});

test('everything else goes to the AI as before (with check C on its answer)', () => {
  for (const c of [
    'Inside COURSE IN THE HOSPITAL, add that the patient was diagnosed with malaria.',
    'change the address to 12 MG Road, Kozhikode',
    'and discharge date was 10th of October',
    'remove the line about malaria from course in hospital',
    'the patient is male',
    'Update the medicines from the attached note',
  ]) {
    assert.equal(route(c), 'ai', c);
  }
});

test('unclear phrase commands ask instead of guessing', () => {
  assert.equal(route('remove the words Oral, Twice Daily'), 'ask'); // which section?
  assert.equal(route('remove the words Intravenous, Weekly from advice'), 'ask'); // not found
});
