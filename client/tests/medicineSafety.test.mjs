// Medicine safety for typed and spoken commands: src/lib/verify.js checkMedicineEdits (+ numbersSaid).
// A new or changed medicine line may contain ONLY what the person said. Dummy data only.
// Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { checkMedicineEdits, checkTableEdits, numbersSaid, sectionTitleOf, withDuplicateChoice } from '../src/lib/verify.js';
import { getBlocks } from '../src/lib/outline.js';

const schema = getSchema([StarterKit]);
const p = (s, bold) => schema.node('paragraph', null, [schema.text(s, bold ? [schema.marks.bold.create()] : undefined)]);
const doc = schema.node('doc', null, [
  p('DISCHARGE SUMMARY', true), // B0
  p('DIAGNOSIS', true), p('ENTERIC FEVER'), // B1 B2
  p('TREATMENT GIVEN', true), p('Inj. CEFTRIAXONE 1 g — IV — Twice Daily'), // B3 B4
  p('ADVICE', true), // B5
  p('Tab. DOLO (Paracetamol) 650 mg — Oral — As needed (SOS) for fever'), // B6
  p('Tab. CIPLOX 200 mg — (1-0-1) — 2 days'), // B7
  p('Review in OPD after 1 week.'), // B8
  p('FOLLOW UP', true), p('Review in OPD after 7 days.'), // B9 B10
]);
const add = (new_value, block_id = 'B7') => [{ block_id, operation: 'insert_after', new_value, field_label: 'Advice' }];
const chk = (said, edits, extra = '') => checkMedicineEdits(doc, { said, edits, extra });
const ok = (said, edits, msg) => { const r = chk(said, edits); assert.equal(r.reject, undefined, `${msg || said}: ${r.reject}`); return r; };
const no = (said, edits, re, msg) => { const r = chk(said, edits); assert.ok(r.reject, `${msg || said}: should be refused`); if (re) assert.match(r.reject, re, msg || said); return r; };

test('the dummy document: blocks and sections as the tests expect', () => {
  const b = getBlocks(doc).map((x) => x.node.textContent);
  assert.equal(b[6].slice(0, 8), 'Tab. DOL');
  assert.equal(sectionTitleOf(doc, 'B7'), 'ADVICE');
  assert.equal(sectionTitleOf(doc, 'B4'), 'TREATMENT GIVEN');
});

test('numbers said: written next to a unit, spoken "six fifty", and all the existing forms', () => {
  const has = (s, n) => assert.ok(numbersSaid(s).includes(n), `${s} -> ${n} (${numbersSaid(s)})`);
  has('add paracetamol 500mg', 500); has('tab 650MG', 650); has('1.5g', 1.5); has('for 5days', 5); has('review on 20th', 20);
  // spoken "six fifty" stays 6 and 50 (it could also mean 6.50): never read as 650 (the existing decision)
  has('dolo six fifty', 6); has('dolo six fifty', 50); assert.ok(!numbersSaid('dolo six fifty').includes(650));
  has('six hundred fifty', 650); has('five hundred milligram', 500); has('zero point five', 0.5); has('Dolo-650', 650);
  has('5 lakh 86 thousand', 586000);
  assert.ok(!numbersSaid('vitamin b12 is 400').includes(12)); // "b12" stays one word, as before
  assert.ok(!numbersSaid('6 50').includes(650)); // digits are never joined
});

