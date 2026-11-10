// Regression tests: "clear Advice" (whole section) vs "remove all medicines" (medicine lines only), for every
// layout of the Advice heading, and the AI can never delete a heading on the first line of a paragraph.
// Dummy data only.   Run:  cd client  &&  node --test tests/
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState } from '@tiptap/pm/state';
import { history, undo, undoDepth } from '@tiptap/pm/history';
import { classifyCommand } from '../src/lib/commandIntent.js';
import { clearSection } from '../src/lib/sectionCommands.js';
import { applyRemovals, removalSummary, textAfter } from '../src/lib/medicineText.js';

// voiceEdit.js imports its neighbours without ".js": a temporary copy with the endings added
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-advice');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'previewEdits', 'medicineText', 'sections']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { medicinesLostByEdits } = await import(pathToFileURL(path.join(tmp, 'previewEdits.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit]);
const t = (s, m) => schema.text(s, m);
const p = (...k) => schema.node('paragraph', null, k);
const B = () => [schema.marks.bold.create()];
const h = (s) => p(t(s, B()));
const br = () => schema.nodes.hardBreak.create();
const lines = (xs) => xs.flatMap((l, i) => (i ? [br(), t(l)] : [t(l)]));
const DOLO = 'Tab. DOLO (Paracetamol) 650 mg — Oral — Twice Daily (1-0-1) — 3 days';
const SYP = 'Syp. INSTARAFT (Antacid) 10 ml — Oral — TDS — 5 days';
const REVIEW = 'Review in OPD after 1 week';
const START = () => [h('DISCHARGE SUMMARY'), h('DIAGNOSIS'), p(t('ENTERIC FEVER')), h('COURSE IN HOSPITAL'), p(t('Patient is stable.'))];
const END = () => [h('FOLLOW UP'), p(t('OPD on Monday'))];
// the four ways the Advice heading appears in Word files
const LAYOUTS = {
  'separate heading, medicines in one paragraph': { heading: 'ADVICE', kids: () => [...START(), h('ADVICE'), p(...lines([DOLO, SYP, REVIEW])), ...END()] },
  '"ADVICE :" heading, one paragraph per line': { heading: 'ADVICE :', kids: () => [...START(), h('ADVICE :'), p(t(DOLO)), p(t(SYP)), p(t(REVIEW)), ...END()] },
  'heading in the SAME paragraph (ADVICE↵Tab ...)': { heading: 'ADVICE', kids: () => [...START(), p(t('ADVICE', B()), br(), ...lines([DOLO, SYP, REVIEW])), ...END()] },
  'inline label (Advice : Tab ...)': { heading: 'Advice : ', kids: () => [...START(), p(t('Advice : ', B()), ...lines([DOLO, SYP, REVIEW])), ...END()] },
};
const makeEditor = (kids) => {
  const doc = schema.node('doc', null, kids);
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), isDestroyed: true, schema };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return { ed, doc };
};
// the document as lines of text (line breaks inside a paragraph become separate lines, marked with ↵)
const text = (doc) => { const out = []; doc.forEach((n) => { let s = ''; n.forEach((c) => { s += c.isText ? c.text : '↵'; }); out.push(s); }); return out; };
const untouched = (doc) => {
  const all = text(doc);
  for (const x of ['DISCHARGE SUMMARY', 'DIAGNOSIS', 'ENTERIC FEVER', 'COURSE IN HOSPITAL', 'Patient is stable.', 'FOLLOW UP', 'OPD on Monday']) assert.ok(all.includes(x), x);
};

// ---------- 1. clear the whole Advice section ----------
// the approved rules: these four clear the WHOLE section ...
const CLEAR = ['Clear Advice.', 'Clear the Advice section.', 'Empty Advice.', 'Empty the Advice section.'];
for (const [name, L] of Object.entries(LAYOUTS)) {
  test(`CLEAR ADVICE (${name}): confirmation first, then ALL content removed, heading kept exactly, one Undo`, () => {
    for (const c of CLEAR) {
      const { ed, doc } = makeEditor(L.kids());
      const r = classifyCommand(doc, c);
      assert.equal(r.type, 'clear', `${c}: ${r.question || ''}`);
      assert.equal(r.confirm, true, c); // the window opens first; nothing changed yet
      assert.ok(ed.state.doc.eq(doc), c);
      assert.deepEqual(r.preview.lines.map((l) => l.text), [DOLO, SYP, REVIEW], c); // what the window lists (not the heading)
      assert.equal(r.preview.medicines, 2, c);
      const out = clearSection(ed, r.section);
      assert.equal(out.ok, true, `${c}: ${out.error || ''}`);
      const all = text(ed.state.doc);
      const at = all.findIndex((x) => x.startsWith(L.heading.trim()));
      assert.ok(at >= 0, `${c}: heading kept`);
      assert.equal(all[at].replace(/↵$/, ''), L.heading.trim() === 'ADVICE :' ? 'ADVICE :' : L.heading, `${c}: heading text unchanged`);
      assert.ok(!all.join('\n').includes('DOLO') && !all.join('\n').includes(REVIEW), `${c}: everything under Advice removed`);
      untouched(ed.state.doc);
      assert.equal(undoDepth(ed.state), 1, c);
      undo(ed.state, ed.view.dispatch);
      assert.ok(ed.state.doc.eq(doc), `${c}: one Undo restores everything`);
    }
  });
}

