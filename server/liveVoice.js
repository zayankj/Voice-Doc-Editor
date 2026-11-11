// Gemini Live for VOICE commands only (test branch). A SEPARATE client: the existing `ai` client in index.js,
// which handles typed instructions and uploads, is not touched.
//
//   Browser -> gateway -> /api/extract-edits (one WAV clip, unchanged) -> HERE:
//     1. the WAV is checked and turned into raw PCM (16-bit, 16 kHz, mono - what Live expects)
//     2. one Live session: the existing prompt as system instruction, ONE function "propose_edits"
//     3. the clip is sent between activityStart / activityEnd (the app already decided where the command ends)
//     4. the answer: the function's arguments (heard, understood, language, edits, summary). Google's own transcript
//        is only the PROOF that speech was heard (it writes English words said in Malayalam speech in Malayalam
//        script, which the browser's checks cannot read; the model writes them in English letters, as on the
//        existing path)
//     5. everything is CHECKED here; anything missing or invalid -> an error, so index.js uses the existing path
//   index.js then runs scopeGuard.js on the result (scope check, English interpretation in summary) and the
//   browser receives { edits, summary, heard }, so all its safety checks still run.
//
// Settings (server/.env):  GEMINI_LIVE_MODEL (empty = Live off), GEMINI_LIVE_API_VERSION (default v1alpha),
//                          GEMINI_LIVE_TIMEOUT_MS (default 20000). The API key is the existing GEMINI_API_KEY.
// Nothing here logs keys, audio, transcripts or document text.

import { GoogleGenAI, Modality, Type } from '@google/genai';

const OPERATIONS = ['set', 'replace_text', 'append', 'clear', 'insert_after'];
const MAX_SECONDS = 60; // the app's clips are at most ~31 s
const MAX_EDITS = 50;
const MAX_TEXT = 10000; // characters per text field

// read lazily, so dotenv has always run first
const settings = () => ({
  model: String(process.env.GEMINI_LIVE_MODEL || '').trim(),
  apiVersion: String(process.env.GEMINI_LIVE_API_VERSION || 'v1alpha').trim(),
  timeoutMs: Number(process.env.GEMINI_LIVE_TIMEOUT_MS) || 20000,
});

export const liveEnabled = () => Boolean(settings().model && process.env.GEMINI_API_KEY);
export const liveDescription = () => {
  const s = settings();
  if (!s.model) return 'Live voice: off (GEMINI_LIVE_MODEL is empty)';
  if (!process.env.GEMINI_API_KEY) return 'Live voice: off (GEMINI_API_KEY is missing)';
  return `Live voice: ${s.model} | Gemini Developer API ${s.apiVersion} | timeout ${s.timeoutMs} ms | NOT India-only: dummy data only`;
};

// An error whose message is a fixed, safe category (never content) - index.js logs only this
class LiveError extends Error {}
const fail = (reason) => { throw new LiveError(reason); };

// ---------- WAV -> raw PCM ----------
// Reads the header instead of assuming it. Accepts ONLY: PCM, 1 channel, 16 000 Hz, 16-bit, 0 < length <= 60 s.
// Anything else -> LiveError (index.js then uses the existing path, which accepts every allowed audio type).
export function wavToPcm(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) fail('audio is not a WAV file');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') fail('audio is not a WAV file');
  let fmt = null;
  let data = null;
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) fail('WAV format block is broken');
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (body + size > buf.length) fail('WAV data is cut off');
      data = buf.subarray(body, body + size);
      break;
    }
    at = body + size + (size % 2); // blocks are padded to an even length
  }
  if (!fmt) fail('WAV has no format block');
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) fail('WAV is not 16-bit 16 kHz mono PCM');
  if (!data || !data.length) fail('WAV has no audio');
  if (data.length % 2) fail('WAV audio length is odd');
  if (data.length / 32000 > MAX_SECONDS) fail('WAV is too long');
  return data;
}

// ---------- checking the function's output ----------
// Returns { edits, summary, heard, understood, language, all_words, transcript } or throws LiveError. ALL-OR-NOTHING: one invalid edit
// rejects the whole answer, so an incomplete or invalid edit can never be applied. Unknown fields are dropped.
// transcript = Google's transcript: only the proof that speech was heard (empty -> refused).
// heard = the model's own transcript (English words in English letters, as on the existing path); if it is
// missing, Google's transcript is used. transcript (Google's) is returned for the scope check in index.js only.
export function checkLiveResult(args, transcript) {
  const proof = String(transcript || '').trim();
  if (!proof) fail('empty transcript');
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('invalid function arguments');
  const { edits, summary, heard, understood, language, all_words: allWords } = args;
  if (!Array.isArray(edits)) fail('invalid function arguments');
  if (edits.length > MAX_EDITS) fail('too many edits');
  const optionalText = (v) => v === undefined || (typeof v === 'string' && v.length <= MAX_TEXT);
  if (!optionalText(summary) || !optionalText(heard) || !optionalText(language)) fail('invalid function arguments');
  if (allWords !== undefined && (typeof allWords !== 'string' || allWords.length > 200)) fail('invalid function arguments');
  if (typeof understood !== 'string' || understood.length > MAX_TEXT) fail('invalid function arguments');
  const text = (v) => typeof v === 'string' && v.length <= MAX_TEXT;
  const clean = edits.map((e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) fail('invalid edit');
    if (typeof e.block_id !== 'string' || !/^B\d{1,6}$/.test(e.block_id)) fail('invalid edit');
    if (!OPERATIONS.includes(e.operation)) fail('invalid edit');
    if (!text(e.field_label) || !e.field_label.trim()) fail('invalid edit');
    for (const k of ['new_value', 'find_text']) if (e[k] !== undefined && !text(e[k])) fail('invalid edit');
    // what each operation needs
    if (['set', 'append', 'insert_after'].includes(e.operation) && typeof e.new_value !== 'string') fail('invalid edit');
    if (e.operation === 'replace_text' && (typeof e.find_text !== 'string' || !e.find_text || typeof e.new_value !== 'string')) fail('invalid edit');
    const out = { block_id: e.block_id, operation: e.operation, field_label: e.field_label };
    if (e.new_value !== undefined) out.new_value = e.new_value;
    if (e.find_text !== undefined) out.find_text = e.find_text;
    return out;
  });
  return {
    edits: clean,
    summary: typeof summary === 'string' ? summary : '',
    heard: (typeof heard === 'string' && heard.trim()) || proof,
    understood: understood.trim(),
    language: typeof language === 'string' ? language.trim() : '',
    all_words: typeof allWords === 'string' ? allWords.trim() : '',
    transcript: proof,
  };
}

