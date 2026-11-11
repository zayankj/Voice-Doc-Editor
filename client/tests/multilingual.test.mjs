// Approved option A: commands the app cannot check against the person's own words (not English) are never applied
// directly. The AI's plain-English "understood" goes through the existing engine / checks, and a window shows it
// next to the person's words. English commands keep the existing path. Dummy data only.
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
import { needsPreview, reportedNonEnglish, interpretForPreview, checkInterpretation, malayalamStop, englishChecksCannotRead } from '../src/lib/interpretation.js';
import { classifyCommand } from '../src/lib/commandIntent.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-multi');
for (const c of ['UploadPreview', 'ConfirmClear']) {
  await build({
    entryPoints: [path.join(here, `../src/components/${c}.jsx`)],
    outfile: path.join(tmp, `${c}.mjs`), format: 'esm', jsx: 'automatic', bundle: true, packages: 'external', logLevel: 'silent',
  });
}
const { default: UploadPreview } = await import(pathToFileURL(path.join(tmp, 'UploadPreview.mjs')).href);
const { default: ConfirmClear } = await import(pathToFileURL(path.join(tmp, 'ConfirmClear.mjs')).href);
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
const doc = schema.node('doc', null, [
  heading('DIAGNOSIS'), para(t('ENTERIC FEVER')),
  heading('COURSE IN HOSPITAL'), para(t('Patient is stable. Treated with Tab. DOLO 650 mg.')),
  heading('ADVICE'), para(...ADVICE.flatMap((l, i) => (i ? [br(), t(l)] : [t(l)]))), para(t('Review in OPD after 1 week')),
]);
const interpret = (original, understood) => interpretForPreview(doc, { original, understood });

// the same intention ("remove the generic names from all medicines in Advice"), said in six ways (dummy sentences)
const SAME_INTENT = {
  malayalam: 'നമ്മുടെ അഡ്വൈസിലെ മെഡിസിൻസ് ഉണ്ടല്ലോ അതിൽ ജനറിക് നെയിം ഒന്ന് എല്ലാ മെഡിസിൻസിനും ജനറിക് നെയിം റിമൂവ് ചെയ്യണം',
  kannada: 'ಅಡ್ವೈಸ್‌ನಲ್ಲಿ ಎಲ್ಲಾ ಔಷಧಿಗಳ ಜೆನೆರಿಕ್ ಹೆಸರು ತೆಗೆದುಹಾಕಿ',
  hindi: 'एडवाइस में सभी दवाइयों से जेनेरिक नाम हटा दो',
  urdu: 'ایڈوائس میں سب دواؤں سے جنرک نام ہٹا دو',
  hinglish: 'advice me sab medicine ka generic naam hata do',
  malayalamEnglish: 'എല്ലാ medicines-നും generic name remove ചെയ്യണം',
};
const LANGUAGE = { malayalam: 'Malayalam', kannada: 'Kannada', hindi: 'Hindi', urdu: 'Urdu', hinglish: 'Hindi + English', malayalamEnglish: 'Malayalam + English' };
const UNDERSTOOD = 'remove the generic names from all medicines in Advice';

// ---------- which commands need the window ----------
test('non-English commands need a window; English (also broken English) keeps the existing path', () => {
  for (const [k, said] of Object.entries(SAME_INTENT)) assert.equal(needsPreview(said, LANGUAGE[k]), true, k);
  // Hindi in English letters: no other script, but the AI reports Hindi -> window
  assert.equal(needsPreview('oral hatao sab tablet se', 'Hindi'), true);
  for (const [said, lang] of [
    ['remove generic names from all medicines', 'English'],
    ['age 45 make', 'Broken English'],
    ['sir creatinine two point four now', 'English (informal)'],
    ['change follow up to 2 weeks', ''], // no language reported: the stricter English checks on the person's own words
  ]) assert.equal(needsPreview(said, lang), false, said);
});

