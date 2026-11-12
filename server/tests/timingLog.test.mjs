// Privacy tests for the timing logs (server/timingLog.js, the labels of server/liveVoice.js, server/index.js).
// The logs may hold ONLY numbers, yes/no and fixed labels: never patient details, document text, transcripts,
// audio, medicines or keys - and the timing never reaches the API answer. Dummy data only.
// Run:  cd server  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { timingLine, safeLabel, LIVE_REASONS } from '../timingLog.js';
import { checkLiveResult } from '../liveVoice.js';
import { finishCommand } from '../scopeGuard.js';

// dummy "sensitive" values: none of them may ever appear in a log line
const SECRETS = ['TEST PATIENT', 'Main Road, Sample Town', '22 Years', 'Tab. DUMMYMED 650 mg', 'add name test patient',
  'ENTERIC FEVER', 'AIzaDUMMYKEY0000', 'UklGRiQAAABXQVZF'];
const noSecrets = (line) => { for (const s of SECRETS) assert.ok(!line.toLowerCase().includes(s.toLowerCase()), `"${s}" leaked: ${line}`); };

const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const live = fs.readFileSync(new URL('../liveVoice.js', import.meta.url), 'utf8');

test('timingLine: numbers, yes/no and fixed labels pass; every other text becomes "?"', () => {
  const line = timingLine('Voice timing', {
    live: 'ok', connect_ms: 170.4, answer_ms: 3420, model_audio: false, backup: true, edits: 6, missing: undefined,
    reason: 'invalid edit (new_value missing)', closed: 'closed 1007',
  });
  assert.equal(line, 'Voice timing: live=ok connect_ms=170 answer_ms=3420 model_audio=no backup=yes edits=6 missing=- '
    + 'reason="invalid edit (new_value missing)" closed="closed 1007"');
  for (const s of SECRETS) {
    const l = timingLine('Voice timing', { reason: s, live: s, heard: s, connect_ms: s });
    noSecrets(l);
    assert.equal(l, 'Voice timing: reason=? live=? heard=? connect_ms=?');
  }
  assert.equal(safeLabel('closed 1007 TEST PATIENT'), '?');
  assert.equal(safeLabel({ toString: () => 'timeout' }), '?'); // only real strings from the list
  // field names from content are dropped; a title from content is never printed
  noSecrets(timingLine('TEST PATIENT', { 'TEST PATIENT': 1, [SECRETS[3]]: 2, ok_ms: 3 }));
  assert.equal(timingLine('TEST PATIENT', { ok_ms: 3 }), 'Timing: ok_ms=3');
  assert.equal(timingLine('Voice timing', { a_ms: NaN, b_ms: Infinity }), 'Voice timing: a_ms=? b_ms=?');
});

