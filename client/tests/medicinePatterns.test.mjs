// Fix A: a dosing pattern ("(1-0-1)") that nobody said, on a NEW medicine line (src/lib/verify.js checkMedicineEdits).
// Gemini sometimes copies the pattern style of the existing medicine lines ("Twice Daily (1-0-1)") although only
// "twice daily" was said. That whole command used to be refused. Now:
//   - no pattern said at all          -> the pattern (and its brackets) is REMOVED, the rest is checked as before
//   - the same pattern said            -> kept
//   - a DIFFERENT pattern said         -> refused (a pattern the person said is never dropped or replaced)
//   - the pattern was written INSTEAD of the frequency said ("(1-0-1)" for "twice daily") -> refused
// Every other check (numbers, units, durations, frequency, route, names, existing lines, all or nothing) is unchanged.
// Dummy data only.  Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { checkMedicineEdits, checkTableEdits, withDuplicateChoice } from '../src/lib/verify.js';
import { getBlocks } from '../src/lib/outline.js';

const schema = getSchema([StarterKit]);
const p = (s, bold) => schema.node('paragraph', null, [schema.text(s, bold ? [schema.marks.bold.create()] : undefined)]);
// medicine lines written with patterns, like the hospital documents
const MEDS = [
  'Tab. METRONIDAZOLE 500 mg — Three Times Daily (1-1-1) — 2 days', // B3
  'Syp. INSTARAFT (Antacid) 10 ml — Three Times Daily (1-1-1) — 5 days — 10 mins after food', // B4
  'Tab. ZINCOVIT (Multivitamin/Mineral) — Once Daily (1-0-0) — 14 days', // B5
  'Tab. AZITHROMYCIN 500 mg — (1-0-1) — 5 days', // B6
];
const doc = schema.node('doc', null, [
  p('DISCHARGE SUMMARY', true), p('DIAGNOSIS', true), p('ENTERIC FEVER'), // B0 B1 B2
  ...MEDS.map((m) => p(m)), // B3-B6 (section ADVICE starts below: heading first)
]);
// the real layout: heading ADVICE, the medicines, an advice line, FOLLOW UP
const docAdvice = schema.node('doc', null, [
  p('DISCHARGE SUMMARY', true), p('DIAGNOSIS', true), p('ENTERIC FEVER'), // B0 B1 B2
  p('ADVICE', true), ...MEDS.map((m) => p(m)), p('Drink plenty of water.'), // B3, B4-B7, B8
  p('FOLLOW UP', true), p('Review in OPD after 1 week.'), // B9 B10
]);
void doc;
const add = (...lines) => lines.map((new_value) => ({ block_id: 'B7', operation: 'insert_after', new_value, field_label: 'Advice' }));
const chk = (said, edits) => checkMedicineEdits(docAdvice, { said, edits });
const ok = (said, edits) => { const r = chk(said, edits); assert.equal(r.reject, undefined, `${said}: ${r.reject}`); return r; };
const no = (said, edits, re) => { const r = chk(said, edits); assert.ok(r.reject, `${said}: should be refused`); if (re) assert.match(r.reject, re, said); return r; };
const lines = (r) => r.edits.map((e) => e.new_value);

test('the dummy document: ADVICE holds the four medicine lines', () => {
  const b = getBlocks(docAdvice).map((x) => x.node.textContent);
  assert.equal(b[3], 'ADVICE');
  assert.equal(b[7], MEDS[3]);
});

test('1. once daily + an unsaid (1-0-0): the pattern is removed, the medicine is accepted', () => {
  const r = ok('Add tablet pantoprazole 40 mg once daily for 5 days', add('Tab. PANTOPRAZOLE 40 mg — Once Daily (1-0-0) — 5 days'));
  assert.deepEqual(lines(r), ['Tab. PANTOPRAZOLE 40 mg — Once Daily — 5 days']);
});

test('2. twice daily + an unsaid (1-0-1): the pattern is removed, the medicine is accepted (the reported case)', () => {
  const r = ok('Add a tablet Paracetamol 500 mg twice daily for 3 days.', add('Tab. PARACETAMOL 500 mg — Twice Daily (1-0-1) — 3 days'));
  assert.deepEqual(lines(r), ['Tab. PARACETAMOL 500 mg — Twice Daily — 3 days']);
  assert.equal(r.medicine, true);
  // other ways the AI writes it: no brackets, "BD" said, a pattern right after the strength
  assert.deepEqual(lines(ok('add tablet paracetamol 500 mg twice daily for 3 days', add('Tab. PARACETAMOL 500 mg — Twice Daily 1-0-1 — 3 days'))), ['Tab. PARACETAMOL 500 mg — Twice Daily — 3 days']);
  assert.deepEqual(lines(ok('add tab paracetamol 500 mg BD for 3 days', add('Tab. PARACETAMOL 500 mg — Twice Daily (1-0-1) — 3 days'))), ['Tab. PARACETAMOL 500 mg — Twice Daily — 3 days']);
  assert.deepEqual(lines(ok('add tablet paracetamol 500 mg twice daily', add('Tab. PARACETAMOL 500 mg (1-0-1) — Twice Daily'))), ['Tab. PARACETAMOL 500 mg — Twice Daily']);
  // no replacement pattern is ever written, and nothing is added
  assert.ok(!/\d\s*-\s*\d/.test(lines(r)[0]));
});

