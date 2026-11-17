// VOICE STREAMING, stage 2: the gateway WebSocket route (gateway/voiceStream.js). A real HTTP server + real WebSocket
// clients; the AI service is a stand-in WebSocket server (no Gemini call). The real validate() of gateway/index.js and
// real rate-limit counters (shared with a real HTTP rate limiter, as index.js wires them). Dummy data only; nothing is
// written to gateway/logs.  Run:  cd gateway  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { rateLimit, MemoryStore } from 'express-rate-limit';
import { WebSocketServer, WebSocket } from 'ws';
import { attachVoiceStream, STREAM_PATH, UPSTREAM_PATH, LIMITS, voiceStreamingEnabled } from '../voiceStream.js';

const INDEX = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
// the REAL validate() of the HTTP route, taken word for word from index.js
const validate = (() => {
  const from = INDEX.indexOf('const FILE_TYPES');
  const to = INDEX.indexOf('// ---------- forward to the AI service');
  return new Function(`${INDEX.slice(from, to)}\nreturn validate;`)();
})();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const APP_KEY = 'test-app-key';
const INTERNAL = 'test-internal-key';
const ORIGIN = 'http://localhost:5173';
const START = { type: 'start', outline: '[B0] (P) "DISCHARGE SUMMARY"\n[B1] (P) "DIAGNOSIS"', today: '17-11-2026', templateId: '' };
const RESULT = { type: 'result', edits: [{ block_id: 'B1', operation: 'append', new_value: ', TYPHOID', field_label: 'Diagnosis' }], summary: 'Added.', heard: 'add typhoid' };
const pcm = (n, v = 1) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i += 2) b.writeInt16LE(v * ((i / 2) % 50), i); return b; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a stand-in for the AI service's internal route: records everything; answers as told
async function fakeAi(behaviour = {}) {
  const seen = { connections: 0, headers: [], messages: [], audio: [], closed: 0 };
  const server = http.createServer((_q, r) => { r.statusCode = 404; r.end(); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== UPSTREAM_PATH || behaviour.refuse) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      seen.connections++;
      seen.headers.push(req.headers);
      ws.on('close', () => { seen.closed++; });
      ws.on('message', async (d, isBinary) => {
        if (isBinary) { seen.audio.push(Buffer.from(d)); return; }
        const m = JSON.parse(String(d));
        seen.messages.push(m);
        if (m.type === 'start') {
          if (behaviour.closeOnStart) return ws.close(1000);
          ws.send(JSON.stringify({ type: 'ready' }));
          if (behaviour.earlyResult) ws.send(JSON.stringify(RESULT));
        }
        if (m.type === 'end') {
          if (behaviour.silent) return; // never answers
          await sleep(behaviour.delayMs || 0);
          if (behaviour.closeOnEnd) return ws.close(1000);
          ws.send(JSON.stringify(behaviour.answer || { ...RESULT, extra_field: 'not passed on' }));
          ws.close(1000);
        }
      });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); server.close(r); }) };
}

// the gateway: an express app with the real per-IP limiter and the real per-client limiter on an HTTP route, and the
// stream route on the same server - sharing the SAME counter stores, exactly as index.js wires them
async function gateway({ ai, ipLimit = 300, clientLimit = 20, aiUrl } = {}) {
  const audits = [];
  const ipStore = new MemoryStore();
  const clientStore = new MemoryStore();
  const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: ipLimit, store: ipStore, standardHeaders: true, legacyHeaders: false }));
  app.post('/api/extract-edits', (req, res, next) => { req.client = { name: 'testapp' }; next(); },
    rateLimit({ windowMs: 60_000, limit: clientLimit, store: clientStore, keyGenerator: (req) => req.client.name }), (_q, r) => r.json({ ok: true }));
  const server = http.createServer(app);
  attachVoiceStream(server, {
    clients: [{ name: 'testapp', hash: sha(APP_KEY) }], origins: [ORIGIN], aiUrl: aiUrl || ai.url, internalKey: INTERNAL, validate,
    ipStore, ipLimit, clientStore, clientLimit, audit: (e) => audits.push(e),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, url: `ws://127.0.0.1:${port}${STREAM_PATH}`, http: `http://127.0.0.1:${port}`, audits, close: () => new Promise((r) => server.close(r)) };
}

