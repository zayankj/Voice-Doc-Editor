// Offline tests for server/liveVoice.js (no network, no API key needed). Dummy data only.
// Run:  cd server  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { wavToPcm, checkLiveResult, liveEnabled, liveDescription, isModelAudio } from '../liveVoice.js';
import { pcmChunksToWav } from '../../client/src/lib/wav.js'; // the browser's own WAV writer = the real format

// 0.5 s of dummy 16-bit samples, as base64 chunks like the microphone sends them
const samples = Buffer.alloc(16000);
for (let i = 0; i < samples.length; i += 2) samples.writeInt16LE(((i * 37) % 2000) - 1000, i);
const chunks = [samples.subarray(0, 6000), samples.subarray(6000)].map((b) => b.toString('base64'));
const realWav = () => Buffer.from(pcmChunksToWav(chunks).base64, 'base64');
const throwsLive = (fn, re) => assert.throws(fn, (e) => re.test(e.message));

// ---------- WAV -> PCM ----------
test('the browser\'s real WAV (16-bit, 16 kHz, mono) -> exactly its PCM samples', () => {
  const wav = realWav();
  assert.equal(wav.length, 44 + samples.length);
  assert.ok(wavToPcm(wav).equals(samples));
});

test('extra blocks before the audio (e.g. LIST) are skipped safely', () => {
  const wav = realWav();
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([5, 0, 0, 0]), Buffer.from('abcde'), Buffer.from([0])]); // odd size + pad byte
  const withList = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
  assert.ok(wavToPcm(withList).equals(samples));
});

test('anything that is not exactly 16-bit 16 kHz mono PCM is refused (-> existing path)', () => {
  const edit = (offset, write) => { const w = realWav(); write(w, offset); return w; };
  throwsLive(() => wavToPcm(Buffer.from('not a wav file at all, just some text here....')), /not a WAV/);
  throwsLive(() => wavToPcm(Buffer.alloc(10)), /not a WAV/);
  throwsLive(() => wavToPcm(edit(22, (w, o) => w.writeUInt16LE(2, o))), /16-bit 16 kHz mono/); // stereo
  throwsLive(() => wavToPcm(edit(24, (w, o) => w.writeUInt32LE(44100, o))), /16-bit 16 kHz mono/); // 44.1 kHz
  throwsLive(() => wavToPcm(edit(34, (w, o) => w.writeUInt16LE(8, o))), /16-bit 16 kHz mono/); // 8-bit
  throwsLive(() => wavToPcm(edit(20, (w, o) => w.writeUInt16LE(3, o))), /16-bit 16 kHz mono/); // float, not PCM
  throwsLive(() => wavToPcm(edit(40, (w, o) => w.writeUInt32LE(samples.length + 100, o))), /cut off/); // claims more data than there is
  throwsLive(() => wavToPcm(edit(40, (w, o) => w.writeUInt32LE(0, o))), /no audio/);
  throwsLive(() => wavToPcm(realWav().subarray(0, 44 + 999)), /cut off/);
  // longer than 60 s
  const long = Buffer.alloc(44 + 61 * 32000);
  realWav().copy(long, 0, 0, 44);
  long.writeUInt32LE(61 * 32000, 40);
  throwsLive(() => wavToPcm(long), /too long/);
});

// ---------- checking the function's output ----------
const good = {
  heard: 'Change serum creatinine from 1.9 to 2.9.',
  understood: 'change Serum Creatinine to 2.9',
  language: 'English',
  summary: 'Updated serum creatinine.',
  edits: [
    { block_id: 'B2', operation: 'replace_text', find_text: '1.9', new_value: '2.9', field_label: 'Serum Creatinine', extra: 'dropped' },
    { block_id: 'B9', operation: 'append', new_value: ' Patient stable.', field_label: 'Course in Hospital' },
    { block_id: 'B4', operation: 'clear', field_label: 'Remarks' },
  ],
};