test('valid new medicine entries pass (only what was said; equivalent forms of the same words)', () => {
  const r = ok('add tablet Azee 500 mg after food twice a day for 5 days to advice', add('Tab. AZEE 500 mg — Twice Daily — After Food — 5 days'));
  assert.equal(r.medicine, true);
  ok('add tab azee 500mg BD for three days', add('Tab. AZEE 500 mg — Twice Daily — 3 days'));
  ok('add tablet pan six hundred fifty mg orally', add('Tab. PAN 650 mg — Oral'));
  no('add tablet pan six fifty mg orally', add('Tab. PAN 650 mg — Oral'), /contains 650/, '"six fifty" is refused, never guessed');
  ok('add tablet pan 40 milligram before breakfast', add('Tab. PAN 40 mg — Before Breakfast'));
  ok('add tablet zincovit 1-0-1', add('Tab. ZINCOVIT — (1-0-1)'));
  ok('add tablet zincovit zero zero one', add('Tab. ZINCOVIT (0-0-1)'));
  ok('add syrup ascoril 10 ml three times a day', add('Syp. ASCORIL 10 ml — Three Times Daily'));
  ok('add tablet azee 500 mg once daily for a week', add('Tab. AZEE 500 mg — Once Daily — 1 week'));
  // Option A: only the parts said, words said are written as said
  ok('Add the following medication entry in the advice section: Paracetamol 500 mg oral route as prescribed by the treating physician',
    add('Paracetamol 500 mg — Oral — As prescribed by the treating physician', 'B4'));
  // names: exact, capitals / punctuation / spacing aside
  ok('in treatment given add tablet Dolo-650', add('Tab. DOLO 650', 'B4'));
  ok('add tablet co amoxiclav 625 mg', add('Tab. CO-AMOXICLAV 625 mg'));
  ok('add tablet amoxiclav 625 mg', add('Tab. Amoxiclav 625 mg'));
});

test('optional details nobody said are REMOVED from a new medicine line (not refused); invented numbers still refuse', () => {
  const cleaned = (said, v, at) => ok(said, add(v, at)).edits[0].new_value;
  // the example: "Oral" was not said -> removed, the rest is added (DOLO is already there: a new line)
  const r = ok('Add tablet Dolo 500 mg daily night', add('Tab. DOLO 500 mg — Oral — Daily Night'));
  assert.equal(r.edits[0].new_value, 'Tab. DOLO 500 mg — Daily Night');
  assert.deepEqual(r.newEntries, [0]);
  assert.equal(cleaned('add tablet azee 500 mg to advice', 'Tab. AZEE 500 mg — Oral'), 'Tab. AZEE 500 mg');
  assert.equal(cleaned('add tablet azee 500 mg to advice', 'Tab. AZEE 500 mg — As needed (SOS)'), 'Tab. AZEE 500 mg');
  assert.equal(cleaned('add tablet azee 500 mg to advice', 'Tab. AZEE 500 mg — SOS'), 'Tab. AZEE 500 mg');
  assert.equal(cleaned('add tablet azee 500 mg to advice', 'Tab. AZEE 500 mg — As directed by the physician'), 'Tab. AZEE 500 mg');
  assert.equal(cleaned('add tablet azee 500 mg to advice', 'Tab. AZEE 500 mg — After Food'), 'Tab. AZEE 500 mg');
  assert.equal(cleaned('add tablet azee 500 mg', 'Tab. AZEE (Azithromycin) 500 mg — Oral'), 'Tab. AZEE 500 mg');
  assert.equal(cleaned('add azee 500 mg', 'Tab. AZEE 500 mg'), 'AZEE 500 mg'); // "Tab." not said
  assert.equal(cleaned('add tablet azee 500 mg twice a day', 'Tab. AZEE 500 mg — Oral — Twice Daily — After Food'), 'Tab. AZEE 500 mg — Twice Daily');
  assert.equal(cleaned('add tablet azee 500 mg', 'Tab. AZEE 500 mg (SOS)'), 'Tab. AZEE 500 mg');
  // what WAS said stays exactly; a line with nothing extra is not touched
  assert.equal(cleaned('add tablet azee 500 mg orally after food', 'Tab. AZEE 500 mg — Oral — After Food'), 'Tab. AZEE 500 mg — Oral — After Food');
  // a name is never cut ("Inj. IV PARACETAMOL": IV is part of the name)
  assert.equal(cleaned('in treatment given add injection iv paracetamol 1 g', 'Inj. IV PARACETAMOL 1 g', 'B4'), 'Inj. IV PARACETAMOL 1 g');
  // a DIFFERENT detail than said is a mistake, not an extra: refused (never silently dropped)
  no('add tablet azee 500 mg once daily', add('Tab. AZEE 500 mg — Twice Daily'), /frequency "Twice Daily"/);
  no('add tablet azee 500 mg orally', add('Tab. AZEE 500 mg — IV'), /route "IV"/);
  // numbers, units and dosing patterns are never removed: an invented one refuses the whole command
  no('add tablet azee 500 mg for 5 days', add('Tab. AZEE 500 mg — 5 weeks'), /"5 week"/);
  no('add tablet azee 500 mg', add('Tab. AZEE 500 mg — 5 days'), /contains 5/);
  no('add tablet azee', add('Tab. AZEE 500 mg'), /contains 500/);
  no('add tablet zincovit', add('Tab. ZINCOVIT — (1-0-1)'), /dosing pattern 1-0-1/);
});

