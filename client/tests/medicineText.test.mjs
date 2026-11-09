// Tests for src/lib/medicineText.js (A: remove phrases, B: remove generic names) on the real Advice lines
// Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { EditorState } from '@tiptap/pm/state';
import { history, undo } from '@tiptap/pm/history';
import { detectMedicineCommand, applyRemovals, textAfter, findGenericBracket, phrasesFromCommand } from '../src/lib/medicineText.js';
import { getBlocks } from '../src/lib/outline.js';

const schema = getSchema([StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell]);
const p = (t) => schema.node('paragraph', null, t ? [schema.text(t)] : []);
const bold = (t) => schema.node('paragraph', null, [schema.text(t, [schema.marks.bold.create()])]);

// The Advice section exactly as in the screenshots
const ADVICE = [
  'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — Twice Daily (1-0-1) — 2 days',
  'Tab. METRONIDAZOLE (Metronidazole) 500 mg — Oral — Three Times Daily (1-1-1) — 2 days',
  'Syp. INSTARAFT (Antacid) 10 ml — Oral — Three Times Daily (1-1-1) — 5 days — 10 mins after food',
  'Tab. ZINCOVIT (Multivitamin/Mineral) — Oral — Once Daily (1-0-0) — 14 days',
  'Tab. BACTOGUT (Probiotic) — Oral — Once Daily (1-0-0) — 7 days',
  'Tab. DOLO (Paracetamol) 650 mg — Oral — As Needed (SOS)',
  'AZIPROPROTEIN POWDER (Protein Supplement) 2 scoops — Oral — Twice Daily (1-0-1) — 1 week — In 1 glass of water',
];
const DIAG = 'ENTERIC FEVER (A01.0: Typhoid fever), SEPSIS (Severe) - RESOLVED';
const COURSE = 'Started on oral antibiotics (Meropenem). Oral intake improved. Twice Daily dressing done.';
const FOLLOW = 'Follow up in OPD (Dr. Arjun) after 5 days';

function makeEditor(adviceLines = ADVICE) {
  const doc = schema.node('doc', null, [
    bold('DISCHARGE SUMMARY'),
    bold('DIAGNOSIS'), p(DIAG),
    bold('COURSE IN HOSPITAL'), p(COURSE),
    bold('ADVICE'), ...adviceLines.map(p), p(FOLLOW),
  ]);
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), isDestroyed: false };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
}
const texts = (ed) => getBlocks(ed.state.doc).map((b) => b.node.textContent);
const advice = (ed) => texts(ed).slice(texts(ed).indexOf('ADVICE') + 1);
const others = (ed) => texts(ed).slice(0, texts(ed).indexOf('ADVICE') + 1);
const done = (ed) => { ed.isDestroyed = true; }; // stops the 5-second highlight timer

// ---------- A. remove phrases ----------
test('A, YOUR EXACT COMMAND: "Inside the Advice section, remove phrases such as Oral, Twice Daily, Once Daily, Three Times Daily."', () => {
  const ed = makeEditor();
  const r = detectMedicineCommand(ed.state.doc, 'Inside the Advice section, remove phrases such as Oral, Twice Daily, Once Daily, Three Times Daily.');
  assert.equal(r.kind, 'phrases');
  assert.equal(r.plan.section.title, 'Advice');
  assert.equal(r.plan.changes.length, 7); // all 7 medicine lines, NOT the follow-up line, NOT other sections
  assert.equal(applyRemovals(ed, r.plan).ok, true);
  assert.deepEqual(advice(ed), [
    'Tab. CIPLOX (Ciprofloxacin) 200 mg — (1-0-1) — 2 days',
    'Tab. METRONIDAZOLE (Metronidazole) 500 mg — (1-1-1) — 2 days',
    'Syp. INSTARAFT (Antacid) 10 ml — (1-1-1) — 5 days — 10 mins after food',
    'Tab. ZINCOVIT (Multivitamin/Mineral) — (1-0-0) — 14 days',
    'Tab. BACTOGUT (Probiotic) — (1-0-0) — 7 days',
    'Tab. DOLO (Paracetamol) 650 mg — As Needed (SOS)',
    'AZIPROPROTEIN POWDER (Protein Supplement) 2 scoops — (1-0-1) — 1 week — In 1 glass of water',
    FOLLOW,
  ]);
  done(ed);
});

