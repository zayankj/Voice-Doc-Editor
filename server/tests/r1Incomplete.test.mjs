// STAGE R1 (no Gemini call, dummy data): an answer with an INCOMPLETE edit (its text is missing) is never passed on:
// on every command path (typed, backup voice, streaming backup: finishCommand) the whole answer becomes "nothing was
// changed"; the Live path already refuses it (checkLiveResult -> backup model). Never about words or medicines.
// Run:  cd server  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { finishCommand, incompleteEdit, INCOMPLETE_ANSWER } from '../scopeGuard.js';
import { checkLiveResult } from '../liveVoice.js';

const outline = '[B0] (P) "DIAGNOSIS"\n[B1] (P) "TYPHOID"\n[B10] (P) "01-11-2026"\n[B12] (P) "06-11-2026"';
const ok = { block_id: 'B1', operation: 'append', new_value: ', FEVER', field_label: 'Diagnosis' };

test('R1 server: incompleteEdit - missing texts are incomplete, an explicit "" keeps its meaning (same rule as the browser)', () => {
  for (const e of [{ operation: 'set' }, { operation: 'set', new_value: null }, { operation: 'append' }, { operation: 'append', new_value: '  ' },
    { operation: 'insert_after', new_value: '' }, { operation: 'replace_text', new_value: 'x' }, { operation: 'replace_text', find_text: '', new_value: 'x' },
    { operation: 'replace_text', find_text: 'a' }]) assert.equal(incompleteEdit(e), true, JSON.stringify(e));
  for (const e of [ok, { operation: 'set', new_value: '' }, { operation: 'replace_text', find_text: 'a', new_value: '' }, { operation: 'clear' },
    { operation: 'format', style: 'bold' }]) assert.equal(incompleteEdit(e), false, JSON.stringify(e));
  // the browser's copy of the rule says the same
  const client = fs.readFileSync(new URL('../../client/src/lib/voiceEdit.js', import.meta.url), 'utf8');
  assert.match(client, /export function incompleteEdit\(e\)/);
});

test('R1 server: the real 18 Nov answer (two `set` without new_value) -> nothing is passed on, the person is told', () => {
  const r = finishCommand({ edits: [{ block_id: 'B10', operation: 'set', field_label: 'Date of Admission' }, { block_id: 'B12', operation: 'set', field_label: 'Date of Discharge' }],
    summary: 'Changed the date of admission and date of discharge to 10-11-2026.', heard: '', understood: 'change the dates' }, { outline, said: ['change the date to 10-11-2026'] });
  assert.deepEqual(r.edits, []);
  assert.equal(r.summary, INCOMPLETE_ANSWER);
});

test('R1 server: a batch with one incomplete edit -> the WHOLE answer is not used (never a part of it)', () => {
  const r = finishCommand({ edits: [ok, { block_id: 'B1', operation: 'replace_text', find_text: 'TYPHOID', field_label: 'Diagnosis' }], summary: 'x', heard: 'h' },
    { outline, said: ['x'] });
  assert.deepEqual(r.edits, []);
  assert.equal(r.summary, INCOMPLETE_ANSWER);
  assert.equal(r.heard, 'h', 'the transcript is still shown');
});

test('R1 server: complete answers pass exactly as before; Live still refuses an incomplete call (backup model)', () => {
  const r = finishCommand({ edits: [ok], summary: 'Added fever.', heard: '', understood: 'add FEVER to Diagnosis' }, { outline, said: ['add fever to diagnosis'] });
  assert.deepEqual(r.edits, [ok]);
  assert.equal(r.summary, 'Added fever.');
  assert.throws(() => checkLiveResult({ heard: 'x', understood: 'x', summary: 'x', edits: [{ block_id: 'B10', operation: 'set', field_label: 'Date' }] }, 'x'), /new_value missing/);
});
