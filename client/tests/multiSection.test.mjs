// Commands that name SEVERAL sections (src/lib/verify.js checkNamedSection -> checkSeveralSections).
// "In diagnosis add X and in presenting complaints add Y" used to be refused ("Which section did you mean?") even
// when the AI's edits were right. Now: every edit must be in a section the person named, and its words must come from
// the part of the command that names THAT section; anything unclear or unnamed is still asked / refused.
// The medicine check runs afterwards exactly as before. Dummy data only.
// Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { checkNamedSection, checkMedicineEdits } from '../src/lib/verify.js';
import { getBlocks } from '../src/lib/outline.js';

const schema = getSchema([StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell]);
const p = (t) => schema.node('paragraph', null, t ? [schema.text(t)] : []);
const bold = (t) => schema.node('paragraph', null, [schema.text(t, [schema.marks.bold.create()])]);
const cell = (t) => schema.node('tableCell', null, [p(t)]);
const row = (...ts) => schema.node('tableRow', null, ts.map(cell));

const MED = 'Tab. CIPLOX (Ciprofloxacin) 500 mg — Oral — Twice Daily (1-0-1) — 5 days';
function makeDoc(extra = []) {
  return schema.node('doc', null, [
    bold('DISCHARGE SUMMARY'),
    schema.node('table', null, [row('Name', 'DUMMY PATIENT', 'Age', '40 Years'), row('Gender', 'Male', 'IP No', 'IP000123')]),
    bold('DIAGNOSIS'), p('ENTERIC FEVER'),
    bold('PRESENTING COMPLAINTS'), p('A 40-year-old male presented with fever for 5 days. Headache and body pain.'),
    bold('PAST HISTORY'), p('Known case of type 2 diabetes mellitus for 6 years.'),
    bold('PHYSICAL EXAMINATION'), p('Pulse 96/min, BP 120/80 mmHg.'),
    bold('SYSTEMIC EXAMINATION'), p('CVS: S1 S2 heard.'),
    bold('COURSE IN HOSPITAL'), p('Patient was admitted with high grade fever. Fever subsided on day 3.'),
    bold('ADVICE'), p(MED), p('Drink plenty of water.'),
    bold('FOLLOW UP'), p('Review in OPD after 1 week.'),
    ...extra,
  ]);
}
const texts = (doc) => getBlocks(doc).map((b) => b.node.textContent);
const id = (doc, text) => { const i = texts(doc).indexOf(text); assert.notEqual(i, -1, text); return `B${i}`; };
const add = (block_id, new_value, operation = 'append') => ({ block_id, operation, new_value, field_label: 'x' });
const rep = (block_id, find_text, new_value) => ({ block_id, operation: 'replace_text', find_text, new_value, field_label: 'x' });

// ---------- now allowed: each section named, each edit in its own section ----------
test('two sections named, one addition each -> both edits pass unchanged (nothing moved)', () => {
  const doc = makeDoc();
  const cases = [
    ['In diagnosis add ACUTE GASTRITIS and in presenting complaints add: Vomiting for 2 days.',
      [add(id(doc, 'ENTERIC FEVER'), ', ACUTE GASTRITIS'), add(id(doc, texts(doc)[6]), ' Vomiting for 2 days.')]],
    ['Add fever to diagnosis and add vomiting to presenting complaints.',
      [add(id(doc, 'ENTERIC FEVER'), ', FEVER'), add(id(doc, texts(doc)[6]), ' Vomiting.')]],
    ['In diagnosis add ACUTE GASTRITIS and in advice add: Take rest for one week.',
      [add(id(doc, 'ENTERIC FEVER'), ', ACUTE GASTRITIS'), add(id(doc, 'Drink plenty of water.'), 'Take rest for one week.', 'insert_after')]],
  ];
  for (const [cmd, edits] of cases) {
    const r = checkNamedSection(doc, cmd, edits);
    assert.equal(r.reject, undefined, `${cmd}: ${r.reject}`);
    assert.deepEqual(r.edits, edits, cmd);
    assert.deepEqual(r.moved, []);
  }
});

test('an addition in one section and a change in another (sentence break) -> both pass', () => {
  const doc = makeDoc();
  const edits = [add(id(doc, 'Drink plenty of water.'), 'Take rest for one week.', 'insert_after'), rep(id(doc, 'Review in OPD after 1 week.'), '1 week', '10 days')];
  const r = checkNamedSection(doc, 'In advice add: Take rest for one week. In follow up change 1 week to 10 days.', edits);
  assert.equal(r.reject, undefined, r.reject);
  assert.deepEqual(r.edits, edits);
});

