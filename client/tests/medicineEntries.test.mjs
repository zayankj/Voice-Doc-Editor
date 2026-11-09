// Tests for medicine ENTRIES and instruction CATEGORIES in src/lib/medicineText.js
// (medicines in one paragraph with line breaks, separate paragraphs, mixed; route/frequency; exact positions)
// Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState } from '@tiptap/pm/state';
import { history, undo } from '@tiptap/pm/history';
import {
  entriesOfBlock, planRemoval, applyRemovals, textAfter, categoryOfTerm, sectionEntries,
} from '../src/lib/medicineText.js';
import { getBlocks } from '../src/lib/outline.js';
import { getSections } from '../src/lib/sections.js';

const schema = getSchema([StarterKit]);
const BOLD = () => [schema.marks.bold.create()];
const t = (s, marks) => schema.text(s, marks);
const br = () => schema.nodes.hardBreak.create();
const para = (...kids) => schema.node('paragraph', null, kids);
const heading = (s) => para(t(s, BOLD()));
// one paragraph, medicines separated by line breaks (how Word line breaks arrive in the editor)
const brPara = (lines) => para(...lines.flatMap((l, i) => (i ? [br(), t(l)] : [t(l)])));

const ADVICE = [
  'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — Twice Daily (1-0-1) — 2 days',
  'Tab. METRONIDAZOLE (Metronidazole) 500 mg — Oral — Three Times Daily (1-1-1) — 2 days',
  'Syp. INSTARAFT (Antacid) 10 ml — Oral — Three Times Daily (1-1-1) — 5 days — 10 mins after food',
  'Tab. ZINCOVIT (Multivitamin/Mineral) — Oral — Once Daily (1-0-0) — 14 days',
  'Tab. BACTOGUT (Probiotic) — Oral — Once Daily (1-0-0) — 7 days',
  'Tab. DOLO (Paracetamol) 650 mg — Oral — As Needed (SOS)',
  'AZIPROPROTEIN POWDER (Protein Supplement) 2 scoops — Oral — Twice Daily (1-0-1) — 1 week',
  'Tab. CIPLOX 500 mg — Oral — Twice Daily (1-0-1) — 3 days',
];
const DIAG = 'ENTERIC FEVER (A01.0: Typhoid fever), SEPSIS - RESOLVED';
const COURSE = 'Started on oral antibiotics twice daily. Oral intake improved.';

function editorWith(adviceBlocks) {
  const doc = schema.node('doc', null, [heading('DIAGNOSIS'), para(t(DIAG)), heading('COURSE IN HOSPITAL'), para(t(COURSE)), heading('ADVICE'), ...adviceBlocks]);
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), isDestroyed: false };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
}
const advice = (ed) => getSections(ed.state.doc).find((s) => s.title === 'ADVICE');
const entryTexts = (ed) => sectionEntries(ed.state.doc, advice(ed)).map((e) => e.text);
const otherBlocks = (ed) => getBlocks(ed.state.doc).slice(0, 5).map((b) => b.node.textContent);
const plan = (ed, opts) => planRemoval(ed.state.doc, advice(ed), opts);
const done = (ed) => { ed.isDestroyed = true; };

const GENERIC_AFTER = [
  'Tab. CIPLOX 200 mg — Oral — Twice Daily (1-0-1) — 2 days',
  'Tab. METRONIDAZOLE 500 mg — Oral — Three Times Daily (1-1-1) — 2 days',
  ADVICE[2], ADVICE[3], ADVICE[4], // descriptions stay
  'Tab. DOLO 650 mg — Oral — As Needed (SOS)',
  ADVICE[6], ADVICE[7],
];

// ---------- entries ----------
test('one paragraph with line breaks -> 8 separate medicine entries (not one long line)', () => {
  const ed = editorWith([brPara(ADVICE)]);
  assert.deepEqual(entryTexts(ed), ADVICE);
  done(ed);
});

test('a glued line "... 2 daysTab. METRONIDAZOLE ..." is split into two medicines', () => {
  const ed = editorWith([para(t(ADVICE[0] + ADVICE[1]))]);
  assert.deepEqual(entryTexts(ed), [ADVICE[0], ADVICE[1]]);
  done(ed);
});

test('mixed: some medicines in one paragraph with breaks, others in their own paragraphs', () => {
  const ed = editorWith([brPara(ADVICE.slice(0, 3)), para(t(ADVICE[3])), brPara(ADVICE.slice(4))]);
  assert.deepEqual(entryTexts(ed), ADVICE);
  done(ed);
});

