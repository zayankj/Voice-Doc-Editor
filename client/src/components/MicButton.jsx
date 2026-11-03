export default function MicButton({ status, onClick }) {
  const label = { idle: 'Tap to speak', connecting: 'Connecting...', listening: 'Listening... tap to stop' }[status];
  return (
    <div className="mic-wrap">
      <button
        className={`mic ${status}`}
        onClick={onClick}
        disabled={status === 'connecting'}
        aria-label="Record voice command"
      >
        {status === 'listening' ? '■' : '🎤'}
      </button>
      <span className="mic-label">{label}</span>
    </div>
  );
}
