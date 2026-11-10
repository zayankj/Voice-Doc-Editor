// Regression tests: "remove all from Advice" clears the WHOLE Advice section, but only after the user confirms.
// The medicine safety rules for single medicines and for the AI are unchanged. Dummy data only.
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
import { EditorState } from '@tiptap/pm/state';
import { history, undo, undoDepth } from '@tiptap/pm/history';
import { classifyCommand } from '../src/lib/commandIntent.js';
import { clearSection, clearPreview } from '../src/lib/sectionCommands.js';
import { getSections } from '../src/lib/sections.js';
import { getBlocks } from '../src/lib/outline.js';

// voiceEdit.js imports its neighbours without ".js": a temporary copy with the endings added
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-clear');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
await build({
  entryPoints: [path.join(here, '../src/components/ConfirmClear.jsx')],
  outfile: path.join(tmp, 'ConfirmClear.mjs'), format: 'esm', jsx: 'automatic', bundle: true, packages: 'external', logLevel: 'silent',
});
const { default: ConfirmClear } = await import(pathToFileURL(path.join(tmp, 'ConfirmClear.mjs')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit]);
const t = (s, m) => schema.text(s, m);
const para = (...kids) => schema.node('paragraph', null, kids);
const heading = (s) => para(t(s, [schema.marks.bold.create()]));
const br = () => schema.nodes.hardBreak.create();
const ADVICE = [
  'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — Twice Daily (1-0-1) — 2 days',
  'Syp. INSTARAFT (Antacid) 10 ml — Oral — Three Times Daily (1-1-1) — 5 days',
  'Tab. DOLO (Paracetamol) 650 mg — Oral — As Needed (SOS)',
];
// the real layout: medicines in ONE paragraph with line breaks, then a plain advice line
const makeDoc = () => schema.node('doc', null, [
  heading('DISCHARGE SUMMARY'),
  heading('DIAGNOSIS'), para(t('ENTERIC FEVER')),
  heading('COURSE IN HOSPITAL'), para(t('Patient is stable.')), para(t('Oral intake improved.')),
  heading('ADVICE'), para(...ADVICE.flatMap((l, i) => (i ? [br(), t(l)] : [t(l)]))), para(t('Review in OPD after 1 week')),
  heading('FOLLOW UP'), para(t('OPD on Monday')),
]);
function makeEditor() {
  const ed = { state: EditorState.create({ doc: makeDoc(), plugins: [history()] }), isDestroyed: false };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
}
const texts = (ed) => getBlocks(ed.state.doc).map((b) => b.node.textContent);
const under = (ed, h, next) => { const x = texts(ed); return x.slice(x.indexOf(h) + 1, next ? x.indexOf(next) : undefined); };
const cls = (c) => classifyCommand(makeDoc(), c);

// ---------- 1. recognising whole-section commands ----------
test('whole-Advice commands are a clear that NEEDS CONFIRMATION (Advice has medicines)', () => {
  for (const c of [
    'remove all from Advice', 'Remove all from the Advice section.',
    'clear the entire Advice section', 'clear advice', 'delete all from the advice section', 'delete all in advice',
    'remove all of advice', 'remove all the content from advice', 'empty the Advice section', 'wipe advice',
  ]) {
    const r = cls(c);
    assert.equal(r.type, 'clear', c);
    assert.equal(r.section.title.replace(/\s*:\s*$/, ''), 'ADVICE', c);
    assert.equal(r.confirm, true, c);
  }
  // (approved rule) "remove everything from Advice" removes only the MEDICINES (the review line stays)
  const r = cls('remove everything from Advice');
  assert.equal(r.type, 'remove');
  assert.equal(r.kind, 'entries');
  assert.deepEqual(r.plan.changes.map((ch) => ch.before), ADVICE);
});

test('sections WITHOUT medicines still clear at once (no confirmation), as before', () => {
  for (const c of ['remove everything from the course in hospital', 'remove all from course in hospital', 'clear the diagnosis']) {
    const r = cls(c);
    assert.equal(r.type, 'clear', c);
    assert.equal(r.confirm, false, c);
  }
});