// ---------- 2. remove all medicines (only the medicine lines) ----------
// ... and these remove only the MEDICINE entries (non-medicine advice text and the heading stay)
const ALL_MEDS = ['Clear all the medicines.', 'Empty the advice', 'Remove everything from advice', 'Remove all the medicine.',
  'Remove all medicines from Advice.', 'Remove all medicines', 'please remove all the medicines from the advice section', 'Remove everything from the advice.'];
for (const [name, L] of Object.entries(LAYOUTS)) {
  test(`REMOVE ALL MEDICINES (${name}): only medicine lines go; heading, review text and other sections stay; one Undo`, () => {
    for (const c of ALL_MEDS) {
      const { ed, doc } = makeEditor(L.kids());
      const r = classifyCommand(doc, c);
      assert.equal(r.type, 'remove', `${c}: ${r.question || ''}`);
      assert.equal(r.kind, 'entries', c); // the existing confirm window for whole medicines
      assert.deepEqual(r.plan.changes.map((ch) => ch.before.trim()), [DOLO, SYP], c);
      assert.ok(ed.state.doc.eq(doc), c); // nothing changed before Apply
      assert.equal(applyRemovals(ed, r.plan).ok, true, c);
      const all = text(ed.state.doc);
      assert.ok(!all.join('\n').includes('DOLO') && !all.join('\n').includes('INSTARAFT'), `${c}: medicines removed`);
      assert.ok(all.join('\n').includes(REVIEW), `${c}: non-medicine advice kept`);
      assert.ok(all.some((x) => x.startsWith(L.heading.trim())), `${c}: heading kept`);
      untouched(ed.state.doc);
      assert.equal(removalSummary(r.plan, r.kind), 'Removed 2 medicines.', c);
      assert.equal(undoDepth(ed.state), 1, c);
      undo(ed.state, ed.view.dispatch);
      assert.ok(ed.state.doc.eq(doc), `${c}: one Undo restores everything`);
    }
  });
}

test('remove all medicines: the exact text that remains (heading + review line, line breaks tidy)', () => {
  const after1 = (L) => { const { ed, doc } = makeEditor(L.kids()); applyRemovals(ed, classifyCommand(doc, 'Remove all medicines from Advice.').plan); return text(ed.state.doc); };
  assert.ok(after1(LAYOUTS['separate heading, medicines in one paragraph']).includes(REVIEW));
  assert.ok(after1(LAYOUTS['heading in the SAME paragraph (ADVICE↵Tab ...)']).includes(`ADVICE↵${REVIEW}`));
  assert.ok(after1(LAYOUTS['inline label (Advice : Tab ...)']).includes(`Advice : ${REVIEW}`));
});

// ---------- 3. never confused with other commands ----------
test('not confused: frequency removal, timing question, one type, exceptions, a second job', () => {
  const { doc } = makeEditor(LAYOUTS['separate heading, medicines in one paragraph'].kids());
  const freq = classifyCommand(doc, 'remove frequency from all medicines');
  assert.equal(freq.kind, 'phrases');
  assert.deepEqual(freq.intent.categories, ['frequency']);
  assert.ok(freq.plan.changes.flatMap((c) => c.removals).filter((x) => x.kind === 'pattern').every((x) => !x.selected)); // patterns unticked
  assert.equal(textAfter(freq.plan.changes[0]), 'Tab. DOLO (Paracetamol) 650 mg — Oral — (1-0-1) — 3 days');
  assert.equal(classifyCommand(doc, 'remove timing from all medicine').type, 'ask');
  const syp = classifyCommand(doc, 'remove all syrups');
  assert.deepEqual(syp.plan.changes.map((c) => c.before), [SYP]);
  for (const c of ['remove all medicines from advice except dolo', 'remove all medicines but keep dolo', 'remove all medicines from advice and add Tab. PAN 40 mg']) {
    const r = classifyCommand(doc, c);
    assert.ok(!(r.type === 'remove' && r.intent?.all), c); // never "every medicine"
  }
});

test('Advice cannot be identified -> asks, never another section, never an AI edit', () => {
  const { doc } = makeEditor([...START(), ...END()]);
  for (const c of ['Clear Advice.', 'Empty the Advice section.', 'Remove all medicines from Advice.']) {
    const r = classifyCommand(doc, c);
    assert.equal(r.type, 'ask', c);
    assert.match(r.question, /could not find the Advice section clearly|could not find any medicines/, c);
  }
  // Advice with no medicine: "remove all medicines" asks; "clear advice" still clears (with confirmation)
  const { doc: noMeds } = makeEditor([...START(), h('ADVICE'), p(t(REVIEW)), ...END()]);
  assert.match(classifyCommand(noMeds, 'Remove all medicines from Advice.').question, /There are no medicines in Advice/);
  const clear = classifyCommand(noMeds, 'Clear Advice.');
  assert.equal(clear.type, 'clear');
  assert.equal(clear.confirm, true);
});