test('reported language: kinds of English stay English; any other language counts', () => {
  for (const l of ['English', 'english', 'Broken English', 'English (informal)', 'Simple English', 'Indian English', '', undefined]) {
    assert.equal(reportedNonEnglish(l), false, String(l));
  }
  for (const l of ['Hindi', 'Malayalam + English', 'Kannada, English', 'Urdu', 'English and Hindi', 'Tamil']) {
    assert.equal(reportedNonEnglish(l), true, l);
  }
});

// ---------- the SAME intention in every language -> the SAME plan from the existing engine ----------
test('one intention, six ways of saying it -> exactly the same medicine plan (the existing engine, from "understood")', () => {
  const english = classifyCommand(doc, UNDERSTOOD);
  assert.equal(english.type, 'remove');
  for (const said of Object.values(SAME_INTENT)) {
    const r = interpret(said, UNDERSTOOD);
    assert.equal(r.type, 'remove', said);
    assert.equal(r.kind, english.kind);
    assert.deepEqual(r.plan, english.plan, said);
  }
});

test('the existing safety rules still apply to the interpretation', () => {
  // doses of several medicines at once: asked, never done
  assert.equal(interpret(SAME_INTENT.hindi, 'remove the doses from all medicines in Advice').type, 'ask');
  // "timing" is unclear: asked
  assert.equal(interpret(SAME_INTENT.hindi, 'remove the timing from all medicines').type, 'ask');
  // a medicine that is not in the document
  assert.equal(interpret(SAME_INTENT.hindi, 'remove the generic name from Tab. PAN').type !== 'remove', true);
  // no interpretation at all
  assert.equal(interpret(SAME_INTENT.malayalam, '').type, 'ask');
  const q = interpret(SAME_INTENT.malayalam, 'remove the doses from all medicines in Advice').question;
  assert.ok(q && !/Understood as|Your words/.test(q)); // a plain English question, no extra labels
});

test('dosing patterns: ticked only when the person\'s OWN words ask for them (digits count in every language)', () => {
  const u = 'remove the frequency and the dosing patterns from all medicines in Advice';
  const ticked = (r) => r.plan.changes.flatMap((c) => c.removals).filter((x) => x.kind === 'pattern').map((x) => x.selected);
  const notAsked = interpret('എല്ലാ മരുന്നുകളിൽ നിന്നും frequency കളയുക', u);
  assert.equal(notAsked.type, 'remove');
  assert.ok(ticked(notAsked).length > 0 && ticked(notAsked).every((s) => s === false)); // shown, not ticked
  const asked = interpret('എല്ലാ മരുന്നുകളിൽ നിന്നും frequency, 1-0-1 കളയുക', u);
  assert.ok(ticked(asked).every((s) => s === true));
});

test('clearing a section: always the confirmation window (also sections an English command clears at once)', () => {
  const r = interpret('ഡയഗ്നോസിസ് മുഴുവൻ കളയുക', 'clear the Diagnosis section');
  assert.equal(r.type, 'clear');
  assert.equal(r.section.title, 'DIAGNOSIS');
  assert.equal(classifyCommand(doc, 'clear the Diagnosis section').confirm, false); // English: at once, as before
});

test('other edits (any section): the AI\'s edits go to the preview window', () => {
  for (const u of ['change the diagnosis to TYPHOID FEVER', 'add FEVER to Diagnosis', 'make Course in Hospital lowercase',
    'change the follow-up to 2 weeks', 'change the age in the patient details to 45']) {
    assert.equal(interpret(SAME_INTENT.hindi, u).type, 'edits', u);
  }
});

test('English commands: the existing checks are unchanged', () => {
  // still word-checked against the person's own words
  assert.equal(checkInterpretation(doc, { original: 'remove generic names from all medicines', understood: UNDERSTOOD }).type, 'remove');
  assert.equal(checkInterpretation(doc, { original: 'oral hatao sab tablet se', understood: 'remove Oral from all tablets in Advice' }).type, 'ask');
  assert.match(malayalamStop(SAME_INTENT.malayalam), /cannot confirm the action/); // unchanged (now only reached by English)
});