test('A: other sections are NOT changed (Course in Hospital also says "oral" and "Twice Daily")', () => {
  const ed = makeEditor();
  const before = others(ed);
  applyRemovals(ed, detectMedicineCommand(ed.state.doc, 'Inside the Advice section, remove phrases such as Oral, Twice Daily').plan);
  assert.deepEqual(others(ed), before);
  done(ed);
});

test('A: your second example, "Thrice daily" is not in the document -> reported, the rest removed', () => {
  const ed = makeEditor();
  const r = detectMedicineCommand(ed.state.doc, 'Remove Oral, Twice Daily, Thrice daily, Three times daily and Once Daily from Advice.');
  assert.equal(r.kind, 'phrases');
  assert.deepEqual(r.plan.notFound, ['Thrice daily']);
  assert.equal(r.plan.counts.Oral, 7);
  assert.equal(r.plan.counts['Three times daily'], 2);
  done(ed);
});

test('A: whole words only ("Oral" does not touch "Orally"), capitals ignored', () => {
  const ed = makeEditor(['Tab. X 5 mg — Orally — ORAL — once']);
  applyRemovals(ed, detectMedicineCommand(ed.state.doc, 'remove the word oral from advice').plan);
  assert.equal(advice(ed)[0], 'Tab. X 5 mg — Orally — once');
  done(ed);
});

test('A: the phrase list is read correctly', () => {
  assert.deepEqual(phrasesFromCommand('Inside the Advice section, remove phrases such as Oral, Twice Daily, Once Daily, Three Times Daily.', 'ADVICE'),
    ['Oral', 'Twice Daily', 'Once Daily', 'Three Times Daily']);
  assert.deepEqual(phrasesFromCommand('Remove Oral, Twice Daily and Once Daily from the advice section', 'ADVICE'), ['Oral', 'Twice Daily', 'Once Daily']);
  assert.deepEqual(phrasesFromCommand('remove "Oral" and "SOS" from advice', 'ADVICE'), ['Oral', 'SOS']);
});

test('A: not a phrase list -> left to the AI (no change here)', () => {
  const ed = makeEditor();
  assert.equal(detectMedicineCommand(ed.state.doc, 'remove the line about malaria from course in hospital'), null);
  assert.equal(detectMedicineCommand(ed.state.doc, 'remove everything from advice'), null); // = clear section, not this
  done(ed);
});

test('A: no section named -> asks; nothing found -> says so', () => {
  const ed = makeEditor();
  assert.match(detectMedicineCommand(ed.state.doc, 'remove the words Oral, Twice Daily').ask, /Which section/);
  assert.match(detectMedicineCommand(ed.state.doc, 'remove the words Intravenous, Weekly from advice').ask, /None of these were found in Advice/);
  done(ed);
});

// ---------- B. remove generic names ----------
test('B, YOUR EXAMPLES: "Remove all generic medicine names from Advice"', () => {
  const ed = makeEditor();
  const r = detectMedicineCommand(ed.state.doc, 'Remove all generic medicine names from Advice');
  assert.equal(r.kind, 'generic');
  // generic names are selected; descriptions (Antacid, Multivitamin/Mineral, Probiotic, Protein Supplement) are not
  const picked = r.plan.changes.map((c) => [c.removals[0].text, c.removals[0].kind, c.removals[0].selected]);
  assert.deepEqual(picked, [
    ['(Ciprofloxacin)', 'generic', true],
    ['(Metronidazole)', 'generic', true],
    ['(Antacid)', 'description', false],
    ['(Multivitamin/Mineral)', 'description', false],
    ['(Probiotic)', 'description', false],
    ['(Paracetamol)', 'generic', true],
    ['(Protein Supplement)', 'description', false],
  ]);
  assert.equal(textAfter(r.plan.changes[0]), 'Tab. CIPLOX 200 mg — Oral — Twice Daily (1-0-1) — 2 days');
  assert.equal(textAfter(r.plan.changes[5]), 'Tab. DOLO 650 mg — Oral — As Needed (SOS)');
  applyRemovals(ed, r.plan);
  assert.equal(advice(ed)[0], 'Tab. CIPLOX 200 mg — Oral — Twice Daily (1-0-1) — 2 days');
  assert.equal(advice(ed)[5], 'Tab. DOLO 650 mg — Oral — As Needed (SOS)');
  assert.equal(advice(ed)[2], ADVICE[2]); // description not selected -> unchanged
  assert.equal(advice(ed)[7], FOLLOW); // (Dr. Arjun) never touched
  done(ed);
});

