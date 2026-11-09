// Tests for src/lib/commandIntent.js: ONE classifier for typed instructions and voice transcripts
// Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { classifyCommand, understandRemoval } from '../src/lib/commandIntent.js';
import { textAfter } from '../src/lib/medicineText.js';

const schema = getSchema([StarterKit]);
const t = (s, marks) => schema.text(s, marks);
const para = (...kids) => schema.node('paragraph', null, kids);
const heading = (s) => para(t(s, [schema.marks.bold.create()]));
const br = () => schema.nodes.hardBreak.create();
const ADVICE = [
  'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — Twice Daily (1-0-1) — 2 days',
  'Tab. METRONIDAZOLE (Metronidazole) 500 mg — Oral — Three Times Daily (1-1-1) — 2 days',
  'Syp. INSTARAFT (Antacid) 10 ml — Oral — Three Times Daily (1-1-1) — 5 days',
  'Tab. ZINCOVIT (Multivitamin/Mineral) — Oral — Once Daily (1-0-0) — 14 days',
  'Tab. DOLO (Paracetamol) 650 mg — Oral — As Needed (SOS)',
];
// the real layout: medicines in ONE paragraph separated by line breaks
const doc = schema.node('doc', null, [
  heading('DIAGNOSIS'), para(t('ENTERIC FEVER')),
  heading('PRESENTING COMPLAINT'), para(t('60-year-old female presented with loose stools.')),
  heading('COURSE IN HOSPITAL'), para(t('Patient is stable. Oral intake improved. Twice daily dressing.')),
  heading('ADVICE'), para(...ADVICE.flatMap((l, i) => (i ? [br(), t(l)] : [t(l)]))),
]);
const cls = (c) => classifyCommand(doc, c);
const afterLines = (r) => r.plan.changes.map(textAfter);

// ---------- 6: the exact voice command that was wrongly treated as "clear the section" ----------
const VOICE = 'Inside the Advice section remove oral in all the section and twice daily and so on.';
test('YOUR VOICE COMMAND: route + frequency removal in Advice, NOT a clear', () => {
  const r = cls(VOICE);
  assert.equal(r.type, 'remove');
  assert.deepEqual(r.intent.categories.sort(), ['frequency', 'route']);
  assert.equal(r.intent.section, 'ADVICE');
  assert.deepEqual(r.intent.phrases, []); // "and so on", "in all the section" are not phrases
  assert.equal(r.plan.changes.length, 5); // every medicine entry
  assert.deepEqual(afterLines(r), [
    'Tab. CIPLOX (Ciprofloxacin) 200 mg — (1-0-1) — 2 days',
    'Tab. METRONIDAZOLE (Metronidazole) 500 mg — (1-1-1) — 2 days',
    'Syp. INSTARAFT (Antacid) 10 ml — (1-1-1) — 5 days',
    'Tab. ZINCOVIT (Multivitamin/Mineral) — (1-0-0) — 14 days',
    'Tab. DOLO (Paracetamol) 650 mg — As Needed (SOS)', // SOS kept
  ]);
});

test('TYPED and VOICE give the same result (punctuation, capitals, spoken variants)', () => {
  const variants = [
    VOICE,
    'inside the advice section remove oral in all the section and twice daily and so on',
    'Inside the Advice section, remove Oral, Twice Daily, Three Times Daily and so on.',
    'in advice remove the oral and twice daily etc',
    'Remove phrases such as Oral, Twice Daily, Three Times Daily and so on.',
    'remove oral, twice daily and all those things from advice',
  ];
  const results = variants.map((v) => JSON.stringify(afterLines(cls(v))));
  for (const r of results) assert.equal(r, results[0]);
});

// ---------- 3: your list of natural instructions ----------
test('"Remove all oral instructions from Advice" -> only Oral', () => {
  const r = cls('Remove all oral instructions from Advice.');
  assert.deepEqual(r.intent.phrases.map((p) => p.toLowerCase()), ['oral']);
  assert.equal(afterLines(r)[0], 'Tab. CIPLOX (Ciprofloxacin) 200 mg — Twice Daily (1-0-1) — 2 days');
});

test('"Remove twice daily and once daily from all medicines" -> only those two (section found by itself)', () => {
  const r = cls('Remove twice daily and once daily from all medicines.');
  assert.equal(r.type, 'remove');
  assert.deepEqual(r.intent.phrases.map((p) => p.toLowerCase()), ['twice daily', 'once daily']);
  assert.equal(r.intent.section, 'ADVICE');
  assert.equal(afterLines(r)[0], 'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — (1-0-1) — 2 days');
  assert.ok(r.plan.changes.every((c) => !/three times/i.test(c.removals.map((x) => x.text).join())));
});

test('"Remove all route and frequency descriptions from Advice" -> both categories (not descriptions)', () => {
  const r = cls('Remove all route and frequency descriptions from Advice.');
  assert.deepEqual(r.intent.categories.sort(), ['frequency', 'route']);
});

