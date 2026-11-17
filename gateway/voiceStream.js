// VOICE STREAMING - the public WebSocket route of the gateway (only when ENABLE_VOICE_STREAMING=true; off by default).
//   browser (through the app's proxy, which adds the access key) --ws--> /api/voice-stream (HERE)
//     --ws + internal key--> AI service /internal/voice-stream (server/voiceStream.js) --> Gemini Live
// ONE connection = ONE spoken command. Messages from the app:
//   {"type":"start", outline, today, templateId?}   (JSON text, first)   - checked with the existing validate()
//   binary frames: raw 16-bit, 16 kHz, mono PCM while the person speaks
//   {"type":"end"} | {"type":"cancel"}
// Messages to the app: {"type":"ready"}, then ONCE {"type":"result", edits, summary, heard} or
// {"type":"error", status, error}; then the connection is closed.
// The same protection as the HTTP route, before anything is accepted: the access key, the allowed origins, the
// per-IP limit (each connection) and the per-client model-request limit (each command) - both COUNTED IN THE SAME
// STORES as the HTTP routes, so streaming never gives extra requests. Plus: connection, frame, audio-size, start,
// idle, answer-time and cancellation limits. Keys never reach the app; the internal key only goes to the AI service.
// PRIVACY: one audit line per command (who, when, status, time, size) - never audio, transcripts or document text.
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

export const STREAM_PATH = '/api/voice-stream';
export const UPSTREAM_PATH = '/internal/voice-stream';
export const voiceStreamingEnabled = () => String(process.env.ENABLE_VOICE_STREAMING || '').trim().toLowerCase() === 'true';

export const LIMITS = {
  maxStartBytes: 1_300_000, // the start message (the document may be 300 000 characters, escaped in JSON)
  maxChunkBytes: 64 * 1024, // one audio frame (the browser sends 4 KB every 128 ms)
  maxAudioBytes: 60 * 16000 * 2, // 60 s of 16-bit 16 kHz mono (the AI service has the same limit)
  maxConnectionsPerClient: 2, // open voice connections of one app at the same time
  startWithinMs: 10_000, // the start message must arrive this soon after connecting
  idleMs: 15_000, // no audio and no end for this long while speaking -> dropped
  answerMs: 100_000, // after the end: the same wait as the HTTP route (AI_TIMEOUT_MS)
};

