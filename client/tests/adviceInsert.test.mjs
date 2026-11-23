// Advice placement (23 Nov): the generic insert_before operation and insert_after's separate_paragraph flag.
// Gemini decides WHAT the text is and WHERE it goes; these tests check only the STRUCTURE the editor builds
// (list items, lines of a paragraph with line breaks, paragraphs), the order of several edits, undo (one step),
// the History values and the highlight. Dummy documents and dummy medicines only.
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
import { history, undo, undoDepth } from '@tiptap/pm/history';
import { bottomUp, withRealLineBreaks } from '../src/lib/aiEdits.js';
import { isDeletion } from '../src/lib/deletions.js';
import { asOneUndoStep } from '../src/lib/undoStep.js';
import { reasonCode } from '../src/lib/editFailure.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-advice-insert');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'previewEdits', 'medicineText', 'sections']) {
  fs.writeFileSync(path.join(tmp, `${f}.js`), fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)(\.js)?'/g, "from './$1.js'"));
}
const { applyVoiceEdit, incompleteEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { previewEdits } = await import(pathToFileURL(path.join(tmp, 'previewEdits.js')).href);
const { getBlocks } = await import(pathToFileURL(path.join(tmp, 'outline.js')).href);
const { flashKey } = await import(pathToFileURL(path.join(tmp, 'flash.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---------- dummy documents ----------
const schema = getSchema([StarterKit, Table, TableRow, TableHeader, TableCell]);
const t = (s) => schema.text(s);
const p = (...k) => schema.node('paragraph', null, k);
const tp = (s) => p(t(s));
const h = (s) => p(schema.text(s, [schema.marks.bold.create()]));
const br = () => schema.nodes.hardBreak.create();
const ol = (...xs) => schema.node('orderedList', null, xs.map((x) => schema.node('listItem', null, [tp(x)])));
const CIPLOX = 'Tab. CIPLOX 500 mg — Twice Daily — 5 days';
const PAN = 'Tab. PAN 40 mg — Once Daily — 5 days';
const SYP = 'Syp. CREMAFFIN 10 ml — At night';
const DOLO = 'Tab. DOLO 650 mg — Morning — 3 days';
const OMEZ = 'Cap. OMEZ 20 mg — Before food — 5 days';
// Advice with a NUMBERED medicine list (optionally an advice paragraph before / after it)
const listDoc = ({ pre = false, post = false } = {}) => schema.node('doc', null, [h('DIAGNOSIS'), tp('TYPHOID'), h('ADVICE'),
  ...(pre ? [tp('Take adequate rest.')] : []), ol(CIPLOX, PAN, SYP), ...(post ? [tp('Drink plenty of water.')] : []),
  h('FOLLOW UP'), tp('Review in OPD after 1 week.')]);
// Advice with the medicines as ONE paragraph with line breaks
const linesDoc = () => schema.node('doc', null, [h('ADVICE'), p(t(CIPLOX), br(), t(PAN), br(), t(SYP)), h('FOLLOW UP'), tp('Review in OPD after 1 week.')]);

class FakeView { // dispatch as a class method, as in ProseMirror's EditorView (asOneUndoStep wraps it)
  constructor(owner) { this.owner = owner; }
  dispatch(tr) {
    this.owner.state = this.owner.state.apply(tr);
    // the highlighted text, read right after its change (later edits move positions; the real highlight plugin maps them)
    const f = tr.getMeta(flashKey);
    if (f?.add) this.owner.flashes.push(this.owner.state.doc.textBetween(f.add.from, f.add.to, ' / ', ' / '));
  }
}
const editorOf = (doc) => {
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), schema, isDestroyed: false, dryRun: true, flashes: [] };
  ed.view = new FakeView(ed);
  return ed;
};
const id = (ed, start) => {
  const i = getBlocks(ed.state.doc).findIndex((b) => b.node.textContent.startsWith(start));
  assert.ok(i >= 0, `dummy block "${start}"`);
  return `B${i}`;
};
// the document as a readable list: [P] paragraph (lines joined with " / "), 1. 2. list items
const shape = (doc) => {
  const out = [];
  doc.forEach((n) => {
    if (n.type.name === 'orderedList' || n.type.name === 'bulletList') n.forEach((li, _, i) => out.push(`${i + 1}. ${li.textContent}`));
    else out.push(`[P] ${n.textBetween(0, n.content.size, ' / ', ' / ')}`);
  });
  return out;
};
// the App.jsx flow for one command: cleaned edits -> bottomUp -> all-or-nothing dry run (2+) -> ONE undo step
function command(ed, edits) {
  const ordered = bottomUp(edits.map(withRealLineBreaks));
  if (ordered.length > 1) {
    const dry = previewEdits(ed.state.doc, ordered, { fromFile: false });
    if (dry.blocked.length) return { applied: false, blocked: dry.blocked };
  }
  let results = [];
  asOneUndoStep(ed.view, () => { results = ordered.map((e) => applyVoiceEdit(ed, e, {})); });
  return { applied: results.every((r) => r.ok), results };
}
const edit = (block_id, operation, new_value, extra = {}) => ({ block_id, operation, new_value, field_label: 'Advice', ...extra });

// ================= 1-3: medicines at the top, in the middle, at the bottom of a NUMBERED list =================
test('1. medicine at the top: insert_before the first medicine -> the FIRST numbered entry', () => {
  const ed = editorOf(listDoc());
  assert.equal(command(ed, [edit(id(ed, 'Tab. CIPLOX'), 'insert_before', DOLO)]).applied, true);
  assert.deepEqual(shape(ed.state.doc), ['[P] DIAGNOSIS', '[P] TYPHOID', '[P] ADVICE', `1. ${DOLO}`, `2. ${CIPLOX}`, `3. ${PAN}`, `4. ${SYP}`, '[P] FOLLOW UP', '[P] Review in OPD after 1 week.']);
  assert.equal(ed.state.doc.child(3).type.name, 'orderedList', 'still ONE numbered list');
  assert.equal(ed.state.doc.child(3).childCount, 4);
});

test('1b. medicine at the top when advice text comes before the list (Gemini targets the first medicine)', () => {
  const ed = editorOf(listDoc({ pre: true }));
  command(ed, [edit(id(ed, 'Tab. CIPLOX'), 'insert_before', DOLO)]);
  assert.deepEqual(shape(ed.state.doc).slice(2, 5), ['[P] ADVICE', '[P] Take adequate rest.', `1. ${DOLO}`]);
});

test('2. medicine between two medicines: insert_after PAN (unchanged) / insert_before SYP (new) -> the same place', () => {
  for (const e of [(ed) => edit(id(ed, 'Tab. PAN'), 'insert_after', DOLO), (ed) => edit(id(ed, 'Syp. CREMAFFIN'), 'insert_before', DOLO)]) {
    const ed = editorOf(listDoc());
    command(ed, [e(ed)]);
    assert.deepEqual(shape(ed.state.doc).slice(3, 7), [`1. ${CIPLOX}`, `2. ${PAN}`, `3. ${DOLO}`, `4. ${SYP}`]);
  }
});

test('3. medicine at the bottom: insert_after the last medicine -> the last entry (unchanged behaviour)', () => {
  const ed = editorOf(listDoc());
  command(ed, [edit(id(ed, 'Syp. CREMAFFIN'), 'insert_after', DOLO)]);
  assert.deepEqual(shape(ed.state.doc).slice(3, 8), [`1. ${CIPLOX}`, `2. ${PAN}`, `3. ${SYP}`, `4. ${DOLO}`, '[P] FOLLOW UP']);
});

// ================= 4-5: follow-up and general advice: separate paragraphs =================
test('4. follow-up after the medicines: insert_after the last medicine + separate_paragraph -> a paragraph after the list', () => {
  const ed = editorOf(listDoc());
  command(ed, [edit(id(ed, 'Syp. CREMAFFIN'), 'insert_after', 'Review in OPD after 2 weeks.', { separate_paragraph: true })]);
  assert.deepEqual(shape(ed.state.doc), ['[P] DIAGNOSIS', '[P] TYPHOID', '[P] ADVICE', `1. ${CIPLOX}`, `2. ${PAN}`, `3. ${SYP}`, '[P] Review in OPD after 2 weeks.', '[P] FOLLOW UP', '[P] Review in OPD after 1 week.']);
  assert.equal(ed.state.doc.child(3).childCount, 3, 'the medicine list is unchanged');
});

test('4b. separate_paragraph aimed at a MIDDLE medicine still lands after the whole list (never inside the numbering)', () => {
  const ed = editorOf(listDoc());
  command(ed, [edit(id(ed, 'Tab. CIPLOX'), 'insert_after', 'Avoid heavy work for 5 days.', { separate_paragraph: true })]);
  assert.deepEqual(shape(ed.state.doc).slice(3, 7), [`1. ${CIPLOX}`, `2. ${PAN}`, `3. ${SYP}`, '[P] Avoid heavy work for 5 days.']);
});

test('4c. follow-up at an explicit position: "at the top" = insert_after the heading -> a paragraph above the list (unchanged)', () => {
  const ed = editorOf(listDoc());
  command(ed, [edit(id(ed, 'ADVICE'), 'insert_after', 'Come back if the fever returns.')]);
  assert.deepEqual(shape(ed.state.doc).slice(2, 5), ['[P] ADVICE', '[P] Come back if the fever returns.', `1. ${CIPLOX}`]);
});

test('5. general advice at the end of Advice (after an advice paragraph): a normal paragraph (unchanged)', () => {
  const ed = editorOf(listDoc({ post: true }));
  command(ed, [edit(id(ed, 'Drink plenty'), 'insert_after', 'Avoid oily food.')]);
  assert.deepEqual(shape(ed.state.doc).slice(6, 9), ['[P] Drink plenty of water.', '[P] Avoid oily food.', '[P] FOLLOW UP']);
  // separate_paragraph on an ordinary paragraph: the same normal paragraph
  const ed2 = editorOf(listDoc({ post: true }));
  command(ed2, [edit(id(ed2, 'Drink plenty'), 'insert_after', 'Avoid oily food.', { separate_paragraph: true })]);
  assert.ok(ed2.state.doc.eq(ed.state.doc));
});

// ================= 6: a paragraph with LINE BREAKS =================
test('6. line-break medicines: insert_before a named line, before the first line, and a follow-up after the block', () => {
  let ed = editorOf(linesDoc());
  command(ed, [edit(id(ed, 'Tab. CIPLOX'), 'insert_before', DOLO, { find_text: 'Tab. PAN' })]);
  assert.deepEqual(shape(ed.state.doc)[1], `[P] ${CIPLOX} / ${DOLO} / ${PAN} / ${SYP}`, 'before the PAN line');
  ed = editorOf(linesDoc());
  command(ed, [edit(id(ed, 'Tab. CIPLOX'), 'insert_before', DOLO, { find_text: CIPLOX })]);
  assert.deepEqual(shape(ed.state.doc)[1], `[P] ${DOLO} / ${CIPLOX} / ${PAN} / ${SYP}`, 'at the top (before the first line)');
  ed = editorOf(linesDoc());
  command(ed, [edit(id(ed, 'Tab. CIPLOX'), 'insert_before', DOLO)]);
  assert.deepEqual(shape(ed.state.doc)[1], `[P] ${DOLO} / ${CIPLOX} / ${PAN} / ${SYP}`, 'no find_text: before the first line');
  ed = editorOf(linesDoc());
  command(ed, [edit(id(ed, 'Tab. CIPLOX'), 'insert_after', 'Review in OPD after 2 weeks.', { find_text: 'Syp. CREMAFFIN', separate_paragraph: true })]);
  assert.deepEqual(shape(ed.state.doc).slice(1, 3), [`[P] ${CIPLOX} / ${PAN} / ${SYP}`, '[P] Review in OPD after 2 weeks.'], 'not a line of the medicine block');
  ed = editorOf(linesDoc());
  command(ed, [edit(id(ed, 'Tab. CIPLOX'), 'insert_after', DOLO, { find_text: 'Syp. CREMAFFIN' })]);
  assert.deepEqual(shape(ed.state.doc)[1], `[P] ${CIPLOX} / ${PAN} / ${SYP} / ${DOLO}`, 'insert_after without the flag: unchanged');
});

// ================= 7-8: several edits =================
test('7. two medicines at the top as two insert_before edits on the same block -> in Gemini\'s order (list and lines)', () => {
  let ed = editorOf(listDoc());
  command(ed, [edit(id(ed, 'Tab. CIPLOX'), 'insert_before', DOLO), edit(id(ed, 'Tab. CIPLOX'), 'insert_before', OMEZ)]);
  assert.deepEqual(shape(ed.state.doc).slice(3, 8), [`1. ${DOLO}`, `2. ${OMEZ}`, `3. ${CIPLOX}`, `4. ${PAN}`, `5. ${SYP}`]);
  ed = editorOf(linesDoc());
  command(ed, [edit(id(ed, 'Tab. CIPLOX'), 'insert_before', DOLO, { find_text: 'Tab. PAN' }), edit(id(ed, 'Tab. CIPLOX'), 'insert_before', OMEZ, { find_text: 'Tab. PAN' })]);
  assert.deepEqual(shape(ed.state.doc)[1], `[P] ${CIPLOX} / ${DOLO} / ${OMEZ} / ${PAN} / ${SYP}`);
  ed = editorOf(listDoc());
  command(ed, [edit(id(ed, 'Tab. CIPLOX'), 'insert_before', `${DOLO}\n${OMEZ}`)]);
  assert.deepEqual(shape(ed.state.doc).slice(3, 5), [`1. ${DOLO}`, `2. ${OMEZ}`], 'one edit with a line break: two entries');
});

test('8. several edits in one command: same block (insert_before + replace_text) and different blocks, correct order', () => {
  const ed = editorOf(listDoc());
  const r = command(ed, [
    edit(id(ed, 'Tab. CIPLOX'), 'insert_before', DOLO),
    edit(id(ed, 'Tab. CIPLOX'), 'replace_text', '250 mg', { find_text: '500 mg' }), // the SAME block, after the insert in Gemini's list
    edit(id(ed, 'Syp. CREMAFFIN'), 'insert_after', 'Review in OPD after 2 weeks.', { separate_paragraph: true }),
    edit(id(ed, 'TYPHOID'), 'append', ', DEHYDRATION'),
  ]);
  assert.equal(r.applied, true);
  assert.deepEqual(shape(ed.state.doc), ['[P] DIAGNOSIS', '[P] TYPHOID, DEHYDRATION', '[P] ADVICE', `1. ${DOLO}`, '2. Tab. CIPLOX 250 mg — Twice Daily — 5 days', `3. ${PAN}`, `4. ${SYP}`, '[P] Review in OPD after 2 weeks.', '[P] FOLLOW UP', '[P] Review in OPD after 1 week.']);
  // bottomUp: the insert_before of a block comes after that block's other edits; two with the same line are one edit
  const o = bottomUp([edit('B5', 'insert_before', 'A'), edit('B5', 'set', 'S'), edit('B5', 'insert_before', 'B'), edit('B9', 'append', 'x')]);
  assert.deepEqual(o.map((e) => `${e.block_id}:${e.operation}:${e.new_value}`), ['B9:append:x', 'B5:set:S', 'B5:insert_before:A\nB']);
  const lines = bottomUp([edit('B5', 'insert_before', 'A', { find_text: 'X' }), edit('B5', 'insert_before', 'B', { find_text: 'Y' })]);
  assert.equal(lines.length, 2, 'different lines: two edits');
});

test('8b. the dry run (trial run) gives exactly the same document as applying', () => {
  const ed = editorOf(listDoc());
  const edits = [edit(id(ed, 'Tab. CIPLOX'), 'insert_before', DOLO), edit(id(ed, 'Tab. CIPLOX'), 'insert_before', OMEZ),
    edit(id(ed, 'Syp. CREMAFFIN'), 'insert_after', 'Review in OPD after 2 weeks.', { separate_paragraph: true })];
  const dry = previewEdits(ed.state.doc, bottomUp(edits), { fromFile: false });
  assert.equal(dry.blocked.length, 0);
  command(ed, edits);
  assert.ok(dry.doc.eq(ed.state.doc));
});

// ================= 9: insert_after without the flag is unchanged =================
test('9. insert_after without separate_paragraph (absent / false / not exactly true) behaves exactly as before', () => {
  const plain = editorOf(listDoc());
  command(plain, [edit(id(plain, 'Syp. CREMAFFIN'), 'insert_after', 'Review in OPD after 2 weeks.')]);
  assert.deepEqual(shape(plain.state.doc).slice(5, 7), [`3. ${SYP}`, '4. Review in OPD after 2 weeks.'], 'as before: a list item (Gemini decides with the flag)');
  for (const flag of [false, 'true', 1, null]) {
    const ed = editorOf(listDoc());
    command(ed, [edit(id(ed, 'Syp. CREMAFFIN'), 'insert_after', 'Review in OPD after 2 weeks.', { separate_paragraph: flag })]);
    assert.ok(ed.state.doc.eq(plain.state.doc), `separate_paragraph: ${JSON.stringify(flag)}`);
  }
});

// ================= 10: invalid input =================
test('10. invalid insert_before: no text, text not found, more than one matching line -> nothing changes', () => {
  assert.match(incompleteEdit({ block_id: 'B4', operation: 'insert_before' }), /no new text for this change \(insert_before\)/);
  assert.match(incompleteEdit({ block_id: 'B4', operation: 'insert_before', new_value: '  ' }), /insert_before/);
  assert.equal(incompleteEdit({ block_id: 'B4', operation: 'insert_before', new_value: DOLO }), '');
  let ed = editorOf(linesDoc());
  const before = ed.state.doc;
  let r = applyVoiceEdit(ed, edit(id(ed, 'Tab. CIPLOX'), 'insert_before', DOLO, { find_text: 'Tab. NOTHERE' }), {});
  assert.equal(r.ok, false);
  assert.equal(reasonCode(r), 'text_not_found');
  r = applyVoiceEdit(ed, edit(id(ed, 'Tab. CIPLOX'), 'insert_before', DOLO, { find_text: 'Tab.' }), {});
  assert.equal(r.ok, false, 'two lines contain "Tab."');
  assert.equal(r.blocked, true);
  r = applyVoiceEdit(ed, edit(id(ed, 'Tab. CIPLOX'), 'insert_before', ''), {});
  assert.equal(r.ok, false);
  assert.ok(ed.state.doc.eq(before), 'nothing changed');
  ed = editorOf(listDoc());
  r = applyVoiceEdit(ed, edit('B99', 'insert_before', DOLO), {});
  assert.equal(r.ok, false);
  assert.equal(reasonCode({ ok: false, error: 'insert_before needs new_value' }), 'missing_value');
  // never a deletion (no confirmation window for an addition)
  assert.equal(isDeletion(ed.state.doc, edit(id(ed, 'Tab. CIPLOX'), 'insert_before', DOLO)), false);
  assert.equal(isDeletion(ed.state.doc, edit(id(ed, 'Tab. CIPLOX'), 'insert_after', 'x', { separate_paragraph: true })), false);
});

test('10b. table: insert_before a row of a data table adds the row BEFORE it; insert_after still after it', () => {
  const cell = (s) => schema.node('tableCell', null, [tp(s)]);
  const row = (...xs) => schema.node('tableRow', null, xs.map(cell));
  const doc = schema.node('doc', null, [h('LAB INVESTIGATIONS'), schema.node('table', null, [row('Investigation', 'Result'), row('Haemoglobin', '12.1 g/dL'), row('Serum Creatinine', '1.1 mg/dL')])]);
  const rows = (ed) => { const out = []; ed.state.doc.child(1).forEach((r) => out.push(r.textContent)); return out; };
  const ed = editorOf(doc);
  assert.equal(applyVoiceEdit(ed, edit(id(ed, 'Serum Creatinine'), 'insert_before', 'Platelet Count | 1,50,000/cumm'), {}).ok, true);
  assert.deepEqual(rows(ed), ['InvestigationResult', 'Haemoglobin12.1 g/dL', 'Platelet Count1,50,000/cumm', 'Serum Creatinine1.1 mg/dL']);
  const ed2 = editorOf(doc);
  applyVoiceEdit(ed2, edit(id(ed2, 'Haemoglobin'), 'insert_after', 'Platelet Count | 1,50,000/cumm'), {});
  assert.deepEqual(rows(ed2), rows(ed), 'the same place from the other side');
});

// ================= 11: undo, History values, highlight =================
test('11. ONE undo reverts the whole command (insert_before + separate_paragraph); History values; highlight set', () => {
  const ed = editorOf(listDoc());
  const original = ed.state.doc;
  const r = command(ed, [edit(id(ed, 'Tab. CIPLOX'), 'insert_before', DOLO), edit(id(ed, 'Syp. CREMAFFIN'), 'insert_after', 'Review in OPD after 2 weeks.', { separate_paragraph: true })]);
  assert.equal(r.applied, true);
  assert.equal(undoDepth(ed.state), 1, 'one undo step');
  // History (App.jsx handleEdit) shows before -> after of each change: an addition has no "before"
  for (const x of r.results) { assert.equal(x.before, ''); assert.ok(x.after.length > 0); assert.ok(Number.isInteger(x.pos)); }
  assert.deepEqual(r.results.map((x) => x.after).sort(), [DOLO, 'Review in OPD after 2 weeks.'].sort());
  // the highlight covers exactly the new text
  const texts = ed.flashes;
  assert.ok(texts.includes(DOLO), texts.join(' | '));
  assert.ok(texts.includes('Review in OPD after 2 weeks.'), texts.join(' | '));
  undo(ed.state, (tr) => { ed.state = ed.state.apply(tr); });
  assert.ok(ed.state.doc.eq(original), 'back exactly to the original document');
});

test('11b. line breaks: the highlight covers the medicine block; undo restores it', () => {
  const ed = editorOf(linesDoc());
  const original = ed.state.doc;
  command(ed, [edit(id(ed, 'Tab. CIPLOX'), 'insert_before', DOLO, { find_text: 'Tab. PAN' })]);
  assert.ok(ed.flashes.some((f) => f.includes(DOLO)), ed.flashes.join(' | '));
  undo(ed.state, (tr) => { ed.state = ed.state.apply(tr); });
  assert.ok(ed.state.doc.eq(original));
});

// ================= 12: nothing else moves; no medicine rule in the code =================
test('12. nothing existing is moved, changed or removed (every original line still there, in the same order)', () => {
  const ed = editorOf(listDoc({ pre: true, post: true }));
  const before = shape(ed.state.doc).map((l) => l.replace(/^\d+\. /, ''));
  command(ed, [edit(id(ed, 'Tab. CIPLOX'), 'insert_before', DOLO), edit(id(ed, 'Syp. CREMAFFIN'), 'insert_after', 'Review in OPD after 2 weeks.', { separate_paragraph: true })]);
  const now = shape(ed.state.doc).map((l) => l.replace(/^\d+\. /, '')).filter((l) => l !== DOLO && l !== '[P] Review in OPD after 2 weeks.');
  assert.deepEqual(now, before);
  // the bold headings keep their look
  assert.ok(ed.state.doc.child(2).firstChild.marks.some((m) => m.type.name === 'bold'));
});

test('12b. the new code decides by STRUCTURE only: no medicine words or follow-up phrases in it', () => {
  const src = fs.readFileSync(path.join(here, '../src/lib/voiceEdit.js'), 'utf8');
  const part = src.slice(src.indexOf('function addNewLinesBefore('), src.indexOf('// ---------- look-only edits'));
  assert.ok(part.length > 0);
  assert.doesNotMatch(part, /isMedicine|FORM|medicine|follow|review|advice/i);
  const order = fs.readFileSync(path.join(here, '../src/lib/aiEdits.js'), 'utf8');
  assert.doesNotMatch(order, /isMedicine|FORM_|follow-up phrase/i);
});