// ---------- the function the model calls (same fields as the existing JSON answer) ----------
const proposeEdits = {
  name: 'propose_edits',
  description: 'Return the result for the spoken command. Call it exactly once.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      heard: { type: Type.STRING },
      understood: { type: Type.STRING },
      language: { type: Type.STRING },
      all_words: { type: Type.STRING },
      summary: { type: Type.STRING },
      edits: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            block_id: { type: Type.STRING },
            operation: { type: Type.STRING, enum: OPERATIONS },
            new_value: { type: Type.STRING },
            find_text: { type: Type.STRING },
            field_label: { type: Type.STRING },
          },
          required: ['block_id', 'operation', 'field_label'],
        },
      },
    },
    required: ['heard', 'understood', 'edits', 'summary'],
  },
};

// Added AFTER the existing prompt (the prompt itself is unchanged)
const LIVE_SUFFIX = `

LIVE SESSION: the spoken command arrives as audio in this session. Do not speak. When the person has finished,
call the function propose_edits exactly once, with heard, understood, language, all_words, summary and edits following all the rules above
(an empty edits list when nothing should change or when you ask a question). Never answer in any other way.`;

let client = null;
const liveClient = () => {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: settings().apiVersion } });
  return client;
};

// One voice clip -> { edits, summary, heard, understood, language, all_words, transcript }. Throws LiveError (safe message) on ANY problem.
export async function liveExtract({ prompt, audioBase64 }) {
  const s = settings();
  if (!liveEnabled()) fail('live is off');
  const pcm = wavToPcm(Buffer.from(String(audioBase64 || ''), 'base64'));

  let session = null;
  let connecting = null;
  let timer = null;
  let transcript = '';
  let call = null;
  let settle;
  const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  done.catch(() => {}); // a late rejection must never crash the server (it is still seen by "await done")

  try {
    timer = setTimeout(() => settle.reject(new LiveError('timeout')), s.timeoutMs);
    connecting = liveClient().live.connect({
        model: s.model,
        config: {
          responseModalities: [Modality.AUDIO], // this model does not allow TEXT answers; any audio is ignored
          inputAudioTranscription: {}, // Google's transcript of the speech -> heard
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } }, // we mark start and end ourselves
          systemInstruction: prompt + LIVE_SUFFIX,
          tools: [{ functionDeclarations: [proposeEdits] }],
        },
        callbacks: {
          onmessage: (m) => {
            const t = m.serverContent?.inputTranscription?.text;
            if (t) transcript += t;
            const fc = m.toolCall?.functionCalls?.find((f) => f.name === 'propose_edits');
            if (fc && !call) {
              call = fc;
              settle.resolve();
            }
            if (m.serverContent?.turnComplete && !call) settle.reject(new LiveError('no function call'));
          },
          onerror: () => settle.reject(new LiveError('connection error')),
          onclose: (e) => { if (!call) settle.reject(new LiveError(`closed ${e?.code ?? ''}`.trim())); },
        },
      });
    connecting.catch(() => {}); // same for a connection that fails after the time limit
    session = await Promise.race([connecting, done.then(() => null)]); // a timeout / close while connecting wins
    if (!session) fail('connection failed');

    session.sendRealtimeInput({ activityStart: {} });
    for (let i = 0; i < pcm.length; i += 8192) {
      session.sendRealtimeInput({ audio: { data: pcm.subarray(i, i + 8192).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
    }
    session.sendRealtimeInput({ activityEnd: {} });

    await done;
    // the transcript may arrive just after the call: wait briefly for it
    for (let i = 0; i < 10 && !transcript.trim(); i++) await new Promise((r) => setTimeout(r, 100));
    return checkLiveResult(call.args, transcript);
  } catch (e) {
    throw e instanceof LiveError ? e : new LiveError('connection error');
  } finally {
    clearTimeout(timer);
    try {
      if (call && session) session.sendToolResponse({ functionResponses: [{ id: call.id, name: call.name, response: { ok: true } }] });
    } catch { /* closing anyway */ }
    try { session?.close(); } catch { /* already closed */ }
    // the time limit hit while connecting: close that session as soon as it opens
    if (!session && connecting) connecting.then((s) => { try { s.close(); } catch { /* ignore */ } }).catch(() => {});
  }
}
