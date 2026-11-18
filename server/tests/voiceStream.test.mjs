// VOICE STREAMING, stage 1: the internal route (server/voiceStream.js) and the streaming Live session
// (startLiveStream in server/liveVoice.js). A real HTTP server + real WebSocket client; Live and the backup model are
// replaced by test doubles (no Gemini call). Dummy data only.  Run:  cd server  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { WebSocket } from 'ws';
import { attachVoiceStream, STREAM_PATH, LIMITS, voiceStreamingEnabled } from '../voiceStream.js';
import { pcmToWav, wavToPcm } from '../liveVoice.js';

const KEY = 'test-internal-key';
const OUTLINE = '[B0] (P) "DISCHARGE SUMMARY"\n[B1] (P) "DIAGNOSIS"\n[B2] (P) "ENTERIC FEVER"';
const START = { type: 'start', outline: OUTLINE, today: '17-11-2026', templateId: '', cursorBlock: 'B2', recent: [] };
const pcm = (n, v = 1) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i += 2) b.writeInt16LE(v * ((i / 2) % 100), i); return b; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOD = { edits: [{ block_id: 'B2', operation: 'append', new_value: ', TYPHOID', field_label: 'Diagnosis' }], summary: 'Added.', heard: 'add typhoid', understood: 'Add typhoid to the diagnosis.', transcript: 'add typhoid' };

// a stand-in for startLiveStream: records what it gets; end() answers / fails as told
function fakeLive({ answer = GOOD, fail = null, delayMs = 0 } = {}) {
  const calls = { opened: 0, prompts: [], pushed: [], ended: 0, cancelled: 0 };
  const start = ({ prompt }) => {
    calls.opened++; calls.prompts.push(prompt);
    const kept = [];
    return {
      push: (b) => { kept.push(b); calls.pushed.push(b); },
      end: async () => {
        calls.ended++; await sleep(delayMs);
        if (fail) throw Object.assign(new Error(fail), { timing: { answer_ms: 5 } });
        return Object.defineProperty({ ...answer }, 'timing', { value: { connect_ms: 1, answer_ms: 2 }, enumerable: false });
      },
      cancel: () => { calls.cancelled++; },
      audio: () => Buffer.concat(kept),
      bytes: () => kept.reduce((n, b) => n + b.length, 0),
    };
  };
  return { start, calls };
}

