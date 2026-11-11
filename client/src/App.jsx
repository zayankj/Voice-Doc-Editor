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
import { applyVoiceEdit, applyPatientConsistency, ensurePatientConsistency, getPatientFacts } from './lib/voiceEdit';
import { scrollToPos, scrollToFirstChange } from './lib/scroll';
import { findMissingFields } from './lib/validate';
import { genderChangeAllowed } from './lib/guards';
import { clearSection } from './lib/sectionCommands';
import { applyRemovals, textAfter, removalSummary } from './lib/medicineText';
import { classifyCommand } from './lib/commandIntent';
import { understoodFrom, malayalamStop, checkInterpretation, needsPreview, interpretForPreview, englishChecksCannotRead, summaryToShow } from './lib/interpretation';
import { asOneUndoStep } from './lib/undoStep';
import { checkNamedSection, checkTableEdits } from './lib/verify';
import ConfirmChanges from './components/ConfirmChanges';
import ConfirmClear from './components/ConfirmClear';
import UploadPreview from './components/UploadPreview';
import { startLive } from './lib/liveClient';
import { startCapture } from './lib/audio';
import { createSegmenter } from './lib/vad';
import { pcmChunksToWav } from './lib/wav';
import { exportDocx } from './lib/exportDocx';
import { todayString } from './lib/tools';
import { extractEdits, checkFile, FILE_ACCEPT } from './lib/fileExtract';
import { previewEdits, medicinesLostByEdits } from './lib/previewEdits';
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
  const queue = useRef([]); // finished commands waiting to be sent
  const working = useRef(false);
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
  function handleEdit(args, { scroll = true, allowGender = true, fromFile = false, collect = null } = {}) {
    const factsBefore = getPatientFacts(editor.state.doc);
    const r = applyVoiceEdit(editor, args, { allowGender, fromFile });
    if (!r.ok) return { ok: false, error: r.error, blocked: r.blocked };
    // Header age/gender changed -> also fix "60-year-old female" etc. in the rest of the document
    const synced = applyPatientConsistency(editor, factsBefore);
    if (scroll && r.pos != null) scrollToPos(editor, r.pos, true);
    const at = new Date().toLocaleTimeString();
    // One history entry: the edit and its consistency fixes are undone together
    const extra = synced.length ? ` (+${synced.length} matching place${synced.length > 1 ? 's' : ''} updated)` : '';
    const entry = {
      label: (args.field_label || args.block_id) + extra,
      before: r.before || '(empty)',
      after: r.after || '(empty)',
      at,
    };
    if (collect) collect.push(entry);
    else setHistory((h) => [entry, ...h]);
    return { ok: true, moved: Boolean(r.moved), new_text: r.after, also_updated: synced.map((c) => c.after) };
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

  // ---------- commands done by CODE, not by the AI ----------
  // ONE classifier (lib/commandIntent.js) for typed instructions AND voice transcripts:
  //   clear  "remove everything from the course in hospital"      -> the existing clear-section step
  //   remove "remove generic names from Advice", "remove oral, twice daily and so on"
  //          -> the confirm window; nothing changes before Apply
  //   ask    unclear -> a question, nothing changes
  //   ai     anything else -> the normal AI editing (returns false)
  // Returns true when the command was handled here (done, asked, or shown for confirmation).
  // source: 'typed' | 'voice' (for the message after Apply)
  function runCodeCommand(command, source = 'typed') {
    const c = String(command || '').trim();
    if (!c) return false;
    // the cursor tells which medicine "this medicine" is
    const intent = classifyCommand(editor.state.doc, c, { cursor: editor.state.selection.from });

    if (intent.type === 'ask') {
      setNote(intent.question);
      return true;
    }

    // "Remove everything from <section>" / "make <section> blank": the whole section is emptied in one step
    // (the heading stays; one Undo brings it back).
    if (intent.type === 'clear') {
      // a section with medicines (Advice): ask first; nothing changes until "Clear section"
      if (intent.confirm) {
        openPending({ kind: 'clear', section: intent.section, preview: intent.preview, doc: editor.state.doc });
        setNote('Please check the window, then press Clear section or Cancel. Nothing has been changed yet.');
        return true;
      }
      doClear(intent.section);
      return true;
    }

    if (intent.type !== 'remove') return false; // not a command for code: the AI handles it as before
    return showRemoval(intent, { source });
  }

  // Empties one section in ONE step (one Undo; the heading stays) and records it in History.
  // preview (from the confirmation window): what was listed, so the message says exactly what was removed
  function doClear(section, preview = null) {
    const r = clearSection(editor, section);
    if (!r.ok) {
      setNote(`🔒 Nothing was changed: ${r.error}.`);
    } else if (r.alreadyEmpty) {
      setNote(`${r.title} is already empty. Nothing was changed.`);
    } else {
      setHistory((h) => [
        { label: `${r.title}: section cleared`, before: r.before, after: '(empty)', at: new Date().toLocaleTimeString() },
        ...h,
      ]);
      scrollToPos(editor, r.pos, true);
      const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
      const others = preview ? preview.lines.length - preview.medicines : 0;
      const what = !preview ? 'all content removed'
        : `removed ${[preview.medicines ? n(preview.medicines, 'medicine', 'medicines') : '', others ? n(others, 'other line', 'other lines') : '']
          .filter(Boolean).join(' and ')}`;
      setNote(`${r.title}: ${what} (the heading stays). Use Undo to bring it back.`);
    }
  }

  // "Clear section" in the confirmation window
  function applyClear() {
    const p = pending;
    setPending(null);
    if (!p) return;
    if (!editor.state.doc.eq(p.doc)) {
      setNote('The document changed while the window was open, so nothing was changed. Please give the command again.');
      return;
    }
    doClear(p.section, p.preview);
  }

  // extra = { source, understood, original }: understood/original are shown when the plan came from the
  // AI's interpretation (already checked against the original words by lib/interpretation.js)
  function showRemoval(intent, extra = {}) {
    // Removal: show the preview window. Remember the document as it is now: if it changes while the
    // window is open, the preview is outdated and Apply refuses.
    openPending({
      kind: intent.kind, plan: intent.plan, doc: editor.state.doc,
      source: extra.source || 'typed', understood: extra.understood || '', original: extra.original || '',
    });
    setNote('Please check the changes in the window, then press Apply or Cancel. Nothing has been changed yet.');
    return true;
  }

  // Apply in the confirm window: delete exactly the ticked parts, in ONE step (one Undo)
  function applyPending(planWithChoices) {
    const p = pending;
    setPending(null);
    if (!p) return;
    if (!editor.state.doc.eq(p.doc)) {
      setNote('The document changed while the window was open, so nothing was changed. Please give the command again.');
      return;
    }
    const r = applyRemovals(editor, planWithChoices);
    if (!r.ok) {
      setNote(`Nothing was changed: ${r.error}`);
      return;
    }
    if (!r.lines) {
      setNote('No line was ticked. Nothing was changed.');
      return;
    }
    const lines = planWithChoices.changes.filter((c) => c.removals.some((x) => x.selected));
    // the message says only what was ACTUALLY removed (built from the ticked parts, not from the command)
    const what = removalSummary(planWithChoices, p.kind);
    const title = planWithChoices.section.title;
    const from = p.source === 'voice' ? 'your voice command' : 'your typed instruction';
    setHistory((h) => [
      {
        label: `${title}: ${what}`,
        before: lines.map((c) => c.before).join(' | '),
        after: lines.map((c) => textAfter(c)).join(' | '),
        at: new Date().toLocaleTimeString(),
      },
      ...h,
    ]);
    scrollToFirstChange(editor);
    setNote(`${lines.length} change${lines.length > 1 ? 's' : ''} applied from ${from}. ${what} Changed parts are highlighted in yellow. Use Undo to bring it back.`);
  }

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

  // Applies the AI's edits (already checked and in bottom-up order) as ONE undo step with ONE History entry,
  // and shows what happened. Used for typed / spoken commands, and by Apply in the upload preview.
  // consistency = false: skip the final age / gender step (the user did not tick it in the upload preview)
  function applyAiEdits({ ordered, allowGender, fromFile = false, consistency = true, label, text = '', heard = '', file = null,
    summary = '', voice = false, blockedFirst = [], aiEditCount = ordered.length, keptFacts = [] }) {
    let applied = 0;
    let skipped = 0;
    let noEffect = 0; // edits that "succeeded" but did not change the document
    const blockedWhy = [...blockedFirst]; // edits refused by the checks (table row / locked label / unasked gender change)
    const entries = []; // History entries of this instruction: added as ONE entry below
    let alsoFixed = 0;
    // Patient Details (the header) are the source of age and gender: remembered to tell an explicit change of them
    // apart from text that only MENTIONS another age / sex
    const factsStart = getPatientFacts(editor.state.doc);
    const oldTexts = new Set(getBlocks(editor.state.doc).map((b) => b.node.textContent));
    let usedDetails = null; // the Patient Details written into the new text instead of the dictated age / sex
    // Everything this instruction changes (all AI edits + the age/gender fix) is ONE undo step,
    // even when the changes are far apart ("change the age to 31": table + Presenting Complaint)
    asOneUndoStep(editor.view, () => {
      for (const ed of ordered) {
        const docBefore = editor.state.doc;
        const r = handleEdit(ed, { scroll: false, allowGender, fromFile, collect: entries });
        // Honest counting: an edit only counts when the document REALLY changed
        // (e.g. replacing a text with the same text "succeeds" but changes nothing)
        const changed = r.ok && !editor.state.doc.eq(docBefore);
        if (r.ok && !changed) entries.pop(); // its History entry (handleEdit added exactly one): nothing to record
        if (r.ok && !changed) noEffect++;
        else if (r.ok) applied++;
        else if (r.blocked) blockedWhy.push(`${ed.field_label || ed.block_id}: ${r.error}`);
        else skipped++;
      }

      // Age / gender follow PATIENT DETAILS (the header), which change only when asked:
      //   - Patient Details were changed by this command ("change the age to 45"): every place follows, as before
      //   - otherwise only the text THIS command wrote follows Patient Details ("a 22-year-old male …" is written
      //     with the header's age / sex); no other section and not the header are touched
      if (applied && consistency) {
        const factsNow = getPatientFacts(editor.state.doc);
        const detailsChanged = factsNow.age !== factsStart.age || factsNow.gender !== factsStart.gender;
        const fixes = detailsChanged
          ? ensurePatientConsistency(editor)
          : ensurePatientConsistency(editor, null, (node) => !oldTexts.has(node.textContent));
        alsoFixed = recordConsistency(fixes, entries);
        if (!detailsChanged && fixes.length) { usedDetails = factsNow; alsoFixed = 0; }
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
    const fixedNote = alsoFixed ? `Also updated ${alsoFixed} other place${alsoFixed > 1 ? 's' : ''} so age and gender match everywhere.` : '';
    // the dictated age / sex differed from Patient Details: say so (Patient Details and other sections unchanged)
    const details = usedDetails ? [usedDetails.age && `${usedDetails.age} years`, usedDetails.gender].filter(Boolean).join(', ') : '';
    const factsNote = usedDetails || keptFacts.length
      ? `⚠️ The age or gender in your words differs from Patient Details${details ? ` (${details})` : ''}, so Patient Details were used in the new text${keptFacts.length ? ` and ${keptFacts.join(', ')} ${keptFacts.length > 1 ? 'were' : 'was'} not changed` : ''}. Patient Details were not changed; to change them, say for example "change the age to …".`
      : '';
    // The AI's own summary describes what it TRIED. Show it only when something was applied. When the AI
    // returned no edit at all, its text is a question or explanation ("Which date do you mean?"): show it as such.
    // When it returned edits but none could be applied, its "done" summary would be wrong: leave it out.
    const aiNote = applied ? summary : aiEditCount === 0 && summary ? `AI: ${summary}` : '';
    const noEffectNote = noEffect ? `${noEffect} edit${noEffect > 1 ? 's' : ''} from the AI did not change anything.` : '';
    setNote([head, fixedNote, factsNote, blockedNote, skipped ? `${skipped} could not be applied.` : '', noEffectNote, aiNote].filter(Boolean).join(' '));
  }

  // ---------- upload preview ----------
  // A DRY RUN of the file's edits on a copy of the document (lib/previewEdits.js) is shown in a window.
  // The real document is not touched until Apply.
  function showUploadPreview({ ordered, allowGender, label, text, file, summary }) {
    const doc = editor.state.doc;
    const opts = { allowGender, fromFile: true };
    const preview = previewEdits(doc, ordered, opts);
    if (!preview.items.length && !preview.blocked.length) {
      setNote(`No changes were detected in "${file.name}". The document is unchanged.${summary ? ` AI: ${summary}` : ''}`);
      return;
    }
    // the same dry run for the user's choice of tick boxes (the age / gender step depends on it)
    const recompute = (selected, consistency) => previewEdits(doc, ordered, { ...opts, selected, consistency });
    openPending({ kind: 'upload', doc, ordered, preview, recompute, allowGender, label, text, fileName: file.name, summary });
    setNote('Please check the changes from the file in the window, then press Apply or Cancel. Nothing has been changed yet.');
  }

  // Apply in the upload preview: only the ticked changes, as ONE undo step with ONE History entry
  function applyUpload({ selected, consistency }) {
    const p = pending;
    setPending(null);
    if (!p) return;
    // nothing selected: close the preview; NOTHING runs (no edit, no Undo step, no History entry, no highlight)
    if (!selected.size && !consistency) {
      setNote(`No changes were applied from "${p.fileName}". The document is unchanged.`);
      return;
    }
    if (!editor.state.doc.eq(p.doc)) {
      setNote('The document changed while the window was open, so nothing was changed. Please upload the file again.');
      return;
    }
    applyAiEdits({
      ordered: p.ordered.filter((_, i) => selected.has(i)),
      allowGender: p.allowGender,
      fromFile: true,
      consistency,
      label: p.label,
      text: p.text,
      file: { name: p.fileName },
      summary: p.summary,
      aiEditCount: p.ordered.length,
    });
  }

  // ---------- a command the app cannot check against the person's own words (not English) ----------
  // Approved option A: shown in a window BEFORE anything changes: the person's words, the AI's plain-English
  // "understood", and every change. The existing checks run first, on "understood" (a check that refuses still
  // refuses); the window is added on top of them. Medicine removals and section clears use their existing windows.
  // The windows show only the changes, in English (no extra language / interpretation lines).
  function previewCommand({ original, understood, aiEdits, aiSummary, text, heard, label, voice }) {
    const doc = editor.state.doc;
    const u = String(understood || '').trim();
    // the AI asked a question / changes nothing: show it; nothing changes
    if (!aiEdits.length && (!u || /\?/.test(aiSummary || ''))) {
      setNote(aiSummary ? `AI: ${aiSummary}` : 'The command was not understood clearly. Please say it again, or type it. Nothing was changed.');
      return;
    }
    const r = interpretForPreview(doc, { original, understood: u, cursor: editor.state.selection.from });
    if (r.type === 'ask') {
      setNote(r.question);
      return;
    }
    if (r.type === 'remove') {
      showRemoval(r, { source: voice ? 'voice' : 'typed' }); // the existing medicine window, exactly as for English
      return;
    }
    if (r.type === 'clear') {
      // every section, also those that an English command clears at once
      openPending({ kind: 'clear', section: r.section, preview: r.preview, doc });
      setNote('Please check the window, then press Clear section or Cancel. Nothing has been changed yet.');
      return;
    }
    if (!aiEdits.length) {
      // the interpretation is not a change the app can make (e.g. "removing Tab. DOLO ..."): ask, nothing changes
      setNote('The command was not understood clearly. Please say it again more simply, or type it. Nothing was changed.');
      return;
    }
    // the existing checks, on the AI's restatement plus the person's words (numbers written in digits count)
    const command = `${u} ${original}`;
    const check = checkNamedSection(doc, command, aiEdits);
    if (check.reject) {
      setNote(`🔒 ${check.reject}`);
      return;
    }
    const tableCheck = checkTableEdits(doc, command, check.edits);
    const ordered = bottomUp(tableCheck.edits);
    const allowGender = genderChangeAllowed({ instruction: u, heard: original, hasFile: false });
    const lost = medicinesLostByEdits(doc, ordered, allowGender);
    if (lost >= 2) {
      setNote(`🔒 These AI changes would remove ${lost} medicines at once, so nothing was changed. Several medicines are removed only through ` +
        'the confirmation window.');
      return;
    }
    const opts = { allowGender, fromFile: false };
    const preview = previewEdits(doc, ordered, opts);
    if (!preview.items.length && !preview.blocked.length) {
      setNote(`${tableCheck.blocked.length ? `🔒 ${tableCheck.blocked.join('; ')}. ` : ''}No change can be made from this command. Nothing was changed.`);
      return;
    }
    const recompute = (selected, consistency) => previewEdits(doc, ordered, { ...opts, selected, consistency });
    openPending({
      kind: 'command', doc, ordered, preview, recompute, allowGender, label, text, heard, voice,
      summary: check.moved.length ? check.moved.map((m) => `${m.section}: added 1 line.`).join(' ') : aiSummary,
      blockedFirst: tableCheck.blocked,
      keptFacts: check.skipped || [],
    });
    setNote('Please check the changes in the window, then press Apply or Cancel. Nothing has been changed yet.');
  }

  // Apply in the command window: only the ticked changes, as ONE undo step with ONE History entry
  function applyCommandPreview({ selected, consistency }) {
    const p = pending;
    setPending(null);
    if (!p) return;
    if (!selected.size && !consistency) {
      setNote('Nothing was selected, so nothing was changed.');
      return;
    }
    if (!editor.state.doc.eq(p.doc)) {
      setNote('The document changed while the window was open, so nothing was changed. Please give the command again.');
      return;
    }
    applyAiEdits({
      ordered: p.ordered.filter((_, i) => selected.has(i)),
      allowGender: p.allowGender,
      consistency,
      label: p.label,
      text: p.text,
      heard: p.heard,
      summary: p.summary,
      voice: p.voice,
      blockedFirst: p.blockedFirst,
      aiEditCount: p.ordered.length,
      keptFacts: p.keptFacts || [],
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
  async function runEdits({ file = null, text = '', audio = null, label, voice = false }) {
    stopReadingNow();
    setError('');
    setNote('');
    if (!voice) setTranscript(''); // the "You: ..." line of an earlier voice command does not belong to this request
    currentCommand.current = file ? '' : text; // files are never remembered as a command
    if (!voice) setApplying(true);
    try {
      // Typed command (no file, no voice): commands done by code are recognised BEFORE calling the AI
      if (!file && !audio && runCodeCommand(text, 'typed')) return true;

      const answer = await extractEdits({
        file,
        instruction: text,
        audio,
        outline: buildOutline(editor.state.doc), // fresh snapshot of the document at this moment
        today: todayString(),
        templateId: openTemplateId(), // '' for discharge summaries
        // commands only (never files): where the cursor is, and the commands applied earlier in THIS document
        ...(file ? {} : { cursorBlock: cursorBlockId(), recent: recentCommands.current }),
      });
      const { edits: aiEdits, summary: aiSummary } = answer;
      // heard is the transcript of a VOICE command; for typed text the AI may echo the text, which is not used
      const heard = audio ? answer.heard || '' : '';
      if (heard) setTranscript(heard);
      if (heard) currentCommand.current = [text, heard].filter(Boolean).join(' ');

      // Voice: the AI has turned the speech into text; now check for commands done by code
      if (!file && audio && runCodeCommand([text, heard].filter(Boolean).join(' '), 'voice')) return true;

      // G. (approved option A) Commands the app cannot check against the person's own words (not English):
      //    NEVER applied directly. The AI's plain-English "understood" goes through the existing checks and is shown
      //    in a window next to the person's words; nothing changes until Apply. English commands continue below.
      //    The gateway passes only edits / summary / heard: the AI service puts the interpretation at the start of
      //    summary ("Understood: ...", Option A), so it is read from there.
      if (!file && needsPreview([text, heard].filter(Boolean).join(' '), answer.language)) {
        const meaning = String(answer.understood || '').trim() || understoodFrom(aiSummary);
        currentCommand.current = meaning || currentCommand.current;
        previewCommand({
          original: [text, heard].filter(Boolean).join(' '), understood: meaning,
          aiEdits, aiSummary: summaryToShow(aiSummary), text, heard, label, voice,
        });
        return true;
      }

      // E. (typed and spoken commands, not files) The AI's restatement "Understood: ..." is never trusted by itself.
      //    - a Malayalam command whose action the app cannot check is NEVER carried out (the AI's edits are dropped)
      //    - a medicine removal understood by the AI is re-built by code and checked against the person's own words;
      //      if it matches, the confirm window shows it; if not, the app asks. The AI's own edits are never used.
      if (!file) {
        const original = [text, heard].filter(Boolean).join(' ');
        const understood = understoodFrom(aiSummary);
        const stop = malayalamStop(original, understood);
        if (stop) {
          setNote(stop);
          return true;
        }
        const inter = checkInterpretation(editor.state.doc, { original, understood, cursor: editor.state.selection.from });
        // the words have no English removal word (e.g. Malayalam in English letters reported as English): not
        // rejected; handled like a non-English command (the AI's meaning, the existing checks, a window first)
        if (inter.type === 'ask' && englishChecksCannotRead(original, understood)) {
          const meaning = String(answer.understood || '').trim() || understood;
          currentCommand.current = meaning;
          previewCommand({ original, understood: meaning, aiEdits, aiSummary: summaryToShow(aiSummary), text, heard, label, voice });
          return true;
        }
        if (inter.type === 'ask') {
          setNote(inter.question);
          return true;
        }
        if (inter.type === 'remove') {
          showRemoval(inter, { source: voice ? 'voice' : 'typed', understood: inter.understood, original: inter.original });
          return true;
        }
      }

      // C. When the command names a section ("inside COURSE IN HOSPITAL add ..."), the AI's edits must land
      //    there: added text is moved to that section, other changes elsewhere refuse the whole command.
      //    (Not used for file uploads: a file may update several sections.)
      const check = file ? { edits: aiEdits, moved: [] } : checkNamedSection(editor.state.doc, [text, heard].filter(Boolean).join(' '), aiEdits);
      if (check.reject) {
        setNote(`🔒 ${check.reject}`);
        return true;
      }
      // D. Lab tables: a changed row must be named in the command, and its new number must have been said
      //    (stops a value landing in the wrong row, or a misheard number). Not for files: the file is the source.
      const tableCheck = file ? { edits: check.edits, blocked: [] } : checkTableEdits(editor.state.doc, [text, heard].filter(Boolean).join(' '), check.edits);
      const edits = tableCheck.edits;
      // when text was moved to the right section, the AI's own summary ("added malaria to the diagnosis") is wrong
      // (commands: the "Understood: ..." sentence is used for the checks only, never shown - Option A)
      const summary = check.moved.length ? check.moved.map((m) => `${m.section}: added 1 line.`).join(' ') : file ? aiSummary : summaryToShow(aiSummary);

      // Apply from the bottom of the document upwards, so a newly inserted line
      // never shifts the blocks that are still waiting to be edited.
      const ordered = bottomUp(edits);

      // Gender may only change when the command talks about it (or a file was attached)
      const allowGender = genderChangeAllowed({ instruction: text, heard, hasFile: Boolean(file) });

      // An uploaded file: show the preview first. It is a DRY RUN on a copy of the document; nothing changes
      // until Apply. Typed and spoken commands are applied straight away, as before.
      if (file) {
        showUploadPreview({ ordered, allowGender, label, text, file, summary });
        return true;
      }
      // F. AI edits from a typed / spoken command may never remove SEVERAL medicines at once: that is only done
      //    through the confirmation window. A dry run on a copy (the same code as the upload preview) counts the
      //    medicine lines that would disappear; 2 or more -> nothing is applied.
      const lost = medicinesLostByEdits(editor.state.doc, ordered, allowGender);
      if (lost >= 2) {
        setNote(`🔒 These AI changes would remove ${lost} medicines at once, so nothing was changed. Several medicines are removed only through ` +
          'the confirmation window: say "remove all medicines from Advice", or name the medicines to remove.');
        return true;
      }
      applyAiEdits({ ordered, allowGender, label, text, heard, file, summary, voice, blockedFirst: tableCheck.blocked, aiEditCount: check.edits.length,
        keptFacts: check.skipped || [] });
      return true;
    } catch (err) {
      console.error(err);
      setError(err.message || 'Could not apply the edit');
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
    const outcome = await runAndReport({
      file: attached,
      text: instruction,
      label: attached ? `"${attached.name}"` : 'your instruction',
    });
    if (outcome === 'applied') clearInputs();
    else if (outcome === 'window') inputsWaitForWindow.current = true;
  }

  // ---------- microphone, audio mode: always listening, one command per pause ----------
  // Finished commands go into a queue and are applied one after another.
  async function processQueue() {
    if (working.current) return;
    working.current = true;
    setProcessing(true);
    try {
      while (queue.current.length) {
        const clip = queue.current.shift();
        const { base64, seconds } = pcmChunksToWav(clip);
        if (seconds < 0.5) continue;
        await runAndReport({ audio: { base64, mimeType: 'audio/wav' }, label: 'your voice command', voice: true });
      }
    } finally {
      working.current = false;
      setProcessing(false);
    }
  }

  function enqueueClip(clip) {
    if (queue.current.length >= MAX_QUEUE) {
      showToast('Too many commands waiting. Please wait a moment.');
      return;
    }
    queue.current.push(clip);
    processQueue();
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
          history={history}
          onUndo={undo}
        />
      </div>

    </div>
    </div>
    {pending && onEditor && (
      pending.kind === 'upload' ? (
        <UploadPreview fileName={pending.fileName} summary={pending.summary} preview={pending.preview}
          recompute={pending.recompute} onApply={(c) => finishWindow(pending, () => applyUpload(c))} onCancel={cancelPending} />
      ) : pending.kind === 'command' ? (
        <UploadPreview summary={pending.summary} preview={pending.preview} recompute={pending.recompute}
          command={{ notIncluded: pending.blockedFirst }}
          onApply={(c) => finishWindow(pending, () => applyCommandPreview(c))} onCancel={cancelPending} />
      ) : pending.kind === 'clear' ? (
        <ConfirmClear preview={pending.preview}
          onApply={() => finishWindow(pending, applyClear)} onCancel={cancelPending} />
      ) : (
        <ConfirmChanges kind={pending.kind} plan={pending.plan} understood={pending.understood} original={pending.original}
          onApply={(plan) => finishWindow(pending, () => applyPending(plan))} onCancel={cancelPending} />
      )
    )}
    {toast && <div className="toast">{toast}</div>}
    </div>
  );
}