// ---------- generic names across ALL entries, in every layout ----------
for (const [name, blocks] of [
  ['one paragraph with line breaks', () => [brPara(ADVICE)]],
  ['separate paragraphs', () => ADVICE.map((l) => para(t(l)))],
  ['mixed', () => [brPara(ADVICE.slice(0, 3)), para(t(ADVICE[3])), brPara(ADVICE.slice(4))]],
]) {
  test(`generic names from ALL entries (${name}); descriptions shown but NOT ticked`, () => {
    const ed = editorWith(blocks());
    const p = plan(ed, { categories: ['generic'] });
    const ticked = p.changes.flatMap((c) => c.removals.filter((r) => r.selected).map((r) => r.text));
    const shownNotTicked = p.changes.flatMap((c) => c.removals.filter((r) => !r.selected).map((r) => r.text));
    assert.deepEqual(ticked, ['(Ciprofloxacin)', '(Metronidazole)', '(Paracetamol)']);
    assert.deepEqual(shownNotTicked, ['(Antacid)', '(Multivitamin/Mineral)', '(Probiotic)', '(Protein Supplement)']);
    assert.equal(p.changes.length + p.unchanged.length, 8); // every medicine entry was inspected
    const before = otherBlocks(ed);
    assert.equal(applyRemovals(ed, p).ok, true);
    assert.deepEqual(entryTexts(ed), GENERIC_AFTER);
    assert.deepEqual(otherBlocks(ed), before); // other sections and the ADVICE heading unchanged
    done(ed);
  });
}

test('line breaks are kept: still one paragraph with 7 line breaks after the removal', () => {
  const ed = editorWith([brPara(ADVICE)]);
  applyRemovals(ed, plan(ed, { categories: ['generic'] }));
  const last = ed.state.doc.lastChild;
  let breaks = 0;
  last.forEach((n) => { if (n.type.name === 'hardBreak') breaks++; });
  assert.equal(breaks, 7);
  done(ed);
});

test('character positions stay exact with bold text inside an entry (bold brand kept bold)', () => {
  const p1 = para(t('Tab. '), t('CIPLOX', BOLD()), t(' (Ciprofloxacin) 200 mg — Oral — Twice Daily (1-0-1) — 2 days'), br(),
    t('Tab. '), t('DOLO', BOLD()), t(' (Paracetamol) 650 mg — Oral — As Needed (SOS)'));
  const ed = editorWith([p1]);
  applyRemovals(ed, plan(ed, { categories: ['generic', 'route', 'frequency'] }));
  assert.deepEqual(entryTexts(ed), ['Tab. CIPLOX 200 mg — (1-0-1) — 2 days', 'Tab. DOLO 650 mg — As Needed (SOS)']);
  const boldWords = [];
  ed.state.doc.lastChild.forEach((n) => { if (n.isText && n.marks.some((m) => m.type.name === 'bold')) boldWords.push(n.text); });
  assert.deepEqual(boldWords, ['CIPLOX', 'DOLO']);
  done(ed);
});

// ---------- route and frequency categories ----------
test('categories: example terms are recognised', () => {
  assert.equal(categoryOfTerm('Oral'), 'route');
  assert.equal(categoryOfTerm('IV'), 'route');
  assert.equal(categoryOfTerm('Twice Daily'), 'frequency');
  assert.equal(categoryOfTerm('three times daily'), 'frequency');
  assert.equal(categoryOfTerm('BD'), 'frequency');
  assert.equal(categoryOfTerm('SOS'), 'as_needed');
  assert.equal(categoryOfTerm('after food'), 'food');
  assert.equal(categoryOfTerm('Ciprofloxacin'), null);
});

test('route + frequency removed from every entry; keeps names, strengths, (1-0-1), durations, SOS, "after food"', () => {
  const ed = editorWith([brPara(ADVICE)]);
  applyRemovals(ed, plan(ed, { categories: ['route', 'frequency'] }));
  assert.deepEqual(entryTexts(ed), [
    'Tab. CIPLOX (Ciprofloxacin) 200 mg — (1-0-1) — 2 days',
    'Tab. METRONIDAZOLE (Metronidazole) 500 mg — (1-1-1) — 2 days',
    'Syp. INSTARAFT (Antacid) 10 ml — (1-1-1) — 5 days — 10 mins after food',
    'Tab. ZINCOVIT (Multivitamin/Mineral) — (1-0-0) — 14 days',
    'Tab. BACTOGUT (Probiotic) — (1-0-0) — 7 days',
    'Tab. DOLO (Paracetamol) 650 mg — As Needed (SOS)',
    'AZIPROPROTEIN POWDER (Protein Supplement) 2 scoops — (1-0-1) — 1 week',
    'Tab. CIPLOX 500 mg — (1-0-1) — 3 days',
  ]);
  done(ed);
});

test('generic + route + frequency together gives your example line', () => {
  const ed = editorWith([para(t(ADVICE[0]))]);
  const p = plan(ed, { categories: ['generic', 'route', 'frequency'] });
  assert.equal(textAfter(p.changes[0]), 'Tab. CIPLOX 200 mg — (1-0-1) — 2 days');
  done(ed);
});