// (approved change: "three times daily" said -> its approved pattern (1-1-1) is kept, or added when missing;
// before, Fix A removed it as unsaid - client/tests/medicineTiming.test.mjs has the timing rules)
test('3. three times daily + (1-1-1): the approved pattern is kept, the medicine is accepted', () => {
  const r = ok('Add tablet amoxicillin 250 mg three times daily for 5 days', add('Tab. AMOXICILLIN 250 mg — Three Times Daily (1-1-1) — 5 days'));
  assert.deepEqual(lines(r), ['Tab. AMOXICILLIN 250 mg — Three Times Daily (1-1-1) — 5 days']);
});

test('4. a pattern that WAS said is kept (with or without the frequency words)', () => {
  assert.deepEqual(lines(ok('add tablet paracetamol 500 mg twice daily for 3 days 1 0 1', add('Tab. PARACETAMOL 500 mg — Twice Daily (1-0-1) — 3 days'))),
    ['Tab. PARACETAMOL 500 mg — Twice Daily (1-0-1) — 3 days']);
  assert.deepEqual(lines(ok('add tablet paracetamol 500 mg 1-0-1 for 3 days', add('Tab. PARACETAMOL 500 mg — (1-0-1) — 3 days'))),
    ['Tab. PARACETAMOL 500 mg — (1-0-1) — 3 days']);
  assert.deepEqual(lines(ok('add tablet zincovit zero zero one', add('Tab. ZINCOVIT (0-0-1)'))), ['Tab. ZINCOVIT (0-0-1)']);
});

test('5. a DIFFERENT pattern than the one said: refused (never dropped or replaced)', () => {
  no('add tablet paracetamol 500 mg 1 0 1 for 3 days', add('Tab. PARACETAMOL 500 mg — (1-1-1) — 3 days'), /dosing pattern 1-1-1, which was not in your command/);
  no('add tablet paracetamol 500 mg twice daily 1-0-1', add('Tab. PARACETAMOL 500 mg — Twice Daily (1-0-0)'), /dosing pattern 1-0-0/);
});

test('6. the AI wrote ONLY a pattern instead of the frequency said: refused (the frequency is never silently lost)', () => {
  const r = no('Add tablet paracetamol 500 mg twice daily for 3 days', add('Tab. PARACETAMOL 500 mg — (1-0-1) — 3 days'),
    /is missing the frequency you said: the AI wrote the dosing pattern 1-0-1 instead/);
  assert.match(r.reject, /Nothing was changed/);
  // no frequency said at all: an unsaid pattern is simply removed (nothing the person asked for is lost)
  assert.deepEqual(lines(ok('add tablet zincovit', add('Tab. ZINCOVIT — (1-0-1)'))), ['Tab. ZINCOVIT']);
});

test('7-9. wrong strength, duration or frequency: still refused (also when an unsaid pattern was removed)', () => {
  no('add tablet paracetamol 500 mg twice daily for 3 days', add('Tab. PARACETAMOL 650 mg — Twice Daily (1-0-1) — 3 days'), /contains 650/);
  no('add tablet paracetamol 500 mg twice daily for 3 days', add('Tab. PARACETAMOL 500 mg — Twice Daily (1-0-1) — 5 days'), /contains 5/);
  no('add tablet paracetamol 500 mg twice daily for 3 days', add('Tab. PARACETAMOL 500 mg — Once Daily (1-0-0) — 3 days'), /frequency "Once Daily"/);
  no('add tablet paracetamol 500 mg twice daily for 3 days', add('Tab. PARACETAMOL 500 mcg — Twice Daily — 3 days'), /"500 mcg"/);
  no('add tablet paracetamol 500 mg twice daily for 3 days', add('Tab. PARACETAMOL 500 mg — Twice Daily — 3 weeks'), /"3 week"/);
});

