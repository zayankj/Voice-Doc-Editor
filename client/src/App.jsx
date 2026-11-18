import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@tiptap/react';
import { EditorState } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';

import { Flash, getFlashRanges } from './lib/flash';
import { Placeholders } from './lib/placeholders';
import { FontSize, LineHeight } from './lib/extensions';
import { docxToHtml } from './lib/docxImport';
import { buildOutline, getBlocks } from './lib/outline';
import { applyVoiceEdit, ensurePatientConsistency } from './lib/voiceEdit';
import { scrollToPos, scrollToFirstChange } from './lib/scroll';
import { findMissingFields } from './lib/validate';
import { summaryToShow } from './lib/aiSummary';
import { asOneUndoStep } from './lib/undoStep';
import UploadPreview from './components/UploadPreview';
import { startLive } from './lib/liveClient';
import { startCapture } from './lib/audio';
import { createSegmenter } from './lib/vad';
import { pcmChunksToWav } from './lib/wav';
import { createVoiceStream, streamingOn } from './lib/voiceStream'; // voice streaming: off unless built with ENABLE_VOICE_STREAMING=true
import { voiceTimingLine } from './lib/timing';
import { reasonCode, notAppliedNote, editFailureLine } from './lib/editFailure';
import { exportDocx } from './lib/exportDocx';
import { todayString } from './lib/tools';
import { extractEdits, checkFile, FILE_ACCEPT } from './lib/fileExtract';
import { createRequestTracker, startProgress, isCancelled, isTimeout, NOT_CHANGED } from './lib/requestGuard';
import { previewEdits } from './lib/previewEdits';
import { hasDeletion } from './lib/deletions';
import { readDocument, stopReading, ttsSupported, watchVoices } from './lib/tts';
import TopBar from './components/TopBar';
import FormatBar from './components/FormatBar';
import Ruler from './components/Ruler';
import DocEditor from './components/DocEditor';
import SidePanel from './components/SidePanel';
import Sidebar from './components/Sidebar';
import AppHeader from './components/AppHeader';
import Placeholder from './pages/Placeholder';
import Summaries from './pages/Summaries';
import Templates from './pages/Templates';
import { findDepartment, findTemplate, findTemplateById, templateStartHtml } from './data/templates';
import {
  listTemplateDocs, createTemplateDoc, getTemplateDocHtml, getTemplateDocMeta, saveTemplateDocHtml, deleteTemplateDoc,
} from './lib/templateDocs';
import { useRoute, go, DEFAULT_PAGE } from './lib/route';
import {
  listSummaries, createSummary, getSummaryHtml, saveSummaryHtml, updateSummary, deleteSummary,
} from './lib/summaries';

const KNOWN_PAGES = new Set(['dashboard', 'summaries', 'create-summary', 'templates', 'activity', 'settings']);

const USER_INITIAL = ''; // the user is now shown in the top header (AppHeader)

// audio = the mic listens all the time, each command is sent after a pause (works with the Mumbai models).
// live  = real-time Live model (needs GEMINI_API_KEY and a Live model; not available in the India region setup).
const VOICE_MODE = import.meta.env.VITE_VOICE_MODE === 'live' ? 'live' : 'audio';
const IDLE_STOP_MS = 5 * 60 * 1000; // the mic turns itself off after this long without speech
const MAX_QUEUE = 5; // commands that may wait while a previous one is being applied
const READ_RATE = 1.1; // reading speed for Read aloud (0.95 = normal, 1.1 = fast)
const RESTART_ON_CLICK = true; // while reading, clicking in the document restarts reading from the clicked sentence

// Summaries are saved in this browser by lib/summaries.js (one entry per summary).

// The AI's edits from the bottom of the document upwards, so a newly inserted line never shifts the blocks that
// are still waiting to be edited
function bottomUp(edits) {
  const blockNo = (ed) => {
    const n = parseInt(String(ed.block_id).replace(/\D/g, ''), 10);
    return Number.isNaN(n) ? -1 : n;
  };
  return edits
    .map((ed, i) => ({ ed, i }))
    .sort((a, b) => blockNo(b.ed) - blockNo(a.ed) || b.i - a.i)
    .map((x) => x.ed);
}

