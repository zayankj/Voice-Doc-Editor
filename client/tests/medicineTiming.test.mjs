// A time of day said for a NEW medicine line (src/lib/verify.js checkMedicineEdits + checkTableEdits).
// Approved mapping ONLY: morning (1-0-0) · afternoon (0-1-0) · night / daily night / at bedtime / HS (0-0-1) ·
// morning and night (1-0-1) · morning and afternoon (1-1-0) · afternoon and night (0-1-1) ·
// morning, afternoon and night (1-1-1) · three times daily (1-1-1). Evening: kept, no pattern. Once / twice daily:
// no time and no pattern inferred.
//   - the time is kept in the person's own words, with exactly its pattern (added when the AI left it out)
//   - a different pattern, a missing time or a different time -> refused (all or nothing)
//   - a time of day in a command that adds SEVERAL medicines -> refused (it cannot be tied to one medicine)
//   - nothing said about time -> Fix A: an unsaid pattern is removed; an unsaid time word too
// Dummy data only.  Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { checkMedicineEdits, checkTableEdits, withDuplicateChoice, timingSaid, patternsImplied } from '../src/lib/verify.js';

const schema = getSchema([StarterKit]);
const p = (s, bold) => schema.node('paragraph', null, [schema.text(s, bold ? [schema.marks.bold.create()] : undefined)]);
const doc = schema.node('doc', null, [
  p('DISCHARGE SUMMARY', true), p('DIAGNOSIS', true), p('ENTERIC FEVER'), // B0 B1 B2
  p('ADVICE', true), // B3
  p('Tab. METRONIDAZOLE 500 mg — Three Times Daily (1-1-1) — 2 days'), // B4
  p('Syp. BENADRYL — Daily Morning (1-0-0)'), // B5
  p('Tab. AZITHROMYCIN 500 mg — (1-0-1) — 5 days'), // B6
  p('Drink plenty of water.'), // B7
  p('FOLLOW UP', true), p('Review in OPD after 1 week.'), // B8 B9
]);
const add = (...lines) => lines.map((new_value) => ({ block_id: 'B6', operation: 'insert_after', new_value, field_label: 'Advice' }));
const chk = (said, edits) => checkMedicineEdits(doc, { said, edits });
const ok = (said, ...lines) => { const r = chk(said, add(...lines)); assert.equal(r.reject, undefined, `${said}: ${r.reject}`); return r.edits.map((e) => e.new_value); };
const no = (said, lines, re) => { const r = chk(said, add(...lines)); assert.ok(r.reject, `${said}: should be refused`); if (re) assert.match(r.reject, re, said); assert.match(r.reject, /Nothing was changed/); return r; };
// the second check (as App.jsx runs it, on the cleaned lines) must accept them too
const both = (said, ...lines) => {
  const med = chk(said, add(...lines));
  assert.equal(med.reject, undefined, `${said}: ${med.reject}`);
  const table = checkTableEdits(doc, said, withDuplicateChoice(med.edits, med.newEntries));
  assert.deepEqual(table.blocked, [], `${said}: second check blocked ${table.blocked}`);
  return table.edits.map((e) => e.new_value);
};