test('every reason liveVoice.js can give is a fixed label of the log list (so it is printed, not "?")', () => {
  const reasons = [...live.matchAll(/(?:fail|new LiveError)\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(reasons.length >= 30, `found ${reasons.length}`);
  for (const r of reasons) assert.ok(LIVE_REASONS.includes(r), `missing from LIVE_REASONS: ${r}`);
  assert.match(live, /new LiveError\(`closed \$\{e\?\.code \?\? ''\}`\.trim\(\)\)/); // "closed" / "closed 1007": allowed by the number-only pattern
});

// a valid answer whose text is full of dummy patient content
const good = () => ({
  heard: 'add name test patient', understood: 'add name test patient', summary: 'TEST PATIENT added', language: 'English',
  edits: [{ block_id: 'B2', operation: 'set', new_value: 'TEST PATIENT', field_label: 'Name' }],
});
const withEdit = (extra) => ({ ...good(), edits: [{ block_id: 'B2', operation: 'set', new_value: 'TEST PATIENT', field_label: 'Name', ...extra }] });

test('each rejected Live answer -> exactly its fixed label, with no content in it (the same checks refuse the same answers)', () => {
  const cases = [
    [null, 'invalid function arguments (not an object)'],
    [{ ...good(), edits: 'TEST PATIENT' }, 'invalid function arguments (edits not a list)'],
    [{ ...good(), edits: Array(51).fill(good().edits[0]) }, 'too many edits'],
    [{ ...good(), summary: 5 }, 'invalid function arguments (summary, heard or language not text)'],
    [{ ...good(), all_words: 'x'.repeat(201) }, 'invalid function arguments (all_words not text)'],
    [{ ...good(), understood: undefined }, 'invalid function arguments (understood missing)'],
    [{ ...good(), edits: ['TEST PATIENT'] }, 'invalid edit (not an object)'],
    [withEdit({ block_id: 'TEST PATIENT' }), 'invalid edit (block_id not like B12)'],
    [withEdit({ operation: 'Tab. DUMMYMED 650 mg' }), 'invalid edit (unknown operation)'],
    [withEdit({ field_label: '  ' }), 'invalid edit (field_label missing)'],
    [withEdit({ find_text: 5 }), 'invalid edit (new_value or find_text not text)'],
    [withEdit({ operation: 'insert_after', new_value: undefined, lines: ['Tab. DUMMYMED 650 mg'] }), 'invalid edit (new_value missing)'],
    [withEdit({ operation: 'replace_text', find_text: '' }), 'invalid edit (replace_text needs find_text and new_value)'],
    [withEdit({ style: 'Main Road' }), 'invalid edit (unknown style)'],
    [withEdit({ case: 'Main Road' }), 'invalid edit (unknown case)'],
    [withEdit({ list_type: 'Main Road' }), 'invalid edit (unknown list_type)'],
    [withEdit({ last_block_id: 'TEST PATIENT' }), 'invalid edit (last_block_id not like B12)'],
    [withEdit({ duplicate_ok: 'yes' }), 'invalid edit (duplicate_ok not true/false)'],
    [withEdit({ lines: 'Tab. DUMMYMED 650 mg' }), 'invalid edit (lines not a valid list)'],
    [withEdit({ operation: 'format' }), 'invalid edit (format needs style)'],
    [withEdit({ operation: 'change_case' }), 'invalid edit (change_case needs case)'],
    [withEdit({ select: ['TEST PATIENT'] }), 'invalid edit (select not a valid list)'],
    [withEdit({ operation: 'to_list', list_type: 'bullet' }), 'invalid edit (to_list needs list_type and lines or select)'],
  ];
  for (const [args, label] of cases) {
    let msg = null;
    try { checkLiveResult(args, 'add name test patient'); } catch (e) { msg = e.message; }
    assert.equal(msg, label);
    noSecrets(timingLine('Voice timing', { live: 'failed', reason: msg }));
  }
  // an empty transcript is still refused; a valid answer still passes unchanged
  assert.throws(() => checkLiveResult(good(), '  '), /^Error: empty transcript$|empty transcript/);
  assert.equal(checkLiveResult(good(), 'x').edits[0].new_value, 'TEST PATIENT');
});

test('timing never reaches the API answer: hidden property, and finishCommand returns only edits / summary / heard', () => {
  const result = { ...checkLiveResult(good(), 'add name test patient') };
  Object.defineProperty(result, 'timing', { value: { connect_ms: 170 }, enumerable: false }); // as liveVoice.js attaches it
  assert.ok(!JSON.stringify(result).includes('connect_ms'));
  const sent = finishCommand(result, { outline: '[B2] (P) "TEST PATIENT"', said: [result.transcript] });
  assert.deepEqual(Object.keys(sent).sort(), ['edits', 'heard', 'summary']);
  assert.ok(!JSON.stringify(sent).includes('connect_ms'));
  assert.match(live, /Object\.defineProperty\(obj, 'timing', \{ value: timing, enumerable: false \}\)/);
  // index.js: timing values are only ever printed through timingLine, never put into a response
  for (const l of index.split('\n').filter((x) => /timing/i.test(x) && /res\.(json|status|send)/.test(x))) assert.fail(`timing in a response: ${l}`);
  for (const l of index.split('\n').filter((x) => /\.timing\b/.test(x))) assert.ok(/timingLine|\.\.\.(result|e\?)\.timing|Boolean\((result|e)\?\.timing/.test(l), l);
  assert.equal((index.match(/console\.log\(timingLine\(/g) || []).length, 3);
});

test('index.js: the Live call, the fallback call and the answers are the same lines as before', () => {
  assert.match(index, /const result = await liveExtract\(\{ prompt, audioBase64 \}\);/);
  assert.match(index, /return res\.json\(finishCommand\(result, \{ outline, said: \[result\.transcript\] \}\)\);/);
  assert.match(index, /console\.warn\(`Voice: Live not used \(\$\{e\?\.message \|\| 'error'\}\) after \$\{Date\.now\(\) - t0\} ms -> existing path`\);\r?\n/);
  assert.match(index, /const answer = await generateWithRetry\(\{\r?\n\s+contents: \[\{ role: 'user', parts \}\],/);
  assert.match(index, /res\.json\(isCommand \? finishCommand\(data, \{ outline, said: \[typed\] \}\) : out\);/);
  assert.match(index, /console\.log\(`AI: answered by \$\{model\} in \$\{Date\.now\(\) - tryFrom\} ms`\);/); // model name (from .env) and a number
});
