// Regression tests for uploads (Phase 2): a file never deletes, medicine lists from a prescription,
// the upload preview (a dry run) and its window. The edits are the REAL ones the AI returned in the audit
// (dummy lab image, dummy prescription), replayed on a dummy document. No patient data.
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
const tmp = path.join(here, '.build-upload');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'previewEdits']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit, applyPatientConsistency, getPatientFacts } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
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
const textOf = (ed, i) => {
  const out = [];
  ed.state.doc.descendants((n) => { if (n.isTextblock) { out.push(n); return false; } return true; });
  return out[i];
};
const lines = (node) => { const out = ['']; node.forEach((n) => { if (n.isText) out[out.length - 1] += n.text; else out.push(''); }); return out; };
const FILE = { allowGender: true, fromFile: true };

// ---------- 1. a file never deletes ----------
test('FILE: clearing or emptying a value is refused ("ALP is not in the new report")', () => {
  const ed = makeEditor();
  const before = ed.state.doc;
  for (const e of [
    { block_id: 'B33', operation: 'clear' },
    { block_id: 'B33', operation: 'set', new_value: '' },
    { block_id: 'B27', operation: 'set', new_value: '  ' },
    { block_id: 'B39', operation: 'replace_text', find_text: 'Patient is stable.', new_value: '' },
  ]) {
    const r = applyVoiceEdit(ed, e, FILE);
    assert.equal(r.blocked, true, JSON.stringify(e));
    assert.match(r.error, /cannot delete/);
  }
  assert.ok(ed.state.doc.eq(before));
  done(ed);
});

test('FILE: a paragraph of text cannot be replaced with different text, but text may be added to it', () => {
  const ed = makeEditor();
  const r = applyVoiceEdit(ed, { block_id: 'B39', operation: 'set', new_value: 'Patient was given antibiotics.' }, FILE);
  assert.match(r.error, /replace the existing text/);
  assert.equal(textOf(ed, 39).textContent, COURSE);
  applyVoiceEdit(ed, { block_id: 'B39', operation: 'append', new_value: 'CRP was 48.9.' }, FILE);
  assert.equal(textOf(ed, 39).textContent, `${COURSE} CRP was 48.9.`);
  applyVoiceEdit(ed, { block_id: 'B39', operation: 'set', new_value: `${COURSE} CRP was 48.9. Discharged.` }, FILE); // keeps the old text
  assert.equal(textOf(ed, 39).textContent, `${COURSE} CRP was 48.9. Discharged.`);
  done(ed);
});

test('FILE: table values and short fields can still change (they go through the preview)', () => {
  const ed = makeEditor();
  assert.equal(applyVoiceEdit(ed, { block_id: 'B25', operation: 'set', new_value: '2.4 MG/DL' }, FILE).ok, true);
  assert.equal(applyVoiceEdit(ed, { block_id: 'B14', operation: 'set', new_value: 'ENTERIC FEVER, MALARIA' }, FILE).ok, true);
  assert.equal(textOf(ed, 25).textContent, '2.4 MG/DL');
  assert.equal(textOf(ed, 14).textContent, 'ENTERIC FEVER, MALARIA');
  done(ed);
});

test('TYPED / SPOKEN commands are not affected: clearing and rewriting still work', () => {
  const ed = makeEditor();
  assert.equal(applyVoiceEdit(ed, { block_id: 'B33', operation: 'clear' }).ok, true);
  assert.equal(applyVoiceEdit(ed, { block_id: 'B39', operation: 'set', new_value: 'Patient recovered.' }).ok, true);
  assert.equal(textOf(ed, 39).textContent, 'Patient recovered.');
  done(ed);
});

// ---------- 2. prescription uploads (the regression) ----------
test('PRESCRIPTION (audit, was blocked 2 of 2): the whole list again + Tab. PAN -> PAN added on its OWN line', () => {
  const ed = makeEditor();
  const r = applyVoiceEdit(ed, { block_id: 'B41', operation: 'set', new_value: `${DOLO}\n${INSTARAFT}\n${PAN}` }, FILE);
  assert.equal(r.ok, true);
  // the preview / History show an ADDITION, not the old list struck out (live replay finding)
  assert.deepEqual([r.before, r.after], ['', PAN]);
  assert.deepEqual(lines(textOf(ed, 41)), [DOLO, INSTARAFT, PAN]);
  let bolds = 0;
  textOf(ed, 41).forEach((n) => { if (n.marks?.length) bolds++; });
  assert.equal(bolds, 1); // the bold brand name of the first line is untouched
  done(ed);
});