test('the mapping: what is read from the words said', () => {
  const k = (s) => { const x = timingSaid(s); return x && [x.key, x.pattern, x.words]; };
  assert.deepEqual(k('add dolo 650 mg at night'), ['N', '001', 'at night']);
  assert.deepEqual(k('add dolo 650 mg in the morning'), ['M', '100', 'in the morning']);
  assert.deepEqual(k('add dolo every afternoon'), ['A', '010', 'every afternoon']);
  assert.deepEqual(k('add dolo daily night'), ['N', '001', 'daily night']);
  assert.deepEqual(k('add dolo at bedtime'), ['N', '001', 'at bedtime']);
  assert.deepEqual(k('add dolo HS'), ['N', '001', 'HS']);
  assert.deepEqual(k('add dolo morning and night'), ['MN', '101', 'morning and night']);
  assert.deepEqual(k('add dolo morning and afternoon'), ['MA', '110', 'morning and afternoon']);
  assert.deepEqual(k('add dolo afternoon and night'), ['AN', '011', 'afternoon and night']);
  assert.deepEqual(k('add dolo morning, afternoon and night'), ['MAN', '111', 'morning, afternoon and night']);
  assert.deepEqual(k('add dolo in the evening'), ['E', '', 'in the evening'], 'evening: no approved pattern');
  for (const s of ['add dolo once daily', 'add dolo twice daily', 'add dolo three times daily', 'add dolo 650 mg', 'tonight overnight fortnight'])
    assert.equal(timingSaid(s), null, s);
  assert.deepEqual([...patternsImplied('add dolo three times daily')], ['111']);
  assert.deepEqual([...patternsImplied('add dolo twice daily')], []);
  assert.deepEqual([...patternsImplied('add dolo once daily')], []);
});

test('1. at night -> (0-0-1), in the person\'s words', () => {
  assert.deepEqual(both('Add tablet Dolo 650 mg at night for 3 days.', 'Tab. DOLO 650 mg — At Night (0-0-1) — 3 days'), ['Tab. DOLO 650 mg — At Night (0-0-1) — 3 days']);
  // other words the AI uses for the same time are written as the person said it
  for (const ai of ['Tab. DOLO 650 mg — Daily Night (0-0-1) — 3 days', 'Tab. DOLO 650 mg — At Bedtime — 3 days', 'Tab. DOLO 650 mg — HS — 3 days', 'Tab. DOLO 650 mg — Once Daily at Night — 3 days'])
    assert.deepEqual(both('Add tablet Dolo 650 mg at night for 3 days.', ai), ['Tab. DOLO 650 mg — At Night (0-0-1) — 3 days'], ai);
});

test('2-3. in the morning / every morning -> (1-0-0)', () => {
  assert.deepEqual(both('Add tablet Dolo 650 mg in the morning for 5 days.', 'Tab. DOLO 650 mg — In the Morning (1-0-0) — 5 days'), ['Tab. DOLO 650 mg — In the Morning (1-0-0) — 5 days']);
  assert.deepEqual(both('Add tablet Dolo 650 mg in the morning for 5 days.', 'Tab. DOLO 650 mg — Daily Morning (1-0-0) — 5 days'), ['Tab. DOLO 650 mg — In the Morning (1-0-0) — 5 days']);
  assert.deepEqual(both('Add tablet Dolo 650 mg every morning for 5 days.', 'Tab. DOLO 650 mg — Every Morning — 5 days'), ['Tab. DOLO 650 mg — Every Morning (1-0-0) — 5 days']);
});

test('4-5. in the afternoon / every afternoon -> (0-1-0)', () => {
  assert.deepEqual(both('Add tablet Dolo 650 mg in the afternoon for 5 days.', 'Tab. DOLO 650 mg — Afternoon — 5 days'), ['Tab. DOLO 650 mg — In the Afternoon (0-1-0) — 5 days']);
  assert.deepEqual(both('Add tablet Dolo 650 mg every afternoon.', 'Tab. DOLO 650 mg — Every Afternoon (0-1-0)'), ['Tab. DOLO 650 mg — Every Afternoon (0-1-0)']);
});

test('6. at bedtime -> (0-0-1); daily night -> (0-0-1); HS -> (0-0-1)', () => {
  assert.deepEqual(both('Add tablet Dolo 650 mg at bedtime for 5 days.', 'Tab. DOLO 650 mg — At Bedtime — 5 days'), ['Tab. DOLO 650 mg — At Bedtime (0-0-1) — 5 days']);
  assert.deepEqual(both('Add tablet Dolo 650 mg daily night.', 'Tab. DOLO 650 mg — Daily Night'), ['Tab. DOLO 650 mg — Daily Night (0-0-1)']);
  assert.deepEqual(both('Add tablet Dolo 650 mg HS.', 'Tab. DOLO 650 mg — HS (0-0-1)'), ['Tab. DOLO 650 mg — HS (0-0-1)']);
});

