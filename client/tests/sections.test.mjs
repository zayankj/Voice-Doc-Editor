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
import { isSectionTitle } from '../src/lib/sections.js';
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
// R6: section titles = the blocks isSectionTitle accepts (getSections / command matching were removed with the code-run commands)
const titlesOf = (doc) => getBlocks(doc).filter((b) => isSectionTitle(doc, b)).map((b) => b.node.textContent.trim().replace(/:$/, ''));
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
