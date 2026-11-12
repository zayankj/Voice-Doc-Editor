// Privacy tests for the browser's voice timing line (src/lib/timing.js and its use in App.jsx).
// Only numbers and fixed outcome words may appear: never patient details, document text, transcripts or medicines.
// Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { voiceTimingLine } from '../src/lib/timing.js';

const SECRETS = ['TEST PATIENT', 'Main Road, Sample Town', '22 Years', 'Tab. DUMMYMED 650 mg', 'add name test patient', 'ENTERIC FEVER'];
const noSecrets = (line) => { for (const s of SECRETS) assert.ok(!line.toLowerCase().includes(s.toLowerCase()), `"${s}" leaked: ${line}`); };

test('numbers and the four outcome words pass; any other text becomes "?"', () => {
  assert.equal(
    voiceTimingLine({ clip_s: 5.04, queue_wait_ms: 0.4, request_ms: 3700.2, browser_ms: 6, apply_ms: undefined, total_ms: 3720, outcome: 'applied' }),
    'Voice timing: clip_s=5.0 queue_wait_ms=0 request_ms=3700 browser_ms=6 apply_ms=- total_ms=3720 outcome=applied',
  );
  for (const o of ['applied', 'window', 'none', 'error']) assert.match(voiceTimingLine({ outcome: o }), new RegExp(`outcome=${o}$`));
  for (const s of SECRETS) {
    const l = voiceTimingLine({ outcome: s, heard: s, request_ms: s, [s]: 1 });
    noSecrets(l);
    assert.equal(l, 'Voice timing: outcome=? heard=? request_ms=?');
  }
  assert.equal(voiceTimingLine({ request_ms: NaN }), 'Voice timing: request_ms=?'); // e.g. a command handled before any request
});

test('App.jsx prints the timing ONLY through voiceTimingLine, with numbers and the outcome', () => {
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const calls = [...app.matchAll(/console\.\w+\(voiceTimingLine\(\{([\s\S]*?)\}\)\)/g)];
  assert.equal(calls.length, 1);
  const keys = [...calls[0][1].matchAll(/([a-z_]+):/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['clip_s', 'queue_wait_ms', 'request_ms', 'browser_ms', 'apply_ms', 'total_ms']);
  assert.match(calls[0][1], /total_ms: [^,]+, outcome,\s*$/); // + outcome (shorthand): runAndReport's fixed word
  // no other console line mentions timing; the voice settings are not touched
  assert.equal(app.split('\n').filter((l) => /console\./.test(l) && /timing/i.test(l)).length, 1);
  assert.match(app, /segmenter\.current = createSegmenter\(\{\r?\n\s+onSpeechStart:/); // still the default 1500 ms pause and 400 ms tail
  const vad = fs.readFileSync(new URL('../src/lib/vad.js', import.meta.url), 'utf8');
  assert.match(vad, /silenceMs = 1500,/);
  assert.match(vad, /tailMs = 400,/);
});