test('7-10. two and three times of day -> (1-0-1), (1-1-0), (0-1-1), (1-1-1)', () => {
  assert.deepEqual(both('Add tablet Dolo 650 mg morning and night for 5 days.', 'Tab. DOLO 650 mg — Morning and Night (1-0-1) — 5 days'), ['Tab. DOLO 650 mg — Morning and Night (1-0-1) — 5 days']);
  assert.deepEqual(both('Add tablet Dolo 650 mg morning and afternoon.', 'Tab. DOLO 650 mg — Morning and Afternoon'), ['Tab. DOLO 650 mg — Morning and Afternoon (1-1-0)']);
  assert.deepEqual(both('Add tablet Dolo 650 mg afternoon and night.', 'Tab. DOLO 650 mg — Afternoon and Night (0-1-1)'), ['Tab. DOLO 650 mg — Afternoon and Night (0-1-1)']);
  assert.deepEqual(both('Add tablet Dolo 650 mg morning, afternoon and night for 5 days.', 'Tab. DOLO 650 mg — Morning, Afternoon and Night (1-1-1) — 5 days'),
    ['Tab. DOLO 650 mg — Morning, Afternoon and Night (1-1-1) — 5 days']);
});

test('11. three times daily: the wording is kept and (1-1-1) is used (kept, or added when missing)', () => {
  assert.deepEqual(both('Add tablet Dolo 650 mg three times daily for 5 days.', 'Tab. DOLO 650 mg — Three Times Daily (1-1-1) — 5 days'), ['Tab. DOLO 650 mg — Three Times Daily (1-1-1) — 5 days']);
  assert.deepEqual(both('Add tablet Dolo 650 mg three times daily for 5 days.', 'Tab. DOLO 650 mg — Three Times Daily — 5 days'), ['Tab. DOLO 650 mg — Three Times Daily (1-1-1) — 5 days']);
  assert.deepEqual(both('add tab dolo 650 mg TDS', 'Tab. DOLO 650 mg — TDS'), ['Tab. DOLO 650 mg — TDS (1-1-1)']);
  no('Add tablet Dolo 650 mg three times daily for 5 days.', ['Tab. DOLO 650 mg — Three Times Daily (1-0-1) — 5 days'], /dosing pattern 1-0-1, but "three times daily" is \(1-1-1\)/);
});

test('12-13. once daily / twice daily: the wording is kept, no time and no pattern are invented', () => {
  assert.deepEqual(both('Add tablet Dolo 650 mg once daily.', 'Tab. DOLO 650 mg — Once Daily (1-0-0)'), ['Tab. DOLO 650 mg — Once Daily']);
  assert.deepEqual(both('Add tablet Dolo 650 mg once daily.', 'Tab. DOLO 650 mg — Once Daily'), ['Tab. DOLO 650 mg — Once Daily']);
  assert.deepEqual(both('Add tablet Dolo 650 mg twice daily.', 'Tab. DOLO 650 mg — Twice Daily (1-0-1)'), ['Tab. DOLO 650 mg — Twice Daily']);
  assert.deepEqual(both('Add tablet Dolo 650 mg twice daily.', 'Tab. DOLO 650 mg — Twice Daily'), ['Tab. DOLO 650 mg — Twice Daily']);
  // a time of day the AI added although none was said: removed (never invented)
  assert.deepEqual(both('Add tablet Dolo 650 mg twice daily.', 'Tab. DOLO 650 mg — Twice Daily — Morning and Night (1-0-1)'), ['Tab. DOLO 650 mg — Twice Daily']);
  assert.deepEqual(both('Add tablet Dolo 650 mg once daily.', 'Tab. DOLO 650 mg — Once Daily — At Night'), ['Tab. DOLO 650 mg — Once Daily']);
});

