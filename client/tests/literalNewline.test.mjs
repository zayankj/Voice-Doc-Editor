// Regression: "Put every diagnosis on a separate line" showed "Enteric fever\nheadache\nvomiting" in the document.
// Gemini had escaped the line breaks twice, so new_value held the two characters "\" + "n" instead of a real line
// break. They must become real line breaks. Dummy data, mocked Gemini answers.
// Run:  cd client  &&  node --test tests/
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState } from '@tiptap/pm/state';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-newline');
fs.mkdirSync(tmp, { recursive: true });
for (const f of fs.readdirSync(path.join(here, '../src/lib')).filter((x) => x.endsWith('.js'))) {
  fs.writeFileSync(path.join(tmp, f), fs.readFileSync(path.join(here, '../src/lib', f), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'"));
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { previewEdits } = await import(pathToFileURL(path.join(tmp, 'previewEdits.js')).href);
const { getBlocks } = await import(pathToFileURL(path.join(tmp, 'outline.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit]);
const tp = (s) => schema.node('paragraph', null, [schema.text(s)]);
const h = (s) => schema.node('paragraph', null, [schema.text(s, [schema.marks.bold.create()])]);
const editorOf = () => {
  const doc = schema.node('doc', null, [h('DIAGNOSIS'), tp('Enteric fever, headache, vomiting'),
    h('PRESENTING COMPLAINT'), tp('The patient presented with fever for 3 days.')]);
  const ed = { state: EditorState.create({ doc }), schema, isDestroyed: false, dryRun: true };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
};
const diagnosis = (ed) => getBlocks(ed.state.doc)[1].node;
const linesOf = (node) => node.textBetween(0, node.content.size, '\n', '\n').split('\n');
const breaks = (node) => { let n = 0; node.forEach((c) => { if (c.type.name === 'hardBreak') n += 1; }); return n; };
const LITERAL = 'Enteric fever\\nheadache\\nvomiting'; // exactly what Gemini sent: backslash + n, not a line break

test('set with a literal "\\n" makes real line breaks, one diagnosis per line', () => {
  const ed = editorOf();
  const r = applyVoiceEdit(ed, { block_id: 'B1', operation: 'set', new_value: LITERAL });
  assert.equal(r.ok, true);
  const node = diagnosis(ed);
  assert.deepEqual(linesOf(node), ['Enteric fever', 'headache', 'vomiting']);
  assert.equal(breaks(node), 2);
  assert.ok(!node.textContent.includes('\\'), 'no visible backslash in the document');
});

test('replace_text with a literal "\\n" (and "\\r\\n") also makes real line breaks', () => {
  const ed = editorOf();
  const r = applyVoiceEdit(ed, { block_id: 'B1', operation: 'replace_text', find_text: 'Enteric fever, headache, vomiting', new_value: 'Enteric fever\\r\\nheadache\\nvomiting' });
  assert.equal(r.ok, true);
  assert.deepEqual(linesOf(diagnosis(ed)), ['Enteric fever', 'headache', 'vomiting']);
  assert.ok(!diagnosis(ed).textContent.includes('\\'));
});

test('a real line break still works as before, and other sections are not touched', () => {
  const ed = editorOf();
  const r = applyVoiceEdit(ed, { block_id: 'B1', operation: 'set', new_value: 'Enteric fever\nheadache\nvomiting' });
  assert.equal(r.ok, true);
  assert.deepEqual(linesOf(diagnosis(ed)), ['Enteric fever', 'headache', 'vomiting']);
  assert.equal(getBlocks(ed.state.doc)[3].node.textContent, 'The patient presented with fever for 3 days.');
  assert.equal(getBlocks(ed.state.doc)[0].node.textContent, 'DIAGNOSIS');
});

test('the dry-run check (used for a batch of edits) accepts the literal "\\n" edit too', () => {
  const ed = editorOf();
  const dry = previewEdits(ed.state.doc, [{ block_id: 'B1', operation: 'set', new_value: LITERAL }], { fromFile: false });
  assert.equal(dry.blocked.length, 0);
});

test('text without "\\n" is applied unchanged', () => {
  const ed = editorOf();
  applyVoiceEdit(ed, { block_id: 'B1', operation: 'set', new_value: 'Enteric fever' });
  assert.equal(diagnosis(ed).textContent, 'Enteric fever');
  assert.equal(breaks(diagnosis(ed)), 0);
});