test('strict units: a number needs the same unit as said', () => {
  no('add tablet azee 500', add('Tab. AZEE 500 mg'), /"500 mg".*same unit/);
  no('in treatment given add tablet dolo 650', add('Tab. DOLO 650 mg', 'B4'), /"650 mg"/);
  no('add tablet azee 500 mcg', add('Tab. AZEE 500 mg'), /"500 mg"/);
  no('add injection ceftum 1', add('Inj. CEFTUM 1 g'), /"1 g"/);
  ok('add tablet azee 500 milligram', add('Tab. AZEE 500 mg'));
  ok('add tablet azee 500 mg', add('Tab. AZEE 500 mg'));
  ok('add injection ceftum 1.5 grams', add('Inj. CEFTUM 1.5 gm'));
  ok('add syrup ascoril 5 millilitres', add('Syp. ASCORIL 5 ml'));
});

test('names of NEW medicines: the name from the AI is used for now (no exact matching); placeholders are still refused', () => {
  no('add a new medicine to advice', add('Tab. NEW MEDICINE'), /no real medicine name/);
  no('add a medicine to advice', add('NEW MEDICINE 500 mg'), /no real medicine name/);
  no('add tablet a new medicine', add('Tab. NEW MEDICINE'), /no real medicine name/);
  ok('add tablet metformin 500 mg', add('Tab. TESTMET 500 mg'));
  ok('in treatment given add tablet dollo 650', add('Tab. DOLO 650', 'B4'));
  ok('add tablet azee 500 mg', add('Tab. AZEE XL 500 mg'));
});

test('an ADD of a medicine already there always adds a NEW line (no question); the existing entry is never changed', () => {
  for (const [said, v] of [['add tablet dolo 650 mg to advice', 'Tab. DOLO 650 mg'], ['add tablet dolo 650 mg again', 'Tab. DOLO 650 mg'],
    ['add another tablet dolo 650 mg', 'Tab. DOLO 650 mg'], ['add tablet dolo 650 mg as a new entry', 'Tab. DOLO 650 mg'],
    ['add tablet paracetamol 500 mg', 'Tab. PARACETAMOL 500 mg']]) { // the last: the generic name of DOLO
    const r = ok(said, add(v));
    assert.deepEqual(r.newEntries, [0], said);
    assert.equal(r.edits[0].operation, 'insert_after'); // a new line: the existing DOLO line is not part of the edit
  }
  // the AI's own flag alone is irrelevant: the check decides (and withDuplicateChoice replaces the flag)
  assert.deepEqual(ok('add tablet dolo 650 mg', [{ ...add('Tab. DOLO 650 mg')[0], duplicate_ok: true }]).newEntries, [0]);
  // not there yet / another section: not a second entry
  assert.deepEqual(ok('add tablet azee 500 mg', add('Tab. AZEE 500 mg')).newEntries, []);
  assert.deepEqual(ok('in treatment given add tablet dolo 650 mg', add('Tab. DOLO 650 mg', 'B4')).newEntries, []);
  // an "add" that would CHANGE the existing DOLO line is still refused (never silently modified)
  no('add tablet dolo 500 mg', [{ block_id: 'B6', operation: 'set', new_value: 'Tab. DOLO 500 mg', field_label: 'Advice' }]);
  no('add tablet dolo 500 mg', [{ block_id: 'B6', operation: 'replace_text', find_text: '650 mg — Oral', new_value: '500 mg', field_label: 'Advice' }]);
});

