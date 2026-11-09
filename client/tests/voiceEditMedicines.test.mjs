// Tests for medicine lists in src/lib/voiceEdit.js: new medicines on their own line, multi-medicine paragraphs protected
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
import { history, undo, undoDepth } from '@tiptap/pm/history';
import { asOneUndoStep } from '../src/lib/undoStep.js';
import { clearSection } from '../src/lib/sectionCommands.js';
import { getSections } from '../src/lib/sections.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-voiceedit-meds');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit]);
const BOLD = () => [schema.marks.bold.create()];
const t = (s, m) => schema.text(s, m);
const br = () => schema.nodes.hardBreak.create();
const para = (...k) => schema.node('paragraph', null, k);
const heading = (s) => para(t(s, BOLD()));
const brPara = (lines) => para(...lines.flatMap((l, i) => (i ? [br(), t(l)] : [t(l)])));

const ADVICE = [
  'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — Twice Daily (1-0-1) — 2 days',
  'Tab. METRONIDAZOLE (Metronidazole) 500 mg — Oral — Three Times Daily (1-1-1) — 2 days',
  'Syp. INSTARAFT (Antacid) 10 ml — Oral — Three Times Daily (1-1-1) — 5 days',
  'Tab. DOLO (Paracetamol) 650 mg — Oral — As Needed (SOS)',
];
const COURSE = 'Treated with Tab. DOLO and Syp. ONDEM. Patient is stable.';
const NEW_TAB = 'Tab. PAN 40 mg — Oral — Once Daily — 5 days';

// blocks: B0 DIAGNOSIS, B1 text, B2 COURSE IN HOSPITAL, B3 text, B4 ADVICE, B5.. advice, then FOLLOW UP + text
class FakeView { constructor(o) { this.o = o; } dispatch(tr) { this.o.state = this.o.state.apply(tr); } }
function makeEditor(adviceBlocks = [brPara(ADVICE)]) {
  const doc = schema.node('doc', null, [heading('DIAGNOSIS'), para(t('ENTERIC FEVER')), heading('COURSE IN HOSPITAL'), para(t(COURSE)),
    heading('ADVICE'), ...adviceBlocks, heading('FOLLOW UP'), para(t('Review after 5 days'))]);
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), schema, isDestroyed: false };
  ed.view = new FakeView(ed);
  return ed;
}
const child = (ed, i) => ed.state.doc.child(i);
// the lines of a paragraph, split at line breaks
const linesOf = (node) => { const out = ['']; node.forEach((n) => { if (n.isText) out[out.length - 1] += n.text; else out.push(''); }); return out; };
const breaks = (node) => { let n = 0; node.forEach((c) => { if (c.type.name === 'hardBreak') n++; }); return n; };
const done = (ed) => { ed.isDestroyed = true; };

test('adding a tablet to Advice (one paragraph, 4 medicines) -> its OWN line; the other 4 lines unchanged', () => {
  const ed = makeEditor();
  const r = applyVoiceEdit(ed, { block_id: 'B5', operation: 'append', new_value: NEW_TAB });
  assert.equal(r.ok, true);
  assert.deepEqual(linesOf(child(ed, 5)), [...ADVICE, NEW_TAB]);
  assert.equal(breaks(child(ed, 5)), 4);
  done(ed);
});

test('adding a syrup at the end of Advice with insert_after (as the section check does) -> new line in the same list', () => {
  const ed = makeEditor();
  applyVoiceEdit(ed, { block_id: 'B5', operation: 'insert_after', new_value: 'Syp. ONDEM 5 ml — Oral — Three Times Daily — 3 days' });
  assert.deepEqual(linesOf(child(ed, 5)), [...ADVICE, 'Syp. ONDEM 5 ml — Oral — Three Times Daily — 3 days']);
  assert.equal(child(ed, 6).textContent, 'FOLLOW UP'); // no stray paragraph
  done(ed);
});

test('medicines in separate paragraphs -> the new tablet is a new paragraph; the previous medicine unchanged', () => {
  const ed = makeEditor(ADVICE.map((l) => para(t(l))));
  applyVoiceEdit(ed, { block_id: 'B8', operation: 'append', new_value: NEW_TAB });
  assert.equal(child(ed, 8).textContent, ADVICE[3]);
  assert.equal(child(ed, 9).textContent, NEW_TAB);
  done(ed);
});

test('several medicines in one added text -> each on its own line (newline-separated and glued)', () => {
  for (const value of ['Tab. A 5 mg — Oral\nSyp. B 10 ml — Oral', 'Tab. A 5 mg — Oral Syp. B 10 ml — Oral']) {
    const ed = makeEditor();
    applyVoiceEdit(ed, { block_id: 'B5', operation: 'append', new_value: value });
    assert.deepEqual(linesOf(child(ed, 5)).slice(-2), ['Tab. A 5 mg — Oral', 'Syp. B 10 ml — Oral'], value);
    done(ed);
  }
});

test('the AI adds a medicine to the ADVICE heading -> moved under it, on its own line', () => {
  const ed = makeEditor();
  const r = applyVoiceEdit(ed, { block_id: 'B4', operation: 'append', new_value: NEW_TAB });
  assert.equal(r.ok, true);
  assert.equal(child(ed, 4).textContent, 'ADVICE');
  assert.deepEqual(linesOf(child(ed, 5)).at(-1), NEW_TAB);
  done(ed);
});

