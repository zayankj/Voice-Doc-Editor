// Stage 1 editing-safety fixes. Dummy document only - no patient data. Fake microphone / audio objects for Fix 5.
//   Fix 1  an AI answer is never applied to a document that changed while the AI was working
//   Fix 2  Apply Edit cannot start a second request while a voice command is being processed (the mic is not blocked)
//   Fix 3  several edits of ONE block are applied in Gemini's order (insert_after: last-first, so they read in order)
//   Fix 4  the deletion check sees the edit as it will be applied ("\n" as two characters, spaces / tabs / newlines)
//   Fix 5  a failed microphone start releases the microphone
//   Fix 6  a voice command belongs to the document that was open when it was STARTED (queued / being recorded)
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
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { EditorState } from '@tiptap/pm/state';
import { bottomUp, withRealLineBreaks } from '../src/lib/aiEdits.js';
import { isDeletion, hasDeletion } from '../src/lib/deletions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-stage1');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'previewEdits', 'medicineText', 'sections']) {
  fs.writeFileSync(path.join(tmp, `${f}.js`), fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)(\.js)?'/g, "from './$1.js'"));
}
await build({
  entryPoints: [path.join(here, '../src/components/SidePanel.jsx')], outfile: path.join(tmp, 'SidePanel.mjs'),
  format: 'esm', jsx: 'automatic', bundle: true, packages: 'external', logLevel: 'silent',
});
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { previewEdits } = await import(pathToFileURL(path.join(tmp, 'previewEdits.js')).href);
const { getBlocks, buildOutline } = await import(pathToFileURL(path.join(tmp, 'outline.js')).href);
const { default: SidePanel } = await import(pathToFileURL(path.join(tmp, 'SidePanel.mjs')).href);
const { startCapture } = await import(pathToFileURL(path.join(here, '../src/lib/audio.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const APP = fs.readFileSync(path.join(here, '../src/App.jsx'), 'utf8');
const between = (from, to) => APP.slice(APP.indexOf(from), APP.indexOf(to, APP.indexOf(from)));

// ---------- a dummy document ----------
const schema = getSchema([StarterKit, Table, TableRow, TableHeader, TableCell]);
const t = (s) => schema.text(s);
const p = (...k) => schema.node('paragraph', null, k);
const tp = (s) => p(t(s));
const h = (s) => p(schema.text(s, [schema.marks.bold.create()]));
const br = () => schema.nodes.hardBreak.create();
const cell = (s) => schema.node('tableCell', null, [tp(s)]);
const row = (...xs) => schema.node('tableRow', null, xs.map(cell));
const kids = () => [h('DISCHARGE SUMMARY'), schema.node('table', null, [row('Name', 'DUMMY PATIENT', 'Age', '40 Years')]),
  h('DIAGNOSIS'), tp('TYPHOID'), h('PRESENTING COMPLAINTS'), tp('Fever for 5 days, vomiting for 2 days.'),
  h('COURSE IN HOSPITAL'), tp('Patient was admitted with fever.'),
  h('ADVICE'), tp('Tab. CIPLOX 500 mg — Twice Daily — 5 days'), tp('Tab. PAN 40 mg — Once Daily — 5 days'),
  h('FOLLOW UP'), tp('Review in OPD after 1 week.')];
const editorOf = (nodes = kids()) => {
  const ed = { state: EditorState.create({ doc: schema.node('doc', null, nodes) }), schema, isDestroyed: false, dryRun: true };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
};
const id = (ed, start) => `B${getBlocks(ed.state.doc).findIndex((b) => b.node.textContent.startsWith(start))}`;
const textOf = (ed, start) => getBlocks(ed.state.doc).find((b) => b.node.textContent.startsWith(start))?.node.textContent;
const blockText = (ed, blockId) => getBlocks(ed.state.doc)[parseInt(blockId.slice(1), 10)].node.textContent;
const allText = (ed) => getBlocks(ed.state.doc).map((b) => b.node.textBetween(0, b.node.content.size, '\n', '\n')).join('\n');
// the App.jsx flow after the answer: cleaned edits -> bottomUp -> all-or-nothing dry run (2+) -> apply
function run(ed, edits, order = bottomUp) {
  const ordered = order(edits.map(withRealLineBreaks));
  if (ordered.length > 1 && previewEdits(ed.state.doc, ordered, { fromFile: false }).blocked.length) return false;
  return ordered.map((e) => applyVoiceEdit(ed, e, {})).every((r) => r.ok);
}
// the order App.jsx used BEFORE Stage 1 (same block: reversed)
const oldBottomUp = (edits) => edits.map((ed, i) => ({ ed, i }))
  .sort((a, b) => parseInt(b.ed.block_id.slice(1), 10) - parseInt(a.ed.block_id.slice(1), 10) || b.i - a.i).map((x) => x.ed);

// ================= Fix 1: a changed document is never edited with an old answer =================
test('Fix 1 (bug): an answer made for the document before a change hits the WRONG block', () => {
  const ed = editorOf();
  const before = ed.state.doc;
  const advice = id(ed, 'Tab. PAN'); // the AI's block number for "Tab. PAN" - in the document as it was asked
  // while the AI is working, the doctor adds a line in Diagnosis: every block below moves down by one
  ed.view.dispatch(ed.state.tr.insert(getBlocks(ed.state.doc)[parseInt(id(ed, 'TYPHOID').slice(1), 10)].pos + 9, tp('Dehydration')));
  assert.equal(blockText(ed, advice), 'Tab. CIPLOX 500 mg — Twice Daily — 5 days', 'the old number now points at another medicine');
  assert.equal(ed.state.doc.eq(before), false, 'Stage 1 detects exactly this: the document is not the one the request was made for');
});

test('Fix 1: runEdits refuses the answer when the document changed - before sorting, the dry run, the window or applying', () => {
  const runEdits = between('async function runEdits(', 'async function runAndReport(');
  const after = runEdits.slice(runEdits.indexOf('answer = stream'));
  const at = (s) => after.indexOf(s);
  assert.ok(at('ticket.isStale(currentId.current)') > 0);
  const check = at('if (!editor.state.doc.eq(docAtStart)) {');
  assert.ok(check > at('ticket.isStale(currentId.current)'), 'after the "same document still open" check');
  for (const later of ['bottomUp(aiEdits)', 'previewEdits(', 'needsConfirmation(', 'openPending(', 'applyAiEdits(']) {
    assert.ok(at(later) > check, `${later} only after the check`);
  }
  assert.match(after, /if \(!editor\.state\.doc\.eq\(docAtStart\)\) \{\r?\n\s+setError\(DOC_CHANGED\);\r?\n\s+return false;/);
  assert.match(APP, /const docAtStart = editor\.state\.doc;/, 'the document is taken when the request starts');
  // the request's outline is built from the same document, with no wait in between
  const start = runEdits.slice(runEdits.indexOf('const docAtStart'), runEdits.indexOf('outline: buildOutline(editor.state.doc)'));
  assert.ok(!/await /.test(start), 'nothing can change the document between the snapshot and the outline');
  assert.match(APP, /const DOC_CHANGED = 'The document was changed while the AI was working, so nothing was changed\. Please give the command again\.';/);
  // "error": the typed text / file stay in the Apply Edit box for the retry (runAndReport: !ok -> 'error')
  assert.match(between('async function runAndReport(', 'async function handleApply('), /if \(!ok\) return 'error';/);
});

// ================= Fix 2: no overlapping requests =================
const panel = (extra) => renderToStaticMarkup(React.createElement(SidePanel, {
  status: 'idle', onMic() {}, onRead() {}, readSpeeds: [], onReadSpeed() {}, transcript: '', reply: '', note: '', error: '',
  attached: null, instruction: 'Change the follow up to two weeks.', onInstruction() {}, onApply() {}, history: [], onUndo() {}, applying: false, ...extra,
}));
const applyButton = (html) => html.match(/<button class="btn primary"[^>]*>/)[0];
const micButton = (html) => html.match(/<button class="round-btn mic[^"]*"[^>]*>/)[0];

test('Fix 2: Apply Edit is disabled while a voice command is processed, and enabled again afterwards', () => {
  assert.match(applyButton(panel({ processing: true })), /disabled=""/, 'processing: disabled');
  assert.doesNotMatch(applyButton(panel({ processing: false })), /disabled/, 'done (also after an error): enabled');
  assert.doesNotMatch(applyButton(panel({})), /disabled/, 'no processing prop: as before');
  assert.match(applyButton(panel({ applying: true })), /disabled=""/, 'a typed request running: disabled (as before)');
});

test('Fix 2: the microphone is NOT blocked by a voice command being processed (commands keep being captured)', () => {
  assert.doesNotMatch(micButton(panel({ processing: true, status: 'listening' })), /disabled/, 'listening + processing: the mic stays usable');
  assert.doesNotMatch(micButton(panel({ processing: true, status: 'idle' })), /disabled/);
  // the queue still accepts commands while one is processed; only Apply Edit checks working.current
  const apply = between('async function handleApply(', '// ---------- microphone, audio mode');
  assert.match(apply, /if \(submitting\.current\) return;[^\n]*\r?\n[\s\S]*?if \(working\.current\) return;/);
  assert.doesNotMatch(between('function enqueueClip(', '// ---------- voice streaming'), /working\.current/, 'enqueueClip never waits for processing');
  assert.match(APP, /processing=\{processing\}/);
  // flags are reset in finally blocks (also after an error)
  assert.match(between('async function processQueue(', 'function enqueueClip('), /finally \{\r?\n\s+working\.current = false;\r?\n\s+setProcessing\(false\);/);
  assert.match(between('async function handleApply(', '// ---------- microphone, audio mode'), /finally \{\r?\n\s+submitting\.current = false;/);
});

// ================= Fix 3: the order of several edits of one block =================
test('Fix 3 (bug + fix): "set" then "append" on one block - the append was lost, now it is kept', () => {
  const edits = (ed) => [{ block_id: id(ed, 'TYPHOID'), operation: 'set', new_value: 'Enteric fever' }, { block_id: id(ed, 'TYPHOID'), operation: 'append', new_value: ', dehydration' }];
  const old = editorOf();
  run(old, edits(old), oldBottomUp);
  assert.equal(textOf(old, 'Enteric'), 'Enteric fever', 'before Stage 1: the set ran last and removed the append');
  const ed = editorOf();
  assert.equal(run(ed, edits(ed)), true);
  assert.equal(textOf(ed, 'Enteric'), 'Enteric fever, dehydration');
});

test('Fix 3: two appends to one block stay in Gemini\'s order', () => {
  const edits = (ed) => [{ block_id: id(ed, 'TYPHOID'), operation: 'append', new_value: ' and dehydration' }, { block_id: id(ed, 'TYPHOID'), operation: 'append', new_value: ', resolved' }];
  const old = editorOf();
  run(old, edits(old), oldBottomUp);
  assert.equal(textOf(old, 'TYPHOID'), 'TYPHOID, resolved and dehydration', 'before Stage 1: reversed');
  const ed = editorOf();
  run(ed, edits(ed));
  assert.equal(textOf(ed, 'TYPHOID'), 'TYPHOID and dehydration, resolved');
});

test('Fix 3: two insert_after on one block still read in Gemini\'s order (unchanged)', () => {
  const ed = editorOf();
  const b = id(ed, 'Review in OPD');
  assert.equal(run(ed, [{ block_id: b, operation: 'insert_after', new_value: 'First new line.' }, { block_id: b, operation: 'insert_after', new_value: 'Second new line.' }]), true);
  assert.match(allText(ed), /Review in OPD after 1 week\.\nFirst new line\.\nSecond new line\./);
});

test('Fix 3: edits on different blocks are still applied from the bottom up (an insert never shifts a waiting edit)', () => {
  const ed = editorOf();
  const edits = [
    { block_id: id(ed, 'TYPHOID'), operation: 'insert_after', new_value: 'Dehydration' },
    { block_id: id(ed, 'Review in OPD'), operation: 'set', new_value: 'Review in OPD after 2 weeks.' },
    { block_id: id(ed, 'Tab. PAN'), operation: 'replace_text', find_text: '40 mg', new_value: '20 mg' },
  ];
  assert.deepEqual(bottomUp(edits).map((e) => e.block_id), [edits[1].block_id, edits[2].block_id, edits[0].block_id]);
  assert.equal(run(ed, edits), true);
  assert.ok(textOf(ed, 'Review in OPD').endsWith('2 weeks.'));
  assert.equal(textOf(ed, 'Tab. PAN'), 'Tab. PAN 20 mg — Once Daily — 5 days');
  assert.equal(textOf(ed, 'Dehydration'), 'Dehydration');
  assert.equal(textOf(ed, 'Tab. CIPLOX'), 'Tab. CIPLOX 500 mg — Twice Daily — 5 days', 'nothing else changed');
});

test('Fix 3: bottomUp keeps the insert_after slots among other edits of the same block; it does not change the list given', () => {
  const e = (op, v) => ({ block_id: 'B5', operation: op, new_value: v });
  const input = [e('insert_after', 'A'), e('set', 'S'), e('insert_after', 'B'), e('append', 'X')];
  const copy = JSON.stringify(input);
  assert.deepEqual(bottomUp(input).map((x) => `${x.operation}:${x.new_value}`), ['insert_after:B', 'set:S', 'insert_after:A', 'append:X']);
  assert.equal(JSON.stringify(input), copy);
  assert.deepEqual(bottomUp([]), []);
  // App.jsx uses this one (no second copy)
  assert.match(APP, /import \{ bottomUp, withRealLineBreaks \} from '\.\/lib\/aiEdits';/);
  assert.doesNotMatch(APP, /function bottomUp\(/);
});

// ================= Fix 4: deletions always ask first =================
test('Fix 4 (bug): set "\\n" (backslash + n) emptied a paragraph without the confirmation window', () => {
  const ed = editorOf();
  const b = id(ed, 'Patient was admitted');
  const raw = { block_id: b, operation: 'set', new_value: '\\n' };
  // the check before Stage 1 (decided on the raw text): "\n" as two characters is "text", so no window
  const oldSet = (e) => typeof e.new_value === 'string' && !e.new_value.trim();
  assert.equal(oldSet(raw), false, 'before: not a deletion');
  assert.equal(isDeletion(ed.state.doc, raw), true, 'now: a deletion -> the window');
  assert.equal(hasDeletion(ed.state.doc, [raw].map(withRealLineBreaks)), true);
});

test('Fix 4: empty, spaces, tabs and newline-only values that remove text are deletions (Option 1)', () => {
  const ed = editorOf();
  const course = id(ed, 'Patient was admitted');
  const pc = id(ed, 'Fever for 5 days');
  for (const e of [
    { block_id: course, operation: 'set', new_value: '' },
    { block_id: course, operation: 'set', new_value: '   ' },
    { block_id: course, operation: 'set', new_value: '\t' },
    { block_id: course, operation: 'set', new_value: '\n\n' },
    { block_id: course, operation: 'set', new_value: ' \\n ' },
    { block_id: pc, operation: 'replace_text', find_text: 'vomiting for 2 days', new_value: '' },
    { block_id: pc, operation: 'replace_text', find_text: 'vomiting for 2 days', new_value: ' ' },
    { block_id: pc, operation: 'replace_text', find_text: 'vomiting', new_value: '\t' },
    { block_id: pc, operation: 'replace_text', find_text: ', vomiting for 2 days', new_value: '\n' },
    { block_id: pc, operation: 'replace_text', find_text: '5', new_value: ' ' }, // a number would disappear
    { block_id: pc, operation: 'replace_text', find_text: 'vomiting', new_value: '\\n' },
    { block_id: course, operation: 'clear' },
  ]) assert.equal(isDeletion(ed.state.doc, e), true, JSON.stringify(e));
});

test('Fix 4 (Option 1): turning punctuation into a line break ("each on its own line") is applied directly', () => {
  const ed = editorOf();
  const pc = id(ed, 'Fever for 5 days');
  for (const e of [
    { block_id: pc, operation: 'replace_text', find_text: ', ', new_value: '\n' },
    { block_id: pc, operation: 'replace_text', find_text: ', ', new_value: '\\n' },
    { block_id: pc, operation: 'replace_text', find_text: ' - ', new_value: '\n' },
    { block_id: pc, operation: 'replace_text', find_text: 'vomiting', new_value: 'nausea' },
    { block_id: pc, operation: 'replace_text', find_text: ', ', new_value: '\nAlso: ' },
    { block_id: pc, operation: 'append', new_value: ' ' },
    { block_id: pc, operation: 'insert_after', new_value: '\n' },
  ]) assert.equal(isDeletion(ed.state.doc, e), false, JSON.stringify(e));
  // ... and it really becomes two lines
  const r = applyVoiceEdit(ed, withRealLineBreaks({ block_id: pc, operation: 'replace_text', find_text: ', ', new_value: '\\n' }), {});
  assert.equal(r.ok, true);
  const n = getBlocks(ed.state.doc)[parseInt(pc.slice(1), 10)].node;
  assert.equal(n.textBetween(0, n.content.size, '\n', '\n'), 'Fever for 5 days\nvomiting for 2 days.');
});

test('Fix 4 (Option 1): punctuation-only text that IS the whole paragraph is a deletion (it would empty it)', () => {
  const ed = editorOf([...kids(), h('NOTES'), tp(' - ')]);
  assert.equal(isDeletion(ed.state.doc, { block_id: id(ed, ' - '), operation: 'replace_text', find_text: ' - ', new_value: '\n' }), true);
});

test('Fix 4: App.jsx cleans the edits ONCE when the answer arrives - before the deletion check, the dry run and the window', () => {
  const runEdits = between('async function runEdits(', 'async function runAndReport(');
  assert.match(runEdits, /const aiEdits = rawEdits\.map\(withRealLineBreaks\);/);
  const at = (s) => runEdits.indexOf(s);
  assert.ok(at('rawEdits.map(withRealLineBreaks)') < at('bottomUp(aiEdits)'));
  assert.ok(at('bottomUp(aiEdits)') < at('needsConfirmation(doc, ordered)'));
});

test('Fix 4: the line-break conversion of App.jsx and of applyVoiceEdit give the same result', () => {
  for (const v of ['Enteric fever\\nheadache\\r\\nvomiting', 'a\\n', '\\n', 'no breaks', 'real\nbreak', 'C:\\notes']) {
    const ed1 = editorOf();
    const ed2 = editorOf();
    const b = id(ed1, 'TYPHOID');
    applyVoiceEdit(ed1, { block_id: b, operation: 'set', new_value: v }, {});
    applyVoiceEdit(ed2, withRealLineBreaks({ block_id: b, operation: 'set', new_value: v }), {});
    assert.ok(ed1.state.doc.eq(ed2.state.doc), v);
  }
  const same = { block_id: 'B1', operation: 'set', new_value: 'x' };
  assert.equal(withRealLineBreaks(same), same, 'nothing to change: the same object');
  assert.equal(withRealLineBreaks(undefined), undefined);
});

// ================= Fix 5: a failed microphone start releases the microphone =================
function fakeMic({ failAt = null } = {}) {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }, { stopped: false, stop() { this.stopped = true; } }];
  const ctxs = [];
  const nodes = [];
  const node = (kind) => { const n = { kind, disconnected: false, connect: (x) => x, disconnect() { this.disconnected = true; } }; nodes.push(n); return n; };
  globalThis.__fakeNavigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) } };
  Object.defineProperty(globalThis, 'navigator', { value: globalThis.__fakeNavigator, configurable: true, writable: true });
  globalThis.AudioContext = class {
    constructor() {
      if (failAt === 'context') throw new Error('NotSupportedError: sample rate');
      this.state = 'running';
      ctxs.push(this);
      this.audioWorklet = { addModule: async () => { if (failAt === 'worklet') throw new Error('worklet failed to load'); } };
      this.destination = {};
    }
    createMediaStreamSource() { if (failAt === 'source') throw new Error('source failed'); return node('source'); }
    createGain() { const g = node('gain'); g.gain = { value: 1 }; return g; }
    close() { this.state = 'closed'; return Promise.resolve(); }
  };
  globalThis.AudioWorkletNode = class {
    constructor() {
      if (failAt === 'node') throw new Error('node failed');
      Object.assign(this, node('worklet'));
      this.port = { onmessage: null };
      nodes[nodes.length - 1] = this;
    }
  };
  return { tracks, ctxs, nodes };
}

test('Fix 5 (bug): before Stage 1, a failed start left the microphone on', async (t2) => {
  const old = path.join('C:/Users/moham/AppData/Local/Temp/claude/fe30f3cede31d5e9/b954b2cb-875c-46e9-814d-606883c29131/scratchpad/backup-before-stage1/audio.js');
  if (!fs.existsSync(old)) { t2.skip('the backup of the old audio.js is not on this computer'); return; }
  const { startCapture: oldStart } = await import(pathToFileURL(old).href);
  const m = fakeMic({ failAt: 'worklet' });
  await assert.rejects(oldStart(() => {}));
  assert.equal(m.tracks.some((x) => x.stopped), false, 'old: tracks still running');
  assert.equal(m.ctxs[0].state, 'running', 'old: audio context still open');
});

for (const failAt of ['context', 'worklet', 'source', 'node']) {
  test(`Fix 5: start fails at "${failAt}" -> every track stopped, the audio context closed, the error still reported`, async () => {
    const m = fakeMic({ failAt });
    await assert.rejects(startCapture(() => {}), (e) => e instanceof Error);
    assert.ok(m.tracks.every((x) => x.stopped), 'all tracks stopped');
    assert.ok(m.ctxs.every((c) => c.state === 'closed'), 'audio context closed');
    assert.ok(m.nodes.every((n) => n.disconnected), 'created nodes disconnected');
  });
}

test('Fix 5: a successful start is unchanged (tracks run; stop() releases everything once)', async () => {
  const m = fakeMic();
  const chunks = [];
  const stop = await startCapture((c, rms) => chunks.push([c, rms]));
  assert.ok(m.tracks.every((x) => !x.stopped), 'running');
  assert.equal(m.ctxs[0].state, 'running');
  const worklet = m.nodes.find((n) => n.kind === 'worklet');
  worklet.port.onmessage({ data: new Float32Array([0, 0.5, -0.5]) });
  assert.equal(chunks.length, 1, 'audio still reaches the app');
  stop();
  stop();
  assert.ok(m.tracks.every((x) => x.stopped));
  assert.equal(m.ctxs[0].state, 'closed');
});

// ================= Fix 6: a voice command belongs to its document =================
test('Fix 6: the document is recorded when a command STARTS, carried with the clip, and checked in the queue', () => {
  const seg = between('segmenter.current = createSegmenter({', 'stopMic.current = await startCapture(');
  assert.match(seg.slice(seg.indexOf('onSpeechStart:'), seg.indexOf('onSegment:')), /speechDoc\.current = currentId\.current;/);
  const enqueue = between('function enqueueClip(', '// ---------- voice streaming');
  assert.match(enqueue, /const docKey = speechDoc\.current;/);
  assert.match(enqueue, /if \(!docKey \|\| docKey !== currentId\.current\) \{\r?\n\s+stream\?\.cancel\(\);\r?\n\s+showToast\(DISCARDED\);\r?\n\s+return;/);
  assert.match(enqueue, /queue\.current\.push\(\{ clip, endedAt: performance\.now\(\), stream, docKey \}\)/);
  const q = between('async function processQueue(', 'function enqueueClip(');
  assert.match(q, /if \(docKey !== currentId\.current\) \{ spoken\?\.cancel\(\); continue; \}/);
  assert.ok(q.indexOf('docKey !== currentId.current') < q.indexOf('pcmChunksToWav(clip)'), 'checked before anything is sent');
});

test('Fix 6: opening another document (or leaving the editor) drops the queue and closes the stream being spoken', () => {
  const effect = between('// Opening a document (or leaving it)', '// "Open" on a template');
  const at = (s) => effect.indexOf(s);
  assert.ok(at('requests.current.cancelAll();') > 0 && at('discardVoiceCommands();') > at('requests.current.cancelAll();'));
  assert.ok(at('discardVoiceCommands();') < at('currentId.current = openKey;'), 'before the new document becomes the open one');
  const discard = between('function discardVoiceCommands(', 'function enqueueClip(');
  assert.match(discard, /for \(const q of queue\.current\) q\.stream\?\.cancel\(\);\r?\n\s+queue\.current = \[\];/);
  assert.match(discard, /speakingStream\.current\?\.cancel\(\);\r?\n\s+speakingStream\.current = null;/);
  assert.match(APP, /const DISCARDED = 'A voice command for the previous document was discarded\. Nothing was changed\.';/);
});

test('Fix 6: a simulated switch - queued and half-spoken commands of patient A never run for patient B', () => {
  // the queue logic of App.jsx, replayed with the same rules (the browser test checks the real app)
  const state = { currentId: 'A', speechDoc: null, queue: [], sent: [], toasts: 0, cancelled: 0 };
  const stream = () => ({ cancel() { state.cancelled++; } });
  const onSpeechStart = () => { state.speechDoc = state.currentId; };
  const enqueue = (clip) => {
    const docKey = state.speechDoc; state.speechDoc = null;
    const s = stream();
    if (!docKey || docKey !== state.currentId) { s.cancel(); state.toasts++; return; }
    state.queue.push({ clip, docKey, stream: s });
  };
  const discard = () => { for (const q of state.queue) q.stream.cancel(); if (state.queue.length) state.toasts++; state.queue = []; };
  const process = () => { while (state.queue.length) { const q = state.queue.shift(); if (q.docKey !== state.currentId) { q.stream.cancel(); continue; } state.sent.push([q.clip, state.currentId]); } };
  onSpeechStart(); enqueue('cmd1 for A');
  onSpeechStart(); enqueue('cmd2 for A'); // both queued (the first is "being processed")
  onSpeechStart(); // cmd3: the doctor is still speaking ...
  discard(); state.currentId = 'B'; // ... when patient B is opened
  enqueue('cmd3 for A (finished after the switch)');
  process();
  onSpeechStart(); enqueue('cmd4 for B'); process();
  assert.deepEqual(state.sent, [['cmd4 for B', 'B']], 'only the command spoken for B runs for B');
  assert.equal(state.cancelled, 3, 'the streams of the 3 discarded commands are closed');
  assert.equal(state.toasts, 2, 'the person is told');
});