test('other spellings of frequency and route are found too (not only the examples)', () => {
  const lines = [
    'Tab. A 5 mg — PO — BD — 5 days', 'Inj. B 1 g — IV — every 8 hours — 3 days', 'Tab. C 10 mg — Orally — Thrice Daily',
    'Tab. D 1 mg — once a day — at bedtime', 'Inj. E 40 mg — SC — OD', 'Cap. F 20 mg — Twice a day (1-0-1) — 7 days',
  ];
  const ed = editorWith([brPara(lines)]);
  applyRemovals(ed, plan(ed, { categories: ['route', 'frequency'] }));
  assert.deepEqual(entryTexts(ed), ['Tab. A 5 mg — 5 days', 'Inj. B 1 g — 3 days', 'Tab. C 10 mg', 'Tab. D 1 mg', 'Inj. E 40 mg', 'Cap. F 20 mg — (1-0-1) — 7 days']);
  done(ed);
});

test('brand names are never touched by short abbreviations (IMOL, Inj. IV PARACETAMOL)', () => {
  const ed = editorWith([brPara(['Tab. IMOL 500 mg — IM — OD', 'Inj. IV PARACETAMOL 1 g — IV — BD'])]);
  applyRemovals(ed, plan(ed, { categories: ['route', 'frequency'] }));
  assert.deepEqual(entryTexts(ed), ['Tab. IMOL 500 mg', 'Inj. IV PARACETAMOL 1 g']);
  done(ed);
});

test('As Needed (SOS) and food timing are kept unless asked; removed when asked', () => {
  const ed = editorWith([brPara([ADVICE[2], ADVICE[5]])]);
  assert.equal(plan(ed, { categories: ['route', 'frequency'] }).changes.every((c) => c.removals.every((r) => !/SOS|food/i.test(r.text))), true);
  const p = plan(ed, { categories: ['as_needed', 'food'] });
  assert.deepEqual(p.changes.map(textAfter), ['Syp. INSTARAFT (Antacid) 10 ml — Oral — Three Times Daily (1-1-1) — 5 days', 'Tab. DOLO (Paracetamol) 650 mg — Oral']);
  done(ed);
});

test('descriptions are removed only when asked for explicitly', () => {
  const ed = editorWith([brPara(ADVICE)]);
  const p = plan(ed, { categories: ['description'] });
  assert.deepEqual(p.changes.flatMap((c) => c.removals.filter((r) => r.selected).map((r) => r.text)), ['(Antacid)', '(Multivitamin/Mineral)', '(Probiotic)', '(Protein Supplement)']);
  done(ed);
});

test('literal phrases: "Twice Daily, Once Daily and Three Times Daily" only those, across all entries', () => {
  const ed = editorWith([brPara(ADVICE)]);
  const p = plan(ed, { phrases: ['Twice Daily', 'Once Daily', 'Three Times Daily'] });
  applyRemovals(ed, p);
  assert.ok(entryTexts(ed).every((x) => !/twice daily|once daily|three times daily/i.test(x)));
  assert.ok(entryTexts(ed).every((x, i) => i === 7 || x.includes('Oral'))); // route not touched
  assert.equal(entryTexts(ed)[0], 'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — (1-0-1) — 2 days');
  done(ed);
});

test('other sections are never changed (Course in Hospital says "oral" and "twice daily")', () => {
  const ed = editorWith([brPara(ADVICE)]);
  const before = otherBlocks(ed);
  applyRemovals(ed, plan(ed, { categories: ['route', 'frequency', 'generic'] }));
  assert.deepEqual(otherBlocks(ed), before);
  done(ed);
});

test('nothing found -> no changes, and the category is reported as not found', () => {
  const ed = editorWith([brPara(['Tab. A 5 mg — 5 days'])]);
  const p = plan(ed, { categories: ['route'] });
  assert.equal(p.changes.length, 0);
  assert.deepEqual(p.notFound, ['route']);
  done(ed);
});

test('ONE Undo restores everything, including the line breaks', () => {
  const ed = editorWith([brPara(ADVICE)]);
  const original = ed.state.doc;
  applyRemovals(ed, plan(ed, { categories: ['generic', 'route', 'frequency'] }));
  undo(ed.state, ed.view.dispatch);
  assert.ok(ed.state.doc.eq(original));
  done(ed);
});

test('an entry changed after the preview -> nothing applied', () => {
  const ed = editorWith([brPara(ADVICE)]);
  const p = plan(ed, { categories: ['generic'] });
  const b = getBlocks(ed.state.doc).at(-1);
  ed.view.dispatch(ed.state.tr.insertText('X', b.pos + 1));
  const snapshot = ed.state.doc;
  assert.equal(applyRemovals(ed, p).ok, false);
  assert.ok(ed.state.doc.eq(snapshot));
  done(ed);
});

test('entriesOfBlock keeps exact document positions for every character', () => {
  const ed = editorWith([brPara(ADVICE.slice(0, 2))]);
  const block = getBlocks(ed.state.doc).at(-1);
  for (const e of entriesOfBlock(block, 0)) {
    for (let i = 0; i < e.text.length; i++) assert.equal(ed.state.doc.textBetween(e.map[i], e.map[i] + 1), e.text[i]);
  }
  done(ed);
});
