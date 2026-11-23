// R4 (D3 + D7): deletion confirmation decided by the operation only; everything else is applied directly.
// Typed, spoken and uploaded edits share one path in App.jsx. Dummy document only - no patient data.
// Run:  cd client  &&  node --test tests/
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { EditorState } from '@tiptap/pm/state';
import { history, undo, undoDepth } from '@tiptap/pm/history';
import { asOneUndoStep } from '../src/lib/undoStep.js';

// voiceEdit.js and consistency.js import their neighbours without ".js": a temporary copy with the endings added
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-r4');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'previewEdits', 'medicineText', 'sections']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { hasDeletion, isDeletion } = await import(pathToFileURL(path.join(here, '../src/lib/deletions.js')).href);
const { previewEdits } = await import(pathToFileURL(path.join(tmp, 'previewEdits.js')).href);
await build({
  entryPoints: [path.join(here, '../src/components/UploadPreview.jsx')],
  outfile: path.join(tmp, 'UploadPreview.mjs'), format: 'esm', jsx: 'automatic', bundle: true, packages: 'external', logLevel: 'silent',
});
const { default: UploadPreview } = await import(pathToFileURL(path.join(tmp, 'UploadPreview.mjs')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell]);
const BOLD = () => [schema.marks.bold.create()];
const t = (s, m) => schema.text(s, m);
const p = (s) => schema.node('paragraph', null, s ? [t(s)] : []);
const bold = (s) => schema.node('paragraph', null, [t(s, BOLD())]);
const th = (c) => schema.node('tableHeader', null, [typeof c === 'string' ? p(c) : c]);
const tr = (...c) => schema.node('tableRow', null, c);
const table = (...r) => schema.node('table', null, r);
const br = () => schema.nodes.hardBreak.create();

const LAB = [['HB', '13.6 G/DL'], ['TLC', '26,560/CUMM'], ['PLATELET COUNT', '3,86,000/CUMM'], ['SERUM CREATININE', '1.9 MG/DL'],
  ['TOTAL BILIRUBIN', '1.2 MG/DL'], ['SGPT', '41 U/L'], ['SGOT', '39 U/L'], ['ALP', '248 U/L'], ['SODIUM', '140 MEQ/L'], ['POTASSIUM', '3.4 MEQ/L']];
const DOLO = 'Tab. DOLO (Paracetamol) 650 mg — Oral — SOS';
const INSTARAFT = 'Syp. INSTARAFT 10 ml — Oral — TDS — 5 days';
const PAN = 'Tab. PAN 40 mg — Oral — Once daily before breakfast — 5 days';
const COURSE = '40-year-old male treated with IV fluids. Patient is stable.';
// The same block numbers as in the audit: B4 age, B8 sex, B12 IP No value, B18.. lab rows, B39 course text, B41 advice
function makeDoc(advice = [schema.node('paragraph', null, [t('Tab. '), t('DOLO', BOLD()), t(' (Paracetamol) 650 mg — Oral — SOS'), br(), t(INSTARAFT)])]) {
  return schema.node('doc', null, [
    bold('DISCHARGE SUMMARY'),
    table(
      tr(th('Name'), th('MR. TEST PATIENT'), th('AGE'), th('40 Y')),
      tr(th('Address'), th('DUMMY STREET'), th('SEX'), th('MALE')),
      tr(th('Discharge Date'), th('30-10-2026'), th('IP No'), th('IP00011111')),
    ),
    bold('DIAGNOSIS'), p('ENTERIC FEVER'),
    bold('LAB INVESTIGATIONS'),
    table(tr(th(bold('Investigation')), th(bold('Result'))), ...LAB.map(([a, b]) => tr(th(bold(a)), th(bold(b))))),
    bold('COURSE IN HOSPITAL'), p(COURSE),
    bold('ADVICE'), ...advice,
  ]);
}
class FakeView { constructor(o) { this.o = o; } dispatch(x) { this.o.state = this.o.state.apply(x); } }
function makeEditor(doc = makeDoc()) {
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), schema, isDestroyed: false };
  ed.view = new FakeView(ed);
  return ed;
}
const done = (ed) => { ed.isDestroyed = true; };

// ============ R4 (D3): deletion is decided by the OPERATION only ============
test('R4. deletions: clear / set "" / replace_text with "" on existing text', () => {
  const doc = makeDoc();
  assert.equal(isDeletion(doc, { block_id: 'B39', operation: 'clear' }), true);
  assert.equal(isDeletion(doc, { block_id: 'B39', operation: 'set', new_value: '' }), true);
  assert.equal(isDeletion(doc, { block_id: 'B39', operation: 'replace_text', find_text: 'Patient is stable.', new_value: '' }), true);
  assert.equal(isDeletion(doc, { block_id: 'B41', operation: 'replace_text', find_text: INSTARAFT, new_value: '' }), true); // a medicine: same rule
});

test('R4. NOT deletions: additions, replacements, corrections, formatting, lists - whatever the words say', () => {
  const doc = makeDoc();
  for (const e of [
    { block_id: 'B39', operation: 'set', new_value: 'Patient was given antibiotics.' },
    { block_id: 'B39', operation: 'set', new_value: 'remove delete clear' }, // words do not matter
    { block_id: 'B39', operation: 'append', new_value: 'Discharged.' },
    { block_id: 'B39', operation: 'insert_after', new_value: 'Review in OPD.' },
    { block_id: 'B41', operation: 'replace_text', find_text: 'DOLO', new_value: 'CALPOL' },
    { block_id: 'B39', operation: 'format', style: 'bold' },
    { block_id: 'B39', operation: 'change_case', case: 'upper' },
    { block_id: 'B41', operation: 'to_list', list_type: 'bullet' },
  ]) assert.equal(isDeletion(doc, e), false, JSON.stringify(e));
  assert.equal(hasDeletion(doc, []), false);
  assert.equal(hasDeletion(doc, undefined), false);
});

