// Option 1: the AI's "Understood: ..." restatement is never trusted by itself (lib/interpretation.js), and a
// Malayalam command whose action the app cannot check is never carried out. Dummy data only.
// Run:  cd client  &&  node --test tests/
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { understoodFrom, malayalamStop, checkInterpretation, hasMalayalam } from '../src/lib/interpretation.js';
import { classifyCommand } from '../src/lib/commandIntent.js';
import { textAfter } from '../src/lib/medicineText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-interp');
await build({
  entryPoints: [path.join(here, '../src/components/ConfirmChanges.jsx')],
  outfile: path.join(tmp, 'ConfirmChanges.mjs'), format: 'esm', jsx: 'automatic', bundle: true, packages: 'external', logLevel: 'silent',
});
const { default: ConfirmChanges, toggleEntryRemovals } = await import(pathToFileURL(path.join(tmp, 'ConfirmChanges.mjs')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit]);
const t = (s, m) => schema.text(s, m);
const para = (...kids) => schema.node('paragraph', null, kids);
const heading = (s) => para(t(s, [schema.marks.bold.create()]));
const br = () => schema.nodes.hardBreak.create();
const ADVICE = [
  'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — Twice Daily (1-0-1) — 2 days',
  'Syp. INSTARAFT (Antacid) 10 ml — Oral — Three Times Daily (1-1-1) — 5 days',
  'Tab. DOLO (Paracetamol) 650 mg — Oral — As Needed (SOS)',
];
const doc = schema.node('doc', null, [heading('DIAGNOSIS'), para(t('FEVER')), heading('ADVICE'), para(...ADVICE.flatMap((l, i) => (i ? [br(), t(l)] : [t(l)])))]);
const check = (original, understood, cursor) => checkInterpretation(doc, { original, understood, cursor });

// Malayalam test sentences (dummy): "from all tablets oral remove do" with English words kept in English letters
const ML_REMOVE = 'എല്ലാ tablets-ൽ നിന്നും oral remove ചെയ്യൂ';
const ML_NO_ACTION = 'എല്ലാ മരുന്നുകളിൽ നിന്നും oral കളയുക'; // the action is a Malayalam word only
const ML_CHANGE = 'എല്ലാ tablets-ൽ oral change ചെയ്യൂ';

test('"Understood:" is read from the AI summary', () => {
  assert.equal(understoodFrom('Understood: remove the Oral route from all tablets in Advice. Removed 2 lines.'), 'remove the Oral route from all tablets in Advice');
  assert.equal(understoodFrom('Understood: remove Oral from Tab. DOLO in Advice.'), 'remove Oral from Tab. DOLO in Advice');
  assert.equal(understoodFrom('Changed the age.'), '');
  assert.equal(hasMalayalam(ML_REMOVE), true);
  assert.equal(hasMalayalam('oral hatao sab tablet se'), false);
});

test('a matching interpretation -> the plan is REBUILT BY CODE from the document (the AI edits are not used)', () => {
  const r = check(ML_REMOVE, 'remove the Oral route from all tablets in Advice');
  assert.equal(r.type, 'remove');
  assert.deepEqual(r.intent.forms, ['tab']);
  // exactly what the code classifier plans for the plain English command
  assert.deepEqual(r.plan.changes.map(textAfter), classifyCommand(doc, 'remove the Oral route from all tablets in Advice').plan.changes.map(textAfter));
  assert.deepEqual(r.plan.changes.map(textAfter), ['Tab. CIPLOX (Ciprofloxacin) 200 mg — Twice Daily (1-0-1) — 2 days', 'Tab. DOLO (Paracetamol) 650 mg — As Needed (SOS)']);
  assert.equal(r.original, ML_REMOVE);
});

