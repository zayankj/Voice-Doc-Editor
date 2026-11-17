// VOICE STREAMING - internal route (only when ENABLE_VOICE_STREAMING=true; off by default).
// The gateway opens ONE WebSocket per spoken command to ws://127.0.0.1:<port>/internal/voice-stream with the internal
// key (the browser never reaches this service). Messages:
//   gateway -> here : {"type":"start", outline, today, templateId?, cursorBlock?, recent?}   (JSON text, first)
//                     binary frames: raw 16-bit, 16 kHz, mono PCM, while the person speaks
//                     {"type":"end"}     the browser's pause detection ended the command (1.5 s, unchanged)
//                     {"type":"cancel"}  the command is dropped (too short, the person stopped, the page closed)
//   here -> gateway : {"type":"ready"}   the command was accepted (Live is being opened)
//                     {"type":"result", edits, summary, heard}  - ONCE, only after "end", fully checked
//                     {"type":"error", status, error}           - ONCE, nothing to apply
// then this side closes the connection. Exactly the existing request is answered: the same prompt as the HTTP voice
// path, Live with the same settings and all-or-nothing checks, the scope check (finishCommand), and on any Live
// problem the existing backup path with the same clip as a WAV. Nothing is ever answered before "end".
// PRIVACY: logs hold only numbers and fixed labels (timingLog.js) - never audio, transcripts or document text.
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { startLiveStream as realStartLiveStream, pcmToWav } from './liveVoice.js';
import { timingLine } from './timingLog.js';

export const STREAM_PATH = '/internal/voice-stream';
export const voiceStreamingEnabled = () => String(process.env.ENABLE_VOICE_STREAMING || '').trim().toLowerCase() === 'true';

export const LIMITS = {
  maxStartBytes: 1_200_000, // the start message: the document outline (the gateway allows 300 000 characters)
  maxChunkBytes: 64 * 1024, // one audio frame (the browser sends 4 KB every 128 ms)
  maxAudioBytes: 60 * 16000 * 2, // 60 s of 16-bit 16 kHz mono (the same limit as Live; the browser cuts at 30 s)
  startWithinMs: 10_000, // the start message must arrive this soon after connecting
  idleMs: 15_000, // no audio and no end for this long while speaking -> dropped
};

const ERRORS = {
  busy: 'The model is busy or not responding right now. Try again in a minute.',
  timeout: 'The AI did not answer in time. Your document has not been changed. Please try again.',
  unreadable: 'The model returned an unreadable answer. Try again.',
  invalid: 'The voice command could not be read. Please try again.',
};