test('valid answer -> { edits, summary, heard, understood, language, all_words, transcript }; heard = the MODEL words; unknown fields dropped', () => {
  const r = checkLiveResult(good, '  google transcript  ');
  assert.deepEqual(Object.keys(r).sort(), ['all_words', 'edits', 'heard', 'language', 'summary', 'transcript', 'understood']);
  assert.equal(r.transcript, 'google transcript'); // Google's own words, for the scope check in index.js only
  assert.equal(r.all_words, '');
  assert.equal(checkLiveResult({ ...good, all_words: ' ella ' }, 'x').all_words, 'ella');
  // all_words must be short text, otherwise the whole answer is refused (existing path)
  throwsLive(() => checkLiveResult({ ...good, all_words: 5 }, 'x'), /invalid function arguments/);
  throwsLive(() => checkLiveResult({ ...good, all_words: 'x'.repeat(201) }, 'x'), /invalid function arguments/);
  assert.equal(r.heard, 'Change serum creatinine from 1.9 to 2.9.');
  assert.equal(r.understood, 'change Serum Creatinine to 2.9');
  assert.equal(r.language, 'English');
  assert.equal(r.summary, 'Updated serum creatinine.');
  assert.deepEqual(r.edits[0], { block_id: 'B2', operation: 'replace_text', field_label: 'Serum Creatinine', new_value: '2.9', find_text: '1.9' });
  assert.equal(r.edits.length, 3);
  // a question / nothing to change: an empty edits list is valid
  assert.deepEqual(checkLiveResult({ edits: [], understood: 'which date is unclear', summary: 'Which date? Nothing was changed.' }, 'change the date').edits, []);
});

test('Malayalam speech: Google writes "remove" in Malayalam script; heard keeps the model words in English letters', () => {
  const google = 'എല്ലാ മെഡിസിൻസിനും ജനറിക് നെയിം റിമൂവ് ചെയ്യണം';
  const model = 'എല്ലാ medicines-നും generic name remove ചെയ്യണം';
  const r = checkLiveResult({ ...good, edits: [], heard: model, understood: 'remove the generic names from all medicines in Advice', language: 'Malayalam + English' }, google);
  assert.equal(r.heard, model);
  assert.equal(r.language, 'Malayalam + English');
  // the model left heard empty -> Google's transcript is used (never an empty heard)
  assert.equal(checkLiveResult({ ...good, heard: '' }, google).heard, google);
  assert.equal(checkLiveResult({ ...good, heard: undefined }, google).heard, google);
});

test('empty transcript -> refused (existing path)', () => {
  throwsLive(() => checkLiveResult(good, ''), /empty transcript/);
  throwsLive(() => checkLiveResult(good, '   '), /empty transcript/);
});

test('ALL-OR-NOTHING: one invalid edit refuses the whole answer (never a partial edit)', () => {
  const withBad = (bad) => ({ ...good, edits: [good.edits[0], bad] });
  for (const bad of [
    null, 'B2', [],
    { block_id: '2', operation: 'set', new_value: 'x', field_label: 'A' }, // id not "B<number>"
    { block_id: 'B2 ', operation: 'set', new_value: 'x', field_label: 'A' },
    { block_id: 'B2', operation: 'delete', field_label: 'A' }, // unknown operation
    { block_id: 'B2', operation: 'set', new_value: 'x' }, // no field_label
    { block_id: 'B2', operation: 'set', new_value: 'x', field_label: '  ' },
    { block_id: 'B2', operation: 'set', field_label: 'A' }, // set without a value
    { block_id: 'B2', operation: 'append', new_value: 5, field_label: 'A' }, // not text
    { block_id: 'B2', operation: 'insert_after', field_label: 'A' },
    { block_id: 'B2', operation: 'replace_text', new_value: 'x', field_label: 'A' }, // no find_text
    { block_id: 'B2', operation: 'replace_text', find_text: '', new_value: 'x', field_label: 'A' },
    { block_id: 'B2', operation: 'replace_text', find_text: 'a', field_label: 'A' }, // no new_value
    { block_id: 'B2', operation: 'set', new_value: 'x'.repeat(10001), field_label: 'A' }, // too long
  ]) {
    throwsLive(() => checkLiveResult(withBad(bad), 'some words'), /invalid edit/);
  }
});