test('"Empty Advice" clears the whole section; "Empty the advice" removes only the medicines', () => {
  const { doc } = makeEditor(LAYOUTS['separate heading, medicines in one paragraph'].kids());
  assert.equal(classifyCommand(doc, 'Empty Advice.').type, 'clear');
  assert.equal(classifyCommand(doc, 'Empty the Advice section.').type, 'clear');
  const meds = classifyCommand(doc, 'Empty the advice');
  assert.equal(meds.type, 'remove');
  assert.equal(meds.intent.all, true);
});

// ---------- 4. an AI edit can never remove several medicines without the confirmation window ----------
test('AI edits, heading in the SAME paragraph: the medicine guard now applies (no silent removal of the medicines)', () => {
  const id = (ed, start) => `B${text(ed.state.doc).findIndex((x) => x.startsWith(start))}`;
  for (const [layout, head] of [['heading in the SAME paragraph (ADVICE↵Tab ...)', 'ADVICE'], ['inline label (Advice : Tab ...)', 'Advice : ']]) {
    for (const e of [{ operation: 'set', new_value: head }, { operation: 'set', new_value: `${head}${REVIEW}` }, { operation: 'clear' }]) {
      const { ed, doc } = makeEditor(LAYOUTS[layout].kids());
      const r = applyVoiceEdit(ed, { block_id: id(ed, head.trim()), field_label: 'Advice', ...e });
      assert.equal(r.ok, false, `${layout} ${JSON.stringify(e)}`);
      assert.ok(ed.state.doc.eq(doc), `${layout} ${JSON.stringify(e)}: nothing changed`);
    }
  }
});

test('AI edits removing 2+ medicines in ANY layout (one medicine per paragraph too) are refused; one medicine as before', () => {
  const { ed, doc } = makeEditor(LAYOUTS['"ADVICE :" heading, one paragraph per line'].kids());
  const id = (start) => `B${text(doc).findIndex((x) => x.startsWith(start))}`;
  // each paragraph holds ONE medicine, so the per-paragraph guard alone would allow each clear
  const both = [{ block_id: id('Syp.'), operation: 'clear', field_label: 'Advice' }, { block_id: id('Tab. DOLO'), operation: 'clear', field_label: 'Advice' }];
  assert.equal(medicinesLostByEdits(doc, both), 2); // -> App refuses: nothing applied
  assert.equal(medicinesLostByEdits(doc, [both[0]]), 1); // one medicine: unchanged behaviour (allowed)
  assert.equal(medicinesLostByEdits(doc, [{ block_id: id('Review'), operation: 'set', new_value: 'Review in OPD after 2 weeks', field_label: 'Advice' }]), 0);
  assert.ok(ed.state.doc.eq(doc)); // the dry run never touches the document
});

// ---------- 5. the AI can never delete a heading on the first line of a paragraph ----------
test('AI edits: a first-line heading ("ADVICE↵...", "DIAGNOSIS↵...") cannot be removed or renamed; the text after it can change', () => {
  const kids = [...START(), p(t('ADVICE', B()), br(), ...lines([DOLO, SYP])), p(t('DIAGNOSIS'), br(), t('ENTERIC FEVER'), br(), t('SEPSIS')), ...END()];
  const id = (ed, start) => `B${text(ed.state.doc).findIndex((x) => x.startsWith(start))}`;
  for (const e of [{ operation: 'clear' }, { operation: 'set', new_value: '' }, { operation: 'set', new_value: 'RECOMMENDATIONS' }]) {
    const { ed, doc } = makeEditor(kids);
    const r = applyVoiceEdit(ed, { block_id: id(ed, 'ADVICE'), field_label: 'Advice', ...e });
    assert.equal(r.ok, false, JSON.stringify(e));
    assert.match(r.error, /heading "ADVICE" is locked/);
    assert.ok(ed.state.doc.eq(doc));
  }
  // capital-letter CONTENT is not a heading: "ENTERIC FEVER" can still be corrected; DIAGNOSIS stays
  const { ed } = makeEditor(kids);
  const r = applyVoiceEdit(ed, { block_id: id(ed, 'DIAGNOSIS↵'), operation: 'replace_text', find_text: 'ENTERIC FEVER', new_value: 'TYPHOID FEVER', field_label: 'Diagnosis' });
  assert.equal(r.ok, true, r.error);
  assert.ok(text(ed.state.doc).includes('DIAGNOSIS↵TYPHOID FEVER↵SEPSIS'));
});