test('14. evening: kept as said, no pattern invented (an AI pattern is removed)', () => {
  assert.deepEqual(both('Add tablet Dolo 650 mg in the evening.', 'Tab. DOLO 650 mg — In the Evening (0-0-1)'), ['Tab. DOLO 650 mg — In the Evening']);
  assert.deepEqual(both('Add tablet Dolo 650 mg in the evening.', 'Tab. DOLO 650 mg — Evening'), ['Tab. DOLO 650 mg — In the Evening']);
  no('Add tablet Dolo 650 mg in the evening.', ['Tab. DOLO 650 mg — At Night (0-0-1)'], /says "At Night", but you said "in the evening"/);
});

test('15. a wrong pattern for the time said: refused', () => {
  no('Add tablet Dolo 650 mg in the morning.', ['Tab. DOLO 650 mg — In the Morning (0-0-1)'], /dosing pattern 0-0-1, but "in the morning" is \(1-0-0\)/);
  no('Add tablet Dolo 650 mg in the afternoon.', ['Tab. DOLO 650 mg — Afternoon (1-0-0)'], /dosing pattern 1-0-0, but "in the afternoon" is \(0-1-0\)/);
  no('Add tablet Dolo 650 mg at night.', ['Tab. DOLO 650 mg — At Night (1-0-0)'], /dosing pattern 1-0-0, but "at night" is \(0-0-1\)/);
  no('Add tablet Dolo 650 mg morning and night.', ['Tab. DOLO 650 mg — Morning and Night (1-1-1)'], /1-1-1, but "morning and night" is \(1-0-1\)/);
});

test('16. the time said is missing, or replaced by a generic frequency / another time: refused', () => {
  no('Add tablet Dolo 650 mg at night for 3 days.', ['Tab. DOLO 650 mg — 3 days'], /missing the time of day you said \("at night"\)/);
  no('Add tablet Dolo 650 mg at night for 3 days.', ['Tab. DOLO 650 mg — (0-0-1) — 3 days'], /missing the time of day you said/);
  no('Add tablet Dolo 650 mg in the morning for 5 days.', ['Tab. DOLO 650 mg — Once Daily (1-0-0) — 5 days'], /missing the time of day you said \("in the morning"\)/);
  no('Add tablet Dolo 650 mg morning and night.', ['Tab. DOLO 650 mg — Twice Daily (1-0-1)'], /missing the time of day you said/);
  no('Add tablet Dolo 650 mg morning, afternoon and night.', ['Tab. DOLO 650 mg — Three Times Daily (1-1-1)'], /missing the time of day you said/);
  no('Add tablet Dolo 650 mg in the morning.', ['Tab. DOLO 650 mg — At Night (0-0-1)'], /says "At Night", but you said "in the morning"/);
  no('Add tablet Dolo 650 mg morning and night.', ['Tab. DOLO 650 mg — Night (0-0-1)'], /says "Night", but you said "morning and night"/);
});

test('17-18. correct time + pattern from the AI: kept; time without the pattern: ONLY the approved pattern is added', () => {
  assert.deepEqual(both('Add tablet Dolo 650 mg at night for 3 days.', 'Tab. DOLO 650 mg — At Night (0-0-1) — 3 days'), ['Tab. DOLO 650 mg — At Night (0-0-1) — 3 days']);
  assert.deepEqual(both('Add tablet Dolo 650 mg at night for 3 days.', 'Tab. DOLO 650 mg — At Night — 3 days'), ['Tab. DOLO 650 mg — At Night (0-0-1) — 3 days']);
  // the line's own style: capitals stay capitals
  assert.deepEqual(both('Add tablet Dolo 650 mg at night for 3 days.', 'TAB. DOLO 650 MG — AT NIGHT — 3 DAYS'), ['TAB. DOLO 650 MG — AT NIGHT (0-0-1) — 3 DAYS']);
  assert.deepEqual(both('Add tablet Dolo 650 mg in the morning for 5 days.', 'TAB. DOLO 650 MG — DAILY MORNING (1-0-0) — 5 DAYS'), ['TAB. DOLO 650 MG — IN THE MORNING (1-0-0) — 5 DAYS']);
  // nothing else is ever added: no route, no frequency, no duration
  const [line] = both('Add tablet Dolo 650 mg at night.', 'Tab. DOLO 650 mg — At Night');
  assert.equal(line, 'Tab. DOLO 650 mg — At Night (0-0-1)');
});

