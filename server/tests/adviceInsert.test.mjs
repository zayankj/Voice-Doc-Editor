// Advice placement (23 Nov): the generic insert_before operation and the optional separate_paragraph flag of
// insert_after - checked on every path a command answer takes (the answer format, Gemini Live's checkLiveResult and
// the complete-edit check of scopeGuard.js). Uploads keep their five operations. Dummy data only.
// Run:  cd server  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Type } from '@google/genai';
import { COMMAND_OPERATIONS, commandSchema, buildCommandPrompt } from '../commandPrompt.js';
import { checkLiveResult, liveFunctionDeclaration, liveSuffix } from '../liveVoice.js';
import { incompleteEdit, finishCommand } from '../scopeGuard.js';
import { LIVE_REASONS } from '../timingLog.js';

const call = (...edits) => ({ edits, summary: 'ok', heard: 'dummy', understood: 'dummy' });
const ok = (e) => checkLiveResult(call(e), 'dummy words').edits[0];
const refused = (e) => { try { checkLiveResult(call(e), 'dummy words'); return ''; } catch (err) { return err.message; } };

test('insert_before is a command operation (answer format and Live), not an upload operation', () => {
  assert.ok(COMMAND_OPERATIONS.includes('insert_before'));
  const upload = { type: Type.OBJECT, properties: { edits: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { operation: { type: Type.STRING, enum: ['set', 'replace_text', 'append', 'clear', 'insert_after'] } } } } }, required: [] };
  const item = commandSchema(upload).properties.edits.items;
  assert.ok(item.properties.operation.enum.includes('insert_before'));
  assert.equal(item.properties.separate_paragraph.type, Type.BOOLEAN);
  assert.deepEqual(upload.properties.edits.items.properties.operation.enum, ['set', 'replace_text', 'append', 'clear', 'insert_after'], 'the upload format is not changed');
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(index, /operation: \{ type: Type\.STRING, enum: \['set', 'replace_text', 'append', 'clear', 'insert_after'\] \}/);
  const live = liveFunctionDeclaration().parameters.properties.edits.items.properties;
  assert.ok(live.operation.enum.includes('insert_before'));
  assert.equal(live.separate_paragraph.type, Type.BOOLEAN);
  assert.match(live.separate_paragraph.description, /ONLY with insert_after/);
  assert.match(liveSuffix(), /insert_before: the text is in new_value too\. separate_paragraph only with insert_after\./);
});

test('Live: a valid insert_before and a separate_paragraph insert_after are accepted and passed on', () => {
  assert.deepEqual(ok({ block_id: 'B12', operation: 'insert_before', new_value: 'Tab. DUMMY 1 mg', field_label: 'Advice' }),
    { block_id: 'B12', operation: 'insert_before', new_value: 'Tab. DUMMY 1 mg', field_label: 'Advice' });
  assert.deepEqual(ok({ block_id: 'B12', operation: 'insert_before', new_value: 'Tab. DUMMY 1 mg', find_text: 'Tab. A', field_label: 'Advice' }).find_text, 'Tab. A');
  const e = ok({ block_id: 'B14', operation: 'insert_after', new_value: 'Review after 2 weeks.', separate_paragraph: true, field_label: 'Advice' });
  assert.equal(e.separate_paragraph, true);
  assert.equal(ok({ block_id: 'B14', operation: 'insert_after', new_value: 'x', separate_paragraph: false, field_label: 'A' }).separate_paragraph, false);
  assert.equal('separate_paragraph' in ok({ block_id: 'B14', operation: 'insert_after', new_value: 'x', field_label: 'A' }), false, 'absent stays absent');
});

test('Live: malformed insert_before / separate_paragraph are refused (all-or-nothing, a fixed reason)', () => {
  assert.equal(refused({ block_id: 'B12', operation: 'insert_before', field_label: 'A' }), 'invalid edit (new_value missing)');
  assert.equal(refused({ block_id: 'B12', operation: 'insert_before', new_value: 5, field_label: 'A' }), 'invalid edit (new_value or find_text not text)');
  for (const bad of ['yes', 'true', 1, null, {}]) {
    assert.equal(refused({ block_id: 'B12', operation: 'insert_after', new_value: 'x', separate_paragraph: bad, field_label: 'A' }), 'invalid edit (separate_paragraph not true/false)', String(bad));
  }
  assert.equal(refused({ block_id: 'B12', operation: 'insert_above', new_value: 'x', field_label: 'A' }), 'invalid edit (unknown operation)');
  assert.ok(LIVE_REASONS.includes('invalid edit (separate_paragraph not true/false)'), 'the reason can be logged (a fixed label)');
  // one bad edit refuses the whole answer
  assert.throws(() => checkLiveResult(call(
    { block_id: 'B1', operation: 'insert_before', new_value: 'ok', field_label: 'A' },
    { block_id: 'B2', operation: 'insert_after', new_value: 'x', separate_paragraph: 'yes', field_label: 'A' },
  ), 'dummy words'));
});

test('typed / backup / streamed answers: an insert_before without text makes the whole answer unusable (as insert_after)', () => {
  assert.equal(incompleteEdit({ operation: 'insert_before' }), true);
  assert.equal(incompleteEdit({ operation: 'insert_before', new_value: '   ' }), true);
  assert.equal(incompleteEdit({ operation: 'insert_before', new_value: 'Tab. DUMMY' }), false);
  const r = finishCommand({ edits: [{ block_id: 'B1', operation: 'insert_before', new_value: '' }, { block_id: 'B2', operation: 'set', new_value: 'x' }], summary: 's', heard: '' });
  assert.deepEqual(r.edits, [], 'nothing of it is used');
  const fine = finishCommand({ edits: [{ block_id: 'B1', operation: 'insert_before', new_value: 'Tab. DUMMY' }], summary: 's', heard: '' });
  assert.equal(fine.edits.length, 1);
});

test('the prompt: medicines at the top go before the first medicine line; follow-up / advice is its own paragraph', () => {
  const p = buildCommandPrompt({ outline: '[B1] (P) "ADVICE"', today: '23-11-2026', instruction: 'dummy' });
  assert.match(p, /insert_before = a new line before block_id \(when that\s+block has line breaks, find_text = the line it goes before\)/);
  assert.match(p, /separate_paragraph: only with insert_after; true = the new text is its own paragraph after the whole list or\s+block that block_id is in \(never a new entry or line of it\)\./);
  assert.match(p, /"add Dolo 650 at the top of the medicines" -> insert_before the first medicine line/);
  assert.match(p, /"add review after 2 weeks" when the medicines are the last lines of Advice -> insert_after the last medicine line,\s+separate_paragraph = true/);
  assert.match(p, /A position the person names is kept \("at the top" = insert_after the section\s+heading\), always as its own paragraph/);
  // the rest of the medicine rules are unchanged
  assert.match(p, /Put it after the last medicine of the section where the medicines are listed/);
});