test('"Remove frequency instructions from all tablets and syrups" -> frequency, only Tab./Syp.', () => {
  const r = cls('Remove frequency instructions from all tablets and syrups.');
  assert.deepEqual(r.intent.categories, ['frequency']);
  assert.deepEqual(r.intent.forms.sort(), ['syp', 'tab']);
  assert.equal(afterLines(r)[0], 'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — (1-0-1) — 2 days');
});

test('"Remove all administration route descriptions from the Advice section" -> route', () => {
  assert.deepEqual(cls('Remove all administration route descriptions from the Advice section.').intent.categories, ['route']);
});

test('"Remove Oral from Advice" -> phrase removal, never a clear', () => {
  const r = cls('Remove Oral from Advice');
  assert.equal(r.type, 'remove');
  assert.deepEqual(r.intent.phrases, ['Oral']);
});

// ---------- generic names ----------
test('"Remove generic names from Advice" -> every entry in the one paragraph, descriptions not ticked', () => {
  const r = cls('Remove generic names from Advice');
  assert.equal(r.type, 'remove');
  assert.equal(r.kind, 'generic');
  assert.deepEqual(r.plan.changes.flatMap((c) => c.removals.filter((x) => x.selected).map((x) => x.text)),
    ['(Ciprofloxacin)', '(Metronidazole)', '(Paracetamol)']);
  assert.equal(r.plan.changes.length, 5);
});

test('generic names plus route/frequency examples in one command', () => {
  const r = cls('remove the generic names and also oral, twice daily and so on from advice');
  assert.deepEqual(r.intent.categories.sort(), ['frequency', 'generic', 'route']);
  assert.equal(afterLines(r)[0], 'Tab. CIPLOX 200 mg — (1-0-1) — 2 days');
});

test('As Needed / SOS removed only when asked', () => {
  assert.equal(afterLines(cls('remove SOS and so on from advice')).at(-1), 'Tab. DOLO (Paracetamol) 650 mg — Oral');
});

// ---------- clear vs remove ----------
test('clear-section still works when nothing specific is named', () => {
  assert.equal(cls('Clear the entire Advice section').type, 'clear');
  assert.equal(cls('remove everything from the course in hospital').type, 'clear');
  assert.equal(cls('remove all the content from the presenting complaint and make it blank').type, 'clear');
});

test('"everything" mixed with something specific -> ask, never clear', () => {
  const r = cls('remove everything oral from advice');
  assert.equal(r.type, 'ask');
  assert.match(r.question, /remove only .*Oral.* or clear the whole section/i);
});

test('"Delete the Advice section" -> explains and asks (sections cannot be deleted)', () => {
  const r = cls('Delete the Advice section');
  assert.equal(r.type, 'ask');
  assert.match(r.question, /cannot be deleted/);
});

// ---------- asking instead of guessing ----------
test('"remove the instructions from Advice" -> asks which kind', () => {
  const r = cls('remove the instructions from advice');
  assert.equal(r.type, 'ask');
  assert.match(r.question, /route .* frequency .* as needed .* food timing/);
});

test('nothing of that kind in the section -> says so, changes nothing', () => {
  const r = cls('remove IV and IM and so on from advice'); // route category: Oral exists -> found
  assert.equal(r.type, 'remove');
  const none = cls('remove after food and so on from advice'); // no food timing in these lines
  assert.equal(none.type, 'ask');
  assert.match(none.question, /I found no food timing in Advice/);
});

// ---------- everything else still goes to the AI ----------
test('normal edits go to the AI as before', () => {
  for (const c of [
    'remove the line about malaria from course in hospital',
    'change the address to 12 MG Road, Kozhikode',
    'Inside COURSE IN THE HOSPITAL, add that the patient was diagnosed with malaria.',
    'and discharge date was 10th of October',
    'the patient is male',
  ]) {
    assert.equal(cls(c).type, 'ai', c);
  }
});

test('"I\'d like to remove oral from advice" is literal Oral (a plain "like" is not "and so on")', () => {
  const r = cls("I'd like to remove oral from advice");
  assert.deepEqual(r.intent.phrases.map((p) => p.toLowerCase()), ['oral']);
  assert.deepEqual(r.intent.categories, []);
});

test('exact words in a non-medicine section still work', () => {
  const r = cls('remove the word stable from course in hospital');
  assert.equal(r.type, 'remove');
  assert.deepEqual(afterLines(r), ['Patient is. Oral intake improved. Twice daily dressing.']);
});

test('understandRemoval: filler and scope words are never phrases', () => {
  const w = understandRemoval('remove Oral, Twice Daily and so on in all the section', 'ADVICE');
  assert.deepEqual(w.phrases, []);
  assert.deepEqual(w.categories.sort(), ['frequency', 'route']);
});