test('an interpretation that does not match the original words -> asks (type, part, medicine name, "this medicine")', () => {
  const type = check('എല്ലാ medicines-ൽ നിന്നും oral remove ചെയ്യൂ', 'remove the Oral route from all tablets in Advice');
  assert.equal(type.type, 'ask');
  assert.match(type.question, /medicine types do not match/);
  const part = check(ML_REMOVE, 'remove Oral and all frequency instructions from all tablets in Advice');
  assert.equal(part.type, 'ask');
  assert.match(part.question, /"frequency" is not in your words/);
  const name = check('ഡോളോയിൽ നിന്ന് oral remove ചെയ്യൂ', 'remove Oral from DOLO in Advice');
  assert.equal(name.type, 'ask');
  assert.match(name.question, /"DOLO" is not in your words/);
  // cursor on CIPLOX, but the original words never said "this medicine"
  const thisOne = check('ഇതിൽ നിന്ന് oral remove ചെയ്യൂ', 'remove Oral from this medicine in Advice', 30);
  assert.equal(thisOne.type, 'ask');
  assert.match(thisOne.question, /do not say which medicine/);
});

test('an interpretation that is itself unclear or unsafe -> asks (never falls through to the AI edits)', () => {
  const noMedicine = check('this medicine oral remove', 'remove Oral from this medicine in Advice', 3); // cursor not on a medicine
  assert.equal(noMedicine.type, 'ask');
  assert.match(noMedicine.question, /click on the medicine/);
  const bulk = check('all tablet duration 5 days make', 'change the duration of all tablets to 5 days');
  assert.equal(bulk.type, 'ask');
  assert.match(bulk.question, /one medicine at a time/);
});

test('only a medicine REMOVAL may come from an interpretation (never a section clear, never anything else)', () => {
  assert.equal(check('advice clear ചെയ്യൂ', 'clear the entire Advice section').type, 'none');
  assert.equal(check('age 45 change ചെയ്യൂ', 'change the age to 45').type, 'none');
  assert.equal(check('remove oral', '').type, 'none');
});

test('MALAYALAM without a supported action word: NEVER carried out (medicine and non-medicine commands)', () => {
  const q = malayalamStop(ML_NO_ACTION, 'remove the Oral route from all medicines in Advice');
  assert.match(q, /cannot confirm the action in Malayalam yet/);
  assert.match(q, /I understood: "remove the Oral route from all medicines in Advice"/);
  assert.match(q, /Nothing was changed/);
  assert.match(malayalamStop('പ്രായം 45 ആക്കുക'), /cannot confirm the action/); // "make the age 45": not a medicine command
  // and the interpretation check refuses it too (no window can open, so no tick box can apply it)
  const r = check(ML_NO_ACTION, 'remove the Oral route from all medicines in Advice');
  assert.equal(r.type, 'ask');
  assert.match(r.question, /cannot confirm the action in your words/);
  assert.equal(r.plan, undefined); // nothing that could be applied
});

test('MALAYALAM with a different action word than understood -> asks (never carried out)', () => {
  assert.equal(malayalamStop(ML_CHANGE), ''); // "change" is a supported word...
  const r = check(ML_CHANGE, 'remove the Oral route from all tablets in Advice'); // ...but the AI understood "remove"
  assert.equal(r.type, 'ask');
});

test('commands WITHOUT Malayalam: no Malayalam stop', () => {
  assert.equal(malayalamStop('remove oral from all tablets'), '');
  assert.equal(malayalamStop('oral hatao sab tablet se'), '');
});

test('HINDI removal understood by the AI but the action ("hatao") cannot be checked -> asks for an English removal word', () => {
  for (const said of ['oral hatao sab tablet se', 'sab tablet se oral nikalo', 'oral hata do tablets se']) {
    const r = check(said, 'remove the Oral route from all tablets in Advice');
    assert.equal(r.type, 'ask', said);
    assert.match(r.question, /cannot confirm the action in your words/, said);
    assert.match(r.question, /English removal word such as "remove"/, said);
    assert.match(r.question, /Nothing was changed/, said);
    assert.equal(r.plan, undefined, said); // no plan: nothing can be applied, and the AI edits are not used
  }
  // the same words with "remove" are checked and shown in the window as normal
  assert.equal(check('oral remove sab tablet se', 'remove the Oral route from all tablets in Advice').type, 'remove');
  // a NON-removal interpretation continues on the normal path with its existing checks (unchanged)
  assert.equal(check('age 45 kar do', 'change the age to 45').type, 'none');
});

