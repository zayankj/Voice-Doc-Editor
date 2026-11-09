// Tests for the "append" / "insert_after" spacing in src/lib/voiceEdit.js
// Run:  cd client  &&  node --test tests/
// voiceEdit.js imports its neighbours without ".js" (fine for Vite, not for plain Node), so this test makes a
// temporary copy with the endings added, imports it, and deletes the copy afterwards.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState } from '@tiptap/pm/state';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.join(here, '../src/lib');
const tmp = path.join(here, '.build-voiceedit');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables']) {
  const src = fs.readFileSync(path.join(lib, `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit]);
function editor(...paragraphs) {
  const doc = schema.node('doc', null, paragraphs.map((t) => schema.node('paragraph', null, t ? [schema.text(t)] : [])));
  const ed = { state: EditorState.create({ doc }), schema, isDestroyed: false };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
}
const textOf = (ed, i) => ed.state.doc.child(i).textContent;
const done = (ed) => { ed.isDestroyed = true; };

test('YOUR CASE: the AI text starts with a space -> still exactly ONE space', () => {
  const ed = editor('COURSE IN HOSPITAL', 'Patient is currently stable and discharged.');
  applyVoiceEdit(ed, { block_id: 'B1', operation: 'append', new_value: ' Patient was also diagnosed with malaria.' });
  assert.equal(textOf(ed, 1), 'Patient is currently stable and discharged. Patient was also diagnosed with malaria.');
  done(ed);
});

test('normal append keeps one space', () => {
  const ed = editor('Stable.');
  applyVoiceEdit(ed, { block_id: 'B0', operation: 'append', new_value: 'Discharged.' });
  assert.equal(textOf(ed, 0), 'Stable. Discharged.');
  done(ed);
});

test('old text already ends with a space -> no extra space', () => {
  const ed = editor('Stable. ');
  applyVoiceEdit(ed, { block_id: 'B0', operation: 'append', new_value: 'Discharged.' });
  assert.equal(textOf(ed, 0), 'Stable. Discharged.');
  done(ed);
});

test('added text starting with a comma -> no space before it ("DENGUE, MALARIA", not "DENGUE , MALARIA")', () => {
  const ed = editor('ENTERIC FEVER, DENGUE');
  applyVoiceEdit(ed, { block_id: 'B0', operation: 'append', new_value: ', MALARIA' });
  assert.equal(textOf(ed, 0), 'ENTERIC FEVER, DENGUE, MALARIA');
  done(ed);
});

test('appending to an empty line adds no leading space; trailing spaces of the AI text are dropped', () => {
  const ed = editor('');
  applyVoiceEdit(ed, { block_id: 'B0', operation: 'append', new_value: '  Rest for a week.  ' });
  assert.equal(textOf(ed, 0), 'Rest for a week.');
  done(ed);
});

test('a new line (insert_after) has no stray spaces at the start or end', () => {
  const ed = editor('ADVICE', 'Tab. DOLO 650 mg');
  applyVoiceEdit(ed, { block_id: 'B1', operation: 'insert_after', new_value: '  Review after 5 days.  ' });
  assert.equal(textOf(ed, 2), 'Review after 5 days.');
  done(ed);
});

test('set and replace_text are unchanged (intentional spacing kept)', () => {
  const ed = editor('Age: 30 Y', 'Name:  X');
  applyVoiceEdit(ed, { block_id: 'B0', operation: 'replace_text', find_text: '30 Y', new_value: '31 Y' });
  applyVoiceEdit(ed, { block_id: 'B1', operation: 'set', new_value: 'Name:  Y' });
  assert.equal(textOf(ed, 0), 'Age: 31 Y');
  assert.equal(textOf(ed, 1), 'Name:  Y');
  done(ed);
});
