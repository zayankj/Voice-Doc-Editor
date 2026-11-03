export default function HistoryPanel({ history, onUndo }) {
  return (
    <div className="panel">
      <h3>History ({history.length})</h3>
      {history.length === 0 && <p className="muted">No voice edits yet.</p>}
      <ul>
        {history.map((h, i) => (
          <li key={h.at + i}>
            <div>
              <strong>{h.label}</strong> <span className="muted">{h.at}</span>
            </div>
            <div className="diff">
              <s>{h.before}</s> → <b>{h.after}</b>
            </div>
            {i === 0 && <button onClick={onUndo}>Undo</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
