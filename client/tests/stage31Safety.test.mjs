// STAGE 3.1 safety fixes (dummy data only). Run:  cd client  &&  node --test tests/
//  1. Amounts written as WORDS or FRACTIONS in a medicine line ("two tablets", "for one week", "½ tab", "half a
//     tablet") are numbers: refused by BOTH medicine number checks when not said, accepted when said.
//     (Before: they passed both checks, because only digits were read.)
//  2. voiceEdit.js uses the section-start rule of sections.js. A not-bold capitals line inside Advice ("AVOID OILY
//     FOOD") no longer switches the medicine guards off; a not-bold medicine heading ("ADVICE") still switches them on.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState } from '@tiptap/pm/state';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-stage31');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'medicineText', 'sections']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { getBlocks } = await import(pathToFileURL(path.join(tmp, 'outline.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit]);
const t = (s) => schema.text(s);
const p = (...k) => schema.node('paragraph', null, k);
const h = (s) => p(schema.text(s, [schema.marks.bold.create()]));
const br = () => schema.nodes.hardBreak.create();
const editorOf = (kids) => {
  const ed = { state: EditorState.create({ doc: schema.node('doc', null, kids) }), schema, isDestroyed: false, dryRun: true };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
};
const lines = (ed) => getBlocks(ed.state.doc).map((b) => b.node.textBetween(0, b.node.content.size, '↵', '↵'));
const idOf = (ed, start) => `B${getBlocks(ed.state.doc).findIndex((b) => b.node.textContent.startsWith(start))}`;

// ---------------- 1. amounts in words / fractions ----------------
const adviceDoc = schema.node('doc', null, [h('ADVICE'), p(t('Tab. PAN 40 mg — Once Daily — 5 days')), p(t('Drink plenty of water.')), h('FOLLOW UP'), p(t('Review after 1 week.'))]);
const addEdits = (line) => [{ block_id: 'B2', operation: 'insert_after', new_value: line, field_label: 'Advice' }];


// ---------------- 2. voiceEdit section rule ----------------
const capsInside = () => editorOf([h('ADVICE'), p(t('Tab. ALPHA 10 mg — Once Daily')), p(t('AVOID OILY FOOD')),
  p(t('Tab. BETA 20 mg — Twice Daily'), br(), t('Tab. GAMMA 5 mg — At Night')), h('FOLLOW UP'), p(t('Review after 1 week.'))]);
test('3.1b. a new medicine appended there goes on its OWN line (before: glued onto "At Night")', () => {
  const ed = capsInside();
  const r = applyVoiceEdit(ed, { block_id: idOf(ed, 'Tab. BETA'), operation: 'append', new_value: 'Tab. DELTA 1 mg', field_label: 'Advice' }, {});
  assert.equal(r.ok, true, r.error);
  assert.ok(lines(ed).includes('Tab. BETA 20 mg — Twice Daily↵Tab. GAMMA 5 mg — At Night↵Tab. DELTA 1 mg'), lines(ed).join(' | '));
});
test('3.1b. KEPT: a bold heading after Advice still ends the medicine section (Follow Up text is ordinary text)', () => {
  const ed = editorOf([h('ADVICE'), p(t('Tab. ALPHA 10 mg — Once Daily')), h('FOLLOW UP'), p(t('Review in OPD.'), br(), t('Bring reports.'))]);
  const r = applyVoiceEdit(ed, { block_id: idOf(ed, 'Review in OPD'), operation: 'clear', field_label: 'Follow Up' }, {});
  assert.equal(r.ok, true, r.error);
});