async function setup({ live = fakeLive(), backup, makePrompt } = {}) {
  const logs = [];
  const backupCalls = [];
  const server = http.createServer((_q, r) => { r.statusCode = 404; r.end(); });
  attachVoiceStream(server, {
    internalKey: KEY,
    makePrompt: makePrompt || (({ outline, templateId }) => { if (templateId === 'nope') throw Object.assign(new Error('Unknown template'), { status: 400 }); if (!outline) throw Object.assign(new Error('Speak, attach a file or type an instruction'), { status: 400 }); return `PROMPT(${outline.length})`; }),
    backup: async (args) => { backupCalls.push(args); return backup ? backup(args) : { edits: [], summary: 'From backup.', heard: 'x' }; },
    finishCommand: (data, { said }) => ({ edits: data.edits || [], summary: `${data.summary || ''}`, heard: data.heard || '', said_for_test: said }),
    quotaMessage: () => 'QUOTA MESSAGE',
    totalBudgetMs: 90000,
    startLiveStream: live.start,
    log: (l) => logs.push(l),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${server.address().port}${STREAM_PATH}`;
  return { server, url, logs, live, backupCalls, close: () => new Promise((r) => server.close(r)) };
}
// opens a connection; collects every message; resolves when the server closes it
function connect(url, headers = { 'x-internal-key': KEY }) {
  const ws = new WebSocket(url, { headers });
  const got = [];
  const closed = new Promise((resolve) => {
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => resolve('error'));
    ws.on('unexpected-response', (_req, res) => resolve(`http ${res.statusCode}`));
  });
  const open = new Promise((resolve) => { ws.on('open', () => resolve(true)); ws.on('error', () => resolve(false)); ws.on('unexpected-response', () => resolve(false)); });
  return { ws, got, closed, open };
}

test('off by default: only ENABLE_VOICE_STREAMING=true turns it on; index.js attaches it only then', () => {
  const was = process.env.ENABLE_VOICE_STREAMING;
  try {
    for (const v of [undefined, '', 'false', '1', 'yes', 'TRUE ']) {
      if (v === undefined) delete process.env.ENABLE_VOICE_STREAMING; else process.env.ENABLE_VOICE_STREAMING = v;
      assert.equal(voiceStreamingEnabled(), v === 'TRUE ', String(v));
    }
    process.env.ENABLE_VOICE_STREAMING = 'true';
    assert.equal(voiceStreamingEnabled(), true);
  } finally { if (was === undefined) delete process.env.ENABLE_VOICE_STREAMING; else process.env.ENABLE_VOICE_STREAMING = was; }
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(index, /if \(voiceStreamingEnabled\(\)\) \{\r?\n\s+attachVoiceStream\(server, \{/);
  // no .env file is read or changed by this feature: the switch is only read from the environment
  assert.doesNotMatch(fs.readFileSync(new URL('../voiceStream.js', import.meta.url), 'utf8'), /dotenv|readFileSync|writeFileSync/);
});

test('the internal key is required (wrong or missing -> 401, nothing opened); another path -> refused', async () => {
  const s = await setup();
  try {
    for (const h of [{}, { 'x-internal-key': 'wrong' }, { 'x-internal-key': `${KEY}x` }]) {
      const c = connect(s.url, h);
      assert.equal(await c.open, false);
      assert.equal(await c.closed, 'http 401');
    }
    const other = connect(s.url.replace(STREAM_PATH, '/internal/other'));
    assert.equal(await other.open, false);
    assert.equal(s.live.calls.opened, 0);
  } finally { await s.close(); }
});

test('HAPPY PATH: start -> audio while speaking -> end -> ONE checked result; Live gets exactly the audio, in order', async () => {
  const s = await setup();
  try {
    const c = connect(s.url);
    await c.open;
    c.ws.send(JSON.stringify(START));
    await sleep(30);
    assert.deepEqual(c.got, [{ type: 'ready' }]);
    assert.equal(s.live.calls.opened, 1, 'Live opened when speech STARTS');
    assert.equal(s.live.calls.prompts[0], `PROMPT(${OUTLINE.length})`, 'the prompt of the HTTP voice path');
    const chunks = [pcm(4096, 1), pcm(4096, 2), pcm(1000, 3)];
    for (const ch of chunks) { c.ws.send(ch); await sleep(5); }
    await sleep(30);
    assert.equal(c.got.length, 1, 'nothing is answered before the end');
    assert.equal(s.live.calls.ended, 0);
    c.ws.send(JSON.stringify({ type: 'end' }));
    assert.equal(await c.closed, 1000);
    assert.equal(c.got.length, 2);
    assert.deepEqual(c.got[1], { type: 'result', edits: GOOD.edits, summary: 'Added.', heard: 'add typhoid', said_for_test: ['add typhoid'] });
    assert.ok(Buffer.concat(s.live.calls.pushed).equals(Buffer.concat(chunks)), 'every byte, in order');
    assert.equal(s.backupCalls.length, 0);
    assert.equal(s.live.calls.cancelled, 0);
  } finally { await s.close(); }
});

test('Live fails -> the existing backup path gets exactly the spoken audio as a WAV and the same prompt; ONE result', async () => {
  for (const fail of ['timeout', 'no function call', 'invalid edit (unknown operation)', 'empty transcript', 'connection failed']) {
    const s = await setup({ live: fakeLive({ fail }) });
    try {
      const c = connect(s.url);
      await c.open;
      c.ws.send(JSON.stringify(START));
      const chunks = [pcm(4096, 4), pcm(2048, 5)];
      for (const ch of chunks) c.ws.send(ch);
      await sleep(20);
      c.ws.send(JSON.stringify({ type: 'end' }));
      await c.closed;
      assert.equal(s.backupCalls.length, 1, fail);
      const b = s.backupCalls[0];
      assert.equal(b.prompt, `PROMPT(${OUTLINE.length})`);
      assert.ok(wavToPcm(Buffer.from(b.wavBase64, 'base64')).equals(Buffer.concat(chunks)), 'the backup hears exactly the same audio');
      assert.deepEqual(c.got.map((m) => m.type), ['ready', 'result']);
      assert.equal(c.got[1].summary, 'From backup.');
      assert.deepEqual(c.got[1].said_for_test, [''], 'as the HTTP voice path: said = [typed] = [""]');
      assert.ok(s.logs.some((l) => l.startsWith('Voice timing: stream=yes live=failed')), fail);
    } finally { await s.close(); }
  }
});

test('Live cannot even start (off / error) -> the audio is collected and the backup answers', async () => {
  const s = await setup({ live: { start: () => { throw new Error('live is off'); }, calls: {} } });
  try {
    const c = connect(s.url);
    await c.open;
    c.ws.send(JSON.stringify(START));
    c.ws.send(pcm(4096, 7));
    await sleep(20);
    c.ws.send(JSON.stringify({ type: 'end' }));
    await c.closed;
    assert.equal(s.backupCalls.length, 1);
    assert.ok(wavToPcm(Buffer.from(s.backupCalls[0].wavBase64, 'base64')).equals(pcm(4096, 7)));
    assert.equal(c.got.at(-1).type, 'result');
  } finally { await s.close(); }
});

test('backup errors -> ONE error message with the existing wording; nothing to apply', async () => {
  const cases = [
    [Object.assign(new Error('q'), { status: 429 }), 429, 'QUOTA MESSAGE'],
    [Object.assign(new Error('t'), { name: 'TimeoutError' }), 503, 'The AI did not answer in time. Your document has not been changed. Please try again.'],
    [Object.assign(new Error('u'), { unreadable: true }), 502, 'The model returned an unreadable answer. Try again.'],
    [new Error('other'), 503, 'The model is busy or not responding right now. Try again in a minute.'],
  ];
  for (const [err, status, error] of cases) {
    const s = await setup({ live: fakeLive({ fail: 'timeout' }), backup: async () => { throw err; } });
    try {
      const c = connect(s.url);
      await c.open;
      c.ws.send(JSON.stringify(START));
      c.ws.send(pcm(4096));
      await sleep(10);
      c.ws.send(JSON.stringify({ type: 'end' }));
      await c.closed;
      assert.deepEqual(c.got, [{ type: 'ready' }, { type: 'error', status, error }]);
    } finally { await s.close(); }
  }
});

test('cancel / the connection lost while speaking -> Live cancelled, no backup, no answer', async () => {
  for (const how of ['cancel', 'close']) {
    const s = await setup();
    try {
      const c = connect(s.url);
      await c.open;
      c.ws.send(JSON.stringify(START));
      c.ws.send(pcm(4096));
      await sleep(20);
      if (how === 'cancel') c.ws.send(JSON.stringify({ type: 'cancel' })); else c.ws.terminate();
      await c.closed;
      await sleep(30);
      assert.equal(s.live.calls.cancelled, 1, how);
      assert.equal(s.live.calls.ended, 0, how);
      assert.equal(s.backupCalls.length, 0, how);
      assert.deepEqual(c.got.map((m) => m.type), ['ready'], how);
    } finally { await s.close(); }
  }
});

test('the connection lost while Live is answering -> nothing is sent later, no backup', async () => {
  const s = await setup({ live: fakeLive({ delayMs: 150 }) });
  try {
    const c = connect(s.url);
    await c.open;
    c.ws.send(JSON.stringify(START));
    c.ws.send(pcm(4096));
    await sleep(10);
    c.ws.send(JSON.stringify({ type: 'end' }));
    await sleep(20);
    c.ws.terminate();
    await sleep(250);
    assert.deepEqual(c.got.map((m) => m.type), ['ready']);
    assert.equal(s.backupCalls.length, 0);
    assert.equal(s.live.calls.cancelled, 1, 'the Live session is closed');
  } finally { await s.close(); }
});

test('wrong order / bad input -> ONE error, Live cancelled or never opened, never a result', async () => {
  const scenarios = [
    ['audio before start', (ws) => { ws.send(pcm(4096)); }, 400, 0],
    ['end before start', (ws) => { ws.send(JSON.stringify({ type: 'end' })); }, 400, 0],
    ['not JSON', (ws) => { ws.send('hello'); }, 400, 0],
    ['unknown template', (ws) => { ws.send(JSON.stringify({ ...START, templateId: 'nope' })); }, 400, 0],
    ['no document', (ws) => { ws.send(JSON.stringify({ ...START, outline: '' })); }, 400, 0],
    ['second start', (ws) => { ws.send(JSON.stringify(START)); ws.send(JSON.stringify(START)); }, 400, 1],
    ['odd-length audio', (ws) => { ws.send(JSON.stringify(START)); ws.send(Buffer.alloc(4095)); }, 400, 1],
    ['too large frame', (ws) => { ws.send(JSON.stringify(START)); ws.send(Buffer.alloc(LIMITS.maxChunkBytes + 2)); }, 400, 1],
    ['audio after end', (ws) => { ws.send(JSON.stringify(START)); ws.send(pcm(4096)); ws.send(JSON.stringify({ type: 'end' })); ws.send(pcm(4096)); }, null, 1],
  ];
  for (const [name, act, status, opened] of scenarios) {
    const s = await setup({ live: fakeLive({ delayMs: 100 }) });
    try {
      const c = connect(s.url);
      await c.open;
      act(c.ws);
      await c.closed;
      const types = c.got.map((m) => m.type);
      if (status) {
        assert.equal(types.filter((t) => t === 'error').length, 1, name);
        assert.equal(c.got.find((m) => m.type === 'error').status, status, name);
        assert.ok(!types.includes('result'), name);
      } else {
        assert.equal(types.filter((t) => t === 'result' || t === 'error').length, 1, `${name}: exactly one answer`);
      }
      assert.equal(s.live.calls.opened, opened, name);
      if (opened && status) assert.equal(s.live.calls.cancelled, 1, `${name}: Live closed`);
      assert.equal(s.backupCalls.length, 0, name);
    } finally { await s.close(); }
  }
});

test('too much audio (over 60 s) -> refused (413), never sent to a model', async () => {
  const s = await setup();
  try {
    const c = connect(s.url);
    await c.open;
    c.ws.send(JSON.stringify(START));
    const frame = pcm(LIMITS.maxChunkBytes);
    for (let n = 0; n <= LIMITS.maxAudioBytes; n += frame.length) c.ws.send(frame);
    await c.closed;
    assert.equal(c.got.at(-1).status, 413);
    assert.equal(s.backupCalls.length, 0);
    assert.equal(s.live.calls.ended, 0);
  } finally { await s.close(); }
});

test('no start message in time / silence without end -> dropped (408), nothing answered', async () => {
  const saved = { ...LIMITS };
  LIMITS.startWithinMs = 80; LIMITS.idleMs = 80;
  try {
    const s = await setup();
    try {
      const a = connect(s.url);
      await a.open;
      assert.equal(await a.closed, 1000);
      assert.deepEqual(a.got, [{ type: 'error', status: 408, error: 'The voice command could not be read. Please try again.' }]);
      const b = connect(s.url);
      await b.open;
      b.ws.send(JSON.stringify(START));
      b.ws.send(pcm(4096));
      await b.closed;
      assert.deepEqual(b.got.map((m) => m.type), ['ready', 'error']);
      assert.equal(s.live.calls.cancelled, 1);
      assert.equal(s.backupCalls.length, 0);
    } finally { await s.close(); }
  } finally { Object.assign(LIMITS, saved); }
});

test('PRIVACY: the route logs only numbers and fixed labels - never the document, transcript, edits or audio', async () => {
  const secret = 'TEST PATIENT DUMMY ONE';
  for (const live of [fakeLive({ answer: { ...GOOD, heard: secret, transcript: secret, summary: secret } }), fakeLive({ fail: secret })]) {
    const s = await setup({ live, backup: async () => ({ edits: [], summary: secret, heard: secret }) });
    try {
      const c = connect(s.url);
      await c.open;
      c.ws.send(JSON.stringify({ ...START, outline: `[B0] (P) "${secret}"` }));
      c.ws.send(pcm(4096));
      c.ws.send(JSON.stringify({ type: 'end' }));
      await c.closed;
      assert.ok(s.logs.length >= 1);
      for (const l of s.logs) {
        assert.doesNotMatch(l, /TEST PATIENT|DUMMY|PROMPT|typhoid/i, l);
        assert.match(l, /^(Voice|Backup) timing: /);
      }
    } finally { await s.close(); }
  }
});

test('WAV for the backup: pcmToWav is exactly the browser\'s WAV format (wavToPcm reads every byte back)', () => {
  for (const n of [2, 4096, 32000 * 3 + 6]) {
    const p = pcm(n, 3);
    const w = pcmToWav(p);
    assert.equal(w.length, 44 + n);
    assert.ok(wavToPcm(w).equals(p));
  }
});

test('the streaming Live session is the SAME session as liveExtract: same settings and the same message handling, word for word', () => {
  const live = fs.readFileSync(new URL('../liveVoice.js', import.meta.url), 'utf8');
  const a = live.indexOf('export async function liveExtract(');
  const b = live.indexOf('export function startLiveStream(');
  assert.ok(a > 0 && b > a);
  const block = (from, start, end) => { const i = live.indexOf(start, from); return live.slice(i, live.indexOf(end, i)).replace(/\s+/g, ' ').trim(); };
  // the Live settings (model, answer type, transcription, manual start/end, prompt + Live wording, the function)
  const cfg = (from) => block(from, 'model: s.model,', 'callbacks:');
  assert.equal(cfg(b), cfg(a));
  assert.match(cfg(b), /realtimeInputConfig: \{ automaticActivityDetection: \{ disabled: true \} \}/);
  assert.match(cfg(b), /systemInstruction: prompt \+ LIVE_SUFFIX,/);
  // the message handling: the call first, audio only ends an attempt without a call, turn complete without a call fails
  const handler = (from) => block(from, 'onmessage: (m) => {', 'onerror:');
  assert.equal(handler(b), handler(a));
  for (const line of ['onerror:', 'onclose:']) assert.equal(block(b, line, '\n'), block(a, line, '\n'), line);
  // the answer is checked by the same all-or-nothing check, after the same short transcript wait
  const stream = live.slice(b);
  assert.match(stream, /const result = checkLiveResult\(call\.args, transcript\);/);
  assert.match(stream, /for \(let i = 0; i < 10 && !transcript\.trim\(\); i\+\+\) await new Promise\(\(r\) => setTimeout\(r, 100\)\);/);
  // the answer is only read in end(): pushing audio never resolves anything
  const pushFn = stream.slice(stream.indexOf('push(buf) {'), stream.indexOf('async end() {'));
  assert.doesNotMatch(pushFn, /settle\.resolve|checkLiveResult/);
  // liveExtract itself is unchanged and still used by the HTTP voice path
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(index, /const result = await liveExtract\(\{ prompt, audioBase64 \}\);/);
});

test('the stream route uses the same prompt and backup request as the HTTP voice path (index.js)', () => {
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  // HTTP voice path (Stage 3.3): the command prompt, buildCommandPrompt({ ..., instruction: typed, hasAudio, ... })
  assert.match(index, /\? buildCommandPrompt\(\{ outline, today, instruction: typed, hasAudio, template, cursorBlock: cleanCursorBlock\(cursorBlock\), recent: cleanRecent\(recent\) \}\)/);
  // stream: the same call for a voice clip on its own (typed = '', hasAudio = true)
  assert.match(index, /return buildCommandPrompt\(\{ outline, today, instruction: '', hasAudio: true, template, cursorBlock: cleanCursorBlock\(cursorBlock\), recent: cleanRecent\(recent\) \}\);/);
  // backup: audio first, then the prompt; the same answer settings as the HTTP path for a command
  assert.match(index, /parts: \[\{ inlineData: \{ mimeType: 'audio\/wav', data: wavBase64 \} \}, \{ text: prompt \}\]/);
  const httpCfg = "config: { responseMimeType: 'application/json', responseSchema: isCommand ? commandSchema(editsSchema) : editsSchema, temperature: 0 },";
  const streamCfg = "config: { responseMimeType: 'application/json', responseSchema: commandSchema(editsSchema), temperature: 0 },";
  assert.ok(index.includes(httpCfg) && index.includes(streamCfg));
  // the same template rule and the scope check (finishCommand) on every answer
  assert.match(index, /template = Object\.hasOwn\(TEMPLATES, templateId\) \? TEMPLATES\[templateId\] : null;\r?\n\s+if \(!template\) throw/);
  const route = fs.readFileSync(new URL('../voiceStream.js', import.meta.url), 'utf8');
  assert.equal((route.match(/finishCommand\(/g) || []).length, 2 + 1, 'Live answer + backup answer (+ the deps line)');
});

// ---------- review fix: socket errors during the handshake never crash the AI service ----------
import net from 'node:net';
import crypto from 'node:crypto';
test('SOCKET ERRORS: clients that reset during the handshake never crash the AI service; normal connections still work', async () => {
  const s = await setup();
  try {
    const port = Number(new URL(s.url).port);
    for (let i = 0; i < 150; i++) {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(`GET ${i % 3 ? STREAM_PATH : '/other'} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: ${i % 5 ? 13 : 99}\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nx-internal-key: ${i % 2 ? 'wrong' : KEY}\r\n\r\n`);
        sock.resetAndDestroy();
      });
      sock.on('error', () => {});
      if (i % 25 === 0) await sleep(5);
    }
    await sleep(300);
    const c = connect(s.url);
    assert.equal(await c.open, true, 'still running');
    c.ws.send(JSON.stringify(START));
    c.ws.send(pcm(4096));
    await sleep(10);
    c.ws.send(JSON.stringify({ type: 'end' }));
    await c.closed;
    assert.deepEqual(c.got.map((m) => m.type), ['ready', 'result']);
  } finally { await s.close(); }
  const src = fs.readFileSync(new URL('../voiceStream.js', import.meta.url), 'utf8');
  const up = src.slice(src.indexOf("server.on('upgrade'"), src.indexOf('function handle('));
  assert.ok(up.indexOf("socket.on('error', onSocketError);") < up.indexOf('const url ='), 'attached before anything else');
  assert.match(up, /wss\.handleUpgrade\(req, socket, head, \(ws\) => \{\r?\n\s+socket\.removeListener\('error', onSocketError\);\r?\n\s+handle\(ws\);/);
});