test('editing ONE medicine (650 mg -> 500 mg) changes only that line; line breaks and bold kept', () => {
  const p = para(t('Tab. '), t('CIPLOX', BOLD()), t(' 200 mg — Oral'), br(), t('Tab. '), t('DOLO', BOLD()), t(' 650 mg — Oral — As Needed (SOS)'));
  const ed = makeEditor([p]);
  const r = applyVoiceEdit(ed, { block_id: 'B5', operation: 'replace_text', find_text: '650 mg', new_value: '500 mg' });
  assert.equal(r.ok, true);
  assert.deepEqual(linesOf(child(ed, 5)), ['Tab. CIPLOX 200 mg — Oral', 'Tab. DOLO 500 mg — Oral — As Needed (SOS)']);
  assert.equal(breaks(child(ed, 5)), 1);
  const bold = []; child(ed, 5).forEach((n) => { if (n.marks?.some((m) => m.type.name === 'bold')) bold.push(n.text); });
  assert.deepEqual(bold, ['CIPLOX', 'DOLO']);
  done(ed);
});

test('set / clear on the whole multi-medicine paragraph -> refused, document unchanged', () => {
  for (const op of [{ operation: 'set', new_value: 'Tab. CIPLOX 200 mg' }, { operation: 'clear' }]) {
    const ed = makeEditor();
    const before = ed.state.doc;
    const r = applyVoiceEdit(ed, { block_id: 'B5', ...op });
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
    assert.match(r.error, /contains 4 medicines/);
    assert.ok(ed.state.doc.eq(before));
    done(ed);
  }
});

test('replace_text spanning two medicine lines (across the line break) -> refused, document unchanged', () => {
  const ed = makeEditor();
  const before = ed.state.doc;
  const r = applyVoiceEdit(ed, { block_id: 'B5', operation: 'replace_text', find_text: '2 daysTab. METRONIDAZOLE', new_value: '2 days' });
  assert.equal(r.blocked, true);
  assert.match(r.error, /more than one medicine line/);
  assert.ok(ed.state.doc.eq(before));
  done(ed);
});

test('replace_text spanning two GLUED medicines in one line -> refused', () => {
  const ed = makeEditor([para(t(ADVICE[0] + ' ' + ADVICE[3]))]);
  const r = applyVoiceEdit(ed, { block_id: 'B5', operation: 'replace_text', find_text: '2 days Tab. DOLO', new_value: '2 days' });
  assert.equal(r.blocked, true);
  done(ed);
});

test('ONE medicine per paragraph: set on that medicine is still allowed', () => {
  const ed = makeEditor(ADVICE.map((l) => para(t(l))));
  const r = applyVoiceEdit(ed, { block_id: 'B8', operation: 'set', new_value: 'Tab. DOLO (Paracetamol) 500 mg — Oral — As Needed (SOS)' });
  assert.equal(r.ok, true);
  assert.equal(child(ed, 8).textContent, 'Tab. DOLO (Paracetamol) 500 mg — Oral — As Needed (SOS)');
  done(ed);
});

test('OTHER sections behave as before: "Tab. ..." text in Course in Hospital is not a medicine list', () => {
  const ed = makeEditor();
  applyVoiceEdit(ed, { block_id: 'B3', operation: 'append', new_value: 'Tab. PAN was also given.' });
  assert.equal(child(ed, 3).textContent, `${COURSE} Tab. PAN was also given.`); // same line, as before
  applyVoiceEdit(ed, { block_id: 'B3', operation: 'set', new_value: 'Patient recovered.' }); // not blocked there
  assert.equal(child(ed, 3).textContent, 'Patient recovered.');
  applyVoiceEdit(ed, { block_id: 'B1', operation: 'append', new_value: ', MALARIA' }); // spacing fix kept
  assert.equal(child(ed, 1).textContent, 'ENTERIC FEVER, MALARIA');
  done(ed);
});

test('a NON-medicine sentence appended in Advice keeps the old behaviour', () => {
  const ed = makeEditor([para(t('Tab. DOLO 650 mg — Oral'))]);
  applyVoiceEdit(ed, { block_id: 'B5', operation: 'append', new_value: 'if fever persists' });
  assert.equal(child(ed, 5).textContent, 'Tab. DOLO 650 mg — Oral if fever persists');
  done(ed);
});

test('ONE Undo (instruction grouped like App.jsx) restores the exact original', () => {
  const ed = makeEditor();
  const original = ed.state.doc;
  asOneUndoStep(ed.view, () => {
    applyVoiceEdit(ed, { block_id: 'B5', operation: 'append', new_value: NEW_TAB });
    applyVoiceEdit(ed, { block_id: 'B5', operation: 'replace_text', find_text: '650 mg', new_value: '500 mg' });
  });
  assert.equal(undoDepth(ed.state), 1);
  undo(ed.state, ed.view.dispatch.bind(ed.view));
  assert.ok(ed.state.doc.eq(original));
  done(ed);
});

test('whole-section clearing (the existing code command) still works on the multi-medicine Advice', () => {
  const ed = makeEditor();
  const advice = getSections(ed.state.doc).find((s) => s.title === 'ADVICE');
  const r = clearSection(ed, advice);
  assert.equal(r.ok, true);
  assert.equal(child(ed, 4).textContent, 'ADVICE');
  assert.equal(child(ed, 5).textContent, ''); // emptied
  assert.equal(child(ed, 6).textContent, 'FOLLOW UP');
  done(ed);
});