test('the confirm window shows "Understood by AI" next to the person\'s own words', () => {
  const r = check(ML_REMOVE, 'remove the Oral route from all tablets in Advice');
  const html = renderToStaticMarkup(React.createElement(ConfirmChanges, {
    kind: r.kind, plan: r.plan, understood: r.understood, original: r.original, onApply() {}, onCancel() {},
  }));
  assert.match(html, /Understood by AI: <b>remove the Oral route from all tablets in Advice<\/b>/);
  assert.ok(html.includes(`Your words: <i>${ML_REMOVE}</i>`));
  // without an interpretation the window is as before (no banner)
  const plain = classifyCommand(doc, 'remove oral from all tablets');
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(ConfirmChanges, { kind: plain.kind, plan: plain.plan, onApply() {}, onCancel() {} })), /Understood by AI/);
});

test('the window: dosing patterns shown as separate UNTICKED boxes, with a note', () => {
  const r = classifyCommand(doc, 'remove frequency from all medicines');
  const html = renderToStaticMarkup(React.createElement(ConfirmChanges, { kind: r.kind, plan: r.plan, onApply() {}, onCancel() {} }));
  assert.match(html, /<label class="confirm-chip "><input type="checkbox"\/><span>\(1-0-1\)<\/span><em>dosing pattern<\/em>/); // no "on", not checked
  assert.match(html, /Dosing patterns such as \(1-0-1\) are shown but not ticked/);
  // explicitly asked: ticked, and no note
  const asked = classifyCommand(doc, 'remove the dosing patterns from all medicines');
  const html2 = renderToStaticMarkup(React.createElement(ConfirmChanges, { kind: asked.kind, plan: asked.plan, onApply() {}, onCancel() {} }));
  assert.match(html2, /<label class="confirm-chip on"><input type="checkbox" checked=""\/><span>\(1-0-1\)<\/span>/);
  assert.doesNotMatch(html2, /shown but not ticked/);
});

test('re-ticking a whole line restores the PROPOSED ticks (a dosing pattern is never ticked that way)', () => {
  const r = classifyCommand(doc, 'remove frequency from all medicines');
  const proposed = r.plan.changes[0].removals; // Twice Daily (ticked), (1-0-1) (unticked)
  const off = toggleEntryRemovals({ ...r.plan.changes[0], removals: proposed.map((x) => ({ ...x })) }, proposed);
  assert.ok(off.removals.every((x) => !x.selected));
  const on = toggleEntryRemovals(off, proposed);
  assert.deepEqual(on.removals.map((x) => [x.kind, x.selected]), [['frequency', true], ['pattern', false]]);
});

test('an interpretation may tick dosing patterns only when the person\'s OWN words ask for them', () => {
  const no = check('എല്ലാ tablets-ൽ നിന്നും frequency remove ചെയ്യൂ', 'remove all frequency instructions and dosing patterns from all tablets in Advice');
  assert.equal(no.type, 'ask');
  assert.match(no.question, /do not ask to remove the dosing patterns/);
  const yes = check('എല്ലാ tablets-ൽ നിന്നും frequency, dosing pattern remove ചെയ്യൂ', 'remove all frequency instructions and dosing patterns from all tablets in Advice');
  assert.equal(yes.type, 'remove');
});

test('your commands are recognised LOCALLY (typed: the preview opens without any AI call)', () => {
  for (const c of ['Remove Oral and Three Times Daily from all medicines', 'Remove frequency from all medicines', 'remove the dosing patterns from all medicines']) {
    assert.equal(classifyCommand(doc, c).type, 'remove', c);
  }
});
