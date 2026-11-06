import { useState } from 'react';
import HistoryPanel from './HistoryPanel';

const MicIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v4" />
  </svg>
);

const SpeakerIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 5 6 9H3v6h3l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
);

const StopIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

export default function SidePanel({
  status, micDetail, onMic, reading, onRead, applying,
  transcript, reply, note, error,
  attached, onPickFile, onDropFile, onClearFile,
  instruction, onInstruction, onApply,
  history, onUndo,
}) {
  const [tab, setTab] = useState('smart');
  const busyMic = status !== 'idle';
  const micLabel =
    micDetail || (status === 'connecting' ? 'Connecting...' : status === 'listening' ? 'Listening... tap to stop' : 'Mic');
  const canApply = Boolean(attached || instruction.trim()) && !applying && !busyMic;

  return (
    <aside className="side">
      <div className="tabs">
        <button className={`tab ${tab === 'smart' ? 'on' : ''}`} onClick={() => setTab('smart')}>Smart Edit</button>
        <button className={`tab ${tab === 'history' ? 'on' : ''}`} onClick={() => setTab('history')}>
          History ({history.length})
        </button>
      </div>

      {tab === 'smart' ? (
        <div className="side-body">
          <div className="round-row">
            <div className="round-item">
              <button
                className={`round-btn mic ${status}`}
                onClick={onMic}
                disabled={status === 'connecting' || applying}
                aria-label="Mic"
                title="Record a voice command"
              >
                {status === 'listening' ? <StopIcon /> : <MicIcon />}
              </button>
              <span className="round-label">{micLabel}</span>
            </div>

            <div className="round-item">
              <button
                className={`round-btn read ${reading ? 'on' : ''}`}
                onClick={onRead}
                disabled={busyMic || applying}
                aria-label="Read aloud"
                title="Read the document aloud"
              >
                {reading ? <StopIcon /> : <SpeakerIcon />}
              </button>
              <span className="round-label">{reading ? 'Stop' : 'Read'}</span>
            </div>
          </div>
          <p className="hint">Tap Mic, say what to change, then pause. Tap it again to stop.</p>

          <div>
            <div className="section-title">Attach file <span className="opt">(optional)</span></div>
            <div
              className="attach"
              onClick={onPickFile}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) onDropFile(f);
              }}
            >
              {attached ? (
                <span className="chip">
                  📎 {attached.name}
                  <button onClick={(e) => { e.stopPropagation(); onClearFile(); }} aria-label="Remove file">✕</button>
                </span>
              ) : (
                <span className="muted">Click or drop an image, handwritten note, PDF or Word file</span>
              )}
            </div>
          </div>

          <div>
            <div className="section-title">Edit instructions <span className="opt">(optional)</span></div>
            <textarea
              className="instr"
              value={instruction}
              onChange={(e) => onInstruction(e.target.value)}
              placeholder="e.g. Update the medicines from the attached note, set follow-up to 2 weeks"
            />
          </div>

          <button className="btn primary" onClick={onApply} disabled={!canApply}>
            {applying ? 'Applying…' : '💡 Apply Edit'}
          </button>

          {transcript && <p className="bubble you">You: {transcript}</p>}
          {reply && <p className="bubble ai">AI: {reply}</p>}
          {note && <p className="bubble ai">{note}</p>}
          {error && <p className="error">{error}</p>}
        </div>
      ) : (
        <div className="side-body">
          <HistoryPanel history={history} onUndo={onUndo} />
        </div>
      )}
    </aside>
  );
}