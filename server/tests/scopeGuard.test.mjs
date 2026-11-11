// The command scope check and Option A (English interpretation in summary). Dummy data only.
// Run:  cd server  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { finishCommand, removesUnnamedMedicines, saysAll, medicineNames, plainInterpretation, reportedNonEnglish } from '../scopeGuard.js';

// the medicine lines are ONE block; line breaks appear as the two characters \n (as buildOutline writes them)
const OUTLINE = `[B0] (P) "DIAGNOSIS"
[B1] (P) "ENTERIC FEVER"
[B2] (P) "ADVICE"
[B3] (P) "Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — Twice Daily (1-0-1) — 2 days\\nSyp. INSTARAFT (Antacid) 10 ml — Oral — Three Times Daily (1-1-1) — 5 days\\nTab. DOLO (Paracetamol) 650 mg — Oral — As Needed (SOS)"`;
const QUESTION = /^Which medicine should be removed\?.*Nothing was changed\.$/;
const removeAll = (all_words = '', language = 'Hindi') => ({ edits: [], summary: 'Understood: remove all medicines from Advice.', heard: '', understood: 'remove all medicines from Advice', language, all_words });

test('medicine names come from the document, also after a line break inside the block', () => {
  assert.deepEqual(medicineNames(OUTLINE).sort(), ['ciplox', 'dolo', 'instaraft']);
});

test('which interpretations remove WHOLE medicines without naming one', () => {
  for (const u of ['remove all medicines from Advice', 'Understood: remove all medicines from Advice.', 'remove every medicine in Advice',
    'clear all the medicines', 'remove the tablets from Advice', 'remove all syrups', 'remove everything from Advice', 'remove the medicine']) {
    assert.equal(removesUnnamedMedicines(u, OUTLINE), true, u);
  }
  for (const u of ['remove Tab. DOLO from Advice', 'remove DOLO from the medicines in Advice', 'remove INSTARAFT',
    'remove the generic names from all medicines in Advice', 'remove the frequency from all tablets', 'remove the Oral route from all medicines',
    'remove this medicine', 'change the age to 45', 'clear the Diagnosis section', 'add HYPERTENSION to Diagnosis', '']) {
    assert.equal(removesUnnamedMedicines(u, OUTLINE), false, u);
  }
});

test('"all" must really be in the person\'s words (the model\'s claim is checked, never trusted)', () => {
  assert.equal(saysAll('', ['remove all medicines']), true); // English "all"
  assert.equal(saysAll('ella', ['advice ella medicines um ozhivakki kalayan']), true);
  assert.equal(saysAll('എല്ലാ', ['അഡ്വൈസിലെ എല്ലാ മെഡിസിൻസും ഒഴിവാക്കി കളയണം']), true);
  assert.equal(saysAll('ಎಲ್ಲಾ', ['ಎಲ್ಲಾ ಔಷಧಿಗಳನ್ನು ತೆಗೆದುಹಾಕಿ']), true);
  assert.equal(saysAll('sab', ['dawai hata do']), false); // claimed, but not said
  assert.equal(saysAll('', ['dawai hata do']), false);
  assert.equal(saysAll('dawai hata do', ['dawai hata do']), false); // the whole sentence is not an "all" word
  assert.equal(saysAll('x', ['x y']), false); // too short to be evidence
});

test('ambiguous commands in every language -> a question, no edits (typed, Live and backup voice use this)', () => {
  for (const [said, lang] of [['dawai hata do', 'Hindi'], ['marunnu kalayu', 'Malayalam'], ['दवाई हटा दो', 'Hindi'],
    ['ಔಷಧಿ ತೆಗೆದುಹಾಕಿ', 'Kannada'], ['دوائی ہٹا دو', 'Urdu'], ['tablet hata do', 'Hindi']]) {
    const r = finishCommand(removeAll('', lang), { outline: OUTLINE, said: [said] });
    assert.deepEqual(r.edits, [], said);
    assert.match(r.summary, QUESTION, said);
  }
  // AI edits that remove whole medicines are also stopped (not only the medicine-window path)
  const viaEdits = { ...removeAll(), edits: [{ block_id: 'B3', operation: 'clear', field_label: 'Advice' }] };
  assert.deepEqual(finishCommand(viaEdits, { outline: OUTLINE, said: ['dawai hata do'] }).edits, []);
  // the interpretation only in the summary (no understood field) is checked too
  assert.match(finishCommand({ ...removeAll(), understood: '' }, { outline: OUTLINE, said: ['dawai hata do'] }).summary, QUESTION);
  // the model's own transcript (heard) counts as the person's words for voice
  assert.match(finishCommand({ ...removeAll('ella'), heard: 'ella marunnum kalayu' }, { outline: OUTLINE, said: [] }).summary, /^Understood: remove all/);
});

