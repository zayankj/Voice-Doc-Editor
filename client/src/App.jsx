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
import Toolbar from './components/Toolbar';
import DocEditor from './components/DocEditor';
import MicButton from './components/MicButton';
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
  const live = useRef(null);
  const stopMic = useRef(null);
  const fileInput = useRef(null);

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

  async function openDocx(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const html = await docxToHtml(file);
      editor.commands.setContent(html);
      save(html);
      setFileName(file.name);
      setHistory([]);
      setError('');
    } catch (err) {
      console.error(err);
      setError('Could not read that .docx file');
    }
    e.target.value = '';
  }

  // Called when the model calls edit_text
  function handleEdit(args) {
    const r = applyVoiceEdit(editor, args);
    if (!r.ok) return { ok: false, error: r.error };
    setHistory((h) => [
      { label: args.field_label || args.block_id, before: r.before || '(empty)', after: r.after || '(empty)', at: new Date().toLocaleTimeString() },
      ...h,
    ]);
    return { ok: true, new_text: r.after };
  }

  function undo() {
    if (!history.length) return;
    editor.commands.undo();
    setHistory(history.slice(1));
  }

  async function toggleMic() {
    if (status === 'listening') {
      stopMic.current?.();
      live.current?.endAudio();
      setStatus('idle');
      setTimeout(() => live.current?.close(), 4000);
      return;
    }
    try {
      setError(''); setTranscript(''); setReply('');
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
      <Toolbar
        editor={editor}
        fileName={fileName}
        onOpen={() => fileInput.current?.click()}
        onExport={() => exportDocx(editor)}
      />
      <div className="body">
        <DocEditor editor={editor} />
        <aside>
          <MicButton status={status} onClick={toggleMic} />
          {transcript && <p className="bubble you">You: {transcript}</p>}
          {reply && <p className="bubble ai">AI: {reply}</p>}
          {error && <p className="error">{error}</p>}
          <HistoryPanel history={history} onUndo={undo} />
        </aside>
      </div>
    </div>
  );
}
