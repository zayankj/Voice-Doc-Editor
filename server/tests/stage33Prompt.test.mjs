// R2 (rewritten from the Stage 3.3 tests): the compact Gemini-driven command prompt. One prompt for every command path;
// the upload prompt unchanged; every operation and field named in the prompt exists in the answer format.
// No Gemini call, dummy data.  Run:  cd server  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Type } from '@google/genai';
import { buildCommandPrompt, commandSchema, COMMAND_OPERATIONS, STYLES, CASES as CASE_VALUES, SELECT_KINDS } from '../commandPrompt.js';
import { liveSuffix, liveFunctionDeclaration } from '../liveVoice.js';
import { loadBuildExtractPrompt, CASES } from './promptSource.mjs';

const OUTLINE = '[B0] (P) "DIAGNOSIS"\n[B1] (P) "ENTERIC FEVER"\n[B2] (P) "ADVICE"\n[B3] (P) "Tab. PAN 40 mg — Once Daily — 5 days"';
const prompt = (o = {}) => buildCommandPrompt({ outline: OUTLINE, today: '18-11-2026', instruction: 'add typhoid to diagnosis', ...o });
const PARTS = ['UNDERSTANDING THE INSTRUCTION', 'WHAT TO CHANGE', 'MEDICINES', 'PATIENT DETAILS AND OTHER PEOPLE',
  'TABLES, FORMATTING AND LISTS', 'WHEN TO ASK', 'THE ANSWER', 'EXAMPLES'];

test('R2: the parts of the prompt are there, in order, each once', () => {
  const p = prompt();
  let at = -1;
  for (const s of PARTS) {
    const i = p.indexOf(`\n${s}`);
    assert.ok(i > at, s);
    assert.equal(p.split(`\n${s}\n`).length + p.split(`\n${s} (`).length - 1, 2, `${s} once`);
    at = i;
  }
});

test('R2: every operation and edit field named in the prompt exists in the answer format (nothing unsupported)', () => {
  const p = prompt();
  const item = commandSchema({ type: Type.OBJECT, properties: { edits: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { block_id: {}, operation: { type: Type.STRING, enum: [] }, new_value: {}, find_text: {}, field_label: {} }, required: [] } } }, required: [] }).properties.edits.items;
  const live = liveFunctionDeclaration().parameters.properties.edits.items;
  for (const op of COMMAND_OPERATIONS) assert.ok(p.includes(op), `prompt names ${op}`);
  for (const f of ['block_id', 'new_value', 'find_text', 'field_label', 'style', 'case', 'list_type', 'select', 'lines', 'last_block_id', 'duplicate_ok', 'separate_paragraph']) {
    assert.ok(item.properties[f], `schema has ${f}`);
    assert.ok(live.properties[f], `Live has ${f}`);
  }
  for (const v of [...STYLES, ...CASE_VALUES, ...SELECT_KINDS]) assert.ok(p.includes(v), `prompt lists ${v}`);
  // no operation that does not exist
  // (insert_before exists since the Advice placement change of 23 Nov - it is in COMMAND_OPERATIONS, checked above)
  for (const bad of ['delete_block', 'move_block', 'rename_heading']) assert.ok(!p.includes(bad), bad);
});

test('R2: never add information; corrections and rewrites keep the facts', () => {
  const p = prompt();
  assert.match(p, /Never add information that the person did not give/);
  assert.match(p, /Corrections \("correct the spelling", "erase the typo", "fix the grammar"\) change only the wrong words/);
  assert.match(p, /Never translate or change medicine names, numbers or units\./);
});

test('R2: the age / gender rule is automatic only for age and gender (D5)', () => {
  const p = prompt();
  const auto = p.slice(p.indexOf('When the person changes the patient'), p.indexOf('- Other patient details'));
  assert.match(auto, /AGE or GENDER/);
  assert.doesNotMatch(auto, /name|dates|IP number/i);
  assert.match(p, /Other patient details \(name, IP number, dates \.\.\.\) change only in the place the person asks\./);
});

test('R2: typed, voice, template, cursor and recent are filled in as before', () => {
  const typed = prompt();
  assert.match(typed, /USER INSTRUCTION \(typed by the person using the app; this is a command you must follow\):\nadd typhoid to diagnosis\n/);
  const voice = prompt({ instruction: '', hasAudio: true });
  assert.match(voice, /SPOKEN COMMAND: an audio clip is attached\./);
  assert.doesNotMatch(voice, /USER INSTRUCTION/);
  const t = prompt({ template: { name: 'Cardiology Discharge', department: 'Cardiology', aiHints: ['Keep the ECG table as it is.'] } });
  assert.match(t, /THE DOCUMENT \(a hospital document of type "Cardiology Discharge" \(Cardiology department\)\)/);
  assert.match(t, /Notes for this document type \(follow them unless they conflict with the rules above\):\n- Keep the ECG table as it is\./);
  assert.ok(prompt().includes(OUTLINE));
});

test('R2: uploads keep their prompt word for word and get none of the command parts', () => {
  const build = loadBuildExtractPrompt();
  const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/prompt.baseline.json', import.meta.url), 'utf8'));
  for (const [k, args] of Object.entries(CASES)) {
    assert.equal(build(...args), baseline[k], k);
    for (const s of PARTS.slice(0, 4)) assert.ok(!build(...args).includes(`\n${s}\n`), `${k}: ${s}`);
  }
});

test('R2/R3: Live asks for heard, understood, summary and edits only (no statement phrase, no language / all_words)', () => {
  assert.match(liveSuffix(), /call the function propose_edits exactly once, with heard, understood, summary and edits following all the rules above/);
  assert.doesNotMatch(liveSuffix(), /statement/);
});

test('R2: size - much shorter than the Stage 3.3 prompt and the pre-3.3 layered prompt', () => {
  const p = prompt({ outline: '' });
  // measured: pre-3.3 layered prompt 20,405 characters, Stage 3.3 prompt 26,019; R2 about 9.9k with the code-filled parts
  assert.ok(p.length < 12000, `${p.length} characters`);
});