test('19. nothing said about time: an unsaid pattern is still removed (Fix A), and so is an unsaid time word', () => {
  assert.deepEqual(both('Add a tablet Paracetamol 500 mg twice daily for 3 days.', 'Tab. PARACETAMOL 500 mg — Twice Daily (1-0-1) — 3 days'), ['Tab. PARACETAMOL 500 mg — Twice Daily — 3 days']);
  assert.deepEqual(both('add tablet zincovit', 'Tab. ZINCOVIT — (1-0-1)'), ['Tab. ZINCOVIT']);
  assert.deepEqual(both('add tablet zincovit', 'Tab. ZINCOVIT — Daily Night (0-0-1)'), ['Tab. ZINCOVIT']);
  // Fix A's own refusals are unchanged
  no('Add tablet paracetamol 500 mg twice daily for 3 days', ['Tab. PARACETAMOL 500 mg — (1-0-1) — 3 days'], /missing the frequency you said/);
  no('add tablet paracetamol 500 mg 1 0 1 for 3 days', ['Tab. PARACETAMOL 500 mg — (1-1-1) — 3 days'], /dosing pattern 1-1-1, which was not in your command/);
});

test('20. several medicines: a time of day in the command is refused (never tied to the wrong medicine); without a time, the rules are as before', () => {
  no('Add tablet Dolo 650 mg at night and tablet Pan 40 mg in the morning.', ['Tab. DOLO 650 mg — At Night (0-0-1)', 'Tab. PAN 40 mg — In the Morning (1-0-0)'],
    /says a time of day \("at night and in the morning"\) and adds 2 medicines, so it is not clear which medicine the time is for/);
  no('Add tablet Dolo 650 mg at night and tablet Pan 40 mg twice daily.', ['Tab. DOLO 650 mg — At Night (0-0-1)', 'Tab. PAN 40 mg — Twice Daily'], /adds 2 medicines/);
  // no time of day: several medicines as before (the whole-command matching is unchanged; three times daily gets (1-1-1) on its own line)
  assert.deepEqual(both('Add tablet Paracetamol 500 mg twice daily for 3 days, add tablet Amoxicillin 250 mg three times daily for 5 days.',
    'Tab. PARACETAMOL 500 mg — Twice Daily (1-0-1) — 3 days', 'Tab. AMOXICILLIN 250 mg — Three Times Daily — 5 days'),
  ['Tab. PARACETAMOL 500 mg — Twice Daily — 3 days', 'Tab. AMOXICILLIN 250 mg — Three Times Daily (1-1-1) — 5 days']);
});

test('the rest of the medicine safety is unchanged: strength, unit, duration, route, frequency, name', () => {
  no('Add tablet Dolo 650 mg at night for 3 days.', ['Tab. DOLO 500 mg — At Night (0-0-1) — 3 days'], /contains 500/);
  no('Add tablet Dolo 650 mg at night for 3 days.', ['Tab. DOLO 650 mg — At Night (0-0-1) — 5 days'], /contains 5/);
  no('Add tablet Dolo 650 mg at night for 3 days.', ['Tab. DOLO 650 mcg — At Night — 3 days'], /"650 mcg"/);
  no('Add tablet Dolo 650 mg orally at night.', ['Tab. DOLO 650 mg — IV — At Night'], /route "IV"/);
  assert.deepEqual(both('Add tablet Dolo 650 mg at night.', 'Tab. DOLO 650 mg — Oral — At Night (0-0-1)'), ['Tab. DOLO 650 mg — At Night (0-0-1)'], 'unsaid route removed');
  no('Add tablet Dolo 650 mg every night.', ['Tab. DOLO 650 mg — Twice Daily — Every Night'], /frequency "Twice Daily"/);
  no('Add tablet new medicine at night.', ['Tab. NEW MEDICINE — At Night'], /no real medicine name/);
});