const MSG = {
  invalid: 'The voice command could not be read. Please try again.',
  unreachable: 'The AI service is not reachable. Make sure it is running.',
  tooSlow: 'The AI service took too long to answer. Please try again.',
  aiError: 'The AI service returned an error',
  rate: 'Too many requests in a minute. Please wait a moment and try again.',
  rateIp: 'Too many requests. Please slow down.',
};
// error statuses passed on from the AI service as they are (the HTTP route passes 400 / 429 / 503 the same way)
const PASS = new Set([400, 408, 413, 429, 503]);

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const refuseUpgrade = (socket, code, text) => {
  try { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
};

// deps (from index.js): clients [{ name, hash }], origins [..], aiUrl, internalKey, validate(body) (the HTTP route's),
// ipStore + ipLimit (the overall per-IP limiter's store), clientStore + clientLimit (the model-request limiter's
// store), audit(entry) (the gateway's audit log)
export function attachVoiceStream(server, deps) {
  const { clients, origins, aiUrl, internalKey, validate, ipStore, ipLimit, clientStore, clientLimit, audit } = deps;
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxStartBytes });
  const openPerClient = new Map(); // client name -> open voice connections
  const upstreamUrl = `${String(aiUrl).replace(/^http/, 'ws').replace(/\/$/, '')}${UPSTREAM_PATH}`;

  server.on('upgrade', async (req, socket, head) => {
    // a socket error during the handshake (the client reset the connection ...) must never crash the gateway: the
    // socket is closed, which releases everything held for it (below). Removed once the WebSocket is accepted - the
    // ws library handles the socket's errors from then on.
    const onSocketError = () => socket.destroy();
    socket.on('error', onSocketError);
    const url = String(req.url || '').split('?')[0];
    if (url !== STREAM_PATH) { refuseUpgrade(socket, 404, 'Not Found'); return; }
    const ip = req.socket.remoteAddress;
    const started = Date.now();
    const id = crypto.randomUUID();
    const log = (client, status) => audit({ id, client, ip, method: 'WS', path: STREAM_PATH, status, ms: Date.now() - started, input: ['audio-stream'] });
    // 1. allowed website (as the HTTP CORS rule: no Origin = not a browser page; a browser page must be allowed)
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin)) { log(null, 403); refuseUpgrade(socket, 403, 'Forbidden'); return; }
    // 2. the overall per-IP limit (the same counter as every HTTP request)
    try {
      const { totalHits } = await ipStore.increment(ip);
      if (totalHits > ipLimit) { log(null, 429); refuseUpgrade(socket, 429, 'Too Many Requests'); return; }
    } catch { refuseUpgrade(socket, 500, 'Internal Server Error'); return; }
    // 3. the access key (the same check as every /api request)
    const given = sha(req.headers['x-api-key'] || '');
    const client = clients.find((c) => crypto.timingSafeEqual(c.hash, given));
    if (!client) { log(null, 401); refuseUpgrade(socket, 401, 'Unauthorized'); return; }
    // 4. open voice connections of this app: a slot is taken now and given back EXACTLY ONCE - when the accepted
    // connection ends (finish), or when the socket closes without the handshake having been accepted (the ws library
    // refused it: wrong version or key header ...; or the socket failed). A refused handshake never keeps a slot.
    // (the socket may have closed during the await above: then its 'close' has already happened - take nothing)
    if (socket.destroyed) return;
    const open = openPerClient.get(client.name) || 0;
    if (open >= LIMITS.maxConnectionsPerClient) { log(client.name, 429); refuseUpgrade(socket, 429, 'Too Many Requests'); return; }
    openPerClient.set(client.name, open + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      openPerClient.set(client.name, Math.max(0, (openPerClient.get(client.name) || 1) - 1));
    };
    let accepted = false;
    socket.once('close', () => { if (!accepted) release(); });
    wss.handleUpgrade(req, socket, head, (ws) => {
      accepted = true;
      socket.removeListener('error', onSocketError);
      handle(ws, { id, ip, client, release });
    });
  });

  function handle(ws, { id, ip, client, release }) {
    let state = 'waiting'; // waiting -> streaming -> answering -> closed
    let upstream = null;
    let upstreamOpen = false;
    const pending = []; // messages for the AI service while its connection is opening
    let audioBytes = 0;
    let templateId = '';
    let timer = null;

    const toApp = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
    const toAi = (data, isBinary) => {
      if (!upstream) return;
      if (upstreamOpen) upstream.send(data, { binary: isBinary });
      else pending.push([data, isBinary]);
    };
    const setTimer = (ms, status, error) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(status, { type: 'error', status, error }), ms);
    };
    // ends the command ONCE: the final message (or none), both connections closed, one audit line
    function finish(status, final) {
      if (state === 'closed') return;
      state = 'closed';
      clearTimeout(timer);
      if (final) toApp(final);
      try { ws.close(1000); } catch { /* gone */ }
      try { upstream?.close(1000); } catch { /* gone */ }
      if (upstream && !upstreamOpen) try { upstream.terminate(); } catch { /* gone */ }
      release();
      audit({ id, client: client.name, ip, method: 'WS', path: STREAM_PATH, status, ms: Date.now() - startedAt,
        input: ['audio-stream'], template: templateId || 'discharge-summary', approxKB: Math.round(audioBytes / 1024) });
    }
    const startedAt = Date.now();
    const bad = () => finish(400, { type: 'error', status: 400, error: MSG.invalid });
    setTimer(LIMITS.startWithinMs, 408, MSG.invalid);

    ws.on('close', () => {
      if (state === 'closed') return;
      // the app went away (page closed, network lost, cancelled): the AI service is told by closing its connection
      finish(499, null);
    });
    ws.on('error', () => { /* 'close' follows */ });

    // messages are handled strictly ONE AFTER ANOTHER, in the order they arrived: the start check (async counter) is
    // finished before the first audio frame is looked at
    let queue = Promise.resolve();
    ws.on('message', (data, isBinary) => {
      queue = queue.then(() => onMessage(data, isBinary)).catch(() => finish(500, { type: 'error', status: 500, error: MSG.invalid }));
    });

    async function onMessage(data, isBinary) {
      if (state === 'closed') return;
      if (isBinary) {
        if (state !== 'streaming') return bad();
        if (data.length > LIMITS.maxChunkBytes || data.length % 2) return bad();
        audioBytes += data.length;
        if (audioBytes > LIMITS.maxAudioBytes) return finish(413, { type: 'error', status: 413, error: MSG.invalid });
        setTimer(LIMITS.idleMs, 408, MSG.invalid);
        return toAi(data, true);
      }
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return bad(); }
      if (!msg || typeof msg !== 'object') return bad();
      if (msg.type === 'start' && state === 'waiting') return onStart(msg);
      if (msg.type === 'end' && state === 'streaming') {
        if (!audioBytes) return bad();
        state = 'answering';
        setTimer(LIMITS.answerMs, 504, MSG.tooSlow);
        return toAi(JSON.stringify({ type: 'end' }), false);
      }
      if (msg.type === 'cancel' && (state === 'waiting' || state === 'streaming')) {
        toAi(JSON.stringify({ type: 'cancel' }), false);
        return finish(499, null);
      }
      // a cancel AFTER "end", while the AI is still working (e.g. the document changed while it was spoken): a normal
      // cancellation. Closing the AI service connection stops its Live session and any backup (nothing new is started);
      // nothing is answered. (After a result was delivered the connection is closed and this is never reached.)
      if (msg.type === 'cancel' && state === 'answering') return finish(499, null);
      return bad();
    }

    async function onStart(msg) {
      // the same field checks as the HTTP route; only the fields of a voice command are passed on
      let clean;
      try {
        clean = validate({ outline: msg.outline, today: msg.today, templateId: msg.templateId, instruction: '', audioBase64: 'stream', audioMimeType: 'audio/wav' });
      } catch (e) {
        return finish(400, { type: 'error', status: 400, error: e?.message || MSG.invalid });
      }
      templateId = clean.templateId;
      // a spoken command is a model request: the same per-client counter as the HTTP route
      try {
        const { totalHits } = await clientStore.increment(client.name);
        if (state === 'closed') return;
        if (totalHits > clientLimit) return finish(429, { type: 'error', status: 429, error: MSG.rate });
      } catch {
        return finish(500, { type: 'error', status: 500, error: MSG.unreachable });
      }
      state = 'streaming';
      setTimer(LIMITS.idleMs, 408, MSG.invalid);
      upstream = new WebSocket(upstreamUrl, { headers: { 'x-internal-key': internalKey, 'x-request-id': id }, maxPayload: 2_000_000 });
      upstream.on('open', () => {
        upstreamOpen = true;
        for (const [d, b] of pending.splice(0)) upstream.send(d, { binary: b });
      });
      upstream.on('message', (d, isBinary) => {
        if (state === 'closed' || isBinary) return;
        let m;
        try { m = JSON.parse(String(d)); } catch { return finish(502, { type: 'error', status: 502, error: MSG.aiError }); }
        if (m?.type === 'ready') return toApp({ type: 'ready' });
        // only after "end": a result can never arrive while the person is still speaking
        if (m?.type === 'result' && state === 'answering') {
          return finish(200, { type: 'result', edits: Array.isArray(m.edits) ? m.edits : [], summary: m.summary || '', heard: m.heard || '' });
        }
        if (m?.type === 'error') {
          const status = PASS.has(m.status) ? m.status : 502;
          return finish(status, { type: 'error', status, error: typeof m.error === 'string' && m.error ? m.error : MSG.aiError });
        }
        return finish(502, { type: 'error', status: 502, error: MSG.aiError });
      });
      upstream.on('unexpected-response', () => finish(502, { type: 'error', status: 502, error: MSG.unreachable }));
      upstream.on('error', () => finish(502, { type: 'error', status: 502, error: MSG.unreachable }));
      upstream.on('close', () => finish(502, { type: 'error', status: 502, error: MSG.unreachable })); // closed without an answer
      // only the checked fields of the start message go on (the internal key is added here, never by the app)
      toAi(JSON.stringify({ type: 'start', outline: clean.outline, today: clean.today, templateId: clean.templateId }), false);
    }
  }

  return wss;
}
