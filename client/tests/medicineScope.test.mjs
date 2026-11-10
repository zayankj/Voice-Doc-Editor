// Option 1: medicine scope, frequency removal and numeric dosing patterns (code path, no AI). Dummy data only.
// Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState } from '@tiptap/pm/state';
import { history, undo, undoDepth } from '@tiptap/pm/history';
import { classifyCommand } from '../src/lib/commandIntent.js';
import { applyRemovals, textAfter, removalSummary, DOSING_PATTERN, planRemoval } from '../src/lib/medicineText.js';
import { getSections } from '../src/lib/sections.js';

const schema = getSchema([StarterKit]);
const t = (s, m) => schema.text(s, m);
const para = (...kids) => schema.node('paragraph', null, kids);
const heading = (s) => para(t(s, [schema.marks.bold.create()]));
const br = () => schema.nodes.hardBreak.create();
// every medicine type, a dosing pattern on most lines, food timing, SOS, IV, and one line WITHOUT a type word
const ADVICE = [
  'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — Twice Daily (1-0-1) — 2 days',
  'Tab. PAN 40 mg — Oral — Once Daily (1-0-0) — before breakfast — 5 days',
  'Syp. INSTARAFT (Antacid) 10 ml — Oral — Three Times Daily (1-1-1) — 5 days',
  'Cap. BIFILAC — Oral — OD — 7 days',
  'Inj. MONOCEF 1 g — IV — BD — 3 days',
  'Drops. MOXI — Topical — QID — 5 days',
  'Tab. DOLO (Paracetamol) 650 mg — Oral — As Needed (SOS)',
  'Tab. ZINC 20 mg — Oral — every 8 hours — HS (0-0-1) — 10 days',
  'ZINCOFER 20 mg — Oral — TDS — till 12-05-2026',
];
const makeDoc = () => schema.node('doc', null, [
  heading('DIAGNOSIS'), para(t('ENTERIC FEVER')),
  heading('COURSE IN HOSPITAL'), para(t('Oral intake improved. Twice daily dressing.')),
  heading('ADVICE'), para(...ADVICE.flatMap((l, i) => (i ? [br(), t(l)] : [t(l)]))), para(t('Review in OPD after 1 week')),
]);
const cls = (c, opts) => classifyCommand(makeDoc(), c, opts);
// the text of every medicine line after the plan (lines not in the plan stay as they are)
const after = (r) => {
  const map = new Map(r.plan.changes.map((ch) => [ch.before, textAfter(ch)]));
  return ADVICE.map((l) => map.get(l) ?? l);
};
const posOf = (doc, start) => { let at = -1; doc.descendants((n, p) => { if (n.isText && n.text.startsWith(start)) at = p + 2; }); return at; };
// medical details that must NEVER change: names, generics, strengths, durations, food timing, SOS, dates
const DETAILS = [/Tab\. CIPLOX \(Ciprofloxacin\) 200 mg/, /2 days/, /Tab\. PAN 40 mg/, /before breakfast/, /5 days/, /Syp\. INSTARAFT \(Antacid\) 10 ml/,
  /Cap\. BIFILAC/, /7 days/, /Inj\. MONOCEF 1 g/, /3 days/, /Drops\. MOXI/, /Tab\. DOLO \(Paracetamol\) 650 mg/, /As Needed \(SOS\)/,
  /Tab\. ZINC 20 mg/, /10 days/, /ZINCOFER 20 mg/, /12-05-2026/];
const keepsDetails = (lines) => { const all = lines.join('\n'); for (const re of DETAILS) assert.match(all, re, String(re)); };

// ---------- 1. scope ----------
test('"all tablets" / "all syrups" / "all capsules": only that type', () => {
  for (const [c, prefix] of [['remove oral from all tablets', 'Tab.'], ['remove frequency for all syrups', 'Syp.'], ['remove oral from all capsules', 'Cap.']]) {
    const r = cls(c);
    assert.equal(r.type, 'remove', c);
    assert.ok(r.plan.changes.length > 0, c);
    for (const ch of r.plan.changes) assert.ok(ch.before.startsWith(prefix), `${c}: ${ch.before}`);
  }
  assert.equal(cls('remove oral from all tablets').plan.untyped, 1); // ZINCOFER has no type word: left out, and said
});

test('"all medicines" / "every medicine" / no target: EVERY type (tablets, syrups, capsules, injections, drops, untyped)', () => {
  for (const c of ['remove frequency from all medicines', 'remove frequency from every medicine', 'remove frequency from advice', 'remove frequency']) {
    const r = cls(c);
    assert.equal(r.type, 'remove', c);
    assert.equal(r.plan.changes.length, 8, c); // all but DOLO (no frequency, only As Needed)
    assert.ok(['Syp.', 'Cap.', 'Inj.', 'Drops.', 'ZINCOFER'].every((p) => r.plan.changes.some((ch) => ch.before.startsWith(p))), c);
  }
});