test('the AI glued the lines ("...SOSSyp. INSTARAFT...") -> still recognised, PAN added on its own line', () => {
  const ed = makeEditor();
  applyVoiceEdit(ed, { block_id: 'B41', operation: 'set', new_value: `${DOLO}${INSTARAFT} ${PAN}` }, FILE);
  assert.deepEqual(lines(textOf(ed, 41)), [DOLO, INSTARAFT, PAN]);
  done(ed);
});

test('a changed dose in the list -> ONLY that line changes; line break and bold kept', () => {
  const ed = makeEditor();
  const r = applyVoiceEdit(ed, { block_id: 'B41', operation: 'set', new_value: `${DOLO.replace('650', '500')}\n${INSTARAFT}` }, FILE);
  assert.equal(r.ok, true);
  assert.deepEqual([r.before, r.after], [DOLO, DOLO.replace('650', '500')]); // only that line, old -> new
  assert.deepEqual(lines(textOf(ed, 41)), [DOLO.replace('650', '500'), INSTARAFT]);
  const marked = [];
  textOf(ed, 41).forEach((n) => { if (n.marks?.length) marked.push(n.text); });
  assert.deepEqual(marked, ['DOLO']);
  done(ed);
});

test('a list that LOSES a medicine is refused (removing has its own command and window)', () => {
  const ed = makeEditor();
  const before = ed.state.doc;
  const r = applyVoiceEdit(ed, { block_id: 'B41', operation: 'set', new_value: `${INSTARAFT}\n${PAN}` }, FILE);
  assert.equal(r.blocked, true);
  assert.match(r.error, /contains 2 medicines; the proposed list would remove or rewrite medicines/);
  assert.ok(ed.state.doc.eq(before));
  done(ed);
});

test('the same list again -> nothing changes; medicines in separate paragraphs -> the new one is a new paragraph', () => {
  let ed = makeEditor();
  const before = ed.state.doc;
  assert.equal(applyVoiceEdit(ed, { block_id: 'B41', operation: 'set', new_value: `${DOLO}\n${INSTARAFT}` }, FILE).unchanged, true);
  assert.ok(ed.state.doc.eq(before));
  done(ed);
  ed = makeEditor(makeDoc([p(DOLO), p(INSTARAFT)]));
  applyVoiceEdit(ed, { block_id: 'B42', operation: 'set', new_value: `${INSTARAFT}\n${PAN}` }, FILE);
  assert.equal(textOf(ed, 42).textContent, INSTARAFT);
  assert.equal(textOf(ed, 43).textContent, PAN);
  done(ed);
});

// ---------- 3. the preview is a TRUE dry run ----------
// the image upload of the audit: values aimed at the label cells, a new CRP row, "clear ALP"
const IMAGE_EDITS = [
  { block_id: 'B37', operation: 'insert_after', new_value: 'CRP | 48.9 MG/L', field_label: 'CRP' },
  { block_id: 'B32', operation: 'clear', field_label: 'ALP' },
  { block_id: 'B24', operation: 'set', new_value: '2.4 MG/DL', field_label: 'Serum Creatinine' },
  { block_id: 'B22', operation: 'set', new_value: '2,10,000/CUMM', field_label: 'Platelet Count' },
];

test('PREVIEW: the real document and its Undo history are NOT touched', () => {
  const ed = makeEditor();
  const before = ed.state;
  const pv = previewEdits(ed.state.doc, IMAGE_EDITS, FILE);
  assert.equal(ed.state, before); // the very same state object: nothing was dispatched
  assert.equal(undoDepth(ed.state), 0);
  assert.deepEqual(pv.items.map((i) => [i.field, i.before, i.after, i.patient]), [
    ['CRP', '', 'CRP | 48.9 MG/L', false],
    ['SERUM CREATININE', '1.9 MG/DL', '2.4 MG/DL', false],
    ['PLATELET COUNT', '3,86,000/CUMM', '2,10,000/CUMM', false],
  ]);
  assert.deepEqual(pv.blocked.map((b) => b.field), ['ALP']);
  done(ed);
});

