// VOICE STREAMING (only when the app was built with ENABLE_VOICE_STREAMING=true; off by default).
// One spoken command = one WebSocket to the gateway (/api/voice-stream - through the app's proxy, which adds the access
// key; the browser never has a key). The audio is sent WHILE the person speaks, so the AI can answer sooner after the
// pause. Nothing else changes:
//   - the microphone, the pause detection (1.5 s), the tail and the cutting into commands are lib/vad.js, unchanged:
//     this file only receives what vad.js reports
//   - the model hears EXACTLY the clip the existing path would send: quiet chunks are held back until the person
//     speaks again, and at the end only as many as vad.js keeps (its tail) are sent - checked by count; any mismatch
//     drops the stream and the existing HTTP path is used with the clip
//   - the answer is the same { edits, summary, heard } as the HTTP path, read only after "end", once; App.jsx puts it
//     through exactly the same checks (medicine, duplicate, scope, sections ...) before anything is applied
//   - any problem of the stream itself (connection, refused, a mismatch) -> fallback: the existing HTTP voice path with
//     the same clip. Answers of the AI itself (busy, quota, too slow) are shown as on the HTTP path (no second request)
// Nothing here logs or stores content.
import { REQUEST_TIMEOUT_MS, TIMEOUT_MESSAGE, RequestError } from './requestGuard';

export const STREAM_URL_PATH = '/api/voice-stream';
/* global __VOICE_STREAMING__ */
// set at build time by vite.config.js from ENABLE_VOICE_STREAMING (anything but "true" = off)
export const streamingOn = () => typeof __VOICE_STREAMING__ !== 'undefined' && __VOICE_STREAMING__ === true;

// answers of the AI itself: shown like on the HTTP path, never asked a second time
const NO_FALLBACK = new Set([429, 503, 504]);
// the gateway confirms a command with {"type":"ready"} within milliseconds; a connection that is not confirmed this
// soon (stuck while connecting, or open but silent) is closed and the existing HTTP path is used with the clip.
// (The time the AI takes to ANSWER is not limited by this: that is timeoutMs, the same 105 s as the HTTP path.)
export const READY_TIMEOUT_MS = 5000;

// A problem of the stream: fallback = true -> use the existing HTTP path with the clip
export class StreamError extends Error {
  constructor(message, { fallback = true, status = null } = {}) {
    super(message);
    this.name = 'StreamError';
    this.fallback = fallback;
    this.status = status;
  }
}

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export function streamUrl(loc = globalThis.location) {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${STREAM_URL_PATH}`;
}

// start = { outline, today, templateId, ... } (the same fields as the HTTP request); startChunks = the chunks the
// command starts with (vad.js onSpeechStart). Returns the handle App.jsx uses.
export function createVoiceStream({ start, startChunks = [], url = streamUrl(), WebSocketImpl = globalThis.WebSocket, timeoutMs = REQUEST_TIMEOUT_MS, readyMs = READY_TIMEOUT_MS }) {
  let ws;
  let open = false;
  let ready = false; // the gateway confirmed the command
  let readyTimer = null;
  let ended = false; // "end" was sent
  let over = false; // answered, failed or cancelled: nothing more happens
  let sent = 0; // chunks of the clip sent (or queued to be sent) so far
  let held = []; // quiet chunks after the last loud one (sent only if the person speaks again, or as the tail)
  const out = []; // frames waiting for the connection to open
  let settle;
  const answer = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  answer.catch(() => {});
  let timer = null;

  const fail = (err) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    clearTimeout(readyTimer);
    settle.reject(err);
    try { ws?.close(); } catch { /* gone */ }
  };
  const send = (frame) => {
    if (over) return;
    if (open) ws.send(frame);
    else out.push(frame);
  };
  const sendChunk = (b64) => { send(b64ToBytes(b64)); sent++; };

  try {
    ws = new WebSocketImpl(url);
    ws.binaryType = 'arraybuffer';
  } catch {
    fail(new StreamError('could not connect'));
  }
  if (ws && !over) {
    // not confirmed in time: closed (the gateway then stops the command) and the HTTP path is used; anything that
    // arrives later on this connection is ignored (over), so only one answer can ever be used
    readyTimer = setTimeout(() => { if (!ready) fail(new StreamError('not ready in time')); }, readyMs);
    ws.onopen = () => {
      if (over) return;
      open = true;
      ws.send(JSON.stringify({ type: 'start', ...start }));
      for (const f of out.splice(0)) ws.send(f);
    };
    ws.onmessage = (ev) => {
      if (over) return;
      let m;
      try { m = JSON.parse(String(ev.data)); } catch { return fail(new StreamError('unreadable message')); }
      if (m?.type === 'ready') { ready = true; clearTimeout(readyTimer); return; }
      if (m?.type === 'result') {
        // only after the end; never a partial answer
        if (!ended) return fail(new StreamError('answer before the end'));
        over = true;
        clearTimeout(timer);
        clearTimeout(readyTimer);
        settle.resolve({ edits: Array.isArray(m.edits) ? m.edits : [], summary: m.summary || '', heard: m.heard || '' });
        try { ws.close(); } catch { /* gone */ }
        return;
      }
      if (m?.type === 'error') {
        const status = Number(m.status) || null;
        return fail(new StreamError(typeof m.error === 'string' && m.error ? m.error : 'The AI service returned an error', { fallback: !NO_FALLBACK.has(status), status }));
      }
      return fail(new StreamError('unknown message'));
    };
    ws.onerror = () => fail(new StreamError('connection error'));
    ws.onclose = () => fail(new StreamError('connection closed'));
  }
  for (const c of startChunks) sendChunk(c); // the start of the clip is always kept by vad.js

  return {
    // a chunk added to the command (vad.js onSegmentChunk)
    push(b64, loud) {
      if (over || ended) return;
      if (loud) {
        for (const c of held) sendChunk(c);
        held = [];
        sendChunk(b64);
      } else {
        held.push(b64);
      }
    },
    // the command ended (vad.js onSegmentEnd): send exactly the clip's remaining chunks (its tail), then "end"
    finish(kept) {
      if (over || ended) return;
      const need = kept - sent;
      if (need < 0 || need > held.length) { fail(new StreamError('audio mismatch')); return; } // never a different clip
      for (const c of held.slice(0, need)) sendChunk(c);
      held = [];
      ended = true;
      send(JSON.stringify({ type: 'end' }));
    },
    // the command is dropped (too short, the document changed, cancelled): nothing will be answered
    cancel() {
      if (over) return;
      if (open) try { ws.send(JSON.stringify({ type: 'cancel' })); } catch { /* gone */ }
      fail(new StreamError('cancelled', { fallback: false }));
    },
    // the answer: { edits, summary, heard }, or a StreamError (fallback says whether the HTTP path should be used),
    // or a RequestError (timeout / cancelled) exactly like the HTTP path
    result({ signal = null } = {}) {
      if (!ended && !over) fail(new StreamError('not ended'));
      if (signal?.aborted) {
        this.cancel();
        return Promise.reject(new RequestError('cancelled', 'Cancelled. Your document has not been changed.'));
      }
      return new Promise((resolve, reject) => {
        const onAbort = () => { this.cancel(); reject(new RequestError('cancelled', 'Cancelled. Your document has not been changed.')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        clearTimeout(timer);
        if (!over) timer = setTimeout(() => fail(new RequestError('timeout', TIMEOUT_MESSAGE)), timeoutMs);
        answer.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
      });
    },
    get chunksSent() { return sent; },
  };
}
