// Medicine-only confirmation (23 Nov): the confirmation window opens ONLY when an existing MEDICINE is removed or
// replaced by a different medicine (Gemini's removes_medicine); other removals are applied directly (Undo, History,
// highlight). A missing, invalid or contradicting removes_medicine never skips the window for a removal.
// The decision (lib/deletions.js needsConfirmation) is the same for typed, voice, streamed and uploaded commands -
// App.jsx runEdits calls it once for all of them. Dummy documents and dummy medicines only.
// Run:  cd client  &&  node --test tests/
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState } from '@tiptap/pm/state';
import { history, undo, undoDepth } from '@tiptap/pm/history';
import { needsConfirmation, needsMedicineConfirmation, isDeletion } from '../src/lib/deletions.js';
import { bottomUp, withRealLineBreaks } from '../src/lib/aiEdits.js';
import { asOneUndoStep } from '../src/lib/undoStep.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-medicine-confirm');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'previewEdits', 'medicineText', 'sections']) {
  fs.writeFileSync(path.join(tmp, `${f}.js`), fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)(\.js)?'/g, "from './$1.js'"));
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { previewEdits } = await import(pathToFileURL(path.join(tmp, 'previewEdits.js')).href);
const { getBlocks } = await import(pathToFileURL(path.join(tmp, 'outline.js')).href);
const { flashKey } = await import(pathToFileURL(path.join(tmp, 'flash.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const APP = fs.readFileSync(path.join(here, '../src/App.jsx'), 'utf8');

// ---------- a dummy discharge summary ----------
const schema = getSchema([StarterKit]);
const t = (s) => schema.text(s);
const p = (...k) => schema.node('paragraph', null, k);
const tp = (s) => p(t(s));
const h = (s) => p(schema.text(s, [schema.marks.bold.create()]));
const br = () => schema.nodes.hardBreak.create();
const ol = (...xs) => schema.node('orderedList', null, xs.map((x) => schema.node('listItem', null, [tp(x)])));
const PAN = 'Tab. PAN 40 mg — Once Daily — 5 days';
const CIPLOX = 'Tab. CIPLOX 500 mg — Twice Daily — 5 days';
const CROCIN = 'Tab. CROCIN (Paracetamol) 650 mg — SOS';
const docOf = () => schema.node('doc', null, [h('DIAGNOSIS'), tp('TYPHOID'), tp('Dehydration'),
  h('ADVICE'), ol(CIPLOX, PAN), tp('Drink plenty of water.'), tp('Avoid oily food.'),
  h('DISCHARGE MEDICATIONS'), p(t(CROCIN), br(), t('Syp. CREMAFFIN 10 ml — At night')),
  h('FOLLOW UP'), tp('Review in OPD after 1 week.')]);
class FakeView {
  constructor(owner) { this.owner = owner; }
  dispatch(tr) {
    this.owner.state = this.owner.state.apply(tr);
    const f = tr.getMeta(flashKey);
    if (f?.add) this.owner.flashes.push(this.owner.state.doc.textBetween(f.add.from, f.add.to, ' / ', ' / '));
  }
}
const editorOf = () => {
  const ed = { state: EditorState.create({ doc: docOf(), plugins: [history()] }), schema, isDestroyed: false, dryRun: true, flashes: [] };
  ed.view = new FakeView(ed);
  return ed;
};
const id = (ed, start) => {
  const i = getBlocks(ed.state.doc).findIndex((b) => b.node.textContent.startsWith(start));
  assert.ok(i >= 0, start);
  return `B${i}`;
};
const text = (ed) => getBlocks(ed.state.doc).map((b) => b.node.textBetween(0, b.node.content.size, ' / ', ' / ')).join(' | ');
const e = (block_id, operation, extra = {}) => ({ block_id, operation, field_label: 'X', ...extra });
const confirm = (ed, edits) => needsConfirmation(ed.state.doc, edits.map(withRealLineBreaks));

// The App.jsx path after the answer: cleaned -> bottomUp -> dry run (2+) -> window? -> ONE undo step
function runCommand(ed, edits) {
  const ordered = bottomUp(edits.map(withRealLineBreaks));
  if (ordered.length > 1 && previewEdits(ed.state.doc, ordered, { fromFile: false }).blocked.length) return { outcome: 'blocked' };
  if (needsConfirmation(ed.state.doc, ordered)) return { outcome: 'window', ordered, doc: ed.state.doc };
  let results;
  asOneUndoStep(ed.view, () => { results = ordered.map((x) => applyVoiceEdit(ed, x, {})); });
  return { outcome: 'applied', results };
}
// Apply in the window: the ticked edits (all here), refused if the document changed (App.jsx applyCommandPreview)
function applyWindow(ed, w, selected = null) {
  if (!ed.state.doc.eq(w.doc)) return { outcome: 'document changed' };
  const ordered = w.ordered.filter((_, i) => !selected || selected.has(i));
  let results;
  asOneUndoStep(ed.view, () => { results = ordered.map((x) => applyVoiceEdit(ed, x, {})); });
  return { outcome: 'applied', results };
}

// ================= medicine removal: the window =================
test('1/4. removing a medicine (clear, replace_text "", set "") opens the window - with removes_medicine true AND when it is missing', () => {
  const ed = editorOf();
  for (const flag of [true, undefined]) {
    const extra = flag === undefined ? {} : { removes_medicine: flag };
    assert.equal(confirm(ed, [e(id(ed, 'Tab. PAN'), 'clear', extra)]), true, `clear ${flag}`);
    assert.equal(confirm(ed, [e(id(ed, 'Tab. PAN'), 'set', { new_value: '', ...extra })]), true, `set "" ${flag}`);
    assert.equal(confirm(ed, [e(id(ed, 'Tab. CROCIN'), 'replace_text', { find_text: CROCIN, new_value: '', ...extra })]), true, `line of a line-break block ${flag}`);
  }
  // "remove all medicines": one edit per medicine
  assert.equal(confirm(ed, [e(id(ed, 'Tab. CIPLOX'), 'clear', { removes_medicine: true }), e(id(ed, 'Tab. PAN'), 'clear', { removes_medicine: true })]), true);
});

test('8. Cancel: the document is completely unchanged', () => {
  const ed = editorOf();
  const before = ed.state.doc;
  const w = runCommand(ed, [e(id(ed, 'Tab. PAN'), 'clear', { removes_medicine: true })]);
  assert.equal(w.outcome, 'window');
  // Cancel = the window is closed, nothing is applied (App.jsx cancelPending only resets the window)
  assert.ok(ed.state.doc.eq(before));
  assert.equal(undoDepth(ed.state), 0);
  const cancel = APP.slice(APP.indexOf('function cancelPending()'), APP.indexOf('function openPending('));
  assert.doesNotMatch(cancel, /dispatch|applyVoiceEdit|applyAiEdits/);
});

test('9. Apply: the removal is made, ONE undo step brings it back', () => {
  const ed = editorOf();
  const before = ed.state.doc;
  const w = runCommand(ed, [e(id(ed, 'Tab. PAN'), 'clear', { removes_medicine: true })]);
  assert.equal(applyWindow(ed, w).outcome, 'applied');
  assert.ok(!text(ed).includes('Tab. PAN'));
  assert.ok(text(ed).includes('Tab. CIPLOX'), 'the other medicine stays');
  assert.equal(undoDepth(ed.state), 1);
  undo(ed.state, (tr) => { ed.state = ed.state.apply(tr); });
  assert.ok(ed.state.doc.eq(before));
});

// ================= non-medicine removal: applied directly =================
test('10-12. removing a diagnosis, an Advice sentence or a follow-up (removes_medicine false) is applied directly', () => {
  for (const [start, edit] of [
    ['Dehydration', (ed) => e(id(ed, 'Dehydration'), 'clear', { removes_medicine: false })],
    ['Avoid oily food.', (ed) => e(id(ed, 'Avoid oily'), 'replace_text', { find_text: 'Avoid oily food.', new_value: '', removes_medicine: false })],
    ['Review in OPD', (ed) => e(id(ed, 'Review in OPD'), 'set', { new_value: '', removes_medicine: false })],
  ]) {
    const ed = editorOf();
    const r = runCommand(ed, [edit(ed)]);
    assert.equal(r.outcome, 'applied', start);
    assert.ok(!text(ed).includes(start), `${start} removed`);
  }
});

test('13-15. a direct removal: one undo step restores it; History values and the highlight are there', () => {
  const ed = editorOf();
  const before = ed.state.doc;
  const r = runCommand(ed, [e(id(ed, 'Avoid oily'), 'replace_text', { find_text: 'oily ', new_value: '', removes_medicine: false })]);
  assert.equal(r.outcome, 'applied');
  assert.ok(text(ed).includes('Avoid food.'));
  assert.equal(r.results[0].before, 'Avoid oily food.', 'History: before');
  assert.equal(r.results[0].after, 'Avoid food.', 'History: after');
  assert.ok(ed.flashes.some((f) => f.includes('Avoid food.')), 'highlighted');
  assert.equal(undoDepth(ed.state), 1);
  undo(ed.state, (tr) => { ed.state = ed.state.apply(tr); });
  assert.ok(ed.state.doc.eq(before));
});

// ================= mixed and edge cases =================
test('16. a medicine AND a diagnosis removed in one command: the window (the whole command; nothing applied before Apply)', () => {
  const ed = editorOf();
  const before = ed.state.doc;
  const w = runCommand(ed, [e(id(ed, 'Dehydration'), 'clear', { removes_medicine: false }), e(id(ed, 'Tab. PAN'), 'clear', { removes_medicine: true })]);
  assert.equal(w.outcome, 'window');
  assert.ok(ed.state.doc.eq(before));
  assert.equal(w.ordered.length, 2, 'both changes are in the window');
  applyWindow(ed, w);
  assert.ok(!text(ed).includes('Dehydration') && !text(ed).includes('Tab. PAN'));
  assert.equal(undoDepth(ed.state), 1, 'one undo step for both');
});

test('17. a dose change of a medicine that stays: no window (replace_text of the dose, with or without the flag)', () => {
  const ed = editorOf();
  for (const extra of [{ removes_medicine: false }, {}]) {
    assert.equal(confirm(ed, [e(id(ed, 'Tab. PAN'), 'replace_text', { find_text: '40 mg', new_value: '20 mg', ...extra })]), false, JSON.stringify(extra));
  }
  // the whole line rewritten with only a new dose, and Gemini says no medicine is removed: no window
  assert.equal(confirm(ed, [e(id(ed, 'Tab. PAN'), 'set', { new_value: 'Tab. PAN 20 mg — Once Daily — 5 days', removes_medicine: false })]), false);
  const r = runCommand(ed, [e(id(ed, 'Tab. PAN'), 'replace_text', { find_text: '40 mg', new_value: '20 mg', removes_medicine: false })]);
  assert.equal(r.outcome, 'applied');
  assert.ok(text(ed).includes('Tab. PAN 20 mg'));
});

test('18. replacing a medicine with a DIFFERENT medicine (removes_medicine true): the window', () => {
  const ed = editorOf();
  assert.equal(confirm(ed, [e(id(ed, 'Tab. PAN'), 'set', { new_value: 'Tab. RANTAC 150 mg — Twice Daily', removes_medicine: true })]), true);
  assert.equal(confirm(ed, [e(id(ed, 'Tab. PAN'), 'replace_text', { find_text: 'Tab. PAN 40 mg', new_value: 'Tab. RANTAC 150 mg', removes_medicine: true })]), true);
  // the flag missing: a whole medicine line changed -> the window (it cannot be told from a dose change)
  assert.equal(confirm(ed, [e(id(ed, 'Tab. PAN'), 'set', { new_value: 'Tab. RANTAC 150 mg — Twice Daily' })]), true);
});

test('19. adding a medicine (insert_after / insert_before / append / set of an empty block): never the window', () => {
  const ed = editorOf();
  for (const op of ['insert_after', 'insert_before', 'append']) {
    assert.equal(confirm(ed, [e(id(ed, 'Tab. PAN'), op, { new_value: 'Tab. DOLO 650 mg — Morning' })]), false, op);
    assert.equal(confirm(ed, [e(id(ed, 'Tab. PAN'), op, { new_value: 'Tab. DOLO 650 mg', removes_medicine: true })]), false, `${op}: the flag alone does not make an addition a removal`);
  }
  const empty = { state: EditorState.create({ doc: schema.node('doc', null, [h('ADVICE'), schema.node('paragraph')]) }), schema };
  assert.equal(needsConfirmation(empty.state.doc, [e('B1', 'set', { new_value: 'Tab. DOLO 650 mg' })]), false);
  // formatting and lists never
  assert.equal(confirm(ed, [e(id(ed, 'Tab. PAN'), 'format', { style: 'bold' }), e(id(ed, 'Tab. PAN'), 'to_list', { list_type: 'bullet', lines: [PAN] })]), false);
});

test('20. missing, invalid or contradicting removes_medicine never skips the window for a removal', () => {
  const ed = editorOf();
  const pan = id(ed, 'Tab. PAN');
  const dx = id(ed, 'Dehydration');
  // missing / invalid -> treated as unknown: every removal is confirmed (also a non-medicine one)
  for (const bad of [undefined, 'false', 'no', 0, null, {}]) {
    const extra = bad === undefined ? {} : { removes_medicine: bad };
    assert.equal(confirm(ed, [e(pan, 'clear', extra)]), true, `medicine, ${JSON.stringify(bad)}`);
    assert.equal(confirm(ed, [e(dx, 'clear', extra)]), true, `diagnosis, ${JSON.stringify(bad)}: unknown -> confirmed`);
  }
  // contradicting: "false" but the removed text is a medicine line (the app's existing medicine check) -> the window
  assert.equal(confirm(ed, [e(pan, 'clear', { removes_medicine: false })]), true);
  assert.equal(confirm(ed, [e(id(ed, 'Tab. CROCIN'), 'replace_text', { find_text: CROCIN, new_value: '', removes_medicine: false })]), true);
  assert.equal(confirm(ed, [e(pan, 'replace_text', { find_text: PAN, new_value: '\\n', removes_medicine: false })]), true, '"\\n" written as two characters');
  // removing only a detail of a medicine (it stays) with "false": no window
  assert.equal(confirm(ed, [e(pan, 'replace_text', { find_text: ' — 5 days', new_value: '', removes_medicine: false })]), false);
  // removes_medicine never changes isDeletion (it still says what is a removal)
  assert.equal(isDeletion(ed.state.doc, e(dx, 'clear', { removes_medicine: false })), true);
  assert.equal(needsMedicineConfirmation(ed.state.doc, undefined), false);
  assert.equal(needsConfirmation(ed.state.doc, undefined), false);
});

test('21. several edits, and the document changing while the window is open', () => {
  const ed = editorOf();
  const w = runCommand(ed, [e(id(ed, 'Tab. PAN'), 'clear', { removes_medicine: true }), e(id(ed, 'TYPHOID'), 'append', { new_value: ', FEVER', removes_medicine: false })]);
  assert.equal(w.outcome, 'window');
  // the doctor types while the window is open -> Apply refuses (App.jsx applyCommandPreview: doc.eq)
  ed.view.dispatch(ed.state.tr.insertText('DUMMY ', getBlocks(ed.state.doc)[1].pos + 1));
  const changed = ed.state.doc;
  assert.equal(applyWindow(ed, w).outcome, 'document changed');
  assert.ok(ed.state.doc.eq(changed), 'nothing of the window was applied');
  // App.jsx: the window is closed when the editor is left (another document) and Apply checks the document
  assert.match(APP, /setPending\(null\); \/\/ a confirm window that was still open is closed without changing anything/);
  assert.match(APP.slice(APP.indexOf('function applyCommandPreview('), APP.indexOf('function attachFile(')), /if \(!editor\.state\.doc\.eq\(p\.doc\)\)/);
});

test('App.jsx: ONE decision for typed, voice, streamed and uploaded commands; the window only via needsConfirmation', () => {
  const run = APP.slice(APP.indexOf('async function runEdits('), APP.indexOf('async function runAndReport('));
  assert.equal((run.match(/needsConfirmation\(/g) || []).length, 1);
  assert.equal((APP.match(/openPending\(\{/g) || []).length, 1, 'the window opens in one place only');
  assert.doesNotMatch(run, /hasDeletion\(/, 'a removal of other text no longer opens the window');
  assert.match(run, /const fromFile = Boolean\(file\);/, 'uploads take the same path');
  assert.match(APP, /notice: 'This removes existing text, including a medicine \(struck through below\)\./);
  // the permanent-deletion browser dialogs are unchanged
  assert.match(fs.readFileSync(path.join(here, '../src/pages/Summaries.jsx'), 'utf8'), /window\.confirm\(`Delete the summary of \$\{p\.name \|\| s\.caseNo\}\? This cannot be undone\.`\)/);
  assert.match(fs.readFileSync(path.join(here, '../src/pages/Templates.jsx'), 'utf8'), /window\.confirm\('Delete this document\? This cannot be undone\.'\)/);
});

test('the decision uses no new medicine rules: only removes_medicine and the existing isMedicineEntry check', () => {
  const src = fs.readFileSync(path.join(here, '../src/lib/deletions.js'), 'utf8');
  const part = src.slice(src.indexOf('// ---------- the confirmation window'));
  assert.match(part, /isMedicineEntry\(/);
  assert.doesNotMatch(part, /new RegExp|\/\^?\(?(?:tab|cap|syp|inj)/i, 'no medicine pattern of its own');
});