test('PREVIEW = APPLY: applying the same edits gives exactly the previewed document; ONE Undo restores', () => {
  const ed = makeEditor();
  const original = ed.state.doc;
  const pv = previewEdits(ed.state.doc, IMAGE_EDITS, FILE);
  asOneUndoStep(ed.view, () => {
    for (const e of IMAGE_EDITS) {
      const facts = getPatientFacts(ed.state.doc);
      if (applyVoiceEdit(ed, e, FILE).ok) applyPatientConsistency(ed, facts); // as handleEdit in App.jsx
    }
  });
  assert.ok(ed.state.doc.eq(pv.doc));
  assert.equal(undoDepth(ed.state), 1);
  undo(ed.state, ed.view.dispatch.bind(ed.view));
  assert.ok(ed.state.doc.eq(original));
  done(ed);
});

test('PREVIEW: only the ticked edits are included', () => {
  const pv = previewEdits(makeDoc(), IMAGE_EDITS, { ...FILE, selected: new Set([2]) });
  assert.deepEqual(pv.items.map((i) => i.field), ['SERUM CREATININE']);
});

test('PREVIEW: patient details and gender changes are marked; the age / gender step is listed', () => {
  const edits = [
    { block_id: 'B39', operation: 'append', new_value: 'Discharged in stable condition.', field_label: 'Course' },
    { block_id: 'B12', operation: 'set', new_value: 'IP00019515', field_label: 'IP Number' },
    { block_id: 'B8', operation: 'set', new_value: 'FEMALE', field_label: 'Sex' },
    { block_id: 'B4', operation: 'set', new_value: '41 Y', field_label: 'Age' },
  ];
  const pv = previewEdits(makeDoc(), edits, FILE);
  const byField = Object.fromEntries(pv.items.map((i) => [i.field, i]));
  assert.equal(byField['IP No'].patient, true);
  assert.equal(byField.SEX.patient, true);
  assert.equal(byField.AGE.patient, true);
  assert.equal(byField.COURSE?.patient ?? pv.items.find((i) => i.after.includes('Discharged')).patient, false);
  // the narrative "40-year-old male" follows the header: shown, never silent
  const shown = [...pv.items.flatMap((i) => i.also), ...pv.consistency].map((c) => c.after).join(' | ');
  assert.match(shown, /41-year-old female/i);
});

// ---------- 4. the window ----------
const render = (preview) => renderToStaticMarkup(React.createElement(UploadPreview, {
  fileName: 'lab.png', summary: 'Updated platelet count.', preview,
  recompute: (selected, consistency) => previewEdits(makeDoc(), IMAGE_EDITS, { ...FILE, selected, consistency }),
  onApply() {}, onCancel() {},
}));

test('WINDOW: field, old value struck out, new value, tick box each; "will NOT be applied" list with the reason', () => {
  const html = render(previewEdits(makeDoc(), IMAGE_EDITS, FILE));
  assert.match(html, /Changes from &quot;lab.png&quot;/);
  assert.match(html, /<span>SERUM CREATININE<\/span>.*?<del>1.9 MG\/DL<\/del>.*?→ 2.4 MG\/DL/s);
  assert.equal((html.match(/<input type="checkbox"[^>]*checked=""/g) || []).length, 3); // ordinary changes start ticked
  assert.match(html, /1 change from the file will NOT be applied/);
  assert.match(html, /ALP: an uploaded file cannot delete information/);
  assert.match(html, /3 of 3 changes selected/);
  assert.match(html, /Nothing is changed until you press Apply/);
});

test('WINDOW: patient details start UNTICKED with a warning; Apply is disabled until something is ticked', () => {
  const edits = [{ block_id: 'B8', operation: 'set', new_value: 'FEMALE', field_label: 'Sex' }];
  const html = renderToStaticMarkup(React.createElement(UploadPreview, {
    fileName: 'note.jpg', summary: '', preview: previewEdits(makeDoc(), edits, FILE),
    recompute: (selected, consistency) => previewEdits(makeDoc(), edits, { ...FILE, selected, consistency }),
    onApply() {}, onCancel() {},
  }));
  assert.match(html, /<em>patient detail<\/em>/);
  assert.match(html, /are NOT ticked/);
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /<button class="seg-btn on" disabled="">Apply<\/button>/);
});