test('a named medicine: ONLY that medicine (was: every medicine)', () => {
  const r = cls('remove oral from dolo');
  assert.deepEqual(r.plan.changes.map(textAfter), ['Tab. DOLO (Paracetamol) 650 mg — As Needed (SOS)']);
  const f = cls('remove frequency from ciplox');
  assert.deepEqual(f.plan.changes.map(textAfter), ['Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — (1-0-1) — 2 days']); // pattern stays
});

test('"this medicine": the medicine at the cursor; without a cursor on a medicine -> asks', () => {
  const doc = makeDoc();
  const r = classifyCommand(doc, 'remove frequency from this medicine', { cursor: posOf(doc, 'Tab. PAN') });
  assert.deepEqual(r.plan.changes.map(textAfter), ['Tab. PAN 40 mg — Oral — (1-0-0) — before breakfast — 5 days']);
  const none = classifyCommand(doc, 'remove frequency from this medicine', { cursor: 3 }); // cursor in DIAGNOSIS
  assert.equal(none.type, 'ask');
  assert.match(none.question, /click on the medicine/);
});

test('filler words (pls, please, plz, sir, ok ...) are never read as a medicine name', () => {
  for (const c of ['oral remove from all tablet pls', 'remove oral from all tablets please', 'remove oral from all tablets plz',
    'remove oral from all tablets sir', 'remove oral from all tablets ok', 'remove oral from all tablets okay thanks', 'remove frequency from all medicines pls']) {
    const r = cls(c);
    assert.equal(r.type, 'remove', c);
    assert.ok(r.plan.changes.length > 0, c);
  }
  // a real unknown name after a medicine word is still caught
  assert.match(cls('remove oral from tablet crocin pls').question, /could not find a medicine called Crocin/);
});

test('unclear target -> asks: unknown medicine, or a name that fits two medicines', () => {
  assert.match(cls('remove oral from tablet crocin').question, /could not find a medicine called Crocin/);
  const two = schema.node('doc', null, [heading('ADVICE'), para(t('Tab. DOLO 650 mg — Oral — BD'), br(), t('Tab. DOLO 500 mg — Oral — OD'))]);
  const r = classifyCommand(two, 'remove oral from dolo');
  assert.equal(r.type, 'ask');
  assert.match(r.question, /2 medicines in Advice match "DOLO"/);
});

// ---------- 2. frequency + dosing patterns ----------
test('YOUR EXAMPLE "Remove oral once daily for all the medicine": Oral + ALL frequency words, every type; patterns, IV, SOS, food kept', () => {
  const r = cls('Remove oral once daily for all the medicine');
  assert.deepEqual(r.intent.categories, ['frequency']);
  assert.deepEqual(r.intent.phrases, ['oral']);
  const lines = after(r);
  assert.deepEqual(lines, [
    'Tab. CIPLOX (Ciprofloxacin) 200 mg — (1-0-1) — 2 days',
    'Tab. PAN 40 mg — (1-0-0) — before breakfast — 5 days',
    'Syp. INSTARAFT (Antacid) 10 ml — (1-1-1) — 5 days',
    'Cap. BIFILAC — 7 days',
    'Inj. MONOCEF 1 g — IV — 3 days',
    'Drops. MOXI — Topical — 5 days',
    'Tab. DOLO (Paracetamol) 650 mg — As Needed (SOS)',
    'Tab. ZINC 20 mg — (0-0-1) — 10 days',
    'ZINCOFER 20 mg — till 12-05-2026',
  ]);
  keepsDetails(lines);
});

test('"Remove once daily from all tablets": ALL frequency words (OD, BD, TDS, every 8 hours, HS), tablets only; patterns stay', () => {
  const r = cls('Remove once daily from all tablets');
  const lines = after(r);
  assert.equal(lines[0], 'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — (1-0-1) — 2 days');
  assert.equal(lines[1], 'Tab. PAN 40 mg — Oral — (1-0-0) — before breakfast — 5 days');
  assert.equal(lines[7], 'Tab. ZINC 20 mg — Oral — (0-0-1) — 10 days');
  for (const i of [2, 3, 4, 5, 8]) assert.equal(lines[i], ADVICE[i]); // other types untouched
  keepsDetails(lines);
});

