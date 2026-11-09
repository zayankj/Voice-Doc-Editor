// Tests for src/lib/undoStep.js: one instruction = ONE undo step (real ProseMirror history)
// Run:  cd client  &&  node --test tests/
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { EditorState } from '@tiptap/pm/state';
import { history, undo, redo, undoDepth } from '@tiptap/pm/history';
import { asOneUndoStep } from '../src/lib/undoStep.js';
import { getBlocks } from '../src/lib/outline.js';

// the real applyVoiceEdit + age/gender fix (temporary copy with ".js" import endings, deleted afterwards)
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-undo');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit, ensurePatientConsistency } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell]);
const p = (t) => schema.node('paragraph', null, t ? [schema.text(t)] : []);
const bold = (t) => schema.node('paragraph', null, [schema.text(t, [schema.marks.bold.create()])]);
const th = (t) => schema.node('tableHeader', null, [p(t)]);
const row = (...ts) => schema.node('tableRow', null, ts.map(th));
const ORIGINAL = schema.node('doc', null, [
  bold('DISCHARGE SUMMARY'),
  schema.node('table', null, [row('Name', 'MRS.SUJATHA K', 'AGE', '30 Y'), row('Address', 'NASTAR', 'SEX', 'FEMALE')]),
  bold('DIAGNOSIS'), p('ENTERIC FEVER'),
  bold('PRESENTING COMPLAINT'), p('30-year-old female presented with loose stools.'),
  bold('COURSE IN HOSPITAL'), p('A 30 year old female patient was treated. She improved.'),
  bold('ADVICE'), p('Tab. DOLO 650 mg'),
]);

// An editor like the app's: the history plugin, and dispatch as a CLASS METHOD (as in ProseMirror's EditorView)
class FakeView {
  constructor(owner) { this.owner = owner; }
  dispatch(tr) { this.owner.state = this.owner.state.apply(tr); }
}
function makeEditor(doc = ORIGINAL) {
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), schema, isDestroyed: false };
  ed.view = new FakeView(ed);
  return ed;
}
const texts = (ed) => getBlocks(ed.state.doc).map((b) => b.node.textContent);
const id = (ed, text) => `B${texts(ed).indexOf(text)}`;
const done = (ed) => { ed.isDestroyed = true; };

// What runEdits does for "change the age to 31": the AI's two edits (far apart) + the age/gender fix
function changeAgeTo31(ed) {
  const edits = [
    { block_id: id(ed, '30-year-old female presented with loose stools.'), operation: 'replace_text', find_text: '30-year-old', new_value: '31-year-old' },
    { block_id: id(ed, '30 Y'), operation: 'set', new_value: '31 Y' },
  ];
  for (const e of edits) assert.equal(applyVoiceEdit(ed, e).ok, true);
  ensurePatientConsistency(ed); // also fixes "30 year old" in Course in Hospital (a third, distant change)
}

test('WITHOUT the helper (old behaviour): the instruction needs several Undo steps', () => {
  const ed = makeEditor();
  changeAgeTo31(ed);
  assert.ok(undoDepth(ed.state) >= 2);
  undo(ed.state, ed.view.dispatch.bind(ed.view));
  assert.ok(!ed.state.doc.eq(ORIGINAL)); // one Undo is not enough: this was the bug
  done(ed);
});

test('"change the age to 31": ALL distant changes are ONE undo step; ONE Undo restores the exact original', () => {
  const ed = makeEditor();
  asOneUndoStep(ed.view, () => changeAgeTo31(ed));
  const t = texts(ed);
  assert.equal(t[t.indexOf('AGE') + 1], '31 Y');
  assert.ok(t.includes('31-year-old female presented with loose stools.'));
  assert.ok(t.includes('A 31 year old female patient was treated. She improved.'));
  assert.equal(undoDepth(ed.state), 1);
  undo(ed.state, ed.view.dispatch.bind(ed.view));
  assert.ok(ed.state.doc.eq(ORIGINAL));
  done(ed);
});

