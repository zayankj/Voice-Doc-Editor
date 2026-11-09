// Tests for src/lib/sections.js
// Run:  cd client  &&  node --test tests/
// Uses the REAL editor schema (StarterKit + Table, same as App.jsx), so the document structure is the same as in the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { getSections, findSectionsInCommand, isSectionTitle, nameWords, sectionOf } from '../src/lib/sections.js';
import { getBlocks } from '../src/lib/outline.js';

const schema = getSchema([StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell]);
const B = () => [schema.marks.bold.create()];
const p = (t) => schema.node('paragraph', null, t ? [schema.text(t)] : []);
const bold = (t) => schema.node('paragraph', null, [schema.text(t, B())]);
const mixed = (b, rest) => schema.node('paragraph', null, [schema.text(b, B()), schema.text(rest)]); // "PR: 132/MIN"
const th = (t, attrs = null) => schema.node('tableHeader', attrs, [typeof t === 'string' ? p(t) : t]);
const td = (t) => schema.node('tableCell', null, [typeof t === 'string' ? p(t) : t]);
const tr = (...cells) => schema.node('tableRow', null, cells);
const table = (...rows) => schema.node('table', null, rows);
const ul = (...items) => schema.node('bulletList', null, items.map((i) => schema.node('listItem', null, [i])));
const docOf = (...blocks) => schema.node('doc', null, blocks);
const titlesOf = (doc) => getSections(doc).map((s) => s.title);
const indexOf = (doc, text) => getBlocks(doc).findIndex((b) => b.node.textContent === text);

// Shaped like the real discharge summary in the screenshots
const summary = docOf(
  bold('DISCHARGE SUMMARY'),
  bold('CONSULTANT: DR.AISWARYA RAMACHANDRAN MBBS,MD,DNB,CCEBDM,CPCDM,PGDMT,MNAMS'),
  table(
    tr(th('Name'), th('MRS.SUJATHA K'), th('AGE'), th('30 Y')),
    tr(th('Address'), th('NASTAR THENGINGUNDI'), th('SEX'), th('FEMALE')),
    tr(th('Discharge Date'), th('30-10-2026'), th('IP No'), th('IP00019515')),
  ),
  bold('DIAGNOSIS'), p('ENTERIC FEVER (A01.0: Typhoid fever), SEPSIS'),
  bold('PRESENTING COMPLAINT'), p('60-year-old female presented with loose stools.'),
  bold('PHYSICAL EXAMINATION'), ul(mixed('PR: ', '132/MIN'), mixed('BP: ', '70 / 42 MMHG')),
  bold('LAB INVESTIGATIONS'),
  table(tr(th('PARAMETER', { colspan: 2 })), tr(td('CRP'), td('48.9')), tr(td(ul(bold('NIL'))), td('x'))),
  bold('SIGMOIDOSCOPY'),
  bold('COURSE IN HOSPITAL'), p('Initial labs showed leukocytosis.'), bold('DENGUE NS1 POSITIVE.'), p('Patient is stable.'),
  bold('ADVICE'), p('Tab. CIPLOX 200 mg — Oral — Twice Daily (1-0-1) — 2 days'), p('MALARIA'),
  mixed('Signed By: ', 'DR.AISWARYA RAMACHANDRAN'),
);
const S = getSections(summary);
const find = (cmd, sections = S) => findSectionsInCommand(sections, cmd);

// ---------- 1. headings vs normal content ----------
test('finds the real section titles of the summary', () => {
  assert.deepEqual(titlesOf(summary), [
    'DISCHARGE SUMMARY', 'DIAGNOSIS', 'PRESENTING COMPLAINT', 'PHYSICAL EXAMINATION',
    'LAB INVESTIGATIONS', 'SIGMOIDOSCOPY', 'COURSE IN HOSPITAL', 'ADVICE',
  ]);
});

test('bold ALL-CAPS text inside normal content is NOT a heading', () => {
  const blocks = getBlocks(summary);
  const isTitle = (text) => isSectionTitle(summary, blocks[indexOf(summary, text)]);
  assert.equal(isTitle('DENGUE NS1 POSITIVE.'), false); // digits + full stop
  assert.equal(isTitle('MALARIA'), false); // not bold
  assert.equal(isTitle('CONSULTANT: DR.AISWARYA RAMACHANDRAN MBBS,MD,DNB,CCEBDM,CPCDM,PGDMT,MNAMS'), false); // long, ':' inside
  assert.equal(isTitle('PR: 132/MIN'), false); // list item, partly bold
  assert.equal(isTitle('Signed By: DR.AISWARYA RAMACHANDRAN'), false);
});

test('bold short ALL-CAPS words are not headings when they are in a list or have more than 6 words', () => {
  const d = docOf(bold('ADVICE'), ul(bold('REST')), bold('NO HISTORY OF FEVER CHEST PAIN PALPITATION SOB'));
  assert.deepEqual(titlesOf(d), ['ADVICE']);
});