test('YOUR COMMANDS "Remove frequency from all medicines" / "Remove Oral and Three Times Daily from all medicines": patterns shown UNTICKED', () => {
  for (const c of ['Remove frequency from all medicines', 'Remove Oral and Three Times Daily from all medicines']) {
    const r = cls(c);
    const pats = r.plan.changes.flatMap((ch) => ch.removals.filter((x) => x.kind === 'pattern'));
    assert.deepEqual(pats.map((x) => x.text), ['(1-0-1)', '(1-0-0)', '(1-1-1)', '(0-0-1)'], c); // visible, one box each
    assert.ok(pats.every((x) => !x.selected), c); // none ticked
    assert.ok(r.plan.changes.some((ch) => ch.removals.some((x) => x.kind === 'frequency' && x.selected)), c); // frequency words ticked
    assert.equal(after(r).join('\n').match(DOSING_PATTERN).length, 4, c); // nothing removed until the user ticks one
    keepsDetails(after(r));
  }
});

test('the user may tick a pattern by hand: only that pattern goes, separators stay tidy', () => {
  const r = cls('Remove frequency from all medicines');
  const ciplox = r.plan.changes.find((ch) => ch.before.startsWith('Tab. CIPLOX'));
  ciplox.removals.find((x) => x.kind === 'pattern').selected = true;
  assert.equal(textAfter(ciplox), 'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — 2 days');
  assert.equal(textAfter(r.plan.changes.find((ch) => ch.before.startsWith('Tab. PAN'))), 'Tab. PAN 40 mg — Oral — (1-0-0) — before breakfast — 5 days');
});

test('patterns are ticked ONLY when explicitly asked: "dosing patterns", "1-0-1"', () => {
  const only = cls('remove the dosing patterns from all medicines');
  assert.equal(only.type, 'remove');
  assert.ok(only.plan.changes.every((ch) => ch.removals.every((x) => x.kind === 'pattern' && x.selected)));
  assert.equal(after(only)[0], 'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — Twice Daily — 2 days'); // frequency word and dash kept
  assert.equal(after(only)[7], 'Tab. ZINC 20 mg — Oral — every 8 hours — HS — 10 days');
  const both = after(cls('remove frequency and dosing patterns from all tablets'));
  assert.equal(both[0], 'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — 2 days');
  assert.equal(both[2], ADVICE[2]); // syrup untouched
  assert.deepEqual(cls('remove 1-0-1 from ciplox').plan.changes.map(textAfter), ['Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — Twice Daily — 2 days']);
  assert.equal(cls('remove the dose patterns from all medicines').type, 'remove'); // not mistaken for a dose change
  keepsDetails(after(only));
});

test('"remove oral and frequency for all medicines" and "remove frequency for all syrups"', () => {
  const both = after(cls('remove oral and frequency for all medicines'));
  assert.equal(both[4], 'Inj. MONOCEF 1 g — IV — 3 days');
  assert.equal(both[2], 'Syp. INSTARAFT (Antacid) 10 ml — (1-1-1) — 5 days');
  keepsDetails(both);
  const syp = after(cls('remove frequency for all syrups'));
  assert.equal(syp[2], 'Syp. INSTARAFT (Antacid) 10 ml — Oral — (1-1-1) — 5 days');
  assert.deepEqual(syp.filter((_, i) => i !== 2), ADVICE.filter((_, i) => i !== 2));
});

test('dosing patterns STAY: several frequencies listed, "only", one named medicine, route-only, generic names', () => {
  const listed = after(cls('remove twice daily and once daily from all medicines'));
  assert.equal(listed[0], 'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — (1-0-1) — 2 days');
  assert.equal(listed[1], 'Tab. PAN 40 mg — Oral — (1-0-0) — before breakfast — 5 days');
  assert.equal(listed[3], ADVICE[3]); // OD is not one of the two words said
  assert.equal(after(cls('remove only once daily from all tablets'))[1], 'Tab. PAN 40 mg — Oral — (1-0-0) — before breakfast — 5 days');
  assert.equal(after(cls('remove once daily from pan'))[1], 'Tab. PAN 40 mg — Oral — (1-0-0) — before breakfast — 5 days');
  const route = after(cls('remove oral from all medicines'));
  assert.equal(route[0], 'Tab. CIPLOX (Ciprofloxacin) 200 mg — Twice Daily (1-0-1) — 2 days');
  assert.equal(route[7], 'Tab. ZINC 20 mg — every 8 hours — HS (0-0-1) — 10 days');
  const gen = after(cls('remove generic names from advice'));
  assert.equal(gen[0], 'Tab. CIPLOX 200 mg — Oral — Twice Daily (1-0-1) — 2 days');
  for (const r of [listed, route, gen]) assert.equal(r.join('\n').match(DOSING_PATTERN).length, 4);
});