test('single-medicine and partial commands are NOT a clear (the medicine window / AI as before)', () => {
  assert.equal(cls('remove all syrups from advice').type, 'remove');
  assert.equal(cls('remove Dolo from advice').type, 'remove');
  assert.equal(cls('remove all oral from advice').type, 'remove');
  assert.equal(cls('remove generic names from Advice').type, 'remove');
  assert.equal(cls('remove all of the old notes from course in hospital').type, 'ai'); // "all of" + not the section name
  assert.equal(cls('add an empty line to advice').type, 'ai');
  assert.notEqual(cls('remove all from advice and add Tab. PAN 40 mg').type, 'clear'); // a second job: never a plain clear
  assert.equal(cls('remove all from the course in hospital and write stable').type, 'ai'); // left to the AI
  assert.equal(cls('Delete the Advice section').type, 'ask'); // a section and its heading cannot be deleted
});

// ---------- 2. the confirmation window ----------
test('the preview lists every line, marks the medicines, and changes nothing', () => {
  const doc = makeDoc();
  const r = classifyCommand(doc, 'remove all from Advice');
  assert.deepEqual(r.preview.lines.map((l) => l.text), [...ADVICE, 'Review in OPD after 1 week']);
  assert.deepEqual(r.preview.lines.map((l) => l.medicine), [true, true, true, false]);
  assert.equal(r.preview.medicines, 3);
  assert.ok(makeDoc().eq(doc)); // the document was not touched
});

test('the window shows the lines, the counts, Cancel and Clear section', () => {
  const preview = clearPreview(makeDoc(), cls('remove all from Advice').section);
  const html = renderToStaticMarkup(React.createElement(ConfirmClear, { preview, onApply() {}, onCancel() {} }));
  assert.match(html, /Clear the Advice section\?/);
  assert.match(html, /3 medicines and 1 other line will be removed\. The Advice heading stays\./);
  for (const l of ADVICE) assert.ok(html.includes(`<del>${l}</del>`), l);
  assert.match(html, />Cancel</);
  assert.match(html, />Clear section</);
});

// ---------- 3. confirm: the whole section, heading kept, ONE undo ----------
test('confirmed: everything under Advice removed, heading kept, other sections untouched, ONE Undo restores it', () => {
  const ed = makeEditor();
  const r = classifyCommand(ed.state.doc, 'remove all from Advice');
  const out = clearSection(ed, r.section);
  ed.isDestroyed = true; // stops the 5-second highlight timer from touching the test editor
  assert.equal(out.ok, true);
  assert.ok(texts(ed).includes('ADVICE'));
  assert.deepEqual(under(ed, 'ADVICE', 'FOLLOW UP'), ['']);
  assert.deepEqual(under(ed, 'FOLLOW UP'), ['OPD on Monday']);
  assert.deepEqual(under(ed, 'COURSE IN HOSPITAL', 'ADVICE'), ['Patient is stable.', 'Oral intake improved.']);
  assert.equal(undoDepth(ed.state), 1); // one step
  undo(ed.state, ed.view.dispatch);
  assert.ok(ed.state.doc.eq(makeDoc())); // everything back, exactly
});

test('Advice as the LAST section is cleared up to the end of the document', () => {
  const doc = schema.node('doc', null, [heading('DISCHARGE SUMMARY'), heading('DIAGNOSIS'), para(t('FEVER')),
    heading('ADVICE'), para(t(ADVICE[0]), br(), t(ADVICE[1]))]);
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), isDestroyed: true };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  const out = clearSection(ed, getSections(doc).find((s) => /ADVICE/.test(s.title)));
  assert.equal(out.ok, true);
  assert.deepEqual(texts(ed), ['DISCHARGE SUMMARY', 'DIAGNOSIS', 'FEVER', 'ADVICE', '']);
});

// ---------- 4. the medicine safety rules are unchanged ----------
test('the AI still cannot clear or overwrite a paragraph with several medicines', () => {
  const ed = makeEditor();
  const id = `B${texts(ed).findIndex((x) => x.startsWith('Tab. CIPLOX'))}`;
  ed.isDestroyed = true;
  assert.equal(applyVoiceEdit(ed, { block_id: id, operation: 'clear' }).blocked, true);
  assert.equal(applyVoiceEdit(ed, { block_id: id, operation: 'set', new_value: 'Tab. PAN 40 mg' }).ok, false);
  assert.ok(ed.state.doc.eq(makeDoc()));
});