test('spoken commands may use format / change_case / to_list / unlist; their fields are kept, wrong values refused', () => {
  const look = [
    { block_id: 'B3', operation: 'format', style: 'bold', find_text: 'DOLO', field_label: 'Advice' },
    { block_id: 'B5', operation: 'change_case', case: 'upper', last_block_id: 'B9', field_label: 'Course in Hospital' },
    { block_id: 'B3', operation: 'to_list', list_type: 'ordered', lines: ['Tab. A', 'Tab. B'], field_label: 'Advice' },
    { block_id: 'B12', operation: 'unlist', field_label: 'Diet' },
    { block_id: 'B3', operation: 'insert_after', new_value: 'Tab. DOLO', find_text: 'Tab. A', duplicate_ok: true, field_label: 'Advice' },
  ];
  const r = checkLiveResult({ ...good, edits: look }, 'x');
  assert.deepEqual(r.edits, look);
  // to_list with select (the browser picks the lines) - with or without extra lines
  const sel = [{ block_id: 'B3', operation: 'to_list', list_type: 'ordered', select: ['all_medicines'], lines: ['AZIPROPROTEIN POWDER 2 scoops'], field_label: 'Advice' },
    { block_id: 'B3', operation: 'to_list', list_type: 'bullet', select: ['tablets', 'syrups'], field_label: 'Advice' }];
  assert.deepEqual(checkLiveResult({ ...good, edits: sel }, 'x').edits, sel);
  const withBad = (bad) => ({ ...good, edits: [look[0], bad] });
  for (const bad of [
    { block_id: 'B3', operation: 'format', field_label: 'A' }, // no style
    { block_id: 'B3', operation: 'format', style: 'blink', field_label: 'A' },
    { block_id: 'B3', operation: 'change_case', field_label: 'A' }, // no case
    { block_id: 'B3', operation: 'change_case', case: 'random', field_label: 'A' },
    { block_id: 'B3', operation: 'change_case', case: 'upper', last_block_id: '9', field_label: 'A' },
    { block_id: 'B3', operation: 'to_list', list_type: 'ordered', field_label: 'A' }, // no lines
    { block_id: 'B3', operation: 'to_list', lines: ['a'], field_label: 'A' }, // no list_type
    { block_id: 'B3', operation: 'to_list', list_type: 'ordered', lines: [5], field_label: 'A' },
    { block_id: 'B3', operation: 'to_list', list_type: 'ordered', lines: Array(101).fill('a'), field_label: 'A' },
    { block_id: 'B3', operation: 'insert_after', new_value: 'x', duplicate_ok: 'yes', field_label: 'A' },
    { block_id: 'B3', operation: 'to_list', list_type: 'ordered', select: ['vitamins'], field_label: 'A' }, // unknown kind
    { block_id: 'B3', operation: 'to_list', list_type: 'ordered', select: 'tablets', field_label: 'A' }, // not a list
    { block_id: 'B3', operation: 'to_list', list_type: 'ordered', select: [], field_label: 'A' }, // neither select nor lines
  ]) {
    throwsLive(() => checkLiveResult(withBad(bad), 'some words'), /invalid edit/);
  }
});

test('broken arguments -> refused', () => {
  for (const args of [null, undefined, 'text', [], {}, { edits: 'B2' }, { edits: {} }, { edits: [], understood: 'x', summary: 5 },
    { edits: [], summary: '' }, // understood is required
    { edits: [], understood: 5 }, { edits: [], understood: 'x', heard: 7 }, { edits: [], understood: 'x', language: [] },
    { edits: [], understood: 'x'.repeat(10001) }]) {
    throwsLive(() => checkLiveResult(args, 'some words'), /invalid function arguments/);
  }
  throwsLive(() => checkLiveResult({ edits: Array(51).fill(good.edits[2]), understood: 'x', summary: '' }, 'w'), /too many edits/);
});

test('Live is off unless GEMINI_LIVE_MODEL is set; the description never shows a key', () => {
  const saved = { model: process.env.GEMINI_LIVE_MODEL, key: process.env.GEMINI_API_KEY };
  try {
    process.env.GEMINI_API_KEY = 'dummy-not-a-real-key';
    delete process.env.GEMINI_LIVE_MODEL;
    assert.equal(liveEnabled(), false);
    assert.match(liveDescription(), /off/);
    process.env.GEMINI_LIVE_MODEL = 'gemini-3.8-live';
    assert.equal(liveEnabled(), true);
    assert.match(liveDescription(), /gemini-3\.8-live \| Gemini Developer API v1alpha \| timeout 20000 ms/);
    assert.doesNotMatch(liveDescription(), /dummy-not-a-real-key/);
  } finally {
    if (saved.model === undefined) delete process.env.GEMINI_LIVE_MODEL; else process.env.GEMINI_LIVE_MODEL = saved.model;
    if (saved.key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.key;
  }
});

// ---------- early backup: the model SPEAKS instead of calling the function ----------
const audioPart = (mimeType = 'audio/pcm;rate=24000', data = 'AAAA') => ({ inlineData: { mimeType, data } });

test('isModelAudio: only the model\'s own spoken reply counts', () => {
  assert.equal(isModelAudio({ serverContent: { modelTurn: { parts: [audioPart()] } } }), true);
  assert.equal(isModelAudio({ serverContent: { modelTurn: { parts: [{ text: 'x' }, audioPart('AUDIO/PCM')] } } }), true);
  for (const m of [
    { serverContent: { inputTranscription: { text: 'add name test patient' } } }, // Google's transcript of the person
    { serverContent: { modelTurn: { parts: [{ text: 'thinking' }] } } }, // text only
    { serverContent: { modelTurn: { parts: [] } } }, { serverContent: { modelTurn: {} } }, // empty
    { serverContent: { modelTurn: { parts: [audioPart('audio/pcm', '')] } } }, // no audio data
    { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } } },
    { serverContent: { turnComplete: true } }, { serverContent: { generationComplete: true } }, // status messages
    { toolCall: { functionCalls: [{ id: '1', name: 'propose_edits', args: {} }] } }, // the function call itself
    {}, null, undefined, 'audio/pcm',
  ]) assert.equal(isModelAudio(m), false, JSON.stringify(m));
});