test('three sections named -> all three edits pass', () => {
  const doc = makeDoc();
  const edits = [add(id(doc, 'ENTERIC FEVER'), ', ACUTE GASTRITIS'), rep(id(doc, 'Known case of type 2 diabetes mellitus for 6 years.'), '6 years', '8 years'),
    rep(id(doc, 'Review in OPD after 1 week.'), '1 week', '10 days')];
  const r = checkNamedSection(doc, 'In diagnosis add acute gastritis, in past history change 6 years to 8 years and in follow up change 1 week to 10 days', edits);
  assert.equal(r.reject, undefined, r.reject);
  assert.deepEqual(r.edits, edits);
});

test('a look-only edit (lowercase) in a named section passes; a Patient Details cell changed as asked passes', () => {
  const doc = makeDoc();
  const edits = [{ block_id: id(doc, 'ENTERIC FEVER'), operation: 'change_case', case: 'lower', field_label: 'Diagnosis' },
    add(id(doc, 'Review in OPD after 1 week.'), 'Repeat CBC after 1 week.', 'insert_after'), { block_id: id(doc, '40 Years'), operation: 'set', new_value: '45 Years', field_label: 'Age' }];
  const r = checkNamedSection(doc, 'In diagnosis make it lowercase and in follow up add: Repeat CBC after 1 week and change the age to 45', edits);
  assert.equal(r.reject, undefined, r.reject);
  assert.deepEqual(r.edits, edits);
});

// ---------- still refused / asked ----------
test('UNNAMED section: a change in a section the person did not name -> refused, nothing applied', () => {
  const doc = makeDoc();
  // the AI also changed Course in Hospital, which was never named
  const r = checkNamedSection(doc, 'In diagnosis add ACUTE GASTRITIS and in follow up change 1 week to 10 days.', [
    add(id(doc, 'ENTERIC FEVER'), ', ACUTE GASTRITIS'), rep(id(doc, 'Review in OPD after 1 week.'), '1 week', '10 days'),
    rep(id(doc, 'Patient was admitted with high grade fever. Fever subsided on day 3.'), 'day 3', 'day 2')]);
  assert.match(r.reject, /You named Diagnosis and Follow Up, but a change was for Course In Hospital\. Nothing was changed/);
  assert.equal(r.edits, undefined);
});

test('UNNAMED section: an ADDITION put in an unnamed section is refused, never moved', () => {
  const doc = makeDoc();
  const r = checkNamedSection(doc, 'In diagnosis add ACUTE GASTRITIS and in advice add: Take rest for one week.', [
    add(id(doc, 'ENTERIC FEVER'), ', ACUTE GASTRITIS'), add(id(doc, 'Review in OPD after 1 week.'), 'Take rest for one week.', 'insert_after')]);
  assert.match(r.reject, /You named Diagnosis and Advice, but a change was for Follow Up/);
});

test('WRONG named section: the two additions swapped by the AI -> asked which section, nothing applied', () => {
  const doc = makeDoc();
  const r = checkNamedSection(doc, 'In diagnosis add ACUTE GASTRITIS and in presenting complaints add: Vomiting for 2 days.', [
    add(id(doc, 'ENTERIC FEVER'), ', Vomiting for 2 days'), add(id(doc, texts(doc)[6]), ' ACUTE GASTRITIS.')]);
  assert.match(r.reject, /^Which section should this change go to: (Diagnosis|Presenting Complaints) or (Diagnosis|Presenting Complaints)\? Nothing was changed\.$/);
});

test('an addition whose words were not said for that section -> asked again', () => {
  const doc = makeDoc();
  const r = checkNamedSection(doc, 'In diagnosis add ACUTE GASTRITIS and in advice add: Take rest for one week.', [
    add(id(doc, 'ENTERIC FEVER'), ', ACUTE GASTRITIS'), add(id(doc, 'Drink plenty of water.'), 'Avoid spicy food.', 'insert_after')]);
  assert.match(r.reject, /A change for Advice does not match what you asked for Advice\. Nothing was changed/);
});

test('AMBIGUOUS: a second part names only part of a title ("in the examination") -> asks which section', () => {
  const doc = makeDoc();
  const r = checkNamedSection(doc, 'In diagnosis add ACUTE GASTRITIS and in the examination add pallor present.', [
    add(id(doc, 'ENTERIC FEVER'), ', ACUTE GASTRITIS'), add(id(doc, 'Pulse 96/min, BP 120/80 mmHg.'), ' Pallor present.')]);
  assert.match(r.reject, /^Which section did you mean: Physical Examination or Systemic Examination\? Nothing was changed\.$/);
});

