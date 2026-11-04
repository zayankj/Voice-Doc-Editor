import { useState } from 'react';
import VoiceSettings from './VoiceSettings';
import HistoryPanel from './HistoryPanel';

export default function SidePanel({
  status, onMic, reading, onRead, applying,
  voices, voiceName, onVoice, rate, onRate,
  transcript, reply, note, error,
  attached, onPickFile, onDropFile, onClearFile,
  instruction, onInstruction, onApply,
  history, onUndo,
}) {
  const [tab, setTab] = useState('smart');
  const busyMic = status !== 'idle';
  const micLabel = { idle: 'Tap to record', connecting: 'Connecting...', listening: 'Listening... tap to stop' }[status];
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
          <div>
            <div className="section-title">Record voice note</div>
            <div className="voice-card">
              <button
                className={`mic-sm ${status}`}
                onClick={onMic}
                disabled={status === 'connecting' || applying}
                aria-label="Record voice command"
              >
                {status === 'listening' ? '■' : '🎤'}
              </button>
              <div>
                <b>{micLabel}</b>
                <span>Say what to change, e.g. "change the discharge date to today".</span>
              </div>
            </div>
          </div>

          <div>
            <div className="readrow">
              <button className="btn" onClick={onRead} disabled={busyMic || applying}>
                {reading ? '■ Stop reading' : '🔊 Read aloud'}
              </button>
            </div>
            <VoiceSettings voices={voices} voiceName={voiceName} onVoice={onVoice} rate={rate} onRate={onRate} />
          </div>

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