test('R4. clearing or emptying an EMPTY block is not a deletion (nothing is removed)', () => {
  const doc = schema.node('doc', null, [bold('ADVICE'), schema.node('paragraph')]);
  assert.equal(isDeletion(doc, { block_id: 'B1', operation: 'clear' }), false);
  assert.equal(isDeletion(doc, { block_id: 'B1', operation: 'set', new_value: '' }), false);
});

test('R4. one deletion in a batch of several edits: the whole command is confirmed', () => {
  const doc = makeDoc();
  assert.equal(hasDeletion(doc, [
    { block_id: 'B39', operation: 'append', new_value: 'Discharged.' },
    { block_id: 'B41', operation: 'replace_text', find_text: INSTARAFT, new_value: '' },
  ]), true);
});

// ============ the confirmation window (UploadPreview in command mode) ============
const DEL = [{ block_id: 'B41', operation: 'replace_text', find_text: INSTARAFT, new_value: '', field_label: 'Advice' }];
const windowHtml = (edits, fromFile) => renderToStaticMarkup(React.createElement(UploadPreview, {
  summary: 'Removed Instaraft.', preview: previewEdits(makeDoc(), edits, { fromFile }),
  recompute: (selected) => previewEdits(makeDoc(), edits, { fromFile, selected }),
  command: { notice: 'This removes existing text (struck through below). Check it, then press Apply - nothing is changed until then.' },
  onApply() {}, onCancel() {},
}));

test('R4. window: the removed text is struck through, the change starts ticked, Apply and Cancel are there', () => {
  for (const fromFile of [false, true]) {
    const html = windowHtml(DEL, fromFile);
    assert.match(html, /This removes existing text/);
    assert.match(html, /<del>[^<]*INSTARAFT[^<]*<\/del>/);
    assert.equal((html.match(/<input type="checkbox"[^>]*checked=""/g) || []).length, 1);
    assert.match(html, />Apply<\/button>/);
    assert.match(html, /Close without changing/);
    assert.match(html, /Nothing is changed until you press Apply/);
  }
});

test('R4. window: what Apply would write is exactly the dry run; the real document is untouched until then', () => {
  const ed = makeEditor();
  const before = ed.state;
  const pv = previewEdits(ed.state.doc, DEL, { fromFile: false });
  assert.equal(ed.state, before);
  assert.equal(pv.blocked.length, 0);
  asOneUndoStep(ed.view, () => { for (const e of DEL) applyVoiceEdit(ed, e); });
  assert.ok(ed.state.doc.eq(pv.doc));
  assert.ok(!ed.state.doc.textContent.includes('INSTARAFT'));
  assert.ok(ed.state.doc.textContent.includes('DOLO')); // the other medicine stays
  assert.equal(undoDepth(ed.state), 1);
  undo(ed.state, ed.view.dispatch.bind(ed.view));
  assert.ok(ed.state.doc.eq(makeDoc()));
  done(ed);
});

// ============ App.jsx wiring (typed, spoken, streamed AND uploaded share one path) ============
const app = fs.readFileSync(path.join(here, '../src/App.jsx'), 'utf8');
const tail = app.slice(app.indexOf('const ordered = bottomUp(aiEdits);'), app.indexOf('const applyFrom = performance.now();'));

test('R4. App: a deletion opens the window (nothing applied yet); everything else goes straight to applyAiEdits', () => {
  assert.ok(tail.length > 100, 'the runEdits tail was found');
  // (23 Nov) the window is decided by needsConfirmation (only MEDICINE removals; lib/deletions.js) - same place, same
  // window, same "nothing applied before Apply"
  const i = tail.indexOf('if (needsConfirmation(doc, ordered)) {');
  assert.ok(i > 0);
  const block = tail.slice(i);
  assert.match(block, /openPending\(\{\s*kind: 'command'/);
  assert.match(block, /return true;\s*\}\s*$/); // returns before the direct apply
  assert.doesNotMatch(block, /applyAiEdits\(/);
  assert.match(app, /const applyFrom = performance\.now\(\);\r?\n\s+applyAiEdits\(\{ ordered, fromFile, label, text, heard, file, summary, voice, aiEditCount: aiEdits\.length \}\);/);
});

test('R4. App: uploads use the same path (fromFile = Boolean(file)); no upload preview, no word-based checks', () => {
  assert.match(tail, /const fromFile = Boolean\(file\);/);
  for (const gone of ['showUploadPreview(', 'needsPreview(', 'checkInterpretation(', 'checkMedicineEdits(', 'checkNamedSection(', 'medicinesLostByEdits(', 'malayalam', 'genderChangeAllowed'])
    assert.ok(!tail.includes(gone), gone);
});

test('R4. App: Apply in the window applies only the ticked edits, as one step, and refuses if the document changed; Cancel changes nothing', () => {
  const fn = app.slice(app.indexOf('function applyCommandPreview('), app.indexOf('function attachFile('));
  assert.match(fn, /if \(!selected\.size\)/);
  assert.match(fn, /if \(!editor\.state\.doc\.eq\(p\.doc\)\)/);
  assert.match(fn, /ordered: p\.ordered\.filter\(\(_, i\) => selected\.has\(i\)\)/);
  const cancel = app.slice(app.indexOf('function cancelPending()'), app.indexOf('function openPending('));
  assert.match(cancel, /setPending\(null\)/);
  assert.doesNotMatch(cancel, /dispatch|applyVoiceEdit|applyAiEdits/);
});