test('explicit all / every keeps working; named medicines and parts are never asked', () => {
  assert.match(finishCommand(removeAll('ella', 'Malayalam'), { outline: OUTLINE, said: ['pinne aa advice ella medicines um ozhivakki kalayan'] }).summary, /^Understood: remove all medicines from Advice\.$/);
  assert.match(finishCommand(removeAll('sab'), { outline: OUTLINE, said: ['advice se sab dawaiyan hata do'] }).summary, /^Understood: remove all medicines/);
  assert.match(finishCommand(removeAll('', 'English'), { outline: OUTLINE, said: ['remove all medicines from advice'] }).summary, /^Understood: remove all medicines/);
  const named = { edits: [], summary: 'Understood: remove Tab. DOLO from Advice.', heard: '', understood: 'remove Tab. DOLO from Advice', language: 'Malayalam', all_words: '' };
  assert.match(finishCommand(named, { outline: OUTLINE, said: ['Advice-il ninnu DOLO maathram remove cheyyu'] }).summary, /^Understood: remove Tab\. DOLO from Advice\.$/);
  const parts = { edits: [], summary: '', heard: '', understood: 'remove the generic names from all medicines in Advice', language: 'Hindi', all_words: '' };
  assert.match(finishCommand(parts, { outline: OUTLINE, said: ['generic naam hata do'] }).summary, /^Understood: remove the generic names/);
});

test('Option A: non-English -> "Understood: <interpretation>." at the start of summary; English -> unchanged', () => {
  const edit = [{ block_id: 'B1', operation: 'append', new_value: ', HYPERTENSION', field_label: 'Diagnosis' }];
  const kn = finishCommand({ edits: edit, summary: 'Added hypertension.', heard: '', understood: 'Understood: add HYPERTENSION to Diagnosis.', language: 'Kannada' }, { outline: OUTLINE, said: ['ಡಯಾಗ್ನೋಸಿಸ್‌ಗೆ ಹೈಪರ್‌ಟೆನ್ಷನ್ ಸೇರಿಸಿ'] });
  assert.equal(kn.summary, 'Understood: add HYPERTENSION to Diagnosis. Added hypertension.');
  assert.deepEqual(kn.edits, edit);
  assert.deepEqual(Object.keys(kn).sort(), ['edits', 'heard', 'summary']); // what the gateway passes on
  // non-Latin words count as non-English even when no language is reported
  assert.match(finishCommand({ edits: edit, summary: 'Done.', heard: '', understood: 'add HYPERTENSION to Diagnosis' }, { outline: OUTLINE, said: ['ಹೈಪರ್‌ಟೆನ್ಷನ್ ಸೇರಿಸಿ'] }).summary, /^Understood: add HYPERTENSION/);
  // an "Understood:" sentence already in the summary is replaced, never doubled
  const once = finishCommand({ edits: [], summary: 'Understood: removing all medicines. Done.', heard: '', understood: 'remove all medicines from Advice', language: 'Malayalam', all_words: 'ella' }, { outline: OUTLINE, said: ['ella marunnum kalayu'] });
  assert.equal(once.summary, 'Understood: remove all medicines from Advice. Done.');
  // English: exactly as before
  assert.equal(finishCommand({ edits: edit, summary: 'Added hypertension.', heard: '', understood: 'add HYPERTENSION to Diagnosis', language: 'English' }, { outline: OUTLINE, said: ['add hypertension to diagnosis'] }).summary, 'Added hypertension.');
  // a question from the model stays exactly as it is
  assert.equal(finishCommand({ edits: [], summary: 'Which date? Nothing was changed.', heard: '', understood: 'which date is unclear', language: 'Malayalam' }, { outline: OUTLINE, said: ['theeyathi maattanam'] }).summary, 'Which date? Nothing was changed.');
});

test('helpers', () => {
  assert.equal(plainInterpretation('Understood: remove all medicines from Advice.'), 'remove all medicines from Advice');
  assert.equal(reportedNonEnglish('Malayalam (English letters)'), true);
  assert.equal(reportedNonEnglish('Broken English'), false);
  assert.equal(reportedNonEnglish(''), false);
});