test('liveExtract: the function call is taken FIRST; audio only ends an attempt that has no call; the backup gets the original request', () => {
  const live = fs.readFileSync(new URL('../liveVoice.js', import.meta.url), 'utf8');
  const handler = live.slice(live.indexOf('onmessage: (m) => {'), live.indexOf('onerror:'));
  const callAt = handler.indexOf("const fc = m.toolCall?.functionCalls?.find((f) => f.name === 'propose_edits');");
  const audioAt = handler.indexOf("if (!call && isModelAudio(m)) settle.reject(new LiveError('model spoke instead of calling the function'));");
  const turnAt = handler.indexOf("if (m.serverContent?.turnComplete && !call) settle.reject(new LiveError('no function call'));");
  assert.ok(callAt > 0 && audioAt > callAt && turnAt > audioAt, 'order: call, then audio, then turn complete');
  assert.equal((handler.match(/settle\.resolve\(\)/g) || []).length, 1); // success only through the call
  // after the attempt: the session is always closed (a late Live message changes nothing)
  assert.match(live, /try \{ session\?\.close\(\); \} catch/);
  // the backup path (index.js) still uses the original audio and the same prompt
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(index, /const result = await liveExtract\(\{ prompt, audioBase64 \}\);/);
  assert.match(index, /if \(hasAudio\) parts\.push\(\{ inlineData: \{ mimeType: audioMimeType \|\| 'audio\/wav', data: audioBase64 \} \}\);/);
  assert.match(index, /parts\.push\(\{ text: prompt \}\);/);
});

// ---------- Live answer format: descriptions only; types, allowed values and checks unchanged ----------
test('Live-only wording: the function says where each value goes; the answer format itself is unchanged', async () => {
  const { liveFunctionDeclaration, liveSuffix } = await import('../liveVoice.js');
  const { extraEditFields, COMMAND_OPERATIONS } = await import('../commandPrompt.js');
  const { Type } = await import('@google/genai');
  const decl = liveFunctionDeclaration();
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'description' ? undefined : v)));
  // the same shape as before the wording (types, enums, required)
  assert.deepEqual(strip(decl.parameters), {
    type: Type.OBJECT,
    properties: {
      heard: { type: Type.STRING }, understood: { type: Type.STRING }, language: { type: Type.STRING },
      all_words: { type: Type.STRING }, summary: { type: Type.STRING },
      edits: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
        block_id: { type: Type.STRING }, operation: { type: Type.STRING, enum: COMMAND_OPERATIONS },
        new_value: { type: Type.STRING }, find_text: { type: Type.STRING }, field_label: { type: Type.STRING },
        ...strip(extraEditFields(Type)) }, required: ['block_id', 'operation', 'field_label'] } },
    },
    required: ['heard', 'understood', 'edits', 'summary'],
  });
  const f = decl.parameters.properties.edits.items.properties;
  assert.match(f.new_value.description, /REQUIRED for set, append, insert_after and replace_text/);
  assert.match(f.new_value.description, /never in lines/);
  assert.match(f.block_id.description, /Exactly ONE block id .* like "B12"/);
  assert.match(f.lines.description, /^ONLY for to_list\. Never use it to add new text/);
  assert.match(f.select.description, /^ONLY for to_list/);
  assert.match(decl.description, /also to ask a question .* Never answer by speaking\./);
  // the Live-only text: the earlier lines, plus the format checklist
  const s = liveSuffix();
  assert.match(s, /call the function propose_edits exactly once/);
  assert.match(s, /Never answer in any other way\./);
  assert.match(s, /set, append and insert_after: the text to write is ALWAYS in new_value \(never in lines\)/);
  assert.match(s, /block_id: ONE id exactly like B12/);
  assert.match(s, /A question goes in summary with an empty edits list, inside the function call\. Never speak a question or an answer\./);
});

test('the main prompt is not changed by the Live wording (it is only added for Live sessions)', async () => {
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(index, /FORMAT OF THE FUNCTION CALL/);
  const cp = fs.readFileSync(new URL('../commandPrompt.js', import.meta.url), 'utf8');
  assert.doesNotMatch(cp, /FORMAT OF THE FUNCTION CALL/);
  const live = fs.readFileSync(new URL('../liveVoice.js', import.meta.url), 'utf8');
  assert.match(live, /systemInstruction: prompt \+ LIVE_SUFFIX,/);
});
