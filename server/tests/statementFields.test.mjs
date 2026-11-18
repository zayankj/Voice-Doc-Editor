// R2 (replaces the Stage 3.2 statement tests): NO statement metadata. The per-edit statement fields of Stage 3.2 / 3.3
// (intent, section, medicine, changes, source_words) are no longer asked for, no longer in either answer format, no
// longer passed on and never required. Gemini returns the document edits only. Dummy data, no Gemini call.
// Run:  cd server  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@google/genai';
import * as prompt from '../commandPrompt.js';
import { checkLiveResult, liveFunctionDeclaration, liveSuffix } from '../liveVoice.js';
import { finishCommand } from '../scopeGuard.js';

const OLD = ['intent', 'section', 'medicine', 'changes', 'source_words'];
const UPLOAD_OPS = ['set', 'replace_text', 'append', 'clear', 'insert_after'];
const base = () => ({
  type: Type.OBJECT,
  properties: {
    heard: { type: Type.STRING }, summary: { type: Type.STRING },
    edits: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { block_id: {}, operation: { type: Type.STRING, enum: [...UPLOAD_OPS] }, new_value: {}, find_text: {}, field_label: {} }, required: ['block_id', 'operation', 'field_label'] } },
  },
  required: ['edits', 'summary'],
});
const EDIT = { block_id: 'B5', operation: 'replace_text', find_text: '40 mg', new_value: '20 mg', field_label: 'Advice' };

test('R2: neither answer format has statement fields; every field the prompt uses is still there', () => {
  const item = prompt.commandSchema(base()).properties.edits.items;
  const live = liveFunctionDeclaration().parameters.properties.edits.items;
  for (const k of OLD) {
    assert.equal(item.properties[k], undefined, `schema: ${k}`);
    assert.equal(live.properties[k], undefined, `Live: ${k}`);
  }
  for (const k of ['block_id', 'operation', 'new_value', 'find_text', 'field_label', 'style', 'case', 'list_type', 'lines', 'select', 'last_block_id', 'duplicate_ok']) {
    assert.ok(item.properties[k], `schema keeps ${k}`);
    assert.ok(live.properties[k], `Live keeps ${k}`);
  }
  assert.deepEqual(item.required, ['block_id', 'operation', 'field_label']);
});

test('R2: the statement code is gone and the prompt / Live text never asks for statements', () => {
  for (const k of ['cleanStatement', 'withCleanStatement', 'INTENTS', 'CHANGE_PARTS', 'STATEMENT_FIELDS', 'commandAddon']) assert.equal(prompt[k], undefined, k);
  const p = prompt.buildCommandPrompt({ outline: '[B0] (P) "DIAGNOSIS"', today: '18-11-2026', instruction: 'add fever' });
  for (const w of ['source_words', 'statement', 'intent:']) assert.ok(!p.includes(w), `prompt: ${w}`);
  assert.doesNotMatch(liveSuffix(), /statement|source_words/);
});

test('R2: Live - statement keys sent by the model are dropped; an edit without them is accepted (not required)', () => {
  const answer = (e) => ({ heard: 'change pan to 20 mg', understood: 'change PAN to 20 mg', summary: 'Changed.', edits: [e] });
  assert.deepEqual(checkLiveResult(answer(EDIT), 'change pan to 20 mg').edits, [EDIT]);
  const withOld = { ...EDIT, intent: 'change_medicine', section: 'ADVICE', medicine: 'PAN', changes: ['strength'], source_words: 'x' };
  assert.deepEqual(checkLiveResult(answer(withOld), 'change pan to 20 mg').edits, [EDIT], 'dropped, never passed on');
});

test('R2: finishCommand passes plain edits unchanged and adds nothing; the R1 check still works', () => {
  const r = finishCommand({ edits: [EDIT], summary: 'Changed.', heard: '', understood: 'change PAN to 20 mg' }, { outline: '', said: ['change pan to 20 mg'] });
  assert.deepEqual(r.edits, [EDIT]);
  for (const k of OLD) assert.equal(r.edits[0][k], undefined);
  const bad = finishCommand({ edits: [{ block_id: 'B5', operation: 'set', field_label: 'x' }], summary: 'x', heard: '' }, { outline: '', said: ['x'] });
  assert.deepEqual(bad.edits, []);
});
