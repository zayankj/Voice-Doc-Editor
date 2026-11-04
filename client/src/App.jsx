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

import { Flash } from './lib/flash';
import { FontSize, LineHeight } from './lib/extensions';
import { docxToHtml } from './lib/docxImport';
import { buildOutline } from './lib/outline';
import { applyVoiceEdit } from './lib/voiceEdit';
import { scrollToPos, scrollToFirstChange } from './lib/scroll';
import { findMissingFields } from './lib/validate';
import { startLive } from './lib/liveClient';
import { startCapture } from './lib/audio';
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

const STORE = 'voice-doc-html';
const EMPTY = '<p>Click <b>File → Open .docx</b> to load a document, then use the mic to edit it by voice.</p>';
const load = () => { try { return localStorage.getItem(STORE) || EMPTY; } catch { return EMPTY; } };
const save = (html) => { try { localStorage.setItem(STORE, html); } catch { /* ignore */ } };
const lsGet = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const lsSet = (key, value) => { try { localStorage.setItem(key, value); } catch { /* ignore */ } };

export default function App() {
  const [history, setHistory] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | connecting | listening
  const [transcript, setTranscript] = useState('');
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [reading, setReading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [note, setNote] = useState('');
  const [voices, setVoices] = useState([]);
  const [voiceName, setVoiceName] = useState(() => lsGet('tts-voice', ''));
  const [rate, setRate] = useState(() => Number(lsGet('tts-rate', '0.95')) || 0.95);
  const [saved, setSaved] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [collapsed, setCollapsed] = useState(false);
  const [attached, setAttached] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [toast, setToast] = useState('');
  const live = useRef(null);
  const stopMic = useRef(null);
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

  // The best female voice is chosen automatically unless the user picked another one
  useEffect(() => watchVoices(setVoices), []);
  const activeVoice = voices.find((v) => v.name === voiceName) || voices[0];

  function chooseVoice(name) {
    setVoiceName(name);
    lsSet('tts-voice', name);
  }

  function chooseRate(value) {
    setRate(value);
    lsSet('tts-rate', String(value));
  }

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
  // scroll: bring the changed line into view if it is off-screen (Apply Edit scrolls once at the end instead)
  function handleEdit(args, { scroll = true } = {}) {
    const r = applyVoiceEdit(editor, args);
    if (!r.ok) return { ok: false, error: r.error };
    if (scroll && r.pos != null) scrollToPos(editor, r.pos, true);
    setHistory((h) => [
      {
        label: args.field_label || args.block_id,
        before: r.before || '(empty)',
        after: r.after || '(empty)',
        at: new Date().toLocaleTimeString(),
      },
      ...h,
    ]);
    return { ok: true, new_text: r.after };
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
      rate,
      onEnd: () => setReading(false),
    });
  }

  // ---------- Apply Edit: attached file and/or typed instruction ----------
  async function handleApply() {
    if (!attached && !instruction.trim()) return;
    stopReadingNow();
    setError('');
    setNote('');
    setApplying(true);
    try {
      const { edits, summary } = await extractEdits({
        file: attached,
        instruction,
        outline: buildOutline(editor.state.doc),
        today: todayString(),
      });

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

      // every changed part is now highlighted: jump to the first one
      if (applied) scrollToFirstChange(editor);

      const source = attached ? `"${attached.name}"` : 'your instruction';
      const head = applied
        ? `${applied} change${applied > 1 ? 's' : ''} applied from ${source}. Changed parts are highlighted in yellow.`
        : `No changes were needed from ${source}.`;
      setNote([head, skipped ? `${skipped} could not be applied.` : '', summary].filter(Boolean).join(' '));
      setAttached(null);
      setInstruction('');
    } catch (err) {
      console.error(err);
      setError(err.message || 'Could not apply the edit');
    } finally {
      setApplying(false);
    }
  }

  // ---------- microphone ----------
  async function toggleMic() {
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
          onMic={toggleMic}
          reading={reading}
          onRead={toggleRead}
          applying={applying}
          voices={voices}
          voiceName={activeVoice?.name || ''}
          onVoice={chooseVoice}
          rate={rate}
          onRate={chooseRate}
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