// ---------- the windows ----------
const preview = {
  items: [
    { index: 0, field: 'Diagnosis', before: 'ENTERIC FEVER', after: 'TYPHOID FEVER', also: [], patient: false },
    { index: 1, field: 'Age', before: '40', after: '45', also: [], patient: true },
  ],
  blocked: [], unchanged: 0, consistency: [],
};
const html = (props) => renderToStaticMarkup(React.createElement(UploadPreview, { preview, recompute: () => ({ consistency: [] }), onApply() {}, onCancel() {}, ...props }));

test('command window: only the changes (in English), every change ticked; no language / interpretation lines', () => {
  const h = html({ summary: 'Changed the diagnosis.', command: { notIncluded: ['SERUM CREATININE: the new number was not said'] } });
  assert.match(h, /Check this command before it is applied/);
  assert.doesNotMatch(h, /Your words|Understood as|Language:/);
  assert.match(h, /Not included: SERUM CREATININE: the new number was not said/);
  assert.equal((h.match(/<input type="checkbox"[^>]*checked=""/g) || []).length, 2); // both ticked (also the patient detail)
  assert.match(h, />Apply</);
  assert.match(h, />Cancel</);
});

test('upload window: exactly as before when no command is given (patient details unticked)', () => {
  const h = html({ fileName: 'note.txt' });
  assert.match(h, /Changes from &quot;note.txt&quot;/);
  assert.doesNotMatch(h, /Your words/);
  assert.equal((h.match(/<input type="checkbox"[^>]*checked=""/g) || []).length, 1); // the patient detail is not ticked
  assert.match(h, /Patient details \(marked/);
});

test('clear window: exactly the existing window (no extra lines)', () => {
  const p = { title: 'DIAGNOSIS', lines: [{ text: 'ENTERIC FEVER', medicine: false }], medicines: 0 };
  const h = renderToStaticMarkup(React.createElement(ConfirmClear, { preview: p, onApply() {}, onCancel() {} }));
  assert.doesNotMatch(h, /Your words|Understood as|Language:/);
});

// ---------- Malayalam / Hindi ... written in ENGLISH letters (the AI may report it as English) ----------
const TRANSLIT = 'pinne aa advice ella medicines um ozhivakki kalayan';

test('English letters, no English removal word: not rejected, handled like a non-English command', () => {
  assert.equal(englishChecksCannotRead(TRANSLIT, 'remove all medicines from Advice'), true);
  assert.equal(englishChecksCannotRead('sab dawaiyan advice se hata do', 'remove all medicines from Advice'), true);
  // the English checks would have asked for an English word (unchanged function)
  assert.equal(checkInterpretation(doc, { original: TRANSLIT, understood: 'remove all medicines from Advice' }).type, 'ask');
  // English with a removal word: the existing English checks, unchanged
  assert.equal(englishChecksCannotRead('remove all medicines from Advice', 'remove all medicines from Advice'), false);
  assert.equal(englishChecksCannotRead('ella medicines um remove cheyyu', 'remove all medicines from Advice'), false);
  // nothing understood: no window
  assert.equal(englishChecksCannotRead(TRANSLIT, ''), false);
  // the AI reports the language correctly -> the window path directly
  assert.equal(needsPreview(TRANSLIT, 'Malayalam (English letters)'), true);
  assert.equal(needsPreview('ee patientinte age 45 aakki maattuka', 'Malayalam (English letters)'), true);
  assert.equal(needsPreview('age 45 only', 'English'), false); // English: applied directly, as before
});

test('"remove all medicines from Advice": the existing medicine window, ONLY the Advice medicines', () => {
  const r = interpret(TRANSLIT, 'remove all medicines from Advice');
  assert.equal(r.type, 'remove');
  assert.equal(r.kind, 'entries');
  assert.equal(r.plan.section.title.toUpperCase(), 'ADVICE');
  const removed = r.plan.changes.flatMap((c) => c.removals).filter((x) => x.selected).map((x) => x.text);
  assert.deepEqual(removed, ADVICE); // all 3 Advice medicines, whole entries
  // the medicine named in Course in Hospital is not part of the plan; the follow-up line is not a medicine
  assert.ok(!JSON.stringify(r.plan).includes('Treated with'));
  assert.ok(!removed.some((x) => /Review in OPD/.test(x)));
});

test('add / update / replace / remove / clear / unclear in any language -> the right existing workflow', () => {
  for (const [said, u, type] of [
    ['ee patientinte age 45 aakki maattuka', 'change the age in the patient details to 45', 'edits'],
    ['diagnosis il hypertension add cheyyu', 'add HYPERTENSION to Diagnosis', 'edits'],
    ['follow up randu weeks aakki', 'change the follow-up to after 2 weeks', 'edits'],
    ['ಸೀರಮ್ ಕ್ರಿಯೇಟಿನಿನ್ 2.9 ಮಾಡಿ', 'change serum creatinine to 2.9', 'edits'],
    ['course in hospital mein likho patient stable hai', 'add "Patient is stable" to Course in Hospital', 'edits'],
    ['ایڈوائس سے ساری دوائیاں نکال دو', 'remove all medicines from Advice', 'remove'],
    ['ഡയഗ്നോസിസ് മുഴുവൻ കളയുക', 'clear the Diagnosis section', 'clear'],
    ['ee medicine remove cheyyu', 'remove this medicine', 'edits'], // no medicine at the cursor: the AI's edits, then the window
    ['dose kalayu', 'remove the doses from all medicines in Advice', 'ask'],
  ]) assert.equal(interpret(said, u).type, type, said);
});


// ---------- the AI's interpretation may start with "Understood:" (Gemini Live does this) ----------
test('"Understood: ..." prefix: every medicine operation still reaches the existing medicine window', () => {
  const window = (u) => {
    const r = interpret('any words', u);
    return r.type === 'remove' ? { kind: r.kind, picked: r.plan.changes.flatMap((c) => c.removals).filter((x) => x.selected).map((x) => x.text.trim()) } : r.type;
  };
  // removing ALL medicines when explicitly requested (this one did nothing before the fix)
  assert.deepEqual(window('Understood: remove all medicines from Advice.'), { kind: 'entries', picked: ADVICE });
  // one named medicine
  assert.deepEqual(window('Understood: remove Tab. DOLO from Advice.').picked, [ADVICE[2]]);
  assert.deepEqual(window('Understood: remove DOLO from the medicines in Advice.').picked, [ADVICE[2]]);
  // other supported operations: the same plan as without the prefix
  for (const u of ['remove the generic names from all medicines in Advice', 'remove the Oral route from all tablets in Advice', 'remove all syrups from Advice']) {
    assert.deepEqual(interpret('any words', `Understood: ${u}.`), interpret('any words', u), u);
    assert.equal(interpret('any words', u).type, 'remove', u);
  }
  // unsafe operations are still asked
  assert.equal(interpret('any words', 'Understood: remove the doses from all medicines in Advice.').type, 'ask');
});

test('"removing Tab. DOLO from the advice section" (an -ing form): never a removal, nothing changes', () => {
  for (const u of ['removing Tab. DOLO from the advice section', 'Understood: removing Tab. DOLO from the advice section.', 'removing all medicines from the advice section']) {
    const r = interpret('any words', u);
    assert.notEqual(r.type, 'remove', u);
    assert.notEqual(r.type, 'clear', u);
    // with no AI edits the app then asks the person to say it again (App.jsx previewCommand); the browser test checks that
  }
});

test('Option A: the "Understood: ..." sentence in summary is used for the checks, never shown', async () => {
  const { summaryToShow, understoodFrom } = await import('../src/lib/interpretation.js');
  const s = 'Understood: change the follow-up to after 4 weeks. Changed the follow-up to 4 weeks.';
  assert.equal(understoodFrom(s), 'change the follow-up to after 4 weeks'); // what the checks read
  assert.equal(summaryToShow(s), 'Changed the follow-up to 4 weeks.'); // what is shown
  assert.equal(summaryToShow('Understood: remove Tab. DOLO from Advice.'), ''); // "Tab. DOLO" does not end the sentence
  assert.equal(summaryToShow('Changed the age to 45.'), 'Changed the age to 45.'); // no interpretation: unchanged
  assert.equal(summaryToShow('Which medicine should be removed? Nothing was changed.'), 'Which medicine should be removed? Nothing was changed.');
});
