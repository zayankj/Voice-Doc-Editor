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
import { buildOutline } from './lib/outline';
import { applyVoiceEdit, applyPatientConsistency, ensurePatientConsistency, getPatientFacts } from './lib/voiceEdit';
import { genderStatedIn } from './lib/consistency';
import { scrollToPos, scrollToFirstChange } from './lib/scroll';
import { findMissingFields } from './lib/validate';
import { genderChangeAllowed } from './lib/guards';
import { startLive } from './lib/liveClient';
import { startCapture } from './lib/audio';
import { createSegmenter } from './lib/vad';
import { pcmChunksToWav } from './lib/wav';
import { exportDocx } from './lib/exportDocx';
import { todayString } from './lib/tools';
import { extractEdits } from './lib/fileExtract';
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
// TEMPORARY voice debugging. Logs ONLY numbers, block ids, operations and labels (no patient text,
// no transcript). Remove this together with the [voice-debug] lines when we finish.
const DEBUG_VOICE = true;
// Average and peak loudness of a recorded clip (0 = silence, 1 = maximum)
function clipLevels(chunks) {
  let sum = 0, n = 0, peak = 0;
  for (const b64 of chunks) {
    const bin = atob(b64);
    for (let i = 0; i + 1 < bin.length; i += 2) {
      let v = bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      const f = Math.abs(v) / 0x8000;
      sum += f * f; n++; if (f > peak) peak = f;
    }
  }
  return { avg: +Math.sqrt(sum / (n || 1)).toFixed(4), peak: +peak.toFixed(3) };
}

// Summaries are saved in this browser by lib/summaries.js (one entry per summary).

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
  function handleEdit(args, { scroll = true, allowGender = true } = {}) {
    const factsBefore = getPatientFacts(editor.state.doc);
    const r = applyVoiceEdit(editor, args, { allowGender });
    if (!r.ok) return { ok: false, error: r.error, blocked: r.blocked };
    // Header age/gender changed -> also fix "60-year-old female" etc. in the rest of the document
    const synced = applyPatientConsistency(editor, factsBefore);
    if (scroll && r.pos != null) scrollToPos(editor, r.pos, true);
    const at = new Date().toLocaleTimeString();
    // One history entry: the edit and its consistency fixes are undone together
    const extra = synced.length ? ` (+${synced.length} matching place${synced.length > 1 ? 's' : ''} updated)` : '';
    setHistory((h) => [
      {
        label: (args.field_label || args.block_id) + extra,
        before: r.before || '(empty)',
        after: r.after || '(empty)',
        at,
      },
      ...h,
    ]);
    return { ok: true, moved: Boolean(r.moved), new_text: r.after, also_updated: synced.map((c) => c.after) };
  }

  // Adds the automatic age/gender fixes to History (one entry). Returns how many blocks changed.
  function recordConsistency(changes) {
    if (!changes.length) return 0;
    const at = new Date().toLocaleTimeString();
    setHistory((h) => [
      {
        label: `Age / gender made consistent (${changes.length} place${changes.length > 1 ? 's' : ''})`,
        before: changes.map((c) => c.before).join(' | '),
        after: changes.map((c) => c.after).join(' | '),
        at,
      },
      ...h,
    ]);
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

  // ---------- send a file / text / voice clip to the server and apply the edits it returns ----------
  // voice = true: a spoken command. It does not touch the Apply Edit button.
  async function runEdits({ file = null, text = '', audio = null, label, voice = false }) {
    stopReadingNow();
    setError('');
    setNote('');
    if (!voice) setApplying(true);
    try {
      const { edits, summary, heard } = await extractEdits({
        file,
        instruction: text,
        audio,
        outline: buildOutline(editor.state.doc), // fresh snapshot of the document at this moment
        today: todayString(),
        templateId: openTemplateId(), // '' for discharge summaries
      });
      if (heard) setTranscript(heard);

      // Apply from the bottom of the document upwards, so a newly inserted line
      // never shifts the blocks that are still waiting to be edited.
      const blockNo = (ed) => {
        const n = parseInt(String(ed.block_id).replace(/\D/g, ''), 10);
        return Number.isNaN(n) ? -1 : n;
      };
      const ordered = edits
        .map((ed, i) => ({ ed, i }))
        .sort((a, b) => blockNo(b.ed) - blockNo(a.ed) || b.i - a.i)
        .map((x) => x.ed);

      // Gender may only change when the command talks about it (or a file was attached)
      const allowGender = genderChangeAllowed({ instruction: text, heard, hasFile: Boolean(file) });

      let applied = 0;
      let skipped = 0;
      const blockedWhy = []; // edits refused by the guards (locked label / unasked gender change)
      const appliedValues = []; // new texts that were really applied
      const debugRows = []; // [voice-debug]
      for (const ed of ordered) {
        const r = handleEdit(ed, { scroll: false, allowGender });
        if (DEBUG_VOICE) debugRows.push({
          block_id: ed.block_id, operation: ed.operation, field_label: ed.field_label,
          result: r.ok ? (r.moved ? 'moved to section text' : 'applied') : r.blocked ? 'blocked' : 'failed',
        });
        if (r.ok) {
          applied++;
          // only CHANGED text can set a new gender; added sentences ("append") follow the patient's gender
          if (ed.operation === 'set' || ed.operation === 'replace_text') appliedValues.push(ed.new_value || '');
        }
        else if (r.blocked) blockedWhy.push(`${ed.field_label || ed.block_id}: ${r.error}`);
        else skipped++;
      }
      if (DEBUG_VOICE) {
        console.info(`[voice-debug] ${label}: model returned ${edits.length} edit(s)`);
        if (debugRows.length) console.table(debugRows);
      }

      // Age / gender must be the same everywhere. If this command set a gender somewhere
      // (e.g. only in Course in Hospital), that gender goes to the header and everywhere else too.
      // Also repairs places that were already wrong.
      let alsoFixed = 0;
      if (applied) {
        const target = allowGender ? genderStatedIn(appliedValues) : null;
        alsoFixed = recordConsistency(ensurePatientConsistency(editor, target));
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
      setNote([head, fixedNote, blockedNote, skipped ? `${skipped} could not be applied.` : '', summary].filter(Boolean).join(' '));
      return true;
    } catch (err) {
      console.error(err);
      setError(err.message || 'Could not apply the edit');
      return false;
    } finally {
      if (!voice) setApplying(false);
    }
  }

  // ---------- Apply Edit button: attached file and/or typed instruction ----------
  async function handleApply() {
    if (!attached && !instruction.trim()) return;
    const ok = await runEdits({
      file: attached,
      text: instruction,
      label: attached ? `"${attached.name}"` : 'your instruction',
    });
    if (ok) {
      setAttached(null);
      setInstruction('');
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
        const clip = queue.current.shift();
        const { base64, seconds } = pcmChunksToWav(clip);
        if (DEBUG_VOICE) {
          const lv = clipLevels(clip);
          console.info('[voice-debug] clip', { seconds: +seconds.toFixed(1), avgLevel: lv.avg, peakLevel: lv.peak, sent: seconds >= 0.5 });
        }
        if (seconds < 0.5) continue;
        await runEdits({ audio: { base64, mimeType: 'audio/wav' }, label: 'your voice command', voice: true });
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
        accept="image/*,.pdf,.docx,.txt,.csv"
        hidden
        onChange={(e) => {
          setAttached(e.target.files?.[0] || null);
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
          onDropFile={setAttached}
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
    {toast && <div className="toast">{toast}</div>}
    </div>
  );
}