test('a dosing pattern is only 3-4 single digits (0-4 or ½): dates, "1-2 tablets", 10-12 never match', () => {
  const m = (s) => (s.match(DOSING_PATTERN) || []);
  assert.deepEqual(m('(1-0-1) (1-1-1) (0-0-1) (½-0-½) 1-0-1 (1-1-1-1)'), ['(1-0-1)', '(1-1-1)', '(0-0-1)', '(½-0-½)', '1-0-1', '(1-1-1-1)']);
  for (const s of ['12-05-2026', '1-2 tablets', '10-12 days', '2-3', '5-10-15', '1-0-12']) assert.deepEqual(m(s), [], s);
  // removing ALL frequency never touches a date on the line
  assert.match(after(cls('remove frequency from all medicines'))[8], /till 12-05-2026$/);
});

test('the planner itself: patterns never ticked unless asked; shown only next to a removed frequency word', () => {
  const doc = makeDoc();
  const advice = getSections(doc).find((s) => /ADVICE/.test(s.title));
  const pats = (o) => planRemoval(doc, advice, o).changes.flatMap((c) => c.removals.filter((r) => r.kind === 'pattern'));
  assert.ok(pats({ categories: ['frequency'] }).length > 0);
  assert.ok(pats({ categories: ['frequency'] }).every((r) => !r.selected)); // shown, unticked
  assert.ok(pats({ phrases: ['twice daily'] }).every((r) => !r.selected)); // literal frequency: shown, unticked
  assert.ok(pats({ patterns: true }).every((r) => r.selected) && pats({ patterns: true }).length === 4); // explicitly asked
  for (const o of [{ categories: ['route'] }, { categories: ['generic'] }, { categories: ['food'] }, { categories: ['as_needed'] }, { phrases: ['oral'] }]) {
    assert.equal(pats(o).length, 0, JSON.stringify(o)); // not even shown
  }
  // an unticked suggestion is not counted as "found"
  assert.equal(planRemoval(doc, advice, { categories: ['frequency'] }).counts.pattern, undefined);
});

// ---------- 3. ask, never act ----------
test('bulk dose / strength / duration and unclear "timing" -> ask; one named medicine still goes to the AI as before', () => {
  for (const c of ['remove dose from all medicines', 'remove the strength from all tablets', 'change duration of all tablets to 5 days',
    'remove 5 days from all medicines', 'make all doses 500 mg']) {
    const r = cls(c);
    assert.equal(r.type, 'ask', c);
    assert.match(r.question, /one medicine at a time/, c);
  }
  assert.match(cls('remove timing from all medicine').question, /frequency .* or the food timing/);
  assert.equal(cls('change dolo to 500 mg').type, 'ai');
  assert.equal(cls('change the duration of ciplox to 5 days').type, 'ai');
  assert.equal(cls('remove dose timings from all tablets').type, 'remove'); // "dose timings" = frequency
});

// ---------- 4. apply: one Undo, accurate message ----------
test('Apply: one transaction (one Undo restores everything); the message says exactly what was removed', () => {
  const doc = makeDoc();
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), isDestroyed: true };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  const r = classifyCommand(doc, 'Remove oral once daily for all the medicine');
  assert.equal(applyRemovals(ed, r.plan).ok, true);
  assert.equal(undoDepth(ed.state), 1);
  assert.match(ed.state.doc.textContent, /Tab\. CIPLOX \(Ciprofloxacin\) 200 mg — \(1-0-1\) — 2 days/);
  assert.equal(removalSummary(r.plan, r.kind), 'Removed the Oral route and frequency instructions from 9 medicines.');
  // a pattern ticked by the user is named in the message
  r.plan.changes[0].removals.find((x) => x.kind === 'pattern').selected = true;
  assert.equal(removalSummary(r.plan, r.kind), 'Removed the Oral route, frequency instructions and dosing patterns from 9 medicines.');
  undo(ed.state, ed.view.dispatch);
  assert.ok(ed.state.doc.eq(doc));
});

test('message follows the ticks; other wordings', () => {
  const r = cls('remove oral from all tablets');
  assert.equal(removalSummary(r.plan, r.kind), 'Removed the Oral route from 4 medicines.');
  r.plan.changes[0].removals.forEach((x) => { x.selected = false; }); // the user unticks CIPLOX
  assert.equal(removalSummary(r.plan, r.kind), 'Removed the Oral route from 3 medicines.');
  const l = cls('remove twice daily and once daily from all medicines');
  assert.equal(removalSummary(l.plan, l.kind), 'Removed Twice Daily and Once Daily from 2 medicines.');
  const g = cls('remove generic names from advice');
  // CIPLOX and DOLO; "(Antacid)" is a description: shown but not ticked, so not counted
  assert.equal(removalSummary(g.plan, g.kind), 'Removed generic names from 2 medicines.');
});
