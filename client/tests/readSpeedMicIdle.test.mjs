// Read aloud speed (lib/tts.js setReadingRate, SidePanel speed buttons) and the microphone idle stop (lib/micIdle.js
// with the real lib/vad.js). Dummy document only - no patient data. The browser's speech engine is a fake here.
// Run:  cd client  &&  node --test tests/
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { createMicIdle, MIC_IDLE_TIMEOUT_MS } from '../src/lib/micIdle.js';
import { createSegmenter } from '../src/lib/vad.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-speed-idle');
fs.mkdirSync(tmp, { recursive: true });
for (const [entry, out] of [['lib/tts.js', 'tts.mjs'], ['components/SidePanel.jsx', 'SidePanel.mjs']]) {
  await build({
    entryPoints: [path.join(here, '../src', entry)], outfile: path.join(tmp, out),
    format: 'esm', jsx: 'automatic', bundle: true, packages: 'external', logLevel: 'silent',
  });
}
const tts = await import(pathToFileURL(path.join(tmp, 'tts.mjs')).href);
const { default: SidePanel } = await import(pathToFileURL(path.join(tmp, 'SidePanel.mjs')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const APP = fs.readFileSync(path.join(here, '../src/App.jsx'), 'utf8');

// ---------- a fake browser speech engine: utterances are queued; the test says when each starts / reaches a word / ends
class FakeUtterance { constructor(text) { this.text = text; } }
function fakeSynth() {
  const s = {
    queue: [], spoken: [], speaking: null, dropped: [], dropNow: false,
    getVoices: () => [],
    // like Chrome with its Google voices: queued in the same moment as cancel() of a playing sentence -> never played
    speak(u) { if (s.dropNow) { s.dropped.push(u); return; } s.queue.push(u); s.spoken.push(u); },
    cancel() {
      if (s.speaking) { s.dropNow = true; setTimeout(() => { s.dropNow = false; }, 0); }
      const all = [...(s.speaking ? [s.speaking] : []), ...s.queue];
      s.speaking = null; s.queue = [];
      all.forEach((u, i) => u.onerror?.({ error: i === 0 ? 'interrupted' : 'canceled' }));
    },
    begin() { s.speaking = s.queue.shift(); s.speaking?.onstart?.(); return s.speaking; },
    word(charIndex) { s.speaking.onboundary?.({ name: 'word', charIndex }); },
    end() { const u = s.speaking; s.speaking = null; u.onend?.(); return u; },
  };
  return s;
}
let synth;
const reset = () => { synth = fakeSynth(); globalThis.window = { speechSynthesis: synth }; globalThis.SpeechSynthesisUtterance = FakeUtterance; };

// a dummy document and a minimal editor: the real document, a cursor, and a record of the reading highlight
const schema = getSchema([StarterKit]);
const p = (s) => schema.node('paragraph', null, [schema.text(s)]);
const S1 = 'Patient was admitted with fever.';
const S2 = 'Treated with intravenous fluids and antibiotics for five days.';
function makeEditor(cursor = 1) {
  const doc = schema.node('doc', null, [p('DUMMY HOSPITAL'), p(`${S1} ${S2}`), p('Review in OPD after one week.')]);
  const highlights = [];
  const tr = { metas: {}, setMeta(k, v) { this.metas[typeof k === 'string' ? k : 'flash'] = v; return this; } };
  return {
    highlights, isDestroyed: false,
    state: { doc, selection: { from: cursor }, get tr() { return { ...tr, metas: {} }; } },
    view: { dispatch: (t) => highlights.push(t.metas.flash ?? null), nodeDOM: () => null },
  };
}
// a speed change queues the rest after a short pause (tts.js RATE_CHANGE_GAP_MS)
const gap = () => new Promise((r) => setTimeout(r, tts.RATE_CHANGE_GAP_MS + 30));
const read = (editor, opts = {}) => { const ends = []; tts.readDocument(editor, { rate: 1.1, onEnd: () => ends.push(1), ...opts }); return ends; };

// ---------- READ ALOUD SPEED ----------
test('Read starts at the normal speed: every sentence at the rate it was given (1x = 1.1, unchanged)', () => {
  reset();
  read(makeEditor());
  assert.ok(synth.spoken.length >= 4);
  assert.ok(synth.spoken.every((u) => u.rate === 1.1));
  assert.equal(synth.spoken[0].text, 'Reading the discharge summary now.');
});

test('changing the speed while reading goes on from the WORD it is at, at the new speed - not from the beginning', async () => {
  reset();
  const ends = read(makeEditor());
  synth.begin(); synth.end(); // intro
  synth.begin(); synth.end(); // DUMMY HOSPITAL
  const u = synth.begin(); // the paragraph with S1
  assert.equal(u.text, `${S1}`);
  synth.word(12); // "...admitted" reached
  const before = synth.spoken.length;
  assert.equal(tts.setReadingRate(1.65), true);
  assert.equal(synth.queue.length, 0, 'nothing queued in the same moment as cancel()');
  await gap();
  assert.equal(synth.dropped.length, 0, 'no sentence was dropped');
  const again = synth.spoken.slice(before);
  assert.equal(again[0].text, S1.slice(12), 'goes on from the word it was at');
  assert.ok(again.every((x) => x.rate === 1.65));
  assert.ok(!again.some((x) => x.text === 'Reading the discharge summary now.'), 'never starts again from the top');
  assert.equal(ends.length, 0, 'the cancelled sentences do not end the reading');
});

test('2x after 1.5x; a voice that reports no words goes on from the start of the sentence part; the highlight stays on the same line', async () => {
  reset();
  const ed = makeEditor();
  read(ed);
  synth.begin(); synth.end(); synth.begin(); synth.end();
  synth.begin(); // S1 (no word events)
  const n = synth.spoken.length;
  tts.setReadingRate(1.65);
  await gap();
  synth.begin(); // S1 again, at 1.65
  synth.end();
  const s2 = synth.begin();
  assert.equal(s2.text, S2);
  const lineOfS2 = ed.highlights.at(-1);
  tts.setReadingRate(2.2);
  await gap();
  const again = synth.spoken.slice(n + 0).filter((x) => x.rate === 2); // 2x: played at the engine maximum (2)
  assert.equal(again[0].text, S2, 'the part it was in, from its start');
  synth.begin();
  assert.deepEqual(ed.highlights.at(-1), lineOfS2, 'the same line is highlighted');
});

test('the end of the reading after a speed change: onEnd once, highlight cleared; later speed changes do nothing', async () => {
  reset();
  const ed = makeEditor();
  const ends = read(ed);
  synth.begin();
  const oldLast = synth.spoken.at(-1);
  tts.setReadingRate(2.2);
  await gap();
  oldLast.onend(); // a late event of a cancelled sentence must not end the reading
  assert.equal(ends.length, 0);
  while (synth.queue.length) { synth.begin(); synth.end(); }
  assert.equal(ends.length, 1);
  assert.equal(ed.highlights.at(-1), null, 'the reading highlight is removed');
  assert.equal(tts.setReadingRate(1.1), false, 'nothing is being read any more');
});

test('2x (2 x 1.1 = 2.2) is played at 2, the fastest rate the Chrome Google voices start; nothing is ever given more than 2', async () => {
  assert.equal(tts.MAX_RATE, 2);
  reset();
  read(makeEditor(), { rate: 2.2 }); // click-to-restart at 2x
  assert.ok(synth.spoken.length > 3 && synth.spoken.every((u) => u.rate === 2));
  synth.begin(); synth.end(); synth.begin();
  tts.setReadingRate(1.65);
  await gap();
  tts.setReadingRate(2.2); // the 2x button
  await gap();
  assert.ok(synth.spoken.every((u) => u.rate <= 2));
  assert.equal(synth.spoken.at(-1).rate, 2);
});

test('Stop: reading stops at once, onEnd is not called, the speed can no longer be changed', () => {
  reset();
  const ed = makeEditor();
  const ends = read(ed);
  synth.begin();
  tts.stopReading(ed);
  assert.equal(synth.queue.length, 0);
  assert.equal(ends.length, 0);
  assert.equal(tts.setReadingRate(2.2), false);
  assert.equal(synth.spoken.filter((u) => u.rate === 2.2).length, 0);
});

test('the short pause after cancel(): Stop in it -> nothing more is spoken; two quick speed changes -> only the last is queued, once', async () => {
  reset();
  const ed = makeEditor();
  const ends = read(ed);
  synth.begin();
  const n = synth.spoken.length;
  tts.setReadingRate(2.2);
  tts.stopReading(ed);
  await gap();
  assert.equal(synth.spoken.length, n, 'nothing queued after Stop');
  assert.equal(ends.length, 0);

  reset();
  read(makeEditor());
  synth.begin(); synth.end(); synth.begin();
  const m = synth.spoken.length;
  const left = synth.queue.length + 1; // the rest, from the sentence being read
  tts.setReadingRate(1.65);
  tts.setReadingRate(2.2);
  await gap();
  const after = synth.spoken.slice(m);
  assert.equal(after.length, left, 'the rest of the document once, not twice');
  assert.ok(after.every((u) => u.rate === 2));
});

test('reading from the cursor is unchanged, and a speed change there also goes on from where it is', async () => {
  reset();
  const ed = makeEditor(1);
  const cursorInS2 = ed.state.doc.child(0).nodeSize + 1 + S1.length + 5; // inside the second sentence
  ed.state.selection.from = cursorInS2;
  read(ed);
  assert.equal(synth.spoken[0].text, 'Reading from here.');
  assert.equal(synth.spoken[1].text, S2, 'starts at the sentence of the cursor');
  synth.begin(); synth.end();
  synth.begin(); synth.word(8);
  const n = synth.spoken.length;
  tts.setReadingRate(1.65);
  await gap();
  assert.equal(synth.spoken[n].text, S2.slice(8));
});

test('App: every Read starts at 1x; the speed buttons call setReadingRate; click-to-restart keeps the chosen speed', () => {
  assert.match(APP, /const READ_SPEEDS = \[1, 1\.25, 1\.5, 2\]/);
  const toggle = APP.slice(APP.indexOf('function toggleRead()'), APP.indexOf('function changeReadSpeed'));
  assert.match(toggle, /setReadSpeed\(1\)/);
  assert.match(toggle, /rate: READ_RATE,/);
  assert.match(APP, /setReadingRate\(READ_RATE \* speed\)/);
  assert.match(APP, /rate: READ_RATE \* readSpeedRef\.current/);
});

test('SidePanel: the speed buttons are shown only while reading, with the chosen one pressed', () => {
  const props = { status: 'idle', onMic() {}, onRead() {}, readSpeeds: [1, 1.25, 1.5, 2], onReadSpeed() {}, transcript: '', reply: '', note: '', error: '', attached: null, instruction: '', onInstruction() {}, onApply() {}, history: [], onUndo() {} };
  const off = renderToStaticMarkup(React.createElement(SidePanel, { ...props, reading: false, readSpeed: 1 }));
  assert.ok(!off.includes('Reading speed'));
  const on = renderToStaticMarkup(React.createElement(SidePanel, { ...props, reading: true, readSpeed: 1.25 }));
  assert.match(on, /aria-label="Reading speed"/);
  assert.deepEqual([...on.matchAll(/>([\d.]+x)</g)].map((m) => m[1]), ['1x', '1.25x', '1.5x', '2x'], 'all four, in order');
  assert.match(on, /aria-pressed="true"[^>]*>1\.25x</);
  assert.equal((on.match(/aria-pressed="true"/g) || []).length, 1);
});

test('each of the four speeds: the rest of the WHOLE document is queued at that rate, and reading runs on to the end', async () => {
  // 2x = 2.2 asked, played at 2 (tts.js MAX_RATE)
  for (const [speed, rate] of [[1.25, 1.375], [1.5, 1.65], [2, 2], [1, 1.1]]) {
    reset();
    const ends = read(makeEditor(), { rate: speed === 1 ? 2.2 : 1.1 }); // 1x: switched back from 2x
    const all = synth.spoken.map((u) => u.text);
    synth.begin(); synth.end(); synth.begin(); synth.end(); // intro, title
    synth.begin(); synth.word(8); // in the middle of S1
    const n = synth.spoken.length;
    tts.setReadingRate(1.1 * speed);
    await gap();
    assert.equal(synth.dropped.length, 0);
    const after = synth.spoken.slice(n);
    assert.ok(after.every((u) => Math.abs(u.rate - rate) < 1e-9), `${speed}x -> ${rate}`);
    assert.equal(after[0].text, S1.slice(8), `${speed}x: from the same word`);
    assert.deepEqual(after.slice(1).map((u) => u.text), all.slice(3), `${speed}x: every following sentence, to the end`);
    // the engine plays the new queue sentence after sentence with no click: the reading ends only after the LAST one
    let played = 0;
    while (synth.queue.length) { synth.begin(); assert.equal(ends.length, 0, 'not ended in the middle'); synth.end(); played++; }
    assert.equal(played, after.length);
    assert.equal(ends.length, 1, `${speed}x: ended once, at the end of the document`);
    assert.equal(synth.spoken.at(-1).text, 'That is the end of the summary.');
  }
});

// ---------- MICROPHONE IDLE STOP ----------
test('the time limit is one constant: 25 s', () => {
  assert.equal(MIC_IDLE_TIMEOUT_MS, 25000);
  assert.ok(!/IDLE_STOP_MS|25000|30000/.test(APP), 'App.jsx has no second copy of the time');
});

// drives the REAL vad.js and micIdle.js together, 128 ms per chunk (as the microphone). rmsAt(t) = loudness at time t.
// Returns the time (ms) the mic would be turned off, or null.
function runMic(rmsAt, { ms = 120000, busyAt = () => false } = {}) {
  let clock = 0;
  const idle = createMicIdle({ now: () => clock });
  const seg = createSegmenter({
    onSpeechConfirmed: () => idle.speechConfirmed(),
    onSegmentChunk: (_c, loud) => idle.chunk(loud),
    onSegmentEnd: (info) => idle.segmentEnd(info.sent),
  });
  for (clock = 0; clock <= ms; clock += 128) {
    seg.push('x', rmsAt(clock));
    if (idle.tick(busyAt(clock))) return clock;
  }
  return null;
}
const SILENT = 0.002;
const SPEECH = 0.08;
const T = 25000; // MIC_IDLE_TIMEOUT_MS
const near = (t, expected) => assert.ok(t !== null && Math.abs(t - expected) <= 300, `turned off at ${t}, expected about ${expected}`);

test('mic on, nobody speaks: off after 25 s', () => near(runMic(() => SILENT), T));

test('mic on, speaking without stopping for 100 s (vad cuts it into 30 s commands): never turned off', () => {
  assert.equal(runMic(() => SPEECH, { ms: 100000 }), null);
});

// the clock restarts when a command ENDS: the last word + the 1.5 s pause vad.js waits for
const END = 1536;
test('speech with short pauses (1 s every 4 s): never off while speaking; off 25 s after the last command ended', () => {
  const rms = (t) => (t < 60000 && t % 4000 < 3000 ? SPEECH : SILENT);
  near(runMic(rms), 59000 + END + T - 300);
});

test('speak, then 20 s quiet, then speak again: the clock starts again from the second command', () => {
  const rms = (t) => ((t < 2000 || (t >= 22000 && t < 24000)) ? SPEECH : SILENT);
  near(runMic(rms), 24000 + END + T);
});

test('background noise (a click or cough every 2 s, a steady quiet hum) does NOT keep the mic on', () => {
  near(runMic((t) => (t % 2000 < 128 ? 0.2 : SILENT)), T); // 128 ms clicks: never 500 ms of speech
  near(runMic(() => 0.006), T); // a hum below vad.js's speech level
});

test('a command being processed holds the clock: never cut off while waiting for the AI', () => {
  // spoken at 0-2 s, the AI takes until 50 s; the mic stops 25 s after that, not at 27 s
  const rms = (t) => (t < 2000 ? SPEECH : SILENT);
  near(runMic(rms, { busyAt: (t) => t >= 2000 && t < 50000 }), 50000 + T);
});

test('a slow start (permission prompt): the clock starts with the first microphone chunk', () => {
  let clock = 100000;
  const idle = createMicIdle({ now: () => clock });
  assert.equal(idle.tick(), false, 'the first chunk starts the clock');
  clock += T - 1000;
  assert.equal(idle.tick(), false);
  clock += 1000;
  assert.equal(idle.tick(), true);
});

test('App: the idle stop uses vad.js callbacks only, holds while busy, and stops the mic the normal way with the notice', () => {
  const mic = APP.slice(APP.indexOf('async function startAudioMic()'), APP.indexOf('// ---------- microphone ----------'));
  assert.match(mic, /idle\.speechConfirmed\(\)/);
  assert.match(mic, /idle\.chunk\(loud\)/);
  assert.match(mic, /idle\.segmentEnd\(info\.sent\)/);
  assert.match(mic, /idle\.tick\(working\.current \|\| queue\.current\.length > 0\)/);
  assert.match(mic, /stopListening\(\);\s*showToast\('Microphone turned off automatically due to inactivity\.'\)/);
  assert.ok(!/onSpeechStart: \(\) => \{[^}]*idle/.test(mic), 'a short sound (speech start only) is not counted');
});
