// R3 (D1, D4): finishCommand passes Gemini's command answer on as written - no medicine scope rule, no "all" word
// check, no language rule, no summary rewriting. Only the R1 technical check can stop an answer. Dummy data only.
// Run:  cd server  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as guard from '../scopeGuard.js';

const { finishCommand } = guard;
const OUTLINE = '[B2] (P) "ADVICE"\n[B3] (P) "Tab. CIPLOX 200 mg — Twice Daily\\nTab. DOLO 650 mg — SOS"';
const clear = { block_id: 'B3', operation: 'clear', field_label: 'Advice' };

test('R3: a whole-medicine removal is passed on as Gemini wrote it (no scope question any more)', () => {
  const r = finishCommand({ edits: [clear], summary: 'Removed all medicines from Advice.', heard: '', understood: 'remove the medicines from Advice', all_words: '' },
    { outline: OUTLINE, said: ['remove the medicines'] });
  assert.deepEqual(r.edits, [clear]);
  assert.equal(r.summary, 'Removed all medicines from Advice.');
});

test('R3: a non-English command keeps Gemini\'s own summary (nothing is put in front of it)', () => {
  const r = finishCommand({ edits: [{ block_id: 'B3', operation: 'replace_text', find_text: '650 mg', new_value: '500 mg', field_label: 'Advice' }],
    summary: 'Changed DOLO to 500 mg.', heard: 'dolo 500 aakku', understood: 'change DOLO to 500 mg', language: 'Malayalam (English letters)' },
  { outline: OUTLINE, said: ['dolo 500 aakku'] });
  assert.equal(r.summary, 'Changed DOLO to 500 mg.');
  assert.equal(r.heard, 'dolo 500 aakku');
  assert.deepEqual(Object.keys(r).sort(), ['edits', 'heard', 'summary']);
});

test('R3: the old scope / language helpers are gone; the R1 check stays', () => {
  for (const k of ['removesUnnamedMedicines', 'saysAll', 'medicineNames', 'plainInterpretation', 'reportedNonEnglish', 'understoodFrom']) assert.equal(guard[k], undefined, k);
  const bad = finishCommand({ edits: [clear, { block_id: 'B3', operation: 'set', field_label: 'Advice' }], summary: 'x', heard: 'h' }, { outline: OUTLINE });
  assert.deepEqual(bad.edits, []);
  assert.equal(bad.summary, guard.INCOMPLETE_ANSWER);
  assert.equal(bad.heard, 'h');
});

test('R3: a question from Gemini (no edits) is passed on unchanged', () => {
  const r = finishCommand({ edits: [], summary: 'Which date should change: Date of Admission or Date of Discharge? Nothing was changed.', heard: '' }, {});
  assert.deepEqual(r.edits, []);
  assert.match(r.summary, /Which date should change/);
});