// deps (from index.js): internalKey, makePrompt(start) -> prompt (throws { status, message } for a bad request),
// backup({ prompt, wavBase64, deadline, signal }) -> parsed JSON answer of the existing path,
// finishCommand(data, { outline, said }), quotaMessage(), totalBudgetMs. startLiveStream is replaceable for tests.
export function attachVoiceStream(server, deps) {
  const { internalKey, makePrompt, backup, finishCommand, quotaMessage, totalBudgetMs, startLiveStream = realStartLiveStream, log = console.log } = deps;
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxStartBytes });

  server.on('upgrade', (req, socket, head) => {
    // a socket error during the handshake must never crash the AI service: the socket is closed (nothing else is held
    // for it yet). Removed once the WebSocket is accepted - the ws library handles the socket's errors from then on.
    const onSocketError = () => socket.destroy();
    socket.on('error', onSocketError);
    const url = String(req.url || '').split('?')[0];
    if (url !== STREAM_PATH) { socket.destroy(); return; }
    // the internal key, exactly as for every HTTP request of this service
    const given = Buffer.from(String(req.headers['x-internal-key'] || ''));
    const expected = Buffer.from(String(internalKey || ''));
    if (!expected.length || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      socket.removeListener('error', onSocketError);
      handle(ws);
    });
  });

  function handle(ws) {
    let state = 'waiting'; // waiting -> streaming -> answering -> closed
    let start = null;
    let live = null;
    let liveFailed = null; // the reason Live could not be used (a fixed label)
    let prompt = '';
    let audio = []; // only used when Live could not be opened at all
    let audioBytes = 0;
    const gone = new AbortController(); // the gateway / browser went away: stop, answer nothing
    let idle = null;
    const t0 = Date.now();

    const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
    const closeWith = (obj) => {
      if (state === 'closed') return;
      state = 'closed';
      clearTimeout(idle);
      clearTimeout(startTimer);
      if (obj) send(obj);
      try { ws.close(1000); } catch { /* already closed */ }
    };
    const refuse = (status, error) => { live?.cancel(); closeWith({ type: 'error', status, error }); };
    const keepAlive = () => {
      clearTimeout(idle);
      idle = setTimeout(() => refuse(408, ERRORS.invalid), LIMITS.idleMs);
    };
    const startTimer = setTimeout(() => { if (state === 'waiting') refuse(408, ERRORS.invalid); }, LIMITS.startWithinMs);

    ws.on('close', () => {
      if (state === 'closed') return;
      state = 'closed';
      clearTimeout(idle);
      clearTimeout(startTimer);
      gone.abort();
      live?.cancel();
    });
    ws.on('error', () => { /* 'close' follows */ });

    ws.on('message', (data, isBinary) => {
      if (state === 'closed') return;
      if (isBinary) {
        if (state !== 'streaming') return refuse(400, ERRORS.invalid); // audio before start, or after end
        if (data.length > LIMITS.maxChunkBytes || data.length % 2) return refuse(400, ERRORS.invalid);
        audioBytes += data.length;
        if (audioBytes > LIMITS.maxAudioBytes) return refuse(413, ERRORS.invalid);
        keepAlive();
        if (live) live.push(Buffer.from(data));
        else audio.push(Buffer.from(data));
        return;
      }
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return refuse(400, ERRORS.invalid); }
      if (!msg || typeof msg !== 'object') return refuse(400, ERRORS.invalid);
      if (msg.type === 'start' && state === 'waiting') return onStart(msg);
      if (msg.type === 'end' && state === 'streaming') return onEnd();
      if (msg.type === 'cancel' && (state === 'waiting' || state === 'streaming')) {
        live?.cancel();
        return closeWith(null);
      }
      return refuse(400, ERRORS.invalid); // anything else: a second start, end before start, unknown type
    });

    function onStart(msg) {
      clearTimeout(startTimer);
      start = {
        outline: typeof msg.outline === 'string' ? msg.outline : '',
        today: typeof msg.today === 'string' ? msg.today : '',
        templateId: typeof msg.templateId === 'string' ? msg.templateId : '',
        cursorBlock: msg.cursorBlock,
        recent: msg.recent,
      };
      try {
        prompt = makePrompt(start); // the same prompt as the HTTP voice path (and the same request checks)
      } catch (e) {
        return refuse(e?.status || 400, e?.message || ERRORS.invalid);
      }
      try {
        live = startLiveStream({ prompt });
      } catch (e) {
        live = null; // Live is off or could not start: the audio is collected for the existing path
        liveFailed = e?.message || 'connection failed';
      }
      state = 'streaming';
      keepAlive();
      send({ type: 'ready' });
    }

    async function onEnd() {
      state = 'answering';
      clearTimeout(idle);
      const endAt = Date.now();
      // 1. Live (all-or-nothing checks inside)
      if (live) {
        try {
          const result = await live.end();
          if (state === 'closed') return;
          log(timingLine('Voice timing', { stream: true, live: 'ok', ...result.timing, model_audio: Boolean(result.timing?.model_audio), speech_ms: endAt - t0, after_speech_ms: Date.now() - endAt, edits: result.edits.length }));
          return closeWith({ type: 'result', ...finishCommand(result, { outline: start.outline, said: [result.transcript] }) });
        } catch (e) {
          if (state === 'closed') return;
          liveFailed = e?.message || 'connection error';
          log(timingLine('Voice timing', { stream: true, live: 'failed', reason: liveFailed, ...e?.timing, model_audio: Boolean(e?.timing?.model_audio), backup: true }));
        }
      }
      // 2. the existing path, with exactly the spoken audio as a WAV
      const pcm = live ? live.audio() : Buffer.concat(audio);
      audio = [];
      if (!pcm.length) return refuse(400, ERRORS.invalid);
      const backupFrom = Date.now();
      try {
        const data = await backup({ prompt, wavBase64: pcmToWav(pcm).toString('base64'), deadline: endAt + totalBudgetMs, signal: gone.signal });
        if (state === 'closed') return;
        log(timingLine('Backup timing', { stream: true, backup: 'done', live_tried: Boolean(live), backup_ms: Date.now() - backupFrom, after_speech_ms: Date.now() - endAt }));
        return closeWith({ type: 'result', ...finishCommand(data, { outline: start.outline, said: [''] }) });
      } catch (e) {
        if (state === 'closed' || e?.cancelled) return;
        if (e?.status === 429) return refuse(429, quotaMessage());
        if (e?.unreadable) return refuse(502, ERRORS.unreadable);
        if (e?.name === 'TimeoutError') return refuse(503, ERRORS.timeout);
        return refuse(503, ERRORS.busy);
      }
    }
  }

  return wss;
}
