import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@tiptap/react';
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
import { FontSize, LineHeight } from './lib/extensions';
import { docxToHtml } from './lib/docxImport';
import { buildOutline } from './lib/outline';
import { applyVoiceEdit, applyPatientConsistency, getPatientFacts } from './lib/voiceEdit';
import { scrollToPos, scrollToFirstChange } from './lib/scroll';
import { findMissingFields } from './lib/validate';
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

const USER_INITIAL = 'U'; // letter shown in the round avatar at the top right

// audio = the mic listens all the time, each command is sent after a pause (works with the Mumbai models).
// live  = real-time Live model (needs GEMINI_API_KEY and a Live model; not available in the India region setup).
const VOICE_MODE = import.meta.env.VITE_VOICE_MODE === 'live' ? 'live' : 'audio';
const IDLE_STOP_MS = 5 * 60 * 1000; // the mic turns itself off after this long without speech
const MAX_QUEUE = 5; // commands that may wait while a previous one is being applied
const READ_RATE = 1.1; // reading speed for Read aloud (0.95 = normal, 1.1 = fast)
const RESTART_ON_CLICK = true; // while reading, clicking in the document restarts reading from the clicked sentence

const STORE = 'voice-doc-html';
const EMPTY = '<p>Click <b>File → Open .docx</b> to load a document, then use the mic to edit it by voice.</p>';
const load = () => { try { return localStorage.getItem(STORE) || EMPTY; } catch { return EMPTY; } };
const save = (html) => { try { localStorage.setItem(STORE, html); } catch { /* ignore */ } };

export default function App() {
  const [history, setHistory] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | connecting | listening
  const [hearing, setHearing] = useState(false); // you are speaking right now
  const [processing, setProcessing] = useState(false); // a voice command is being applied
  const [transcript, setTranscript] = useState('');
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
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
    ],
    content: load(),
    onUpdate: ({ editor }) => {
      setSaved(false);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        save(editor.getHTML());
        setSaved(true);
      }, 600);
    },
  });

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
      editor.commands.setContent(html);
      save(html);
      setSaved(true);
      setFileName(file.name);
      setHistory([]);
      setNote('');
      setError('');
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
  function handleEdit(args, { scroll = true } = {}) {
    const factsBefore = getPatientFacts(editor.state.doc);
    const r = applyVoiceEdit(editor, args);
    if (!r.ok) return { ok: false, error: r.error };
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
    return { ok: true, new_text: r.after, also_updated: synced.map((c) => c.after) };
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
    readDocument(editor, {
      voiceName: activeVoice?.name,
      rate: READ_RATE,
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

      let applied = 0;
      let skipped = 0;
      for (const ed of ordered) {
        if (handleEdit(ed, { scroll: false }).ok) applied++;
        else skipped++;
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
      setNote([head, skipped ? `${skipped} could not be applied.` : '', summary].filter(Boolean).join(' '));
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

  const title = fileName ? fileName.replace(/\.docx$/i, '') : 'Untitled document';

  return (
    <div className="app">
      <input ref={fileInput} type="file" accept=".docx" hidden onChange={openDocx} />
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
        saved={saved}
        userInitial={USER_INITIAL}
        onOpen={() => fileInput.current?.click()}
        onExportDocx={() => exportDocx(editor)}
        onPrint={() => window.print()}
        onInsertImage={() => imageInput.current?.click()}
        onZoom={setZoom}
        onValidate={validate}
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
          <DocEditor editor={editor} zoom={zoom} />
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

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}