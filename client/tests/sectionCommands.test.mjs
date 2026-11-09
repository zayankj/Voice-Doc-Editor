// Tests for src/lib/sectionCommands.js ("remove everything from <section>")
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
import { findClearSectionCommand, clearSection } from '../src/lib/sectionCommands.js';
import { getBlocks } from '../src/lib/outline.js';

const schema = getSchema([StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell]);
const p = (t) => schema.node('paragraph', null, t ? [schema.text(t)] : []);
const bold = (t) => schema.node('paragraph', null, [schema.text(t, [schema.marks.bold.create()])]);
const th = (t) => schema.node('tableHeader', null, [p(t)]);
const row = (...ts) => schema.node('tableRow', null, ts.map(th));

// a small editor: the same document model and the same way of applying changes as the app
function makeEditor() {
  const doc = schema.node('doc', null, [
    bold('DISCHARGE SUMMARY'),
    schema.node('table', null, [row('Name', 'MRS.SUJATHA K', 'AGE', '30 Y'), row('Address', 'NASTAR', 'SEX', 'FEMALE')]),
    bold('DIAGNOSIS'), p('ENTERIC FEVER, SEPSIS'),
    bold('PRESENTING COMPLAINT'), p('60-year-old female presented with loose stools.'),
    bold('LAB INVESTIGATIONS'), schema.node('table', null, [row('CRP', '48.9'), row('INR', '1.20')]),
    bold('COURSE IN HOSPITAL'), p('Initial labs showed leukocytosis.'), p('She was given antibiotics.'), p('Patient is stable.'),
    bold('ADVICE'), p('Tab. DOLO 650 mg'),
  ]);
  const ed = { state: EditorState.create({ doc }), isDestroyed: false };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
}
const texts = (ed) => getBlocks(ed.state.doc).map((b) => b.node.textContent);
const under = (ed, heading, next) => { const t = texts(ed); return t.slice(t.indexOf(heading) + 1, next ? t.indexOf(next) : undefined); };
function say(command) {
  const ed = makeEditor();
  const cmd = findClearSectionCommand(ed.state.doc, command);
  const result = cmd?.section ? clearSection(ed, cmd.section) : null;
  ed.isDestroyed = true; // stops the 5-second highlight timer from touching the test editor
  return { ed, cmd, result };
}

test('your command: "remove everything from the course in hospital"', () => {
  const { ed, result } = say('remove everything from the course in hospital');
  assert.equal(result.ok, true);
  assert.deepEqual(under(ed, 'COURSE IN HOSPITAL', 'ADVICE'), ['']); // all 3 lines gone, one empty line left
  assert.ok(texts(ed).includes('COURSE IN HOSPITAL')); // heading stays
  assert.deepEqual(under(ed, 'ADVICE'), ['Tab. DOLO 650 mg']); // next section untouched
  assert.deepEqual(under(ed, 'DIAGNOSIS', 'PRESENTING COMPLAINT'), ['ENTERIC FEVER, SEPSIS']);
});

test('your command: "Now remove all the content from the presenting complaint and make it blank."', () => {
  const { ed, result } = say('Now remove all the content from the presenting complaint and make it blank.');
  assert.equal(result.ok, true);
  assert.deepEqual(under(ed, 'PRESENTING COMPLAINT', 'LAB INVESTIGATIONS'), ['']);
  assert.ok(texts(ed).includes('FEMALE')); // header table untouched (no gender problem any more)
});

test('other ways of saying it', () => {
  for (const c of ['clear the course in hospital', 'make the course in the hospital blank', 'delete the whole section course in hospital',
    'erase course in hospital', 'remove all the text in the hospital course']) {
    assert.ok(say(c).cmd?.section, c);
  }
});

test('a section with a table is emptied completely (table removed too)', () => {
  const { ed, result } = say('remove everything from lab investigations');
  assert.equal(result.ok, true);
  assert.deepEqual(under(ed, 'LAB INVESTIGATIONS', 'COURSE IN HOSPITAL'), ['']);
});

test('removing only PART of a section is NOT a clear (left to the AI)', () => {
  assert.equal(say('remove the line about malaria from course in hospital').cmd, null);
  assert.equal(say('delete the word stable in course in hospital').cmd, null);
  assert.equal(say('remove all mentions of malaria from course in hospital').cmd, null);
});

test('a clear plus another job is left to the AI', () => {
  assert.equal(say('remove everything from course in hospital and write patient recovered').cmd, null);
});

test('no section named -> not a clear command (normal AI editing)', () => {
  assert.equal(say('remove everything').cmd, null);
  assert.equal(say('change the address to 12 MG Road, Kozhikode').cmd, null);
});

test('the document title part is never wiped', () => {
  const { result } = say('remove everything from the discharge summary');
  assert.equal(result.ok, false);
});

test('unclear section -> asks, changes nothing', () => {
  const ed = makeEditor();
  const two = schema.node('doc', null, [bold('PHYSICAL EXAMINATION'), p('a'), bold('SYSTEMIC EXAMINATION'), p('b')]);
  const cmd = findClearSectionCommand(two, 'clear the examination');
  assert.equal(cmd.ambiguous, true);
  assert.equal(texts(ed).length, getBlocks(makeEditor().state.doc).length);
});