// ---------- 2. table cells, merged cells, lists inside cells ----------
test('table cells never start a section (label cells, merged cells, lists inside cells)', () => {
  const blocks = getBlocks(summary);
  for (const text of ['Discharge Date', 'IP No', 'PARAMETER', 'NIL', 'CRP']) {
    assert.equal(isSectionTitle(summary, blocks[indexOf(summary, text)]), false, text);
  }
});

test('table rows stay in the body of their section', () => {
  const lab = S.find((s) => s.title === 'LAB INVESTIGATIONS');
  for (const text of ['PARAMETER', 'CRP', '48.9', 'NIL', 'x']) assert.ok(lab.body.includes(indexOf(summary, text)), text);
  const top = S.find((s) => s.title === 'DISCHARGE SUMMARY'); // header table belongs to the part under the title
  for (const text of ['Name', 'MRS.SUJATHA K', 'Discharge Date', '30-10-2026']) assert.ok(top.body.includes(indexOf(summary, text)), text);
});

test('body of a section stops at the next heading; empty sections are kept', () => {
  const course = S.find((s) => s.title === 'COURSE IN HOSPITAL');
  assert.deepEqual(course.body.map((i) => getBlocks(summary)[i].node.textContent), [
    'Initial labs showed leukocytosis.', 'DENGUE NS1 POSITIVE.', 'Patient is stable.',
  ]);
  assert.equal(S.find((s) => s.title === 'SIGMOIDOSCOPY').body.length, 0);
  assert.equal(sectionOf(S, indexOf(summary, 'Patient is stable.')).title, 'COURSE IN HOSPITAL');
});

// ---------- 3. loose matching ----------
test('loose names find the right section', () => {
  assert.equal(find('inside the course in the hospital make all the content upper case').best.title, 'COURSE IN HOSPITAL');
  assert.equal(find('add this to the hospital course').best.title, 'COURSE IN HOSPITAL');
  assert.equal(find('inside the presenting complaints make all the contents in lower case').best.title, 'PRESENTING COMPLAINT');
  assert.equal(find('Inside course in the hospital add the patient was diagnosed with malaria').best.title, 'COURSE IN HOSPITAL');
});

test('field names are not sections (the app must change the field, not a section)', () => {
  assert.equal(find('change the patient mobile number to 9876543210').best, null);
  assert.equal(find('and discharge date was 10th of October').best, null);
});

test('content words do not steal the section: "in the course in hospital add ... diagnosed with ..."', () => {
  // "diagnosed" is not "diagnosis"; and DIAGNOSIS is not after "in/inside/to"
  assert.equal(find('in the course in hospital add that the patient was diagnosed with dengue').best.title, 'COURSE IN HOSPITAL');
  const r = find('inside course in hospital add a note about the diagnosis');
  assert.equal(r.best.title, 'COURSE IN HOSPITAL'); // both named; the one after "inside" wins
});

test('similar names: the longer, exact one wins', () => {
  const d = docOf(bold('DIAGNOSIS'), p('a'), bold('FINAL DIAGNOSIS'), p('b'), bold('PROVISIONAL DIAGNOSIS'), p('c'));
  const s = getSections(d);
  assert.equal(find('in the final diagnosis add dengue', s).best.title, 'FINAL DIAGNOSIS');
  assert.equal(find('in the provisional diagnosis add dengue', s).best.title, 'PROVISIONAL DIAGNOSIS');
  assert.equal(find('in the diagnosis add dengue', s).best.title, 'DIAGNOSIS');
});

test('only partly named -> no guess, candidates offered for the question', () => {
  const d = docOf(bold('PHYSICAL EXAMINATION'), p('a'), bold('SYSTEMIC EXAMINATION'), p('b'));
  const r = find('in the examination add pallor', getSections(d));
  assert.equal(r.best, null);
  assert.deepEqual(r.candidates.map((c) => c.title), ['PHYSICAL EXAMINATION', 'SYSTEMIC EXAMINATION']);
});

test('two named sections, neither after "in/inside/to" -> ambiguous, ask', () => {
  const r = find('advice and diagnosis make upper case');
  assert.equal(r.best, null);
  assert.equal(r.ambiguous, true);
  assert.deepEqual(r.candidates.map((c) => c.title).sort(), ['ADVICE', 'DIAGNOSIS']);
});

test('the same section title twice in the document -> ambiguous, ask', () => {
  const d = docOf(bold('ADVICE'), p('a'), bold('COURSE IN HOSPITAL'), p('b'), bold('ADVICE'), p('c'));
  const r = find('add rest to the advice', getSections(d));
  assert.equal(r.best, null);
  assert.equal(r.ambiguous, true);
});

test('name words ignore filler words and plurals', () => {
  assert.deepEqual(nameWords('COURSE IN THE HOSPITAL :'), ['course', 'hospital']);
  assert.deepEqual(nameWords('Presenting Complaints'), ['presenting', 'complaint']);
});
