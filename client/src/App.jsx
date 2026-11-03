import { useRef, useState } from 'react';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';

import { Flash } from './lib/flash';
import { docxToHtml } from './lib/docxImport';
import { buildOutline } from './lib/outline';
import { applyVoiceEdit } from './lib/voiceEdit';
import { startLive } from './lib/liveClient';
import { startCapture } from './lib/audio';
import { exportDocx } from './lib/exportDocx';
import { todayString } from './lib/tools';
import { extractEdits } from './lib/fileExtract';
import { readDocument, stopReading, ttsSupported } from './lib/tts';
import Toolbar from './components/Toolbar';
import DocEditor from './components/DocEditor';
import VoiceControls from './components/VoiceControls';
import HistoryPanel from './components/HistoryPanel';

const STORE = 'voice-doc-html';
const EMPTY = '<p>Click <b>Open .docx</b> to load a document, then use the mic to edit it by voice.</p>';
const load = () => { try { return localStorage.getItem(STORE) || EMPTY; } catch { return EMPTY; } };
const save = (html) => { try { localStorage.setItem(STORE, html); } catch { /* ignore */ } };

export default function App() {
  const [history, setHistory] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | connecting | listening
  const [transcript, setTranscript] = useState('');
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState('');
  const live = useRef(null);
  const stopMic = useRef(null);
  const fileInput = useRef(null);
  const uploadInput = useRef(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Flash,
    ],
    content: load(),
    onUpdate: ({ editor }) => save(editor.getHTML()),
  });

  // ---------- open the base .docx ----------
  async function openDocx(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const html = await docxToHtml(file);
      editor.commands.setContent(html);
      save(html);
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

  // ---------- one edit (used by voice AND by uploads) ----------
  function handleEdit(args) {
    const r = applyVoiceEdit(editor, args);
    if (!r.ok) return { ok: false, error: r.error };
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
    readDocument(editor, { onEnd: () => setReading(false) });
  }

  // ---------- upload a file and apply its changes ----------
  async function handleUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    stopReadingNow();
    setError('');
    setNote('');
    setUploading(true);
    try {
      const { edits, summary } = await extractEdits({
        file,
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
        if (handleEdit(ed).ok) applied++;
        else skipped++;
      }

      const head = applied
        ? `${applied} change${applied > 1 ? 's' : ''} applied from "${file.name}".`
        : `No changes were needed from "${file.name}".`;
      setNote([head, skipped ? `${skipped} could not be applied.` : '', summary].filter(Boolean).join(' '));
    } catch (err) {
      console.error(err);
      setError(err.message || 'Could not read the file');
    } finally {
      setUploading(false);
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

  return (
    <div className="app">
      <input ref={fileInput} type="file" accept=".docx" hidden onChange={openDocx} />
      <input
        ref={uploadInput}
        type="file"
        accept="image/*,.pdf,.docx,.txt,.csv"
        hidden
        onChange={handleUpload}
      />
      <Toolbar
        editor={editor}
        fileName={fileName}
        onOpen={() => fileInput.current?.click()}
        onExport={() => exportDocx(editor)}
      />
      <div className="body">
        <DocEditor editor={editor} />
        <aside>
          <VoiceControls
            status={status}
            onMic={toggleMic}
            reading={reading}
            onRead={toggleRead}
            uploading={uploading}
            onUpload={() => uploadInput.current?.click()}
          />
          {transcript && <p className="bubble you">You: {transcript}</p>}
          {reply && <p className="bubble ai">AI: {reply}</p>}
          {note && <p className="bubble ai">{note}</p>}
          {error && <p className="error">{error}</p>}
          <HistoryPanel history={history} onUndo={undo} />
        </aside>
      </div>
    </div>
  );
}