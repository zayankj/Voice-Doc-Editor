// R2 (replaces the Stage 3.2 tests; no gateway code change): NO statement metadata. A plain edit (no intent / section /
// medicine / changes / source_words) reaches the browser exactly as the AI service sent it - nothing is required and
// nothing is added - on the WebSocket stream (real gateway route, stand-in AI service) and on the HTTP route (the
// answer line is pinned). Top-level extras are still not passed on; the request checks accept no statement fields.
// Auth, origin and limits are the existing ones (voiceStream.test.mjs). Dummy data only.
// Run:  cd gateway  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { MemoryStore } from 'express-rate-limit';
import { WebSocketServer, WebSocket } from 'ws';
import { attachVoiceStream, STREAM_PATH, UPSTREAM_PATH } from '../voiceStream.js';

const INDEX = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const validate = (() => {
  const from = INDEX.indexOf('const FILE_TYPES');
  const to = INDEX.indexOf('// ---------- forward to the AI service');
  return new Function(`${INDEX.slice(from, to)}\nreturn validate;`)();
})();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const APP_KEY = 'test-app-key';
const ORIGIN = 'http://localhost:5173';
const START = { type: 'start', outline: '[B0] (P) "ADVICE"\n[B1] (P) "Tab. PAN 40 mg — Once Daily"', today: '18-11-2026', templateId: '' };
const EDIT = { block_id: 'B1', operation: 'replace_text', find_text: '40 mg', new_value: '20 mg', field_label: 'Advice' };
const OLD = ['intent', 'section', 'medicine', 'changes', 'source_words'];

async function fakeAi(answer) {
  const server = http.createServer((_q, r) => { r.statusCode = 404; r.end(); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== UPSTREAM_PATH) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (d, isBinary) => {
        if (isBinary) return;
        const m = JSON.parse(String(d));
        if (m.type === 'start') ws.send(JSON.stringify({ type: 'ready' }));
        if (m.type === 'end') { ws.send(JSON.stringify(answer)); ws.close(1000); }
      });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); server.close(r); }) };
}
async function gateway(ai) {
  const server = http.createServer(express());
  attachVoiceStream(server, {
    clients: [{ name: 'testapp', hash: sha(APP_KEY) }], origins: [ORIGIN], aiUrl: ai.url, internalKey: 'test-internal-key', validate,
    ipStore: new MemoryStore(), ipLimit: 300, clientStore: new MemoryStore(), clientLimit: 20, audit: () => {},
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `ws://127.0.0.1:${server.address().port}${STREAM_PATH}`, close: () => new Promise((r) => server.close(r)) };
}

test('R2 stream: a plain edit (no statement) reaches the browser exactly as sent; nothing added; top-level extras dropped', async () => {
  const ai = await fakeAi({ type: 'result', edits: [EDIT], summary: 'Changed.', heard: 'change pan to 20 mg', understood: 'not passed on', intent: 'not passed on' });
  const g = await gateway(ai);
  try {
    const ws = new WebSocket(g.url, { headers: { 'x-api-key': APP_KEY, origin: ORIGIN } });
    const got = [];
    const closed = new Promise((r) => { ws.on('message', (d) => got.push(JSON.parse(String(d)))); ws.on('close', r); });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify(START));
    ws.send(Buffer.alloc(4096));
    await new Promise((r) => setTimeout(r, 20));
    ws.send(JSON.stringify({ type: 'end' }));
    await closed;
    const result = got.find((m) => m.type === 'result');
    assert.ok(result, JSON.stringify(got));
    assert.deepEqual(result.edits, [EDIT], 'the plain edit, exactly - no statement required');
    for (const k of OLD) assert.equal(result.edits[0][k], undefined, `nothing added: ${k}`);
    assert.deepEqual(Object.keys(result).sort(), ['edits', 'heard', 'summary', 'type'], 'top-level fields: unchanged');
  } finally { await g.close(); await ai.close(); }
});

test('R2 HTTP: the answer line passes the edits list as it is and only edits / summary / heard; requests accept no statement fields', () => {
  assert.match(INDEX, /return res\.json\(\{ edits: data\.edits \|\| \[\], summary: data\.summary \|\| '', heard: data\.heard \|\| '' \}\);/);
  // no new request field: the request checks are unchanged (validate() keeps only the known fields)
  const v = validate({ outline: '[B0] (P) "x"', today: '18-11-2026', instruction: 'change pan to 20 mg', intent: 'remove_medicine', source_words: 'x' });
  assert.equal(v.intent, undefined);
  for (const k of OLD) assert.equal(v[k], undefined, k);
});