test('changing an EXISTING medicine is not touched by the time rules (only new lines are)', () => {
  // the Benadryl line already has "Daily Morning (1-0-0)": an unrelated change keeps it exactly
  const r = chk('change the azithromycin duration to 7 days', [{ block_id: 'B6', operation: 'replace_text', find_text: '5 days', new_value: '7 days', field_label: 'Advice' }]);
  assert.equal(r.reject, undefined, r.reject);
  // a new pattern on an existing line still needs to be said
  const c = chk('change the azithromycin to at night', [{ block_id: 'B6', operation: 'replace_text', find_text: '(1-0-1)', new_value: 'At Night (0-0-1)', field_label: 'Advice' }]);
  assert.match(c.reject, /dosing pattern 0-0-1/);
});

test('REPORTED: frequency AND time of day said -> both kept; the time dropped by the AI -> refused (never invented back)', () => {
  // Test 1: "once daily for 5 days in the morning"
  const S1 = 'Add a tablet Dolo of 650 mg once daily for 5 days in the morning.';
  assert.deepEqual(both(S1, 'TAB. DOLO 650 MG — ONCE DAILY — IN THE MORNING — 5 DAYS'), ['TAB. DOLO 650 MG — ONCE DAILY — IN THE MORNING (1-0-0) — 5 DAYS']);
  assert.deepEqual(both(S1, 'TAB. DOLO 650 MG — ONCE DAILY — IN THE MORNING (1-0-0) — 5 DAYS'), ['TAB. DOLO 650 MG — ONCE DAILY — IN THE MORNING (1-0-0) — 5 DAYS']);
  no(S1, ['TAB. DOLO 650 MG — ONCE DAILY — 5 DAYS'], /missing the time of day you said \("in the morning"\)/);
  no(S1, ['TAB. DOLO 650 MG — ONCE DAILY (1-0-0) — 5 DAYS'], /missing the time of day you said/);
  // Test 2: "every morning" is never replaced by "once daily"
  const S2 = 'Add tablet Dolo 650 mg every morning.';
  assert.deepEqual(both(S2, 'TAB. DOLO 650 MG — EVERY MORNING'), ['TAB. DOLO 650 MG — EVERY MORNING (1-0-0)']);
  no(S2, ['TAB. DOLO 650 MG — ONCE DAILY'], /missing the time of day you said \("every morning"\)/);
  // the other spoken times, frequency + time
  assert.deepEqual(both('Add tablet Dolo 650 mg every night.', 'Tab. DOLO 650 mg — Every Night'), ['Tab. DOLO 650 mg — Every Night (0-0-1)']);
  assert.deepEqual(both('Add tablet Dolo 650 mg night.', 'Tab. DOLO 650 mg — Night (0-0-1)'), ['Tab. DOLO 650 mg — Night (0-0-1)']);
  assert.deepEqual(both('Add tablet Dolo 650 mg afternoon.', 'Tab. DOLO 650 mg — Afternoon'), ['Tab. DOLO 650 mg — Afternoon (0-1-0)']);
  assert.deepEqual(both('Add tablet Dolo 650 mg once daily at night for 3 days.', 'Tab. DOLO 650 mg — Once Daily — At Night — 3 days'), ['Tab. DOLO 650 mg — Once Daily — At Night (0-0-1) — 3 days']);
  no('Add tablet Dolo 650 mg once daily at night.', ['Tab. DOLO 650 mg — Once Daily'], /missing the time of day you said \("at night"\)/);
  no('Add tablet Dolo 650 mg every night.', ['Tab. DOLO 650 mg — Once Daily (0-0-1)'], /missing the time of day you said/);
});