test('Redo brings back ALL changes of the instruction', () => {
  const ed = makeEditor();
  asOneUndoStep(ed.view, () => changeAgeTo31(ed));
  const changed = ed.state.doc;
  undo(ed.state, ed.view.dispatch.bind(ed.view));
  redo(ed.state, ed.view.dispatch.bind(ed.view));
  assert.ok(ed.state.doc.eq(changed));
  done(ed);
});

test('typing just BEFORE the instruction stays its own undo step', () => {
  const ed = makeEditor();
  const b = getBlocks(ed.state.doc).find((x) => x.node.textContent === '30 Y');
  ed.view.dispatch(ed.state.tr.insertText('!', b.pos + 1 + 4)); // user types "!" right next to the age, just before
  const afterTyping = ed.state.doc;
  asOneUndoStep(ed.view, () => {
    assert.equal(applyVoiceEdit(ed, { block_id: id(ed, '30 Y!'), operation: 'set', new_value: '31 Y' }).ok, true);
    assert.equal(applyVoiceEdit(ed, { block_id: id(ed, '30-year-old female presented with loose stools.'), operation: 'replace_text', find_text: '30-year-old', new_value: '31-year-old' }).ok, true);
  });
  assert.equal(undoDepth(ed.state), 2);
  undo(ed.state, ed.view.dispatch.bind(ed.view));
  assert.ok(ed.state.doc.eq(afterTyping)); // instruction undone, typing kept
  undo(ed.state, ed.view.dispatch.bind(ed.view));
  assert.ok(ed.state.doc.eq(ORIGINAL)); // then the typing
  done(ed);
});

test('two instructions in a row stay two separate undo steps', () => {
  const ed = makeEditor();
  asOneUndoStep(ed.view, () => changeAgeTo31(ed));
  const afterFirst = ed.state.doc;
  asOneUndoStep(ed.view, () => applyVoiceEdit(ed, { block_id: id(ed, 'ENTERIC FEVER'), operation: 'append', new_value: ', MALARIA' }));
  assert.equal(undoDepth(ed.state), 2);
  undo(ed.state, ed.view.dispatch.bind(ed.view));
  assert.ok(ed.state.doc.eq(afterFirst));
  done(ed);
});

test('highlight-only updates inside the step do not create or break undo steps', () => {
  const ed = makeEditor();
  asOneUndoStep(ed.view, () => {
    changeAgeTo31(ed);
    ed.view.dispatch(ed.state.tr.setMeta('addToHistory', false)); // like the highlight timer
  });
  assert.equal(undoDepth(ed.state), 1);
  done(ed);
});

test('the editor is left exactly as before (class method restored), also after an error', () => {
  const ed = makeEditor();
  assert.ok(!Object.prototype.hasOwnProperty.call(ed.view, 'dispatch'));
  asOneUndoStep(ed.view, () => changeAgeTo31(ed));
  assert.ok(!Object.prototype.hasOwnProperty.call(ed.view, 'dispatch'));
  assert.throws(() => asOneUndoStep(ed.view, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!Object.prototype.hasOwnProperty.call(ed.view, 'dispatch'));
  // and normal typing afterwards is recorded normally again
  const before = undoDepth(ed.state);
  ed.view.dispatch(ed.state.tr.insertText('Z', 1));
  assert.equal(undoDepth(ed.state), before + 1);
  done(ed);
});

test('an instruction that changes nothing creates no undo step', () => {
  const ed = makeEditor();
  asOneUndoStep(ed.view, () => {
    assert.equal(applyVoiceEdit(ed, { block_id: id(ed, 'AGE'), operation: 'clear' }).ok, false); // locked label (a clear is never moved to the value)
  });
  assert.equal(undoDepth(ed.state), 0);
  done(ed);
});