test('AMBIGUOUS (unchanged): one unclear section name while adding still asks, as before', () => {
  const doc = makeDoc();
  const r = checkNamedSection(doc, 'in the examination add pallor present', [add(id(doc, 'CVS: S1 S2 heard.'), ' Pallor present.')]);
  assert.match(r.reject, /Which section did you mean: Physical Examination or Systemic Examination\?/);
});

test('AMBIGUOUS: the same section title twice in the document -> not treated as several sections (asks as before)', () => {
  const doc = makeDoc([bold('ADVICE'), p('Second advice block.')]);
  const r = checkNamedSection(doc, 'In diagnosis add ACUTE GASTRITIS and in advice add: Take rest for one week.', [
    add(id(doc, 'ENTERIC FEVER'), ', ACUTE GASTRITIS'), add(id(doc, 'Drink plenty of water.'), 'Take rest for one week.', 'insert_after')]);
  assert.ok(r.reject, 'refused / asked');
});

test('two sections inside ONE part ("in advice add: review in the follow up clinic") -> the existing check decides (asks)', () => {
  const doc = makeDoc();
  const r = checkNamedSection(doc, 'In advice add: review in the follow up clinic', [add(id(doc, 'Drink plenty of water.'), 'Review in the follow up clinic.', 'insert_after')]);
  assert.match(r.reject, /Which section did you mean/);
});

// ---------- single named section: exactly as before ----------
test('ONE named section: text the AI put elsewhere is still MOVED into it (existing behaviour)', () => {
  const doc = makeDoc();
  const r = checkNamedSection(doc, 'Inside COURSE IN HOSPITAL, add that the patient was diagnosed with malaria.', [add(id(doc, 'ENTERIC FEVER'), ', MALARIA')]);
  assert.equal(r.edits[0].block_id, id(doc, 'Patient was admitted with high grade fever. Fever subsided on day 3.'));
  assert.equal(r.edits[0].operation, 'insert_after');
  assert.equal(r.moved.length, 1);
});

test('ONE named section + a section title used as an ordinary word -> still the single-section check', () => {
  const doc = makeDoc();
  const edits = [add(id(doc, 'Patient was admitted with high grade fever. Fever subsided on day 3.'), ' He improved. Diagnosis was confirmed.')];
  const r = checkNamedSection(doc, 'In course in hospital add that he improved. Diagnosis was confirmed.', edits);
  assert.equal(r.reject, undefined, r.reject);
  assert.deepEqual(r.edits, edits);
});

test('moving text "from <section> to <section>" keeps the existing rule (removal allowed in the source)', () => {
  const doc = makeDoc();
  const edits = [rep(id(doc, 'Drink plenty of water.'), 'Drink plenty of water.', ''), add(id(doc, 'Review in OPD after 1 week.'), 'Drink plenty of water.', 'insert_after')];
  const r = checkNamedSection(doc, 'Move drink plenty of water from advice to follow up', edits);
  assert.equal(r.reject, undefined, r.reject);
  assert.equal(r.edits.length, 2);
});

test('no section named -> edits unchanged (as before)', () => {
  const doc = makeDoc();
  const edits = [rep(id(doc, 'Pulse 96/min, BP 120/80 mmHg.'), '96', '88')];
  assert.deepEqual(checkNamedSection(doc, 'Change the pulse to 88 and the BP to 130/80.', edits).edits, edits);
});

// ---------- medicine safety still runs on the result ----------
test('MEDICINES: after a two-section command, the medicine check gives exactly the same result as for the raw edits', () => {
  const doc = makeDoc();
  const said = 'In advice add tablet azithral 500 mg once daily for 3 days and in follow up change 1 week to 10 days';
  const good = [add(id(doc, 'Drink plenty of water.'), 'Tab. AZITHRAL 500 mg — Once Daily — 3 days', 'insert_after'), rep(id(doc, 'Review in OPD after 1 week.'), '1 week', '10 days')];
  const r = checkNamedSection(doc, said, good);
  assert.equal(r.reject, undefined, r.reject);
  assert.deepEqual(checkMedicineEdits(doc, { said, edits: r.edits }), checkMedicineEdits(doc, { said, edits: good }));
  // a medicine line with details nobody said: the medicine check still removes / refuses them, as for one section
  const extra = [add(id(doc, 'Drink plenty of water.'), 'Tab. AZITHRAL 500 mg — Oral — Twice Daily — 3 days — after food', 'insert_after'), good[1]];
  const r2 = checkNamedSection(doc, said, extra);
  assert.equal(r2.reject, undefined, r2.reject);
  const med = checkMedicineEdits(doc, { said, edits: r2.edits });
  assert.deepEqual(med, checkMedicineEdits(doc, { said, edits: extra }));
  assert.ok(med.reject || !/Twice Daily|after food/i.test(med.edits[0].new_value), 'unsaid medicine details never pass');
});