test('the examples: Tab. Paracetamol 650 mg already there', () => {
  const d = schema.node('doc', null, [p('ADVICE', true), p('Tab. Paracetamol 650 mg'), p('Review in OPD after 1 week.')]);
  const ins = (v) => [{ block_id: 'B1', operation: 'insert_after', new_value: v, field_label: 'Advice' }];
  const r = checkMedicineEdits(d, { said: 'Add tablet Paracetamol 550 mg as a new entry', edits: ins('Tab. Paracetamol 550 mg') });
  assert.equal(r.reject, undefined);
  assert.deepEqual(r.newEntries, [0]);
  assert.equal(r.edits[0].new_value, 'Tab. Paracetamol 550 mg');
  assert.deepEqual(checkMedicineEdits(d, { said: 'Add tablet Paracetamol', edits: ins('Tab. Paracetamol') }).newEntries, [0]);
  // still strict on numbers: the AI copies 650 from the existing line when 550 was said -> refused
  assert.match(checkMedicineEdits(d, { said: 'Add tablet Paracetamol 550 mg as a new entry', edits: ins('Tab. Paracetamol 650 mg') }).reject, /contains 650/);
});

test('duplicate_ok follows the person\'s words only: the AI flag is removed, set only on the edits the words asked for', () => {
  const edits = [
    { block_id: 'B7', operation: 'insert_after', new_value: 'Tab. DOLO 650 mg', duplicate_ok: true },
    { block_id: 'B8', operation: 'insert_after', new_value: 'Drink water.', duplicate_ok: true },
    { block_id: 'B4', operation: 'insert_after', new_value: 'Tab. X' },
  ];
  const none = withDuplicateChoice(edits, []);
  assert.ok(none.every((e) => !('duplicate_ok' in e)));
  const one = withDuplicateChoice(edits, [2]);
  assert.deepEqual(one.map((e) => e.duplicate_ok), [undefined, undefined, true]);
  assert.equal(edits[0].duplicate_ok, true); // the input is not changed
});

test('existing medicines: a part changes only when the command names it', () => {
  const set = (v) => [{ block_id: 'B6', operation: 'set', new_value: v, field_label: 'Advice' }];
  ok('change dolo to 500 mg', set('Tab. DOLO (Paracetamol) 500 mg — Oral — As needed (SOS) for fever'));
  no('change dolo to 500 mg', set('Tab. DOLO (Paracetamol) 500 mg — As needed (SOS) for fever'), /route of DOLO/);
  no('change dolo to 500 mg', set('Tab. DOLO 500 mg — Oral — As needed (SOS) for fever'), /bracket of DOLO/);
  no('change dolo to 500 mg', set('Syp. DOLO (Paracetamol) 500 mg — Oral — As needed (SOS) for fever'), /form \(Syp\)/);
  no('make dolo bold', set('Tab. DOLO (Paracetamol) 650 mg — Oral — Twice Daily'), /frequency "Twice Daily"/);
  ok('change the route of dolo to IV', [{ block_id: 'B6', operation: 'replace_text', find_text: 'Oral', new_value: 'IV', field_label: 'Advice' }]);
  no('change dolo', [{ block_id: 'B6', operation: 'replace_text', find_text: 'Oral', new_value: 'IV', field_label: 'Advice' }], /route "IV"/);
  ok('replace dolo with tablet crocin', set('Tab. CROCIN 650 mg — Oral — As needed (SOS) for fever'));
  no('change the dose to 650', set('Tab. CROCIN 650 mg — Oral — As needed (SOS) for fever'), /CROCIN was not in your command/);
  // removing a whole medicine: its name must be in the command
  ok('remove ciplox', [{ block_id: 'B7', operation: 'clear', field_label: 'Advice' }]);
  no('clear this line', [{ block_id: 'B7', operation: 'clear', field_label: 'Advice' }], /remove CIPLOX/);
});

test('ordinary advice sentences stay ordinary lines (no medicine checks on their words), invented medicine words are refused', () => {
  for (const s of ['Do not stop medication without cardiologist advice.', 'Continue medication as directed by the treating physician.',
    'Come after the medicine completes.']) {
    const r = ok(`in advice add: ${s}`, add(s, 'B8'));
    assert.equal(r.medicine, false, s);
  }
  ok('review on twentieth november', add('Review on 20-11-2026.', 'B8')); // dates: no number check in advice lines
  no('come after the medicine completes', add('Come after the medicine completes (SOS).', 'B8'), /as needed/);
  no('do not stop medication without cardiologist advice', add('Tab. Medication — Do not stop without cardiologist advice', 'B8'));
  no('continue the same medicines', add('Continue Tab. DOLO as before.', 'B8'), /form \(Tab\)/);
  no('continue the same medicines as directed', add('Continue medicines as directed, after food.', 'B8'), /food timing/);
});

