// Tests for whole-medicine commands in src/lib/commandIntent.js ("remove all syrups", "remove the tablet Dolo")
// Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { classifyCommand } from '../src/lib/commandIntent.js';

const schema = getSchema([StarterKit]);
const t = (s, m) => schema.text(s, m);
const br = () => schema.nodes.hardBreak.create();
const para = (...k) => schema.node('paragraph', null, k);
const heading = (s) => para(t(s, [schema.marks.bold.create()]));
const ADVICE = [
  'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — Twice Daily (1-0-1) — 2 days',
  'Syp. INSTARAFT (Antacid) 10 ml — Oral — Three Times Daily (1-1-1) — 5 days',
  'Tab. DOLO (Paracetamol) 650 mg — Oral — As Needed (SOS)',
  'Syp. CREMAFFIN 15 ml — Oral — At night — 5 days',
  'Cap. PAN-D 40 mg — Oral — Once Daily — 5 days',
  'Tab. CIPLOX 500 mg — Oral — Twice Daily (1-0-1) — 3 days',
];
const doc = schema.node('doc', null, [
  heading('DIAGNOSIS'), para(t('ENTERIC FEVER')),
  heading('COURSE IN HOSPITAL'), para(t('Treated with Syp. ONDEM and Tab. DOLO. Patient is stable.')),
  heading('ADVICE'), para(...ADVICE.flatMap((l, i) => (i ? [br(), t(l)] : [t(l)]))),
]);
const cls = (c) => classifyCommand(doc, c);
const removed = (r) => r.plan.changes.map((c) => c.before);

test('YOUR VOICE COMMAND: "Remove all type of syrup. I don\'t want syrup in the advice section. Remove that syrup."', () => {
  const r = cls("Remove all type of syrup. I don't want syrup in the advice section. Remove that syrup.");
  assert.equal(r.type, 'remove');
  assert.equal(r.kind, 'entries');
  assert.deepEqual(r.intent.entries.forms, ['syp']);
  assert.deepEqual(removed(r), [ADVICE[1], ADVICE[3]]);
  assert.equal(r.plan.unchanged.length, 4);
});

test('YOUR COMMAND: "Remove the tablet Dolo" -> only the Dolo tablet', () => {
  const r = cls('Remove the tablet Dolo');
  assert.equal(r.type, 'remove');
  assert.deepEqual(removed(r), [ADVICE[2]]);
});

test('"remove all tablets from advice" / "remove all capsules"', () => {
  assert.deepEqual(removed(cls('remove all tablets from advice')), [ADVICE[0], ADVICE[2], ADVICE[5]]);
  assert.deepEqual(removed(cls('remove all capsules')), [ADVICE[4]]);
});

test('several medicines by name: "remove Dolo and Ciplox" (Ciplox twice)', () => {
  assert.deepEqual(removed(cls('remove Dolo and Ciplox from advice')), [ADVICE[0], ADVICE[2], ADVICE[5]]);
});

test('a generic name finds the brand: "remove paracetamol"', () => {
  assert.deepEqual(removed(cls('remove the paracetamol tablet')), [ADVICE[2]]);
});

test('a medicine that does not exist -> clear message, nothing changed', () => {
  const r = cls('Remove the tablet Crocin');
  assert.equal(r.type, 'ask');
  assert.match(r.question, /could not find a medicine called Crocin in Advice\. Nothing was changed/);
});

test('one found, one not -> the found one is proposed, the other is listed as not found', () => {
  const r = cls('remove the tablet Dolo and the tablet Crocin');
  assert.deepEqual(removed(r), [ADVICE[2]]);
  assert.ok(r.plan.notFound.includes('Crocin'));
});

test('a form that is not there -> clear message', () => {
  const r = cls('remove all injections from advice');
  assert.equal(r.type, 'ask');
  assert.match(r.question, /There are no injections in Advice/);
});

test('mixed with "everything" -> asks, never guesses', () => {
  assert.equal(cls('remove everything about syrups from advice').type, 'ask');
});

test('Course in Hospital mentions Syp. ONDEM and Tab. DOLO: never touched by Advice removals', () => {
  const r = cls('remove all syrups');
  assert.ok(r.plan.changes.every((c) => !c.before.includes('ONDEM')));
});

test('existing commands keep their meaning', () => {
  assert.equal(cls('Remove the generic names of all tablets.').kind, 'generic');
  assert.deepEqual(cls('Remove frequency instructions from all tablets and syrups.').intent.categories, ['frequency']);
  assert.deepEqual(cls('Inside the Advice section remove oral in all the section and twice daily and so on.').intent.categories.sort(), ['frequency', 'route']);
  assert.equal(cls('remove everything from the course in hospital').type, 'clear');
  assert.equal(cls('Delete the Advice section').type, 'ask');
  for (const c of ['remove the line about malaria from course in hospital', 'Inside COURSE IN THE HOSPITAL, add that the patient was diagnosed with malaria.',
    'change the age to 31', 'add Tab. PAN 40 mg — Oral — Once Daily — 5 days to advice']) {
    assert.equal(cls(c).type, 'ai', c);
  }
});
