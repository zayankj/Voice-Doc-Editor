// VOICE STREAMING, stage 3: the browser side (src/lib/voiceStream.js, the additive vad.js callbacks, App.jsx wiring,
// vite.config.js). Fake WebSockets, synthetic loudness patterns, dummy data only - no network, no Gemini.
// Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSegmenter } from '../src/lib/vad.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-voicestream');
fs.mkdirSync(tmp, { recursive: true });
// voiceStream.js imports './requestGuard' (no extension, as Vite allows): a copy with .js endings for Node
for (const f of ['voiceStream', 'requestGuard']) {
  fs.writeFileSync(path.join(tmp, `${f}.js`), fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'"));
}
// the vad.js of the last commit (before the additive callbacks), to prove the segmentation is unchanged
let headVad = null;
try {
  fs.writeFileSync(path.join(tmp, 'vadHead.js'), execSync('git show HEAD:client/src/lib/vad.js', { cwd: path.join(here, '..'), encoding: 'utf8' }));
  headVad = await import(pathToFileURL(path.join(tmp, 'vadHead.js')).href);
} catch { /* not in a git checkout: that test is skipped */ }
const { createVoiceStream, StreamError, streamingOn, streamUrl } = await import(pathToFileURL(path.join(tmp, 'voiceStream.js')).href);
const { RequestError } = await import(pathToFileURL(path.join(tmp, 'requestGuard.js')).href);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a chunk: 4 bytes of "audio" numbered i, base64 (the real ones are 4096 bytes; the content does not matter here)
const chunk = (i) => Buffer.from([i & 255, (i >> 8) & 255, 7, 9]).toString('base64');
// a random loudness pattern: speech bursts, short pauses (< 1.5 s), long pauses (> 1.5 s), coughs, room noise
function pattern(seed, n = 700) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const out = [];
  while (out.length < n) {
    const kind = rnd();
    const len = 1 + Math.floor(rnd() * (kind < 0.4 ? 40 : kind < 0.7 ? 8 : kind < 0.85 ? 18 : 3));
    const level = kind < 0.4 ? 0.05 + rnd() * 0.2 : kind < 0.85 ? rnd() * 0.006 : 0.05; // speech / silence / cough
    for (let i = 0; i < len; i++) out.push(level * (0.7 + rnd() * 0.6));
  }
  return out.slice(0, n);
}
function runSegmenter(create, levels, extra = {}) {
  const clips = [];
  const events = [];
  const seg = create({ onSpeechStart: () => events.push('start'), onSegment: (clip) => { clips.push(clip.slice()); events.push(`seg:${clip.length}`); }, ...extra });
  levels.forEach((rms, i) => seg.push(chunk(i), rms));
  seg.flush();
  return { clips, events };
}