test('non-English: the restatement counts ONLY for route / frequency / food / as-needed words, never for names or numbers', () => {
  const tg = (v) => add(v, 'B4');
  const r = chk('tablet azee 500 mg randu neram', tg('Tab. AZEE 500 mg — Twice Daily'), 'add Tab. AZEE 500 mg twice daily');
  assert.equal(r.reject, undefined);
  assert.equal(r.edits[0].new_value, 'Tab. AZEE 500 mg — Twice Daily'); // the restatement counts for the frequency
  // without the restatement the frequency counts as not said: removed (not refused)
  assert.equal(chk('tablet azee 500 mg randu neram', tg('Tab. AZEE 500 mg — Twice Daily')).edits[0].new_value, 'Tab. AZEE 500 mg');
  // the form never comes from the restatement: removed
  assert.equal(chk('randu neram', tg('Tab. AZEE — Twice Daily'), 'add Tab. AZEE twice daily').edits[0].new_value, 'AZEE — Twice Daily');
  // numbers never come from the restatement
  assert.match(chk('tablet azee randu neram', tg('Tab. AZEE 500 mg — Twice Daily'), 'add Tab. AZEE 500 mg twice daily').reject, /500/);
});

test('scope: other sections, tables, look-only edits and empty edit lists are not medicine changes', () => {
  const none = (r, edits) => { assert.equal(r.medicine, false); assert.deepEqual(r.newEntries, []); assert.deepEqual(r.edits, edits); };
  const diag = [{ block_id: 'B2', operation: 'append', new_value: ', TYPHOID', field_label: 'Diagnosis' }];
  const bold = [{ block_id: 'B6', operation: 'format', style: 'bold', field_label: 'Advice' }];
  none(chk('add typhoid', diag), diag); // returned unchanged
  none(chk('make dolo bold', bold), bold);
  none(chk('anything', []), []);
  // the existing number check still refuses an invented number in a Tab. line (unchanged)
  assert.equal(checkTableEdits(doc, 'add tablet azee', add('Tab. AZEE 500 mg')).blocked.length, 1);
  assert.equal(checkTableEdits(doc, 'add tablet azee 500mg', add('Tab. AZEE 500 mg')).blocked.length, 0); // "500mg" is now read
});

test('App.jsx: typed and spoken medicine commands are applied directly after every check; no voice medicine window', () => {
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /checkMedicineEdits\(editor\.state\.doc, \{ said: words, edits: check\.edits \}\)/); // typed + voice
  assert.match(app, /checkMedicineEdits\(doc, \{ said: original, extra: u, edits: check\.edits \}\)/); // non-English window (unchanged)
  // the voice medicine window is gone
  for (const gone of ['voiceMedicine', 'showVoiceMedicine', 'applyVoiceMedicine', 'if (voice && med.medicine)']) assert.ok(!app.includes(gone), gone);
  // both command paths apply the CHECKED edits (details nobody said removed); duplicate_ok from the check, never the AI
  assert.match(app, /const checked = file \? check\.edits : withDuplicateChoice\(med\.edits, med\.newEntries\);/);
  assert.match(app, /checkTableEdits\(doc, command, withDuplicateChoice\(med\.edits, med\.newEntries\)\)/);
  // the order in runEdits: medicine check -> number check -> 2-medicine rule -> all-or-nothing dry run -> apply
  const run = app.slice(app.indexOf('async function runEdits'), app.indexOf('async function runAndReport'));
  const at = (s) => { const i = run.indexOf(s); assert.ok(i > 0, s); return i; };
  assert.ok(at('if (med.reject)') < at('checkTableEdits(') && at('checkTableEdits(') < at('medicinesLostByEdits(')
    && at('medicinesLostByEdits(') < at('if (med.medicine) {') && at('if (med.medicine) {') < at('dry.blocked.length') && at('dry.blocked.length') < at('applyAiEdits('));
});