function connect(url, headers = { 'x-api-key': APP_KEY, origin: ORIGIN }) {
  const ws = new WebSocket(url, { headers });
  const got = [];
  let refused = null;
  const closed = new Promise((resolve) => {
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    ws.on('close', (code) => resolve(code));
    ws.on('unexpected-response', (_q, res) => { refused = res.statusCode; resolve(`http ${res.statusCode}`); });
    ws.on('error', () => resolve('error'));
  });
  const open = new Promise((resolve) => { ws.on('open', () => resolve(true)); ws.on('unexpected-response', () => resolve(false)); ws.on('error', () => resolve(false)); });
  return { ws, got, closed, open, refused: () => refused };
}
// one whole command: start, audio, end
async function command(g, chunks = [pcm(4096)]) {
  const c = connect(g.url);
  assert.equal(await c.open, true);
  c.ws.send(JSON.stringify(START));
  for (const ch of chunks) c.ws.send(ch);
  await sleep(20);
  c.ws.send(JSON.stringify({ type: 'end' }));
  await c.closed;
  return c.got;
}

test('off by default; index.js shares the HTTP limiters\' counters with the stream route and attaches it only when switched on', () => {
  const was = process.env.ENABLE_VOICE_STREAMING;
  try {
    for (const v of [undefined, '', 'false', '1', 'yes']) {
      if (v === undefined) delete process.env.ENABLE_VOICE_STREAMING; else process.env.ENABLE_VOICE_STREAMING = v;
      assert.equal(voiceStreamingEnabled(), false, String(v));
    }
    process.env.ENABLE_VOICE_STREAMING = 'true';
    assert.equal(voiceStreamingEnabled(), true);
  } finally { if (was === undefined) delete process.env.ENABLE_VOICE_STREAMING; else process.env.ENABLE_VOICE_STREAMING = was; }
  assert.match(INDEX, /if \(voiceStreamingEnabled\(\)\) \{\r?\n\s+attachVoiceStream\(server, \{/);
  assert.match(INDEX, /limit: IP_LIMIT_PER_MIN,\r?\n\s+store: ipStore,/);
  assert.match(INDEX, /limit: LIMIT_PER_MIN,\r?\n\s+store: clientStore,/);
  assert.match(INDEX, /ipStore, ipLimit: IP_LIMIT_PER_MIN, clientStore, clientLimit: LIMIT_PER_MIN, audit,/);
  assert.match(INDEX, /clients, origins: ORIGINS, aiUrl: AI_URL, internalKey: INTERNAL_KEY, validate,/);
  // the HTTP route and its checks are unchanged
  assert.match(INDEX, /app\.post\('\/api\/extract-edits', express\.json\(\{ limit: '25mb' \}\), extractLimiter, async \(req, res\) => \{/);
  assert.match(INDEX, /app\.use\('\/api', authenticate\);/);
  assert.match(INDEX, /const IP_LIMIT_PER_MIN = 300;/);
});

test('AUTH: no / wrong access key -> 401; a website not allowed -> 403; another path -> 404; the AI service is never contacted', async () => {
  const ai = await fakeAi();
  const g = await gateway({ ai });
  try {
    for (const [headers, code] of [[{ origin: ORIGIN }, 401], [{ 'x-api-key': 'wrong', origin: ORIGIN }, 401], [{ 'x-api-key': `${APP_KEY}x`, origin: ORIGIN }, 401],
      [{ 'x-api-key': APP_KEY, origin: 'http://evil.example' }, 403]]) {
      const c = connect(g.url, headers);
      assert.equal(await c.open, false);
      await c.closed;
      assert.equal(c.refused(), code, JSON.stringify(headers));
    }
    const other = connect(g.url.replace(STREAM_PATH, '/api/other'));
    assert.equal(await other.open, false);
    await other.closed;
    assert.equal(other.refused(), 404);
    // no Origin header (not a browser page): allowed, as the HTTP CORS rule
    const noOrigin = connect(g.url, { 'x-api-key': APP_KEY });
    assert.equal(await noOrigin.open, true);
    noOrigin.ws.close();
    await sleep(30);
    assert.equal(ai.seen.connections, 0, 'nothing reaches the AI service before a start message');
    assert.deepEqual(g.audits.filter((a) => a.status === 401 || a.status === 403).map((a) => a.status), [401, 401, 401, 403]);
  } finally { await g.close(); await ai.close(); }
});

test('HAPPY PATH: checked start fields + the internal key go to the AI service; audio exactly; ONE result with only edits / summary / heard', async () => {
  const ai = await fakeAi();
  const g = await gateway({ ai });
  try {
    const chunks = [pcm(4096, 1), pcm(4096, 2), pcm(512, 3)];
    const c = connect(g.url);
    await c.open;
    c.ws.send(JSON.stringify({ ...START, cursorBlock: 'B1', recent: ['x'], instruction: 'injected', base64: 'AAAA', internalKey: 'nope' }));
    for (const ch of chunks) c.ws.send(ch);
    await sleep(40);
    assert.deepEqual(c.got, [{ type: 'ready' }], 'nothing but ready before the end');
    c.ws.send(JSON.stringify({ type: 'end' }));
    assert.equal(await c.closed, 1000);
    assert.deepEqual(c.got, [{ type: 'ready' }, RESULT], 'one result; unknown fields from the AI service are not passed on');
    // to the AI service: only the checked fields of a voice command (as the HTTP route), then end
    assert.deepEqual(ai.seen.messages, [{ type: 'start', outline: START.outline, today: START.today, templateId: '' }, { type: 'end' }]);
    assert.ok(Buffer.concat(ai.seen.audio).equals(Buffer.concat(chunks)), 'every byte, in order');
    assert.equal(ai.seen.headers[0]['x-internal-key'], INTERNAL, 'the internal key is added by the gateway');
    assert.match(ai.seen.headers[0]['x-request-id'], /^[0-9a-f-]{36}$/);
    assert.equal(ai.seen.headers[0]['x-api-key'], undefined, 'the app key is not passed on');
    // the app never receives a key
    assert.doesNotMatch(JSON.stringify(c.got), new RegExp(`${INTERNAL}|${APP_KEY}`));
    const a = g.audits.at(-1);
    assert.deepEqual(Object.keys(a).sort(), ['approxKB', 'client', 'id', 'input', 'ip', 'method', 'ms', 'path', 'status', 'template']);
    assert.equal(a.status, 200);
    assert.deepEqual(a.input, ['audio-stream']);
  } finally { await g.close(); await ai.close(); }
});

test('VALIDATION: the HTTP route\'s field checks refuse bad start messages (400, its own message); nothing reaches the AI service', async () => {
  const ai = await fakeAi();
  const g = await gateway({ ai });
  try {
    const cases = [
      [{ ...START, outline: '' }, 'The document is missing'],
      [{ ...START, today: '2026-11-17' }, 'The date is not valid'],
      [{ ...START, templateId: '../etc' }, 'The template is not valid'],
      [{ ...START, outline: 5 }, 'The document must be text'],
      [{ ...START, outline: 'x'.repeat(300_001) }, 'The document is too large'],
    ];
    for (const [msg, error] of cases) {
      const c = connect(g.url);
      await c.open;
      c.ws.send(JSON.stringify(msg));
      await c.closed;
      assert.deepEqual(c.got, [{ type: 'error', status: 400, error }], error);
    }
    assert.equal(ai.seen.connections, 0);
  } finally { await g.close(); await ai.close(); }
});

test('INVALID MESSAGES: wrong order or bad audio -> ONE error (400), the AI service connection closed, never a result', async () => {
  const ai = await fakeAi({ delayMs: 100 });
  const g = await gateway({ ai });
  try {
    const cases = [
      ['audio before start', (ws) => ws.send(pcm(4096))],
      ['end before start', (ws) => ws.send(JSON.stringify({ type: 'end' }))],
      ['not JSON', (ws) => ws.send('hello')],
      ['unknown type', (ws) => ws.send(JSON.stringify({ type: 'apply' }))],
      ['second start', (ws) => { ws.send(JSON.stringify(START)); ws.send(JSON.stringify(START)); }],
      ['end without audio', (ws) => { ws.send(JSON.stringify(START)); ws.send(JSON.stringify({ type: 'end' })); }],
      ['odd-length audio', (ws) => { ws.send(JSON.stringify(START)); ws.send(Buffer.alloc(4095)); }],
      ['too large frame', (ws) => { ws.send(JSON.stringify(START)); ws.send(Buffer.alloc(LIMITS.maxChunkBytes + 2)); }],
      ['audio after end', (ws) => { ws.send(JSON.stringify(START)); ws.send(pcm(4096)); ws.send(JSON.stringify({ type: 'end' })); ws.send(pcm(4096)); }],
    ];
    for (const [name, act] of cases) {
      const c = connect(g.url);
      await c.open;
      act(c.ws);
      await c.closed;
      const finals = c.got.filter((m) => m.type !== 'ready');
      assert.equal(finals.length, 1, name);
      assert.deepEqual(finals[0], { type: 'error', status: 400, error: 'The voice command could not be read. Please try again.' }, name);
    }
    await sleep(50);
    assert.equal(ai.seen.closed, ai.seen.connections, 'every AI service connection was closed');
  } finally { await g.close(); await ai.close(); }
});

test('RATE LIMITS: each command counts in the SAME per-client counter as the HTTP route; each connection in the per-IP counter', async () => {
  const ai = await fakeAi();
  const g = await gateway({ ai, clientLimit: 2 });
  try {
    assert.equal((await fetch(`${g.http}/api/extract-edits`, { method: 'POST' })).status, 200); // 1 HTTP request
    assert.equal((await command(g)).at(-1).type, 'result'); // 2: a streamed command
    const third = await command(g); // 3: over the limit
    assert.deepEqual(third, [{ type: 'error', status: 429, error: 'Too many requests in a minute. Please wait a moment and try again.' }]);
    assert.equal((await fetch(`${g.http}/api/extract-edits`, { method: 'POST' })).status, 429, 'the HTTP route sees the streamed commands too');
    assert.equal(ai.seen.connections, 1, 'a refused command never reaches the AI service');
  } finally { await g.close(); await ai.close(); }
  const ai2 = await fakeAi();
  const g2 = await gateway({ ai: ai2, ipLimit: 3 });
  try {
    await fetch(`${g2.http}/api/other`); // 1
    await fetch(`${g2.http}/api/other`); // 2
    const ok = connect(g2.url); // 3
    assert.equal(await ok.open, true);
    ok.ws.close();
    const over = connect(g2.url); // 4
    assert.equal(await over.open, false);
    await over.closed;
    assert.equal(over.refused(), 429);
  } finally { await g2.close(); await ai2.close(); }
});

test('CONNECTIONS: at most 2 open voice connections per app; a closed one frees its place', async () => {
  const ai = await fakeAi();
  const g = await gateway({ ai });
  try {
    const a = connect(g.url); const b = connect(g.url);
    assert.equal(await a.open, true); assert.equal(await b.open, true);
    const c = connect(g.url);
    assert.equal(await c.open, false);
    await c.closed;
    assert.equal(c.refused(), 429);
    a.ws.close();
    await a.closed;
    await sleep(30);
    const d = connect(g.url);
    assert.equal(await d.open, true);
    b.ws.close(); d.ws.close();
  } finally { await g.close(); await ai.close(); }
});

test('LIMITS: over 60 s of audio -> 413; no start in time / silence without end -> 408; no answer after the end in time -> 504', async () => {
  const saved = { ...LIMITS };
  try {
    const ai = await fakeAi({ silent: true });
    const g = await gateway({ ai });
    try {
      // too much audio
      const big = connect(g.url);
      await big.open;
      big.ws.send(JSON.stringify(START));
      const frame = pcm(LIMITS.maxChunkBytes);
      for (let n = 0; n <= LIMITS.maxAudioBytes; n += frame.length) big.ws.send(frame);
      await big.closed;
      assert.deepEqual(big.got.at(-1), { type: 'error', status: 413, error: 'The voice command could not be read. Please try again.' });
      assert.ok(Buffer.concat(ai.seen.audio).length <= LIMITS.maxAudioBytes, 'never more than the limit is passed on');
      LIMITS.startWithinMs = 80; LIMITS.idleMs = 80; LIMITS.answerMs = 120;
      const noStart = connect(g.url);
      await noStart.open;
      await noStart.closed;
      assert.deepEqual(noStart.got, [{ type: 'error', status: 408, error: 'The voice command could not be read. Please try again.' }]);
      const idle = connect(g.url);
      await idle.open;
      idle.ws.send(JSON.stringify(START));
      idle.ws.send(pcm(4096));
      await idle.closed;
      assert.equal(idle.got.at(-1).status, 408);
      const slow = connect(g.url);
      await slow.open;
      slow.ws.send(JSON.stringify(START));
      slow.ws.send(pcm(4096));
      await sleep(20);
      slow.ws.send(JSON.stringify({ type: 'end' }));
      await slow.closed;
      assert.deepEqual(slow.got.at(-1), { type: 'error', status: 504, error: 'The AI service took too long to answer. Please try again.' });
    } finally { await g.close(); await ai.close(); }
  } finally { Object.assign(LIMITS, saved); }
});

test('CANCEL / CONNECTION LOSS: the app cancels or disappears -> the AI service is told (cancel / closed), nothing is answered', async () => {
  for (const how of ['cancel', 'terminate', 'terminate-while-answering']) {
    const ai = await fakeAi({ delayMs: 150 });
    const g = await gateway({ ai });
    try {
      const c = connect(g.url);
      await c.open;
      c.ws.send(JSON.stringify(START));
      c.ws.send(pcm(4096));
      await sleep(40);
      if (how === 'cancel') c.ws.send(JSON.stringify({ type: 'cancel' }));
      else if (how === 'terminate') c.ws.terminate();
      else { c.ws.send(JSON.stringify({ type: 'end' })); await sleep(30); c.ws.terminate(); }
      await c.closed;
      await sleep(250);
      assert.ok(!c.got.some((m) => m.type === 'result'), how);
      assert.equal(ai.seen.closed, 1, `${how}: the AI service connection was closed`);
      if (how === 'cancel') assert.deepEqual(ai.seen.messages.map((m) => m.type), ['start', 'cancel']);
      assert.equal(g.audits.at(-1).status, 499, how);
    } finally { await g.close(); await ai.close(); }
  }
});

test('AI SERVICE PROBLEMS: unreachable / refused / closed without an answer -> 502; its errors are passed on as the HTTP route does', async () => {
  // unreachable (nothing listening)
  const dead = await gateway({ aiUrl: 'http://127.0.0.1:9' });
  try {
    const got = await command(dead);
    assert.deepEqual(got.at(-1), { type: 'error', status: 502, error: 'The AI service is not reachable. Make sure it is running.' });
  } finally { await dead.close(); }
  for (const [behaviour, expected] of [
    [{ refuse: true }, { type: 'error', status: 502, error: 'The AI service is not reachable. Make sure it is running.' }],
    [{ closeOnEnd: true }, { type: 'error', status: 502, error: 'The AI service is not reachable. Make sure it is running.' }],
    [{ answer: { type: 'error', status: 429, error: 'QUOTA TEXT FROM THE AI SERVICE' } }, { type: 'error', status: 429, error: 'QUOTA TEXT FROM THE AI SERVICE' }],
    [{ answer: { type: 'error', status: 503, error: 'busy' } }, { type: 'error', status: 503, error: 'busy' }],
    [{ answer: { type: 'error', status: 500, error: 'x' } }, { type: 'error', status: 502, error: 'x' }],
    [{ answer: { type: 'something' } }, { type: 'error', status: 502, error: 'The AI service returned an error' }],
  ]) {
    const ai = await fakeAi(behaviour);
    const g = await gateway({ ai });
    try {
      const got = await command(g);
      assert.deepEqual(got.at(-1), expected, JSON.stringify(behaviour));
      assert.equal(got.filter((m) => m.type === 'result').length, 0);
    } finally { await g.close(); await ai.close(); }
  }
});

test('NEVER PARTIAL: a result the AI service sends before the end is never passed on (refused, 502)', async () => {
  const ai = await fakeAi({ earlyResult: true });
  const g = await gateway({ ai });
  try {
    const c = connect(g.url);
    await c.open;
    c.ws.send(JSON.stringify(START));
    c.ws.send(pcm(4096));
    await c.closed;
    assert.ok(!c.got.some((m) => m.type === 'result'));
    assert.equal(c.got.at(-1).status, 502);
  } finally { await g.close(); await ai.close(); }
});

test('FALLBACK still there: the HTTP route keeps working next to the stream route', async () => {
  const ai = await fakeAi();
  const g = await gateway({ ai });
  try {
    assert.equal((await fetch(`${g.http}/api/extract-edits`, { method: 'POST' })).status, 200);
    assert.equal((await command(g)).at(-1).type, 'result');
    assert.equal((await fetch(`${g.http}/api/extract-edits`, { method: 'POST' })).status, 200);
  } finally { await g.close(); await ai.close(); }
});

test('PRIVACY: audit lines hold no document, transcript, edits, audio or keys; the route never prints', async () => {
  const secret = 'TEST PATIENT DUMMY ONE';
  const ai = await fakeAi({ answer: { type: 'result', edits: [{ block_id: 'B1', operation: 'set', new_value: secret, field_label: 'Name' }], summary: secret, heard: secret } });
  const g = await gateway({ ai });
  const printed = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => printed.push(a.join(' '));
  try {
    const c = connect(g.url);
    await c.open;
    c.ws.send(JSON.stringify({ ...START, outline: `[B0] (P) "${secret}"` }));
    c.ws.send(pcm(4096));
    await sleep(20);
    c.ws.send(JSON.stringify({ type: 'end' }));
    await c.closed;
    await connect(g.url, { 'x-api-key': 'wrong-key-value' }).closed;
  } finally { Object.assign(console, orig); await g.close(); await ai.close(); }
  const all = JSON.stringify(g.audits) + printed.join('\n');
  // ("discharge-summary" is the template id the HTTP route logs too: a fixed label, not content)
  // (the random request id is hex, so only the document's own markers are looked for: "[B0]", "(P)")
  assert.doesNotMatch(all, /TEST PATIENT|DUMMY|DISCHARGE SUMMARY|typhoid|\[B0\]|\(P\)/i);
  assert.doesNotMatch(all, new RegExp(`${APP_KEY}|${INTERNAL}|wrong-key-value`));
  assert.deepEqual(printed, [], 'the route itself prints nothing');
  const route = fs.readFileSync(new URL('../voiceStream.js', import.meta.url), 'utf8');
  assert.doesNotMatch(route, /console\.(log|warn|error|info)/);
});

test('CANCEL before the end: the AI service is told and closed; 499; nothing answered', async () => {
  const ai = await fakeAi();
  const g = await gateway({ ai });
  try {
    const c = connect(g.url);
    await c.open;
    c.ws.send(JSON.stringify(START));
    c.ws.send(pcm(4096));
    await sleep(40);
    c.ws.send(JSON.stringify({ type: 'cancel' }));
    await c.closed;
    await sleep(60);
    assert.deepEqual(c.got.map((m) => m.type), ['ready']);
    assert.deepEqual(ai.seen.messages.map((m) => m.type), ['start', 'cancel']);
    assert.equal(ai.seen.closed, 1);
    assert.deepEqual(g.audits.map((a) => a.status), [499]);
  } finally { await g.close(); await ai.close(); }
});

test('CANCEL after the end, while the AI is still working: a normal cancellation (499) - the AI connection is closed, no result, no second request', async () => {
  const ai = await fakeAi({ delayMs: 400 });
  const g = await gateway({ ai });
  try {
    const c = connect(g.url);
    await c.open;
    c.ws.send(JSON.stringify(START));
    c.ws.send(pcm(4096));
    await sleep(30);
    c.ws.send(JSON.stringify({ type: 'end' }));
    await sleep(60); // the AI is still working
    c.ws.send(JSON.stringify({ type: 'cancel' }));
    assert.equal(await c.closed, 1000);
    await sleep(600); // longer than the AI's answer would take
    assert.deepEqual(c.got.map((m) => m.type), ['ready'], 'no result and no error after a cancel');
    assert.equal(ai.seen.connections, 1, 'no second request');
    assert.equal(ai.seen.closed, 1, 'the AI service connection was closed (it stops its work)');
    assert.deepEqual(ai.seen.messages.map((m) => m.type), ['start', 'end'], 'nothing new was sent to the AI service');
    assert.deepEqual(g.audits.map((a) => a.status), [499], 'logged as a cancellation, not as a bad request');
  } finally { await g.close(); await ai.close(); }
});

test('CANCEL after the result was delivered: the result stays delivered; the late cancel changes nothing', async () => {
  const ai = await fakeAi();
  const g = await gateway({ ai });
  try {
    const c = connect(g.url);
    await c.open;
    let cancelSent = false;
    c.ws.on('message', (d) => {
      if (JSON.parse(String(d)).type === 'result') {
        try { c.ws.send(JSON.stringify({ type: 'cancel' })); cancelSent = true; } catch { /* already closing */ }
      }
    });
    c.ws.send(JSON.stringify(START));
    c.ws.send(pcm(4096));
    await sleep(20);
    c.ws.send(JSON.stringify({ type: 'end' }));
    await c.closed;
    await sleep(60);
    assert.deepEqual(c.got, [{ type: 'ready' }, RESULT], 'the delivered result is untouched');
    assert.ok(cancelSent);
    assert.deepEqual(g.audits.map((a) => a.status), [200], 'one audit line: delivered (no 499, no 400)');
    assert.equal(ai.seen.connections, 1);
  } finally { await g.close(); await ai.close(); }
});

// ---------- review fixes: rejected handshakes never keep a slot; socket errors never crash the gateway ----------
import net from 'node:net';
const rawHandshake = (port, lines) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${STREAM_PATH} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: ${ORIGIN}\r\nx-api-key: ${APP_KEY}\r\n${lines.join('\r\n')}\r\n\r\n`));
  let got = '';
  s.on('data', (d) => { got += d; if (got.includes('\r\n\r\n')) { resolve(got.split('\r\n')[0]); s.destroy(); } });
  s.on('error', () => resolve('error'));
  setTimeout(() => { resolve(got.split('\r\n')[0] || 'no answer'); s.destroy(); }, 1500);
});
const KEYHDR = () => `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`;

test('REJECTED HANDSHAKES never keep a connection slot (invalid version, missing key header, many in a row); the cap still holds', async () => {
  const ai = await fakeAi();
  const g = await gateway({ ai });
  try {
    assert.match(await rawHandshake(g.port, ['Sec-WebSocket-Version: 99', KEYHDR()]), / 400 /, 'invalid version refused by the ws library');
    assert.match(await rawHandshake(g.port, ['Sec-WebSocket-Version: 13']), / 400 /, 'missing Sec-WebSocket-Key refused');
    for (let i = 0; i < 6; i++) assert.match(await rawHandshake(g.port, ['Sec-WebSocket-Version: 99', KEYHDR()]), / 400 /);
    await sleep(50);
    // all slots are free: 2 normal connections open, the 3rd is refused (the cap itself is unchanged)
    const a = connect(g.url); const b = connect(g.url);
    assert.equal(await a.open, true, 'a normal connection works after rejected handshakes');
    assert.equal(await b.open, true);
    const c = connect(g.url);
    assert.equal(await c.open, false);
    await c.closed;
    assert.equal(c.refused(), 429, 'the connection cap still holds');
    a.ws.close(); await a.closed; await sleep(30);
    const d = connect(g.url);
    assert.equal(await d.open, true, 'a closed connection gives its slot back');
    b.ws.close(); d.ws.close();
    assert.equal(ai.seen.connections, 0, 'no rejected handshake reached the AI service');
  } finally { await g.close(); await ai.close(); }
});

test('SOCKET ERRORS: clients that reset during the handshake never crash the gateway nor keep slots; killed connections release once', async () => {
  const ai = await fakeAi();
  const g = await gateway({ ai });
  try {
    for (let i = 0; i < 200; i++) {
      const s = net.connect(g.port, '127.0.0.1', () => {
        s.write(`GET ${STREAM_PATH} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n${KEYHDR()}\r\nx-api-key: ${i % 2 ? 'wrong' : APP_KEY}\r\n\r\n`);
        s.resetAndDestroy();
      });
      s.on('error', () => {});
      if (i % 25 === 0) await sleep(5);
    }
    await sleep(300);
    // still running, and no slot was kept
    const a = connect(g.url); const b = connect(g.url);
    assert.equal(await a.open, true); assert.equal(await b.open, true);
    // two accepted connections killed abruptly: each slot is given back exactly once (never twice)
    a.ws.terminate(); b.ws.terminate();
    await a.closed; await b.closed; await sleep(50);
    const c = connect(g.url); const d = connect(g.url);
    assert.equal(await c.open, true); assert.equal(await d.open, true);
    const e = connect(g.url);
    assert.equal(await e.open, false, 'still exactly 2: no slot was released twice');
    await e.closed;
    assert.equal(e.refused(), 429);
    c.ws.close(); d.ws.close();
    // the HTTP route still works
    assert.equal((await fetch(`${g.http}/api/extract-edits`, { method: 'POST' })).status, 200);
  } finally { await g.close(); await ai.close(); }
});

test('the socket error handler is attached FIRST in the upgrade handler and removed once the WebSocket is accepted', () => {
  const src = fs.readFileSync(new URL('../voiceStream.js', import.meta.url), 'utf8');
  const up = src.slice(src.indexOf("server.on('upgrade'"), src.indexOf('function handle('));
  assert.ok(up.indexOf("socket.on('error', onSocketError);") < up.indexOf('const url ='), 'attached before anything else');
  assert.match(up, /wss\.handleUpgrade\(req, socket, head, \(ws\) => \{\r?\n\s+accepted = true;\r?\n\s+socket\.removeListener\('error', onSocketError\);/);
  assert.match(up, /socket\.once\('close', \(\) => \{ if \(!accepted\) release\(\); \}\);/);
  assert.match(up, /if \(socket\.destroyed\) return;/);
});
