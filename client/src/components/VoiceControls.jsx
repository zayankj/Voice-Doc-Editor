export default function VoiceControls({ status, onMic, reading, onRead, uploading, onUpload }) {
  const busy = status !== 'idle'; // connecting or listening
  const micLabel = { idle: 'Tap to speak', connecting: 'Connecting...', listening: 'Tap to stop' }[status];

  return (
    <div className="controls">
      <div className="ctrl">
        <button
          className={`round ${reading ? 'on' : ''}`}
          onClick={onRead}
          disabled={busy || uploading}
          title="Read the document aloud"
          aria-label="Read the document aloud"
        >
          {reading ? '■' : '🔊'}
        </button>
        <span className="mic-label">{reading ? 'Stop reading' : 'Read aloud'}</span>
      </div>

      <div className="ctrl">
        <button
          className={`mic ${status}`}
          onClick={onMic}
          disabled={status === 'connecting' || uploading}
          aria-label="Record voice command"
        >
          {status === 'listening' ? '■' : '🎤'}
        </button>
        <span className="mic-label">{micLabel}</span>
      </div>

      <div className="ctrl">
        <button
          className="round"
          onClick={onUpload}
          disabled={busy || uploading}
          title="Upload an image, handwritten note, PDF..."
          aria-label="Upload a file"
        >
          {uploading ? '…' : '📎'}
        </button>
        <span className="mic-label">{uploading ? 'Reading file...' : 'Upload file'}</span>
      </div>
    </div>
  );
}