export default function App() {
  const [history, setHistory] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | connecting | listening
  const [hearing, setHearing] = useState(false); // you are speaking right now
  const [processing, setProcessing] = useState(false); // a voice command is being applied
  const [transcript, setTranscript] = useState('');
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const [applying, setApplying] = useState(false); // Apply Edit button only (files / typed instructions)
  const [progress, setProgress] = useState(''); // what the AI request is doing now ("AI is processing your request…")
  const [note, setNote] = useState('');
  const [voices, setVoices] = useState([]);
  const [saved, setSaved] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [collapsed, setCollapsed] = useState(false);
  const [attached, setAttached] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [toast, setToast] = useState('');
  // a code-based removal (remove phrases / generic names) waiting in the confirm window: { kind, plan, doc }
  const [pending, setPending] = useState(null);
  // Commands applied earlier IN THIS DOCUMENT (context for the AI: "change it back"). At most 3, in memory only;
  // emptied whenever another document is opened (loadIntoEditor), never saved, never shared between documents.
  const recentCommands = useRef([]);
  const currentCommand = useRef(''); // the command being handled now (remembered once it is really applied)
  const openedWindows = useRef(0); // counts confirmation / preview windows (tells Apply Edit that a window opened)
  const inputsWaitForWindow = useRef(false); // Apply Edit's text / file are cleared only when that window applies
  const live = useRef(null);
  const stopMic = useRef(null);
  const segmenter = useRef(null); // cuts the microphone stream into commands (audio mode)
  const queue = useRef([]); // finished commands waiting to be sent: { clip, endedAt, stream }
  const speakingStream = useRef(null); // voice streaming: the stream of the command being spoken now (or null)
  const endedStream = useRef(null); // voice streaming: the stream of the command that just ended (handed to its clip)
  const voiceTiming = useRef(null); // times of the voice command being processed (console line only)
  const working = useRef(false);
  const submitting = useRef(false); // Apply Edit is running (blocks a double click before the button re-renders)
  const requests = useRef(null); // the AI requests still waiting for an answer (lib/requestGuard.js)
  if (!requests.current) requests.current = createRequestTracker();
  const lastActivity = useRef(0);
  const fileInput = useRef(null);
  const attachInput = useRef(null);
  const imageInput = useRef(null);
  const saveTimer = useRef(null);
  const toastTimer = useRef(null);
  const [summaries, setSummaries] = useState(listSummaries);
  const [templateDocs, setTemplateDocs] = useState(listTemplateDocs); // documents made from department templates
  // What is open in the editor right now: a summary id, or "tdoc:<document id>" for a document made from a template
  const currentId = useRef(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      FontSize,
      LineHeight,
      Image.configure({ allowBase64: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Flash,
      Placeholders, // grey {{placeholders}} in template documents (looks only)
    ],
    content: '',
    onUpdate: ({ editor: ed }) => {
      editorRef.current = ed;
      setSaved(false);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => flushSave(), 600);
    },
  });
  // Always the live editor. (onUpdate above was created before the editor existed,
  // so it must not rely on the "editor" variable of that first render.)
  const editorRef = useRef(null);
  editorRef.current = editor;

  // Saves the open summary now (also called before switching to another summary,
  // so the last typed letters are never saved into the wrong summary)
  function flushSave() {
    if (!saveTimer.current) return; // nothing changed since the last save (just looking does not save)
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed || !currentId.current) return;
    try {
      const key = currentId.current;
      if (key.startsWith('tdoc:')) setTemplateDocs(saveTemplateDocHtml(key.slice(5), ed.getHTML(), ed.state.doc));
      else setSummaries(saveSummaryHtml(key, ed.getHTML(), ed.state.doc));
      setSaved(true);
    } catch (e) {
      setError(e.message);
    }
  }

  // The department template open in the editor, or null for a discharge summary.
  // Read from the ref (not from the page address) because voice commands run in callbacks
  // that were created earlier and would otherwise see an old value.
  function openTemplateId() {
    const key = currentId.current || '';
    return key.startsWith('tdoc:') ? getTemplateDocMeta(key.slice(5))?.templateId || '' : '';
  }

  // Puts a document into the editor with a FRESH undo memory,
  // so Undo can never bring back text from a different summary.
  function loadIntoEditor(html) {
    editor.commands.setContent(html || '<p></p>', false);
    editor.view.updateState(EditorState.create({ doc: editor.state.doc, plugins: editor.state.plugins }));
    setHistory([]);
    setNote(''); setError(''); setTranscript(''); setReply('');
    setAttached(null); setInstruction('');
    recentCommands.current = []; // context never goes from one document (patient) to another
    setSaved(true);
  }

  // The reading voice is chosen automatically: the best female voice the browser has
  // (Microsoft Neerja Online (Natural) in Edge).
  useEffect(() => watchVoices(setVoices), []);
  const activeVoice = voices[0];

  function showToast(message) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4000);
  }

  // ---------- open the base .docx ----------
  async function openDocx(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const html = await docxToHtml(file);
      // A Word file always becomes a NEW summary; the open one is kept as it is
      const { summary, list } = createSummary(html);
      setSummaries(list);
      go(`summaries/${summary.id}`);
    } catch (err) {
      console.error(err);
      setError('Could not read that .docx file');
    }
    e.target.value = '';
  }

  // ---------- insert an image into the page ----------
  function insertImage(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => editor.chain().focus().setImage({ src: reader.result }).run();
    reader.readAsDataURL(file);
  }

  // ---------- one edit (used by voice AND by Apply Edit) ----------
  // scroll: bring the changed line into view if it is off-screen (batches scroll once at the end instead)
  // collect: a list to put the History entry in, instead of adding it to History straight away
  //          (runEdits makes ONE History entry for a whole instruction)
  // confirmedReplace: only from Apply in the window of a whole-section replacement (see runEdits, I.)
  // R3 (D5): the edit is applied as Gemini returned it; the app no longer rewrites age / gender after it (Gemini keeps
  // the patient's age and gender consistent itself)
  function handleEdit(args, { scroll = true, fromFile = false, collect = null } = {}) {
    const r = applyVoiceEdit(editor, args, { fromFile });
    if (!r.ok) return { ok: false, error: r.error, blocked: r.blocked };
    if (scroll && r.pos != null) scrollToPos(editor, r.pos, true);
    const entry = {
      label: args.field_label || args.block_id,
      before: r.before || '(empty)',
      after: r.after || '(empty)',
      at: new Date().toLocaleTimeString(),
    };
    if (collect) collect.push(entry);
    else setHistory((h) => [entry, ...h]);
    return { ok: true, new_text: r.after };
  }

  // Adds the automatic age/gender fixes to History (one entry). Returns how many blocks changed.
  // collect: as in handleEdit
  function recordConsistency(changes, collect = null) {
    if (!changes.length) return 0;
    const entry = {
      label: `Age / gender made consistent (${changes.length} place${changes.length > 1 ? 's' : ''})`,
      before: changes.map((c) => c.before).join(' | '),
      after: changes.map((c) => c.after).join(' | '),
      at: new Date().toLocaleTimeString(),
    };
    if (collect) collect.push(entry);
    else setHistory((h) => [entry, ...h]);
    return changes.length;
  }

  // Validate -> Fix age / gender everywhere (also after typing by hand)
  function fixConsistency() {
    const n = recordConsistency(ensurePatientConsistency(editor));
    if (n) scrollToFirstChange(editor);
    showToast(n ? `Fixed ${n} place${n > 1 ? 's' : ''} so age and gender match the header` : 'Age and gender already match everywhere');
  }

  function undo() {
    if (!history.length) return;
    editor.commands.undo();
    setHistory(history.slice(1));
  }

  // ---------- validate ----------
  function validate() {
    const n = findMissingFields(editor);
    showToast(
      n
        ? `${n} field${n > 1 ? 's are' : ' is'} still "Not Specified" (highlighted)`
        : 'No missing fields found'
    );
  }

  // ---------- read aloud ----------
  function stopReadingNow() {
    stopReading(editor);
    setReading(false);
  }

  function toggleRead() {
    if (reading) return stopReadingNow();
    if (!ttsSupported()) {
      setError('This browser does not support reading aloud');
      return;
    }
    setError('');
    setReading(true);
    const tpl = findTemplateById(openTemplateId())?.tpl;
    readDocument(editor, {
      voiceName: activeVoice?.name,
      rate: READ_RATE,
      ...(tpl ? { introText: `Reading the ${tpl.name} now.` } : {}), // summaries keep their usual opening line
      onEnd: () => setReading(false),
    });
  }

  // While reading, a click inside the document restarts the reading from the clicked sentence
  useEffect(() => {
    if (!RESTART_ON_CLICK || !reading || !editor) return undefined;
    const dom = editor.view.dom;
    let timer;

    const onClick = () => {
      clearTimeout(timer);
      // small delay: lets the editor move the cursor to the clicked place first (and ignores a double click)
      timer = setTimeout(() => {
        readDocument(editor, {
          voiceName: activeVoice?.name,
          rate: READ_RATE,
          intro: false, // no opening line, just continue from where you clicked
          onEnd: () => setReading(false),
        });
      }, 150);
    };

    dom.addEventListener('click', onClick);
    return () => {
      clearTimeout(timer);
      dom.removeEventListener('click', onClick);
    };
  }, [reading, editor, activeVoice]);

  // Cancel in the confirm window: the document is not touched
  function cancelPending() {
    setPending(null);
    setNote('Cancelled. Nothing was changed.');
    windowClosed(false); // Apply Edit keeps the typed text / file
  }

  // ---------- windows, Apply Edit inputs and the recent-commands context ----------
  // Every confirmation / preview window opens through here (the command it belongs to is kept with it)
  function openPending(p) {
    openedWindows.current++;
    setPending({ ...p, command: currentCommand.current });
  }
  // Apply / Clear section in a window: did the document really change? Then the command is remembered and the
  // Apply Edit inputs that opened the window are cleared. Otherwise they stay.
  function finishWindow(p, apply) {
    const before = editor.state.doc;
    apply();
    const applied = !editor.state.doc.eq(before);
    if (applied && p?.command) remember(p.command);
    windowClosed(applied);
  }
  function windowClosed(applied) {
    if (inputsWaitForWindow.current && applied) clearInputs();
    inputsWaitForWindow.current = false;
  }
  function clearInputs() {
    setAttached(null);
    setInstruction('');
  }
  function remember(command) {
    const c = String(command || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (c) recentCommands.current = [...recentCommands.current, c].slice(-3);
  }
  // The block the cursor is in ("this paragraph", "this date"), e.g. "B12", or ''
  function cursorBlockId() {
    const from = editor.state.selection.from;
    const b = getBlocks(editor.state.doc).find((x) => from > x.pos && from < x.pos + x.node.nodeSize);
    return b ? `B${b.index}` : '';
  }

  // Applies the AI's edits (in bottom-up order) as ONE undo step with ONE History entry, and shows what happened.
  // Used for typed / spoken commands and for uploads. R3 (D5): no age / gender rewriting by the app afterwards.
  function applyAiEdits({ ordered, fromFile = false, label, text = '', heard = '', file = null,
    summary = '', voice = false, blockedFirst = [], aiEditCount = ordered.length }) {
    let applied = 0;
    const failed = []; // edits the editor could not make: { code, label } (the reason is shown, not only a count)
    let noEffect = 0; // edits that "succeeded" but did not change the document
    const blockedWhy = [...blockedFirst]; // edits refused by a technical check (locked label, missing text ...)
    const entries = []; // History entries of this instruction: added as ONE entry below
    // Everything this instruction changes is ONE undo step, even when the changes are far apart
    asOneUndoStep(editor.view, () => {
      for (const ed of ordered) {
        const docBefore = editor.state.doc;
        const r = handleEdit(ed, { scroll: false, fromFile, collect: entries });
        // Honest counting: an edit only counts when the document REALLY changed
        // (e.g. replacing a text with the same text "succeeds" but changes nothing)
        const changed = r.ok && !editor.state.doc.eq(docBefore);
        if (r.ok && !changed) entries.pop(); // its History entry (handleEdit added exactly one): nothing to record
        if (r.ok && !changed) noEffect++;
        else if (r.ok) applied++;
        else if (r.blocked) blockedWhy.push(`${ed.field_label || ed.block_id}: ${r.error}`);
        else failed.push({ code: reasonCode(r), label: ed.field_label || '' });
      }
    }); // end of the one undo step
    // ONE History entry for the whole instruction, listing every place it changed
    // (one Undo click in History = this whole instruction)
    if (entries.length) {
      const said = String(text || heard || file?.name || label).trim();
      const short = said.length > 60 ? `${said.slice(0, 57)}…` : said;
      const places = [...new Set(entries.map((e) => e.label))];
      setHistory((h) => [
        {
          label: `"${short}": ${places.join(', ')}`,
          before: entries.map((e) => `${e.label}: ${e.before}`).join(' | '),
          after: entries.map((e) => `${e.label}: ${e.after}`).join(' | '),
          at: new Date().toLocaleTimeString(),
        },
        ...h,
      ]);
    }

    if (applied) {
      if (voice) {
        // spoken edit: only scroll when the change is out of view
        const ranges = getFlashRanges(editor.state);
        if (ranges.length) scrollToPos(editor, Math.min(...ranges.map((r) => r.from)), true);
      } else {
        scrollToFirstChange(editor); // every changed part is highlighted: jump to the first one
      }
    }

    const head = applied
      ? `${applied} change${applied > 1 ? 's' : ''} applied from ${label}. Changed parts are highlighted in yellow.`
      : `No changes were made from ${label}.`;
    const blockedNote = blockedWhy.length
      ? `🔒 Blocked ${blockedWhy.length} change${blockedWhy.length > 1 ? 's' : ''} (${blockedWhy.join('; ')}).`
      : '';
    // The AI's own summary describes what it TRIED. Show it only when something was applied. When the AI
    // returned no edit at all, its text is a question or explanation ("Which date do you mean?"): show it as such.
    // When it returned edits but none could be applied, its "done" summary would be wrong: leave it out.
    const aiNote = applied ? summary : aiEditCount === 0 && summary ? `AI: ${summary}` : '';
    const noEffectNote = noEffect ? `${noEffect} edit${noEffect > 1 ? 's' : ''} from the AI did not change anything.` : '';
    setNote([head, blockedNote, notAppliedNote(failed), noEffectNote, aiNote].filter(Boolean).join(' '));
    // console (F12): fixed reason codes and a count only, never document text (lib/editFailure.js)
    const codes = [...failed.map((f) => f.code), ...blockedWhy.map(() => 'rejected_by_check')];
    if (codes.length) console.info(editFailureLine(codes));
  }

  // R4 (D3): Apply in the deletion confirmation window (a command or an uploaded file that removes existing text):
  // the ticked changes, as ONE undo step with ONE History entry. Cancel changes nothing.
  function applyCommandPreview({ selected }) {
    const p = pending;
    setPending(null);
    if (!p) return;
    if (!selected.size) {
      setNote('Nothing was selected, so nothing was changed.');
      return;
    }
    if (!editor.state.doc.eq(p.doc)) {
      setNote('The document changed while the window was open, so nothing was changed. Please give the command again.');
      return;
    }
    applyAiEdits({
      ordered: p.ordered.filter((_, i) => selected.has(i)),
      fromFile: Boolean(p.fromFile),
      label: p.label,
      text: p.text,
      heard: p.heard,
      file: p.fromFile ? { name: p.fileName } : null,
      summary: p.summary,
      voice: p.voice,
      aiEditCount: p.ordered.length,
    });
  }

  // A file is checked as soon as it is attached (file picker or drag-and-drop): a wrong type is never sent
  function attachFile(file) {
    if (!file) return;
    const c = checkFile(file);
    if (c.error) {
      setAttached(null);
      setError(c.error);
      return;
    }
    setError('');
    setAttached(file);
  }

  // ---------- send a file / text / voice clip to the server and apply the edits it returns ----------
  // voice = true: a spoken command. It does not touch the Apply Edit button.
  // stream (voice streaming only): the answer of this clip was asked for WHILE it was spoken (lib/voiceStream.js); it
  // is used exactly like the HTTP answer below. A problem of the stream itself -> the HTTP path with the same clip.
  async function runEdits({ file = null, text = '', audio = null, label, voice = false, stream = null }) {
    const docAtStart = editor.state.doc;
    stopReadingNow();
    setError('');
    setNote('');
    if (!voice) setTranscript(''); // the "You: ..." line of an earlier voice command does not belong to this request
    currentCommand.current = file ? '' : text; // files are never remembered as a command
    if (!voice) setApplying(true);
    try {

      const timing = voice ? voiceTiming.current : null; // voice commands only: numbers for the console line
      if (timing) timing.requestFrom = performance.now();
      // The request may be cancelled (another document opened) and stops after the time limit; the progress text
      // tells the person what is happening while waiting. Nothing in the document changes until the answer is here.
      const ticket = requests.current.start(currentId.current);
      const stopProgress = startProgress(file ? 'file' : voice ? 'voice' : 'typed', setProgress);
      let answer;
      try {
        const request = {
          signal: ticket.signal,
          file,
          instruction: text,
          audio,
          outline: buildOutline(editor.state.doc), // fresh snapshot of the document at this moment
          today: todayString(),
          templateId: openTemplateId(), // '' for discharge summaries
          // commands only (never files): where the cursor is, and the commands applied earlier in THIS document
          ...(file ? {} : { cursorBlock: cursorBlockId(), recent: recentCommands.current }),
        };
        answer = stream
          ? await stream.result({ signal: ticket.signal }).catch((e) => {
            if (!e?.fallback) throw e; // the AI's own answer (busy, quota, too slow), a time-out or a cancel: as on HTTP
            return extractEdits(request); // the stream itself failed: the existing HTTP voice path, same clip
          })
          : await extractEdits(request);
      } finally {
        stopProgress();
        ticket.done();
      }
      // the document this answer was made for is no longer open (or the request was cancelled): never applied
      if (ticket.isStale(currentId.current)) return 'stale';
      if (timing) timing.answerAt = performance.now();
      const { edits: aiEdits, summary: aiSummary } = answer;
      // heard is the transcript of a VOICE command; for typed text the AI may echo the text, which is not used
      const heard = audio ? answer.heard || '' : '';
      if (heard) setTranscript(heard);
      if (heard) currentCommand.current = [text, heard].filter(Boolean).join(' ');

      // R3 / R4 (D1, D3, D4, D7): Gemini decides the edits, and they are applied as Gemini returned them - for typed,
      // spoken and streamed commands AND for uploaded files (with or without an instruction). Only technical checks
      // (applyVoiceEdit: R1 missing text, the block exists, the text to be replaced exists, locked headings / labels).
      const summary = file ? aiSummary : summaryToShow(aiSummary);
      // Apply from the bottom of the document upwards, so a newly inserted line
      // never shifts the blocks that are still waiting to be edited.
      const ordered = bottomUp(aiEdits);
      const fromFile = Boolean(file);
      const doc = editor.state.doc;
      // SEVERAL edits are all or nothing: the same dry run as Apply (lib/previewEdits.js) on a copy; one edit that
      // cannot be applied (a technical check) means NOTHING changes. One edit: applied (or refused) below.
      if (ordered.length > 1) {
        const batchDry = previewEdits(doc, ordered, { fromFile });
        if (batchDry.blocked.length) {
          setNote(`🔒 Nothing was changed: ${batchDry.blocked.map((b) => `${b.field}: ${b.reason}`).join('; ')}.`);
          return true;
        }
      }
      // R4 (D3): an edit that DELETES existing text (clear, set "", replace_text with "") - decided by the operation
      // only: the whole command is shown in the confirmation window first (removed text struck through); nothing
      // changes until Apply. Everything else is applied directly (highlighted, one Undo step, History).
      if (hasDeletion(doc, ordered)) {
        const dry = previewEdits(doc, ordered, { fromFile });
        if (dry.blocked.length) {
          setNote(`🔒 Nothing was changed: ${dry.blocked.map((b) => `${b.field}: ${b.reason}`).join('; ')}.`);
          return true;
        }
        openPending({
          kind: 'command', doc, ordered, preview: dry, label, text, heard, voice, summary, fromFile, fileName: file?.name || '',
          recompute: (selected) => previewEdits(doc, ordered, { fromFile, selected }),
          notice: 'This removes existing text (struck through below). Check it, then press Apply - nothing is changed until then.',
        });
        setNote('Please check the window: this removes existing text. Nothing has been changed yet.');
        return true;
      }
      const applyFrom = performance.now();
      applyAiEdits({ ordered, fromFile, label, text, heard, file, summary, voice, aiEditCount: aiEdits.length });
      if (timing) timing.applyMs = performance.now() - applyFrom;
      return true;
    } catch (err) {
      if (isCancelled(err)) return 'stale'; // another document was opened: nothing to show here
      if (!isTimeout(err)) console.error(err);
      // say clearly that nothing changed (the request failed before any edit; checked, not assumed)
      const msg = err.message || 'Unable to process this instruction. Please try again.';
      const unchanged = editor.state.doc.eq(docAtStart) && !msg.includes(NOT_CHANGED);
      setError(unchanged ? `${msg} ${NOT_CHANGED}` : msg);
      return false;
    } finally {
      if (!voice) setApplying(false);
    }
  }

  // runEdits, then: what happened? 'applied' (the document changed), 'window' (a confirmation / preview window
  // opened; nothing changed yet), 'none' (a question, a safety refusal, nothing to change) or 'error'.
  // A command that really changed the document is remembered as context for the next commands.
  async function runAndReport(args) {
    const docBefore = editor.state.doc;
    const windowsBefore = openedWindows.current;
    const ok = await runEdits(args);
    if (!ok) return 'error';
    if (ok === 'stale') return 'none'; // its document was closed while waiting: nothing applied, nothing remembered
    if (openedWindows.current !== windowsBefore) return 'window';
    if (editor.state.doc.eq(docBefore)) return 'none';
    if (!args.file) remember(currentCommand.current);
    return 'applied';
  }

  // ---------- Apply Edit button: attached file and/or typed instruction ----------
  // The typed text and the file are cleared only when the document REALLY changed. After a question, a safety
  // refusal or an error they stay, so the person can correct them and press Apply Edit again. When a window
  // opens, they are cleared only if Apply in that window changes the document (Cancel keeps them).
  async function handleApply() {
    if (!attached && !instruction.trim()) return;
    if (submitting.current) return; // already running: a second click never sends the instruction twice
    submitting.current = true;
    try {
      const outcome = await runAndReport({
        file: attached,
        text: instruction,
        label: attached ? `"${attached.name}"` : 'your instruction',
      });
      if (outcome === 'applied') clearInputs();
      else if (outcome === 'window') inputsWaitForWindow.current = true;
    } finally {
      submitting.current = false;
    }
  }

  // ---------- microphone, audio mode: always listening, one command per pause ----------
  // Finished commands go into a queue and are applied one after another.
  async function processQueue() {
    if (working.current) return;
    working.current = true;
    setProcessing(true);
    try {
      while (queue.current.length) {
        const { clip, endedAt, stream: spoken = null } = queue.current.shift();
        const startedAt = performance.now();
        const { base64, seconds } = pcmChunksToWav(clip);
        if (seconds < 0.5) { spoken?.cancel(); continue; }
        // voice streaming: its answer belongs to the document AS IT WAS when the person started speaking. If anything
        // changed since (an edit, another document), the stream is dropped and the HTTP path below sends the clip
        // with the document as it is now - exactly as without streaming.
        let stream = spoken;
        if (stream && (stream.docKey !== currentId.current || !editor.state.doc.eq(stream.docAtStart))) {
          stream.cancel();
          stream = null;
        }
        const timing = {};
        voiceTiming.current = timing;
        const outcome = await runAndReport({ audio: { base64, mimeType: 'audio/wav' }, label: 'your voice command', voice: true, stream });
        voiceTiming.current = null;
        // numbers and a fixed outcome word only (lib/timing.js); total = end of speaking (the pause) -> document updated
        const done = performance.now();
        console.info(voiceTimingLine({
          clip_s: seconds, queue_wait_ms: startedAt - endedAt,
          request_ms: timing.answerAt - timing.requestFrom, browser_ms: done - timing.answerAt, apply_ms: timing.applyMs,
          total_ms: done - endedAt, outcome,
        }));
      }
    } finally {
      working.current = false;
      setProcessing(false);
    }
  }

  function enqueueClip(clip) {
    const stream = endedStream.current; // voice streaming: the stream of THIS clip (set just before, by vad.js)
    endedStream.current = null;
    if (queue.current.length >= MAX_QUEUE) {
      stream?.cancel();
      showToast('Too many commands waiting. Please wait a moment.');
      return;
    }
    queue.current.push({ clip, endedAt: performance.now(), stream }); // endedAt: when the pause ended the command (for the timing line)
    processQueue();
  }

  // ---------- voice streaming (lib/voiceStream.js; only when built with ENABLE_VOICE_STREAMING=true) ----------
  // A stream is opened ONLY when no other voice command is waiting or being handled: its answer is made for the
  // document as it is now, so a command spoken while an earlier one is still being applied uses the HTTP path (its
  // document is read when its turn comes, as before). The queue still handles one command at a time.
  function startStream(startChunks) {
    speakingStream.current?.cancel();
    speakingStream.current = null;
    if (!streamingOn() || !editor || working.current || queue.current.length || !currentId.current) return;
    const stream = createVoiceStream({
      start: { outline: buildOutline(editor.state.doc), today: todayString(), templateId: openTemplateId() },
      startChunks,
    });
    stream.docAtStart = editor.state.doc;
    stream.docKey = currentId.current;
    speakingStream.current = stream;
  }
  // the command ended (vad.js): its stream sends the clip's tail and "end" - or is dropped (too short to be a command)
  function endStream({ kept, sent }) {
    const stream = speakingStream.current;
    speakingStream.current = null;
    if (!stream) return;
    if (!sent) { stream.cancel(); return; }
    stream.finish(kept);
    endedStream.current = stream; // handed to the clip in enqueueClip (called right after this by vad.js)
  }

  function stopListening() {
    if (!stopMic.current) return; // already stopped
    stopMic.current();
    stopMic.current = null;
    segmenter.current?.flush(); // a command you are still saying is sent, not lost
    segmenter.current = null;
    setHearing(false);
    setStatus('idle');
  }

  async function startAudioMic() {
    try {
      stopReadingNow(); // the speaker must not feed into the mic
      setError(''); setTranscript(''); setReply(''); setNote('');
      for (const q of queue.current) q.stream?.cancel(); // voice streaming: dropped clips close their streams too
      queue.current = [];
      lastActivity.current = Date.now();
      segmenter.current = createSegmenter({
        onSpeechStart: () => {
          lastActivity.current = Date.now();
          setHearing(true);
        },
        onSegment: (clip) => {
          lastActivity.current = Date.now();
          setHearing(false);
          enqueueClip(clip);
        },
        // voice streaming only (each does nothing when it is off): a stream is opened only once the command has the
        // minimum voiced audio (500 ms) - a cough or a click never opens one; then what vad.js reports is passed to it
        onSpeechConfirmed: (chunksSoFar) => startStream(chunksSoFar),
        onSegmentChunk: (chunk, loud) => speakingStream.current?.push(chunk, loud),
        onSegmentEnd: endStream,
      });
      stopMic.current = await startCapture((chunk, rms) => {
        segmenter.current?.push(chunk, rms);
        if (Date.now() - lastActivity.current > IDLE_STOP_MS) {
          stopListening();
          showToast('Microphone turned off after 5 minutes without speech.');
        }
      });
      setStatus('listening');
    } catch (e) {
      console.error(e);
      segmenter.current = null;
      setError('Could not use the microphone. Allow microphone access for this site and try again.');
      setStatus('idle');
    }
  }

  // ---------- microphone ----------
  async function toggleMic() {
    if (VOICE_MODE === 'audio') {
      if (status === 'listening') stopListening();
      else await startAudioMic();
      return;
    }

    // live mode
    if (status === 'listening') {
      stopMic.current?.();
      live.current?.endAudio();
      setStatus('idle');
      setTimeout(() => live.current?.close(), 4000);
      return;
    }
    try {
      stopReadingNow(); // the speaker must not feed into the mic
      setError(''); setTranscript(''); setReply(''); setNote('');
      setStatus('connecting');
      live.current = await startLive({
        outline: buildOutline(editor.state.doc), // fresh snapshot every time the mic opens
        onEdit: handleEdit,
        onTranscript: (t) => setTranscript((p) => p + t),
        onModelText: (t) => setReply((p) => p + t),
        onError: (e) => setError(e?.message || 'Connection error'),
        onClose: (e) => {
          stopMic.current?.();
          setStatus('idle');
          if (e?.reason) setError(`Session closed: ${e.reason}`);
        },
      });
      stopMic.current = await startCapture((chunk) => live.current?.sendAudio(chunk));
      setStatus('listening');
    } catch (e) {
      console.error(e);
      setError(e.message || 'Could not start voice editing');
      setStatus('idle');
    }
  }

  // What the Mic label says while the voice feature is working
  const micDetail =
    status === 'listening'
      ? hearing
        ? 'Hearing you…'
        : processing
          ? 'Applying your last command…'
          : 'Listening… speak, then pause'
      : processing
        ? 'Applying your command…'
        : '';

  // ---------- which page is open ----------
  const route = useRoute();
  const page = KNOWN_PAGES.has(route[0]) ? route[0] : DEFAULT_PAGE; // unknown address -> Summaries
  // #/summaries/<id>                   -> that summary in the editor
  // #/templates/<department>/doc/<id>   -> a document made from a template, in the SAME editor
  const openId = page === 'summaries' ? route[1] || null : null;
  const openSummary = openId ? summaries.find((s) => s.id === openId) : null;
  const tplDept = page === 'templates' && route[1] ? findDepartment(route[1]) : null;
  const openDoc = tplDept && route[2] === 'doc' && route[3] ? templateDocs.find((d) => d.id === route[3]) || null : null;
  const openTemplate = openDoc ? findTemplate(openDoc.deptId, openDoc.templateId) : null;
  const openKey = openSummary ? openSummary.id : openDoc ? `tdoc:${openDoc.id}` : null;
  const onEditor = Boolean(openKey);

  // Opening a document (or leaving it): save the previous one, then load the new one
  useEffect(() => {
    if (!editor) return;
    if (currentId.current === openKey) return;
    requests.current.cancelAll(); // an answer for the previous document must never land in this one
    flushSave();
    currentId.current = openKey;
    if (openSummary) {
      loadIntoEditor(getSummaryHtml(openSummary.id));
    } else if (openDoc) {
      loadIntoEditor(getTemplateDocHtml(openDoc.id));
    } else if (openId) {
      go('summaries'); // the address points to a summary that does not exist
    } else if (tplDept && route[2]) {
      go(`templates/${tplDept.id}`); // unknown template
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, openKey]);

  // "Open" on a template: always a NEW document from a fresh copy of the template
  function openNewFromTemplate(deptId, tplId) {
    const dept = findDepartment(deptId);
    const tpl = findTemplate(deptId, tplId);
    if (!dept || !tpl) return;
    try {
      const { doc, list } = createTemplateDoc(tpl, deptId, templateStartHtml(tpl, dept));
      setTemplateDocs(list);
      go(`templates/${deptId}/doc/${doc.id}`);
    } catch (e) {
      showToast(e.message);
    }
  }

  const title = openSummary
    ? [openSummary.patient?.name || 'Unnamed patient', openSummary.caseNo].join(' · ')
    : openDoc
      ? [
          `${tplDept.name} › ${openTemplate?.name || 'Document'}${openTemplate?.status === 'demo' ? ' (Demo)' : ''}`,
          openDoc.patientName,
        ].filter(Boolean).join(' · ')
      : 'Untitled document';
  const back = openDoc
    ? { label: `← ${tplDept.name}`, go: () => go(`templates/${tplDept.id}`) }
    : { label: '← Summaries', go: () => go('summaries') };

  // Leaving the editor screen: stop the microphone and reading, so nothing keeps running in the background
  useEffect(() => {
    if (onEditor) return;
    if (status === 'listening') toggleMic();
    if (reading) stopReadingNow();
    setPending(null); // a confirm window that was still open is closed without changing anything
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onEditor]);

  return (
    <div className="shell">
    <AppHeader />
    <div className="shell-body">
    <Sidebar active={page} />

    {page === 'summaries' && !onEditor && (
      <Summaries
        summaries={summaries}
        onOpen={(id) => go(`summaries/${id}`)}
        onImport={() => fileInput.current?.click()}
        onChange={(id, changes) => setSummaries(updateSummary(id, changes))}
        onDelete={(id) => setSummaries(deleteSummary(id))}
      />
    )}
    {page === 'dashboard' && (
      <Placeholder title="Dashboard">
        <p>Welcome. Use <a href="#/summaries">Summaries</a> to edit discharge summaries, or <a href="#/templates">Templates</a> for department documents.</p>
      </Placeholder>
    )}
    {page === 'create-summary' && (
      <Placeholder title="Create Summary">
        <p>Discharge summary creation is available through the existing <a href="#/summaries">Summaries</a> workflow.</p>
      </Placeholder>
    )}
    {page === 'templates' && !onEditor && (
      <Templates
        deptId={route[1]}
        docs={templateDocs}
        onOpen={openNewFromTemplate}
        onContinue={(d) => go(`templates/${d.deptId}/doc/${d.id}`)}
        onDelete={(id) => setTemplateDocs(deleteTemplateDoc(id))}
      />
    )}
    {page === 'activity' && (
      <Placeholder title="Activity">
        <p className="muted">Coming in a later step.</p>
      </Placeholder>
    )}
    {page === 'settings' && (
      <Placeholder title="Settings">
        <p className="muted">No settings yet.</p>
      </Placeholder>
    )}

    {/* The existing editor screen. It is only HIDDEN on other pages, never removed,
        so the document, history and undo are kept while you look at other pages. */}
    <input ref={fileInput} type="file" accept=".docx" hidden onChange={openDocx} />
    <div className="app" hidden={!onEditor}>
      <input
        ref={attachInput}
        type="file"
        accept={FILE_ACCEPT}
        hidden
        onChange={(e) => {
          attachFile(e.target.files?.[0] || null);
          e.target.value = '';
        }}
      />
      <input ref={imageInput} type="file" accept="image/*" hidden onChange={insertImage} />

      <TopBar
        editor={editor}
        title={title}
        onBack={back.go}
        backLabel={back.label}
        saved={saved}
        userInitial={USER_INITIAL}
        onOpen={() => fileInput.current?.click()}
        onExportDocx={() => exportDocx(editor)}
        onPrint={() => window.print()}
        onInsertImage={() => imageInput.current?.click()}
        onZoom={setZoom}
        onValidate={validate}
        onFixConsistency={fixConsistency}
      />
      <FormatBar
        editor={editor}
        zoom={zoom}
        onZoom={setZoom}
        onPrint={() => window.print()}
        onInsertImage={() => imageInput.current?.click()}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
      />

      <div className="workspace">
        <div className="canvas">
          <Ruler />
          <DocEditor editor={editor} zoom={zoom} className={openDoc ? 'tpl-doc' : ''} />
        </div>
        <SidePanel
          status={status}
          micDetail={micDetail}
          onMic={toggleMic}
          reading={reading}
          onRead={toggleRead}
          applying={applying}
          transcript={transcript}
          reply={reply}
          note={note}
          error={error}
          attached={attached}
          onPickFile={() => attachInput.current?.click()}
          onDropFile={attachFile}
          onClearFile={() => setAttached(null)}
          instruction={instruction}
          onInstruction={setInstruction}
          onApply={handleApply}
          progress={progress}
          history={history}
          onUndo={undo}
        />
      </div>

    </div>
    </div>
    {pending && onEditor && (
      <UploadPreview summary={pending.summary} preview={pending.preview} recompute={pending.recompute}
        command={{ notIncluded: pending.blockedFirst, notice: pending.notice }}
        onApply={(c) => finishWindow(pending, () => applyCommandPreview(c))} onCancel={cancelPending} />
    )}
    {toast && <div className="toast">{toast}</div>}
    </div>
  );
}