test('10. unsaid route / food timing / generic bracket: still removed as before (together with the pattern)', () => {
  assert.deepEqual(lines(ok('add tablet paracetamol 500 mg twice daily for 3 days', add('Tab. PARACETAMOL 500 mg — Oral — Twice Daily (1-0-1) — 3 days'))),
    ['Tab. PARACETAMOL 500 mg — Twice Daily — 3 days']);
  assert.deepEqual(lines(ok('add tablet azee 500 mg twice daily', add('Tab. AZEE (Azithromycin) 500 mg — Oral — Twice Daily (1-0-1) — After Food'))),
    ['Tab. AZEE 500 mg — Twice Daily']);
  // a route that WAS said stays; a different route than said is still refused
  assert.deepEqual(lines(ok('add tablet azee 500 mg orally twice daily', add('Tab. AZEE 500 mg — Oral — Twice Daily (1-0-1)'))), ['Tab. AZEE 500 mg — Oral — Twice Daily']);
  no('add tablet azee 500 mg orally twice daily', add('Tab. AZEE 500 mg — IV — Twice Daily (1-0-1)'), /route "IV"/);
});

test('11. existing medicine entries are never changed by the clean-up (only NEW lines are cleaned)', () => {
  // an ADD keeps every existing line exactly: the edit only inserts a line after B7
  const r = ok('add tablet paracetamol 500 mg twice daily', add('Tab. PARACETAMOL 500 mg — Twice Daily (1-0-1)'));
  assert.equal(r.edits.length, 1);
  assert.equal(r.edits[0].block_id, 'B7');
  assert.equal(r.edits[0].operation, 'insert_after');
  // CHANGING an existing line is not cleaned: a new pattern that was not said is still refused there
  no('change the azithromycin frequency to twice daily', [{ block_id: 'B7', operation: 'replace_text', find_text: '(1-0-1)', new_value: 'Twice Daily (1-1-1)', field_label: 'Advice' }],
    /dosing pattern 1-1-1/);
  // removing an existing pattern still needs the command to ask for it
  no('change the azithromycin duration to 7 days', [{ block_id: 'B7', operation: 'set', new_value: 'Tab. AZITHROMYCIN 500 mg — 7 days', field_label: 'Advice' }],
    /dosing pattern of AZITHROMYCIN/);
});

test('12. several medicines in one command: unsaid patterns removed from each, all accepted; one real mistake still refuses all', () => {
  const said = 'Add tablet Paracetamol 500 mg twice daily for 3 days, add tablet Amoxicillin 250 mg three times daily for 5 days, and add syrup Cough Relief 5 ml twice daily for 3 days.';
  const r = ok(said, add('Tab. PARACETAMOL 500 mg — Twice Daily (1-0-1) — 3 days', 'Tab. AMOXICILLIN 250 mg — Three Times Daily (1-1-1) — 5 days', 'Syp. COUGH RELIEF 5 ml — Twice Daily — 3 days'));
  // (twice daily: the unsaid (1-0-1) is removed; three times daily: its approved (1-1-1) stays, tied to the line that says it)
  assert.deepEqual(lines(r), ['Tab. PARACETAMOL 500 mg — Twice Daily — 3 days', 'Tab. AMOXICILLIN 250 mg — Three Times Daily (1-1-1) — 5 days', 'Syp. COUGH RELIEF 5 ml — Twice Daily — 3 days']);
  // the same lines as ONE edit with line breaks
  const one = ok(said, add('Tab. PARACETAMOL 500 mg — Twice Daily (1-0-1) — 3 days\nTab. AMOXICILLIN 250 mg — Three Times Daily (1-1-1) — 5 days'));
  assert.equal(one.edits[0].new_value, 'Tab. PARACETAMOL 500 mg — Twice Daily — 3 days\nTab. AMOXICILLIN 250 mg — Three Times Daily (1-1-1) — 5 days');
  // all or nothing: one strength nobody said refuses the whole command
  // (details are matched against the WHOLE command, as before: a value said for ANOTHER medicine of the same command
  // is not refused - that is "Fix B", not part of this change)
  no(said, add('Tab. PARACETAMOL 500 mg — Twice Daily (1-0-1) — 3 days', 'Tab. AMOXICILLIN 750 mg — Three Times Daily — 5 days', 'Syp. COUGH RELIEF 5 ml — Twice Daily — 3 days'), /contains 750/);
  // one line with the pattern INSTEAD of its frequency refuses the whole command
  no(said, add('Tab. PARACETAMOL 500 mg — (1-0-1) — 3 days', 'Tab. AMOXICILLIN 250 mg — Three Times Daily — 5 days'), /missing the frequency you said/);
});

test('the second check (checkTableEdits) passes the cleaned lines unchanged (the order used by App.jsx)', () => {
  const said = 'Add a tablet Paracetamol 500 mg twice daily for 3 days.';
  const med = ok(said, add('Tab. PARACETAMOL 500 mg — Twice Daily (1-0-1) — 3 days'));
  const table = checkTableEdits(docAdvice, said, withDuplicateChoice(med.edits, med.newEntries));
  assert.deepEqual(table.blocked, []);
  assert.deepEqual(table.edits.map((e) => e.new_value), ['Tab. PARACETAMOL 500 mg — Twice Daily — 3 days']);
});
