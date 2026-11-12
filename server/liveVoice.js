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
import { COMMAND_OPERATIONS, STYLES, CASES, LIST_TYPES, SELECT_KINDS, extraEditFields } from './commandPrompt.js';

// Live is only used for spoken COMMANDS, so it has the same operations as typed commands (commandPrompt.js)
const OPERATIONS = COMMAND_OPERATIONS;
const MAX_LINES = 100; // lines in one to_list edit
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
// timing travels as a HIDDEN property: JSON (the API answer) never includes it, and finishCommand builds a new object
const withTiming = (obj, timing) => Object.defineProperty(obj, 'timing', { value: timing, enumerable: false });

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
  // The message says WHICH check failed, as a fixed label (for the timing log; never a value, never sent to the browser)
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('invalid function arguments (not an object)');
  const { edits, summary, heard, understood, language, all_words: allWords } = args;
  if (!Array.isArray(edits)) fail('invalid function arguments (edits not a list)');
  if (edits.length > MAX_EDITS) fail('too many edits');
  const optionalText = (v) => v === undefined || (typeof v === 'string' && v.length <= MAX_TEXT);
  if (!optionalText(summary) || !optionalText(heard) || !optionalText(language)) fail('invalid function arguments (summary, heard or language not text)');
  if (allWords !== undefined && (typeof allWords !== 'string' || allWords.length > 200)) fail('invalid function arguments (all_words not text)');
  if (typeof understood !== 'string' || understood.length > MAX_TEXT) fail('invalid function arguments (understood missing)');
  const text = (v) => typeof v === 'string' && v.length <= MAX_TEXT;
  const clean = edits.map((e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) fail('invalid edit (not an object)');
    if (typeof e.block_id !== 'string' || !/^B\d{1,6}$/.test(e.block_id)) fail('invalid edit (block_id not like B12)');
    if (!OPERATIONS.includes(e.operation)) fail('invalid edit (unknown operation)');
    if (!text(e.field_label) || !e.field_label.trim()) fail('invalid edit (field_label missing)');
    for (const k of ['new_value', 'find_text']) if (e[k] !== undefined && !text(e[k])) fail('invalid edit (new_value or find_text not text)');
    // what each operation needs
    if (['set', 'append', 'insert_after'].includes(e.operation) && typeof e.new_value !== 'string') fail('invalid edit (new_value missing)');
    if (e.operation === 'replace_text' && (typeof e.find_text !== 'string' || !e.find_text || typeof e.new_value !== 'string')) fail('invalid edit (replace_text needs find_text and new_value)');
    // the look-only / list fields: only known values
    if (e.style !== undefined && !STYLES.includes(e.style)) fail('invalid edit (unknown style)');
    if (e.case !== undefined && !CASES.includes(e.case)) fail('invalid edit (unknown case)');
    if (e.list_type !== undefined && !LIST_TYPES.includes(e.list_type)) fail('invalid edit (unknown list_type)');
    if (e.last_block_id !== undefined && (typeof e.last_block_id !== 'string' || !/^B\d{1,6}$/.test(e.last_block_id))) fail('invalid edit (last_block_id not like B12)');
    if (e.duplicate_ok !== undefined && typeof e.duplicate_ok !== 'boolean') fail('invalid edit (duplicate_ok not true/false)');
    if (e.lines !== undefined && (!Array.isArray(e.lines) || e.lines.length > MAX_LINES || !e.lines.every(text))) fail('invalid edit (lines not a valid list)');
    if (e.operation === 'format' && e.style === undefined) fail('invalid edit (format needs style)');
    if (e.operation === 'change_case' && e.case === undefined) fail('invalid edit (change_case needs case)');
    if (e.select !== undefined && (!Array.isArray(e.select) || e.select.length > SELECT_KINDS.length || !e.select.every((k) => SELECT_KINDS.includes(k)))) fail('invalid edit (select not a valid list)');
    if (e.operation === 'to_list' && (e.list_type === undefined || (!e.lines?.length && !e.select?.length))) fail('invalid edit (to_list needs list_type and lines or select)');
    const out = { block_id: e.block_id, operation: e.operation, field_label: e.field_label };
    for (const k of ['new_value', 'find_text', 'style', 'case', 'list_type', 'lines', 'select', 'last_block_id', 'duplicate_ok']) {
      if (e[k] !== undefined) out[k] = e[k];
    }
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
// The descriptions only tell the model WHERE each value goes (the most common reasons a Live answer was refused:
// new text put in `lines` instead of new_value, a block id not like "B12", a question spoken instead of the call).
// Types, allowed values and required fields are exactly as before; checkLiveResult checks everything as before.
const LIST_ONLY = 'ONLY for to_list. Never use it to add new text: a new line goes in new_value with insert_after.';
const FIELD_HELP = {
  style: 'ONLY for format (required there).',
  case: 'ONLY for change_case (required there).',
  list_type: 'ONLY for to_list (required there).',
  lines: `${LIST_ONLY} The exact existing lines of the document to turn into a list.`,
  select: `${LIST_ONLY} The kinds of medicine lines to turn into a list.`,
  last_block_id: 'Only for format / change_case over several blocks: the LAST block, one id like "B20".',
  duplicate_ok: 'true only when adding a new line of a medicine that is already in that section.',
};
const describedExtraFields = Object.fromEntries(Object.entries(extraEditFields(Type))
  .map(([k, v]) => [k, FIELD_HELP[k] ? { ...v, description: FIELD_HELP[k] } : v]));

const proposeEdits = {
  name: 'propose_edits',
  description: 'Return the result for the spoken command. Call it exactly once - also to ask a question (then edits is '
    + 'empty and summary is the question). Never answer by speaking.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      heard: { type: Type.STRING, description: 'The person\'s words, as said.' },
      understood: { type: Type.STRING, description: 'One plain-English sentence: what should be done, or what is unclear.' },
      language: { type: Type.STRING },
      all_words: { type: Type.STRING },
      summary: { type: Type.STRING, description: 'One short sentence: what was changed - or, when asking, the one question ("... Nothing was changed.").' },
      edits: {
        type: Type.ARRAY,
        description: 'The changes. An empty list when asking a question or when nothing should change.',
        items: {
          type: Type.OBJECT,
          properties: {
            block_id: { type: Type.STRING, description: 'Exactly ONE block id from the document, written like "B12": the letter B and digits only (no brackets, spaces, ranges or lists).' },
            operation: { type: Type.STRING, enum: OPERATIONS },
            new_value: { type: Type.STRING, description: 'The text to write. REQUIRED for set, append, insert_after and replace_text (the replacement text). A new line or medicine always goes here, never in lines.' },
            find_text: { type: Type.STRING, description: 'replace_text: the exact existing text to replace (required). insert_after in a block with several lines: the line it goes after. format / change_case: the part to change.' },
            field_label: { type: Type.STRING, description: 'Short name of what is changed, e.g. "Advice" or "Date of Discharge". Never empty.' },
            ...describedExtraFields,
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
(an empty edits list when nothing should change or when you ask a question). Never answer in any other way.

FORMAT OF THE FUNCTION CALL (an answer in any other form cannot be used, and the command has to be processed again):
- block_id: ONE id exactly like B12 (no brackets, spaces, ranges or lists).
- set, append and insert_after: the text to write is ALWAYS in new_value (never in lines). replace_text: find_text AND new_value.
- lines, select and list_type are ONLY for to_list; style ONLY for format; case ONLY for change_case.
- field_label is never empty.
- A question goes in summary with an empty edits list, inside the function call. Never speak a question or an answer.`;

let client = null;
const liveClient = () => {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: settings().apiVersion } });
  return client;
};

// A Live message carrying the model's SPOKEN reply (an audio part). Google's transcript of the person's speech,
// text-only or empty parts, status messages and function calls are not model audio.
export const isModelAudio = (m) => {
  const parts = m?.serverContent?.modelTurn?.parts;
  return Array.isArray(parts) && parts.some((p) => typeof p?.inlineData?.mimeType === 'string'
    && p.inlineData.mimeType.toLowerCase().startsWith('audio/') && Boolean(p.inlineData.data));
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
  // Timing for the server log only (numbers and yes/no; index.js prints it, the browser never receives it)
  const timing = {};
  const t0 = Date.now();
  let sentAt = 0;

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
            if (m.serverContent?.modelTurn && !call) timing.model_audio = true; // noted for the log
            const fc = m.toolCall?.functionCalls?.find((f) => f.name === 'propose_edits');
            if (fc && !call) {
              call = fc;
              settle.resolve();
            }
            // The model is SPEAKING instead of calling the function: give up now, so the existing path starts at once
            // instead of after the spoken reply. Checked AFTER the call above: a call always wins, and once there is
            // a call, audio is ignored. A settled attempt cannot change (a promise settles only once).
            if (!call && isModelAudio(m)) settle.reject(new LiveError('model spoke instead of calling the function'));
            if (m.serverContent?.turnComplete && !call) settle.reject(new LiveError('no function call'));
          },
          onerror: () => settle.reject(new LiveError('connection error')),
          onclose: (e) => { if (!call) settle.reject(new LiveError(`closed ${e?.code ?? ''}`.trim())); },
        },
      });
    connecting.catch(() => {}); // same for a connection that fails after the time limit
    session = await Promise.race([connecting, done.then(() => null)]); // a timeout / close while connecting wins
    if (!session) fail('connection failed');
    timing.connect_ms = Date.now() - t0;

    session.sendRealtimeInput({ activityStart: {} });
    for (let i = 0; i < pcm.length; i += 8192) {
      session.sendRealtimeInput({ audio: { data: pcm.subarray(i, i + 8192).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
    }
    session.sendRealtimeInput({ activityEnd: {} });
    sentAt = Date.now();
    timing.send_ms = sentAt - t0 - timing.connect_ms;

    await done;
    timing.answer_ms = Date.now() - sentAt; // end of the audio -> the function call
    // the transcript may arrive just after the call: wait briefly for it
    const waitFrom = Date.now();
    for (let i = 0; i < 10 && !transcript.trim(); i++) await new Promise((r) => setTimeout(r, 100));
    timing.transcript_wait_ms = Date.now() - waitFrom;
    const checkFrom = Date.now();
    const result = checkLiveResult(call.args, transcript);
    timing.check_ms = Date.now() - checkFrom;
    return withTiming(result, timing);
  } catch (e) {
    if (sentAt && timing.answer_ms === undefined) timing.answer_ms = Date.now() - sentAt; // end of the audio -> the failure
    throw withTiming(e instanceof LiveError ? e : new LiveError('connection error'), timing);
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

// for the tests only: the function the model calls, and the Live-only text (both read-only)
export const liveFunctionDeclaration = () => proposeEdits;
export const liveSuffix = () => LIVE_SUFFIX;
