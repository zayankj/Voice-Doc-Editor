// R2 (replaces the Stage 3.2 statement tests): NO statement metadata in the browser. Gemini's edits are plain edits
// (block_id, operation, new_value / find_text, field_label ...); the browser applies them without any statement and
// never reads one. Dummy data, mocked edits.  Run:  cd client  &&  node --test tests/
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState } from '@tiptap/pm/state';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-stage32');
fs.mkdirSync(tmp, { recursive: true });
for (const f of fs.readdirSync(path.join(here, '../src/lib')).filter((x) => x.endsWith('.js'))) {
  fs.writeFileSync(path.join(tmp, f), fs.readFileSync(path.join(here, '../src/lib', f), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'"));
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { getBlocks } = await import(pathToFileURL(path.join(tmp, 'outline.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit]);
const p = (s) => schema.node('paragraph', null, [schema.text(s)]);
const h = (s) => schema.node('paragraph', null, [schema.text(s, [schema.marks.bold.create()])]);
const editorOf = () => {
  const ed = { state: EditorState.create({ doc: schema.node('doc', null, [h('DIAGNOSIS'), p('ENTERIC FEVR'), h('ADVICE'), p('Tab. PAN 40 mg — Once Daily — 5 days'), h('FOLLOW UP'), p('Review after 1 week.')]) }), schema, isDestroyed: false, dryRun: true };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
};
const text = (ed) => getBlocks(ed.state.doc).map((b) => b.node.textContent);
const id = (ed, start) => `B${getBlocks(ed.state.doc).findIndex((b) => b.node.textContent.startsWith(start))}`;

test('R2: plain edits (no statement) are applied - nothing else is required', () => {
  const ed = editorOf();
  for (const e of [
    { block_id: id(ed, 'ENTERIC'), operation: 'replace_text', find_text: 'FEVR', new_value: 'FEVER', field_label: 'Diagnosis' },
    { block_id: id(ed, 'Tab. PAN'), operation: 'replace_text', find_text: '40 mg', new_value: '20 mg', field_label: 'Advice' },
    { block_id: id(ed, 'Review'), operation: 'replace_text', find_text: '1 week', new_value: '2 weeks', field_label: 'Follow Up' },
  ]) assert.equal(applyVoiceEdit(ed, e, {}).ok, true, JSON.stringify(e));
  for (const l of ['ENTERIC FEVER', 'Tab. PAN 20 mg — Once Daily — 5 days', 'Review after 2 weeks.']) assert.ok(text(ed).includes(l), l);
});

test('R2: the browser code never reads statement fields', () => {
  const files = [...fs.readdirSync(path.join(here, '../src/lib')).map((f) => path.join(here, '../src/lib', f)), path.join(here, '../src/App.jsx')];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // (names that only the Stage 3.2 statement feature used; "intent" alone is an unrelated local name elsewhere)
    for (const k of ['source_words', 'cleanStatement', 'withCleanStatement', 'STATEMENT_FIELDS', 'CHANGE_PARTS']) assert.ok(!src.includes(k), `${path.basename(f)}: ${k}`);
  }
});