// a fake browser WebSocket: records frames; the test answers
class FakeWS {
  static last = null;
  constructor(url) { this.url = url; this.frames = []; this.closed = false; FakeWS.last = this; }
  send(f) { if (this.closed) throw new Error('closed'); this.frames.push(typeof f === 'string' ? JSON.parse(f) : Buffer.from(f)); }
  close() { this.closed = true; }
  // test side
  openNow() { this.onopen?.(); }
  answer(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  drop() { this.closed = true; this.onclose?.(); }
  get audio() { return Buffer.concat(this.frames.filter((f) => Buffer.isBuffer(f))); }
  get messages() { return this.frames.filter((f) => !Buffer.isBuffer(f)); }
}
const START = { outline: '[B0] (P) "DISCHARGE SUMMARY"', today: '17-11-2026', templateId: '' };
const RESULT = { type: 'result', edits: [{ block_id: 'B0', operation: 'append', new_value: ', X', field_label: 'Title' }], summary: 'Done.', heard: 'add x' };
const bytes = (chunks) => Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64')));
// streams a whole pattern through vad.js + the stream exactly as App.jsx wires them; returns per command: clip + stream
// (as App.jsx: the stream is opened only when vad.js confirms the minimum voiced audio - onSpeechConfirmed)
function streamPattern(levels, { open = 'first' } = {}) {
  const done = [];
  let current = null;
  let ended = null;
  const stats = { streams: 0, segmentsSent: 0, segmentsDropped: 0, droppedWithStream: 0 };
  const seg = createSegmenter({
    onSpeechConfirmed: (startChunks) => { stats.streams++; current = { stream: createVoiceStream({ start: START, startChunks, WebSocketImpl: FakeWS, url: 'ws://test' }), ws: FakeWS.last }; if (open === 'first') current.ws.openNow(); },
    onSegmentChunk: (c, loud) => current?.stream.push(c, loud),
    onSegmentEnd: ({ kept, sent }) => {
      const x = current; current = null;
      if (!sent) { stats.segmentsDropped++; if (x) { stats.droppedWithStream++; x.stream.cancel(); } return; }
      stats.segmentsSent++;
      x.stream.finish(kept); ended = x;
    },
    onSegment: (clip) => { ended.clip = clip.slice(); done.push(ended); ended = null; },
  });
  levels.forEach((rms, i) => seg.push(chunk(i), rms));
  seg.flush();
  if (open === 'last') for (const d of done) d.ws.openNow();
  done.stats = stats;
  return done;
}

test('vad.js: the SEGMENTATION IS UNCHANGED - the same clips at the same moments as the last commit, with or without the new callbacks', { skip: !headVad && 'no git' }, () => {
  for (let seed = 1; seed <= 300; seed++) {
    const levels = pattern(seed);
    const before = runSegmenter(headVad.createSegmenter, levels);
    const now = runSegmenter(createSegmenter, levels);
    const withCallbacks = runSegmenter(createSegmenter, levels, { onSegmentChunk: () => {}, onSegmentEnd: () => {}, onSpeechConfirmed: () => {} });
    assert.deepEqual(now, before, `seed ${seed}`);
    assert.deepEqual(withCallbacks, before, `seed ${seed} (callbacks)`);
  }
  const vad = fs.readFileSync(new URL('../src/lib/vad.js', import.meta.url), 'utf8');
  assert.match(vad, /silenceMs = 1500,/);
  assert.match(vad, /tailMs = 400,/);
  assert.match(vad, /minSpeechMs = 500,/);
  assert.match(vad, /preRollMs = 400,/);
});

test('vad.js reports: onSpeechStart gets the first chunks (pre-roll + first loud); chunks with their loudness; the end with the clip length', () => {
  const got = [];
  const seg = createSegmenter({
    onSpeechStart: (c) => got.push(['start', c.length]),
    onSegmentChunk: (_c, loud) => got.push(['chunk', loud]),
    onSegmentEnd: (e) => got.push(['end', e]),
    onSegment: (clip) => got.push(['clip', clip.length]),
  });
  const levels = [0, 0, 0, 0, 0, 0.2, 0.2, 0.2, 0.2, 0.2, 0, 0.2, ...Array(20).fill(0)];
  levels.forEach((rms, i) => seg.push(chunk(i), rms));
  assert.deepEqual(got[0], ['start', 5], 'pre-roll (4 chunks = 400 ms) + the first loud chunk');
  const end = got.find((g) => g[0] === 'end');
  const clip = got.find((g) => g[0] === 'clip');
  assert.equal(end[1].kept, clip[1]);
  assert.equal(end[1].sent, true);
  assert.ok(got.indexOf(end) < got.indexOf(clip), 'the end is reported just before the clip');
  // a cough (shorter than 500 ms): reported as not sent, no clip
  const short = [];
  const s2 = createSegmenter({ onSegmentEnd: (e) => short.push(e), onSegment: () => short.push('clip') });
  [0.2, 0.2, ...Array(20).fill(0)].forEach((rms, i) => s2.push(chunk(i), rms));
  assert.deepEqual(short, [{ kept: 1 + 4, sent: false }].map((x) => ({ ...x, kept: short[0].kept })));
  assert.equal(short.includes('clip'), false);
});

test('EXACT AUDIO: for 300 random speech patterns the model gets byte for byte the clip the HTTP path would send; "end" last', () => {
  let commands = 0;
  let dropped = 0;
  for (let seed = 1; seed <= 300; seed++) {
    for (const open of ['first', 'last']) { // the connection opens at once / only after the whole command (queued)
      const all = streamPattern(pattern(seed), { open });
      // a stream exists for EXACTLY the commands that are sent; a too-short sound never gets one
      assert.equal(all.stats.streams, all.stats.segmentsSent, `seed ${seed}: one stream per sent command`);
      assert.equal(all.stats.droppedWithStream, 0, `seed ${seed}: no stream for a dropped sound`);
      dropped += all.stats.segmentsDropped;
      for (const d of all) {
        commands++;
        assert.ok(d.ws.audio.equals(bytes(d.clip)), `seed ${seed} (${open}): streamed audio = the clip`);
        assert.deepEqual(d.ws.messages[0], { type: 'start', ...START });
        assert.deepEqual(d.ws.messages.at(-1), { type: 'end' });
        assert.equal(d.ws.frames.at(-1).type, 'end', 'nothing after the end');
      }
    }
  }
  assert.ok(commands > 500, `${commands} commands checked`);
  assert.ok(dropped > 50, `${dropped} too-short sounds checked (none opened a stream)`);
});

test('the ANSWER: read only after the end, once; { edits, summary, heard } only (as the HTTP path)', async () => {
  const s = createVoiceStream({ start: START, startChunks: [chunk(1)], WebSocketImpl: FakeWS, url: 'ws://test' });
  const ws = FakeWS.last;
  ws.openNow();
  ws.answer({ type: 'ready' });
  s.finish(1);
  const p = s.result();
  ws.answer({ ...RESULT, extra: 'dropped' });
  ws.answer({ ...RESULT, summary: 'a second answer is ignored' });
  assert.deepEqual(await p, { edits: RESULT.edits, summary: 'Done.', heard: 'add x' });
  assert.equal(ws.closed, true);
});

test('NEVER PARTIAL: an answer before the end is refused (-> HTTP path)', async () => {
  const s = createVoiceStream({ start: START, startChunks: [chunk(1)], WebSocketImpl: FakeWS, url: 'ws://test' });
  FakeWS.last.openNow();
  FakeWS.last.answer(RESULT); // before finish()
  s.finish(1);
  await assert.rejects(s.result(), (e) => e instanceof StreamError && e.fallback === true);
});

test('FALLBACK: stream problems -> HTTP path; the AI\'s own answers (busy, quota, too slow) -> shown, no second request', async () => {
  const cases = [
    [(ws) => ws.drop(), true],
    [(ws) => ws.onerror?.(), true],
    [(ws) => ws.answer({ type: 'error', status: 400, error: 'bad' }), true],
    [(ws) => ws.answer({ type: 'error', status: 408, error: 'slow start' }), true],
    [(ws) => ws.answer({ type: 'error', status: 413, error: 'too much' }), true],
    [(ws) => ws.answer({ type: 'error', status: 502, error: 'The AI service is not reachable. Make sure it is running.' }), true],
    [(ws) => ws.answer({ type: 'weird' }), true],
    [(ws) => ws.onmessage({ data: 'not json' }), true],
    [(ws) => ws.answer({ type: 'error', status: 429, error: 'Too many requests in a minute.' }), false, 'Too many requests in a minute.'],
    [(ws) => ws.answer({ type: 'error', status: 503, error: 'The model is busy or not responding right now. Try again in a minute.' }), false, 'The model is busy or not responding right now. Try again in a minute.'],
    [(ws) => ws.answer({ type: 'error', status: 504, error: 'The AI service took too long to answer. Please try again.' }), false, 'The AI service took too long to answer. Please try again.'],
  ];
  for (const [act, fallback, message] of cases) {
    const s = createVoiceStream({ start: START, startChunks: [chunk(1)], WebSocketImpl: FakeWS, url: 'ws://test' });
    const ws = FakeWS.last;
    ws.openNow();
    s.finish(1);
    const p = s.result();
    act(ws);
    await assert.rejects(p, (e) => e instanceof StreamError && e.fallback === fallback && (!message || e.message === message), String(act));
  }
  // could not even create the connection
  const s = createVoiceStream({ start: START, startChunks: [chunk(1)], WebSocketImpl: function Broken() { throw new Error('no'); }, url: 'ws://test' });
  s.finish(1);
  await assert.rejects(s.result(), (e) => e.fallback === true);
});

test('a clip that does not match what was sent is never used (-> HTTP path)', async () => {
  const s = createVoiceStream({ start: START, startChunks: [chunk(1), chunk(2)], WebSocketImpl: FakeWS, url: 'ws://test' });
  FakeWS.last.openNow();
  s.push(chunk(3), false);
  s.finish(7); // vad.js says 7 chunks, but only 3 exist
  await assert.rejects(s.result(), (e) => e.fallback === true && /mismatch/.test(e.message));
  assert.ok(!FakeWS.last.messages.some((m) => m.type === 'end'), 'no "end" was sent');
});

test('CANCEL / TIME-OUT: a cancel tells the gateway; a time-out and a cancel signal end the wait like on the HTTP path', async () => {
  const a = createVoiceStream({ start: START, startChunks: [chunk(1)], WebSocketImpl: FakeWS, url: 'ws://test' });
  const wa = FakeWS.last;
  wa.openNow();
  a.cancel();
  assert.deepEqual(wa.messages.at(-1), { type: 'cancel' });
  assert.equal(wa.closed, true);
  const b = createVoiceStream({ start: START, startChunks: [chunk(1)], WebSocketImpl: FakeWS, url: 'ws://test', timeoutMs: 40 });
  FakeWS.last.openNow();
  b.finish(1);
  await assert.rejects(b.result(), (e) => e instanceof RequestError && e.kind === 'timeout');
  const c = createVoiceStream({ start: START, startChunks: [chunk(1)], WebSocketImpl: FakeWS, url: 'ws://test' });
  const wc = FakeWS.last;
  wc.openNow();
  c.finish(1);
  const ctl = new AbortController();
  const p = c.result({ signal: ctl.signal });
  ctl.abort();
  await assert.rejects(p, (e) => e instanceof RequestError && e.kind === 'cancelled');
  wc.answer(RESULT); // a late answer changes nothing
  await sleep(5);
  assert.equal(wc.closed, true);
});

test('off by default; the URL is the page\'s own host (the proxy adds the key); no key in the browser code', () => {
  assert.equal(streamingOn(), false, 'not built with ENABLE_VOICE_STREAMING=true');
  assert.equal(streamUrl({ protocol: 'http:', host: 'localhost:5173' }), 'ws://localhost:5173/api/voice-stream');
  assert.equal(streamUrl({ protocol: 'https:', host: 'app.example' }), 'wss://app.example/api/voice-stream');
  const src = fs.readFileSync(new URL('../src/lib/voiceStream.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /api[-_]?key|INTERNAL|GEMINI|console\./i);
  const vite = fs.readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(vite, /const voiceStreaming = String\(env\.ENABLE_VOICE_STREAMING \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'true';/);
  assert.match(vite, /define: \{ __VOICE_STREAMING__: JSON\.stringify\(voiceStreaming\) \}/);
  assert.match(vite, /ws: voiceStreaming,/);
  assert.match(vite, /headers: \{ 'x-api-key': env\.GATEWAY_API_KEY \|\| '' \},/, 'the key is still added by the proxy only');
});

test('App.jsx: a streamed answer goes through EXACTLY the same steps as the HTTP answer; fallback = the same HTTP request', () => {
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const run = app.slice(app.indexOf('async function runEdits('), app.indexOf('async function runAndReport('));
  // the answer: from the stream, or (stream problem / no stream) the unchanged HTTP request
  assert.match(run, /answer = stream\r?\n\s+\? await stream\.result\(\{ signal: ticket\.signal \}\)\.catch\(\(e\) => \{\r?\n\s+if \(!e\?\.fallback\) throw e;[^\n]*\r?\n\s+return extractEdits\(request\);[^\n]*\r?\n\s+\}\)\r?\n\s+: await extractEdits\(request\);/);
  // every step after the answer, in the same order, for both
  const after = run.slice(run.indexOf('answer = stream'));
  // (R3) Gemini's edits -> the technical dry run of a batch -> apply; the same for the stream and HTTP answers
  const steps = ['ticket.isStale(currentId.current)', 'bottomUp(aiEdits)', 'previewEdits(', 'applyAiEdits('];
  let at = 0;
  for (const s of steps) { const i = after.indexOf(s, at); assert.ok(i > at, `${s} after the answer, in order`); at = i; }
  // the queue: one at a time; a stream is used only for the document it was made for
  const q = app.slice(app.indexOf('async function processQueue('), app.indexOf('function enqueueClip('));
  assert.match(q, /if \(stream && \(stream\.docKey !== currentId\.current \|\| !editor\.state\.doc\.eq\(stream\.docAtStart\)\)\) \{\r?\n\s+stream\.cancel\(\);\r?\n\s+stream = null;/);
  assert.match(q, /if \(working\.current\) return;\r?\n\s+working\.current = true;/);
  assert.match(q, /while \(queue\.current\.length\) \{/);
  // a stream only when nothing else is waiting or being handled
  assert.match(app, /if \(!streamingOn\(\) \|\| !editor \|\| working\.current \|\| queue\.current\.length \|\| !currentId\.current\) return;/);
  // the timing line and the voice settings are unchanged
  assert.match(app, /segmenter\.current = createSegmenter\(\{\r?\n\s+onSpeechStart:/);
  assert.match(app, /total_ms: done - endedAt, outcome,/);
});

// ---------- the 5-second "ready" deadline ----------
const { READY_TIMEOUT_MS } = await import(pathToFileURL(path.join(tmp, 'voiceStream.js')).href);
const { REQUEST_TIMEOUT_MS } = await import(pathToFileURL(path.join(tmp, 'requestGuard.js')).href);

test('READY DEADLINE: connected but never "ready" -> closed at the deadline, the HTTP path is used; nothing later is ever used', async () => {
  const s = createVoiceStream({ start: START, startChunks: [chunk(1)], WebSocketImpl: FakeWS, url: 'ws://test', readyMs: 60 });
  const ws = FakeWS.last;
  ws.openNow(); // connected, but the gateway never confirms
  s.push(chunk(2), true);
  await sleep(100);
  assert.equal(ws.closed, true, 'closed at the deadline (the gateway then stops the command)');
  const framesAtDeadline = ws.frames.length;
  s.push(chunk(3), true); // the person is still speaking: ignored
  s.finish(3);
  await assert.rejects(s.result(), (e) => e instanceof StreamError && e.fallback === true && /not ready/.test(e.message));
  assert.equal(ws.frames.length, framesAtDeadline, 'nothing is sent after the deadline (no "end")');
  ws.answer({ type: 'ready' }); // late messages on this connection change nothing
  ws.answer(RESULT);
  await sleep(5);
  await assert.rejects(s.result(), (e) => e.fallback === true, 'still the same failure: only the HTTP answer can be used');
});

test('READY DEADLINE: stuck while connecting (never opens) -> the HTTP path after the deadline', async () => {
  const s = createVoiceStream({ start: START, startChunks: [chunk(1)], WebSocketImpl: FakeWS, url: 'ws://test', readyMs: 60 });
  const ws = FakeWS.last; // never opened
  s.finish(1);
  const t0 = Date.now();
  await assert.rejects(s.result(), (e) => e instanceof StreamError && e.fallback === true);
  assert.ok(Date.now() - t0 < 1000, 'the HTTP path starts at the deadline, not after the 105 s time-out');
  assert.equal(ws.closed, true);
  assert.equal(ws.frames.length, 0, 'nothing was ever sent');
});

test('SLOW BUT VALID: "ready" just inside the deadline and an answer long after it -> the answer is used (only the AI time limit applies)', async () => {
  const s = createVoiceStream({ start: START, startChunks: [chunk(1)], WebSocketImpl: FakeWS, url: 'ws://test', readyMs: 80, timeoutMs: 2000 });
  const ws = FakeWS.last;
  await sleep(40);
  ws.openNow(); // a slow connection
  await sleep(25);
  ws.answer({ type: 'ready' }); // at ~65 ms, inside the 80 ms deadline
  s.push(chunk(2), true);
  s.finish(2);
  const p = s.result();
  await sleep(300); // the AI takes much longer than the ready deadline
  assert.equal(ws.closed, false, 'not closed by the ready deadline');
  ws.answer(RESULT);
  assert.deepEqual(await p, { edits: RESULT.edits, summary: 'Done.', heard: 'add x' });
});

test('the deadlines: 5 s for "ready"; the AI\'s answer keeps the same 105 s limit as the HTTP path; one HTTP request at most', () => {
  assert.equal(READY_TIMEOUT_MS, 5000);
  assert.equal(REQUEST_TIMEOUT_MS, 105000);
  const src = fs.readFileSync(new URL('../src/lib/voiceStream.js', import.meta.url), 'utf8');
  assert.match(src, /timeoutMs = REQUEST_TIMEOUT_MS, readyMs = READY_TIMEOUT_MS \}\)/);
  // the ready deadline only fails a stream that is not confirmed; a confirmed one is limited by timeoutMs only
  assert.match(src, /readyTimer = setTimeout\(\(\) => \{ if \(!ready\) fail\(new StreamError\('not ready in time'\)\); \}, readyMs\);/);
  // App.jsx: the HTTP request appears exactly twice - the no-stream path and the fallback inside the SAME await
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const run = app.slice(app.indexOf('async function runEdits('), app.indexOf('async function runAndReport('));
  assert.equal((run.match(/extractEdits\(request\)/g) || []).length, 2);
});

// ---------- review fix: short noises never open a stream (the existing 500 ms minimum, the same count as vad.js) ----------
// 128 ms chunks: the minimum (500 ms) = 4 loud chunks. levels: L = loud, q = quiet.
const L = 0.2; const q = 0.0005;
const QUIET = (n) => Array(n).fill(q);

test('SHORT NOISE: a sound shorter than 500 ms of voiced audio opens NO stream and sends no clip (as before: no clip)', () => {
  for (const loudChunks of [1, 2, 3]) {
    let created = 0; let clips = 0;
    const seg = createSegmenter({
      onSpeechConfirmed: () => { created++; },
      onSegment: () => { clips++; },
    });
    [...QUIET(10), ...Array(loudChunks).fill(L), ...QUIET(20)].forEach((rms, i) => seg.push(chunk(i), rms));
    seg.flush();
    assert.equal(created, 0, `${loudChunks} loud chunk(s): no stream`);
    assert.equal(clips, 0, `${loudChunks} loud chunk(s): no clip (unchanged)`);
  }
  // and through the streamer wiring: no WebSocket at all
  const all = streamPattern([...QUIET(10), L, L, L, ...QUIET(20)]);
  assert.equal(all.stats.streams, 0);
  assert.equal(all.length, 0);
});

test('EXACTLY THE MINIMUM (4 loud chunks = 512 ms): one stream, opened at the 4th loud chunk; the audio = the clip', () => {
  const events = [];
  const seg = createSegmenter({
    onSpeechStart: () => events.push('start'),
    onSpeechConfirmed: (c) => events.push(`confirmed:${c.length}`),
    onSegment: (clip) => events.push(`clip:${clip.length}`),
  });
  [...QUIET(10), L, L, L, L, ...QUIET(20)].forEach((rms, i) => seg.push(chunk(i), rms));
  seg.flush();
  // pre-roll (4 quiet) + 4 loud = 8 chunks when confirmed; the clip: those 8 + the 400 ms tail (4 chunks)
  assert.deepEqual(events, ['start', 'confirmed:8', 'clip:12']);
  const all = streamPattern([...QUIET(10), L, L, L, L, ...QUIET(20)]);
  assert.equal(all.stats.streams, 1);
  assert.equal(all.length, 1);
  assert.ok(all[0].ws.audio.equals(bytes(all[0].clip)), 'streamed audio = the HTTP clip');
  assert.deepEqual(all[0].ws.messages.map((m) => m.type), ['start', 'end']);
});

test('NORMAL SPEECH (with short pauses): one stream per command, opened once; the audio = the clip', () => {
  const speech = [...QUIET(8), L, L, q, L, L, L, q, q, L, L, L, L, q, L, L, ...QUIET(20)];
  let confirmed = 0;
  const seg = createSegmenter({ onSpeechConfirmed: () => { confirmed++; } });
  speech.forEach((rms, i) => seg.push(chunk(i), rms));
  seg.flush();
  assert.equal(confirmed, 1, 'reported once per command');
  const all = streamPattern(speech);
  assert.equal(all.stats.streams, 1);
  assert.ok(all[0].ws.audio.equals(bytes(all[0].clip)));
});

test('A SHORT NOISE, THEN REAL SPEECH: no stream for the noise; exactly one for the speech, with exactly its clip', () => {
  const levels = [...QUIET(8), L, L, ...QUIET(16), L, L, L, L, L, L, q, L, L, ...QUIET(20)]; // cough (256 ms), pause, speech
  const all = streamPattern(levels);
  assert.equal(all.stats.segmentsDropped, 1, 'the cough is dropped (as before)');
  assert.equal(all.stats.droppedWithStream, 0, 'the cough never had a stream');
  assert.equal(all.stats.streams, 1, 'one stream: the speech');
  assert.equal(all.length, 1);
  assert.ok(all[0].ws.audio.equals(bytes(all[0].clip)), 'the speech clip, byte for byte');
  // the HTTP path gets the same clip (the segmenter alone)
  const http = runSegmenter(createSegmenter, levels);
  assert.equal(http.clips.length, 1);
  assert.ok(bytes(http.clips[0]).equals(all[0].ws.audio));
});

test('App.jsx: the stream is opened on onSpeechConfirmed (never on the first loud chunk)', () => {
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const seg = app.slice(app.indexOf('segmenter.current = createSegmenter({'), app.indexOf('stopMic.current = await startCapture('));
  // (the mic idle stop also listens to onSpeechConfirmed: lib/micIdle.js; the stream is opened in the same callback)
  assert.match(seg, /onSpeechConfirmed: \(chunksSoFar\) => \{[^}]*startStream\(chunksSoFar\);[^}]*\},/);
  const onStart = seg.slice(seg.indexOf('onSpeechStart:'), seg.indexOf('onSegment:'));
  assert.doesNotMatch(onStart, /startStream/, 'not opened when speech merely starts');
  assert.equal((app.match(/startStream\(/g) || []).length, 2, 'the definition + this one call');
});
