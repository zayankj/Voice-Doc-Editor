// Medicine-only confirmation (23 Nov): Gemini marks each clear / set / replace_text with removes_medicine, on every
// path - typed and backup voice (the command answer format), Gemini Live and streaming (checkLiveResult) and uploads
// (the upload answer format and prompt). The browser decides the window from it (client/src/lib/deletions.js);
// anything that is not true / false is left out here, so the browser treats it as unknown (and confirms a removal).
// Dummy data only. Run:  cd server  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Type } from '@google/genai';
import { commandSchema, buildCommandPrompt } from '../commandPrompt.js';
import { checkLiveResult, liveFunctionDeclaration } from '../liveVoice.js';
import { finishCommand } from '../scopeGuard.js';
import { loadBuildExtractPrompt, CASES } from './promptSource.mjs';

const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const RULE = /removes_medicine: on every clear, set and replace_text: true when the edit removes an existing medicine from the\s+document or replaces it with a different medicine; false when it removes or changes only other text, or changes\s+only details of a medicine that stays \(dose, strength, timing, duration \.\.\.\)\./;
const call = (...edits) => ({ edits, summary: 'ok', heard: 'dummy', understood: 'dummy' });
const live = (e) => checkLiveResult(call(e), 'dummy words').edits[0];

test('the answer formats carry removes_medicine (true / false) - commands, Live and uploads; upload operations unchanged', () => {
  const upload = { type: Type.OBJECT, properties: { edits: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { operation: { type: Type.STRING, enum: [] } }, required: [] } } }, required: [] };
  assert.equal(commandSchema(upload).properties.edits.items.properties.removes_medicine.type, Type.BOOLEAN);
  assert.equal(liveFunctionDeclaration().parameters.properties.edits.items.properties.removes_medicine.type, Type.BOOLEAN);
  assert.match(index, /removes_medicine: \{ type: Type\.BOOLEAN \}, \/\/ medicine-removal confirmation in the browser/);
  assert.match(index, /operation: \{ type: Type\.STRING, enum: \['set', 'replace_text', 'append', 'clear', 'insert_after'\] \}/, 'upload operations unchanged');
  // not required anywhere (an answer without it is still used; the browser confirms a removal then)
  assert.doesNotMatch(index, /required: \[[^\]]*removes_medicine/);
});

test('the prompts tell Gemini when removes_medicine is true or false (command and upload prompts; no word about a window)', () => {
  const p = buildCommandPrompt({ outline: '[B1] (P) "ADVICE"', today: '23-11-2026', instruction: 'dummy' });
  assert.match(p, RULE);
  assert.doesNotMatch(p, /confirm/i);
  const build = loadBuildExtractPrompt();
  for (const [k, args] of Object.entries(CASES)) {
    assert.match(build(...args), RULE, k);
    assert.doesNotMatch(build(...args), /confirm/i, k);
  }
});

test('Live / streaming: true and false are passed on; anything else is left out (never refuses the command)', () => {
  assert.equal(live({ block_id: 'B4', operation: 'clear', removes_medicine: true, field_label: 'Advice' }).removes_medicine, true);
  assert.equal(live({ block_id: 'B4', operation: 'clear', removes_medicine: false, field_label: 'Advice' }).removes_medicine, false);
  for (const bad of ['true', 1, null, {}]) {
    const out = live({ block_id: 'B4', operation: 'clear', removes_medicine: bad, field_label: 'Advice' });
    assert.equal('removes_medicine' in out, false, JSON.stringify(bad));
  }
  assert.equal('removes_medicine' in live({ block_id: 'B4', operation: 'clear', field_label: 'Advice' }), false);
});

test('typed / backup answers pass removes_medicine on unchanged (finishCommand)', () => {
  const r = finishCommand({ edits: [{ block_id: 'B4', operation: 'clear', removes_medicine: true }, { block_id: 'B2', operation: 'clear', removes_medicine: false }], summary: 's', heard: '' });
  assert.deepEqual(r.edits.map((e) => e.removes_medicine), [true, false]);
});