test('B: ticking a description in the preview removes it too', () => {
  const ed = makeEditor();
  const r = detectMedicineCommand(ed.state.doc, 'remove generic names from advice');
  r.plan.changes[2].removals[0].selected = true; // the user ticks "(Antacid)"
  applyRemovals(ed, r.plan);
  assert.equal(advice(ed)[2], 'Syp. INSTARAFT 10 ml — Oral — Three Times Daily (1-1-1) — 5 days — 10 mins after food');
  done(ed);
});

test('B: "Remove the generic names from tablets and syrups" -> only Tab. and Syp. lines', () => {
  const ed = makeEditor();
  const r = detectMedicineCommand(ed.state.doc, 'Remove the generic names from tablets and syrups.');
  assert.equal(r.plan.section.title, 'Advice'); // the only section with medicines
  assert.ok(r.plan.changes.every((c) => /^(Tab|Syp)\./.test(c.before)));
  assert.ok(!r.plan.changes.some((c) => c.before.startsWith('AZIPROPROTEIN')));
  done(ed);
});

test('B: "Remove the generic names of all tablets" -> only Tab. lines', () => {
  const ed = makeEditor();
  const r = detectMedicineCommand(ed.state.doc, 'Remove the generic names of all tablets.');
  assert.ok(r.plan.changes.length > 0 && r.plan.changes.every((c) => c.before.startsWith('Tab.')));
  done(ed);
});

test('B SAFETY: dosage patterns and instructions are never removed', () => {
  for (const line of [
    'Tab. X (1-0-1) 5 mg', 'Tab. X (SOS) 5 mg', 'Tab. X (after food) 5 mg', 'Tab. X (Twice daily) 5 mg',
    'Tab. X 500 mg (Paracetamol)', // bracket AFTER the strength: not the brand's generic name
    'Tab. X (Vitamin D3) 60000 IU', // digit inside
    'Follow up in OPD (Dr. Arjun) after 5 days',
  ]) {
    assert.equal(findGenericBracket(line, { allowWithoutForm: true }), null, line);
  }
});

test('B: written in capitals still works', () => {
  const hit = findGenericBracket('TAB. CIPLOX (CIPROFLOXACIN) 200 MG — ORAL');
  assert.equal(hit.text, ' (CIPROFLOXACIN)'); // the space in front is removed together with the bracket
  assert.equal(hit.kind, 'generic');
});

test('B: the Diagnosis brackets are never touched (only the chosen section is read)', () => {
  const ed = makeEditor();
  const before = others(ed);
  applyRemovals(ed, detectMedicineCommand(ed.state.doc, 'remove all generic names from advice').plan);
  assert.deepEqual(others(ed), before);
  done(ed);
});

test('B: medicines in two sections and none named -> asks', () => {
  const doc = schema.node('doc', null, [bold('TREATMENT'), p('Tab. A (Amoxicillin) 5 mg'), bold('ADVICE'), p('Tab. B (Cefixime) 200 mg')]);
  assert.match(detectMedicineCommand(doc, 'remove the generic names').ask, /more than one section: Treatment or Advice/);
});

// ---------- one step, undo, safety ----------
test('ONE Undo brings every line back', () => {
  const ed = makeEditor();
  applyRemovals(ed, detectMedicineCommand(ed.state.doc, 'Inside the Advice section, remove phrases such as Oral, Twice Daily, Once Daily, Three Times Daily.').plan);
  assert.notDeepEqual(advice(ed), [...ADVICE, FOLLOW]);
  undo(ed.state, ed.view.dispatch);
  assert.deepEqual(advice(ed), [...ADVICE, FOLLOW]);
  done(ed);
});

test('if the document changed after the preview, NOTHING is applied', () => {
  const ed = makeEditor();
  const r = detectMedicineCommand(ed.state.doc, 'remove generic names from advice');
  const b = getBlocks(ed.state.doc)[r.plan.changes[0].block];
  ed.view.dispatch(ed.state.tr.insertText('X', b.pos + 1)); // someone typed in that line
  const snapshot = texts(ed);
  const res = applyRemovals(ed, r.plan);
  assert.equal(res.ok, false);
  assert.deepEqual(texts(ed), snapshot);
  done(ed);
});
