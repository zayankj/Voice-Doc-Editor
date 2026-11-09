import { useEffect } from 'react';

// Confirmation window before clearing a WHOLE section that contains medicines (Advice ...).
// Shows every line that will be removed. Nothing changes until "Clear section"; Cancel / Esc / clicking
// outside changes nothing. The heading always stays. Uses the same styles as the medicine confirm window.
//
// Props:
//   preview   from lib/sectionCommands.js clearPreview(): { title, lines: [{ text, medicine }], medicines }
//   onApply   clear the section
//   onCancel  close without changing anything

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function ConfirmClear({ preview, onApply, onCancel }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const others = preview.lines.length - preview.medicines;
  const summary = `${plural(preview.medicines, 'medicine', 'medicines')}${others ? ` and ${plural(others, 'other line', 'other lines')}` : ''} will be removed. The ${preview.title} heading stays.`;
  const title = `Clear the ${preview.title} section?`;

  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal confirm" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <b>{title}</b>
            <span>Everything under {preview.title} will be removed. Nothing is changed until you press Clear section. Other sections are not affected.</span>
          </div>
          <button className="icon-btn" onClick={onCancel} aria-label="Close without changing">✕</button>
        </div>

        <div className="modal-body confirm-body">
          <p className="confirm-note warn">{summary}</p>
          <ul className="confirm-list">
            {preview.lines.map((l, i) => (
              <li key={i}>
                <div className="confirm-row">
                  <div className="confirm-lines">
                    <div className="confirm-before"><del>{l.text}</del></div>
                    {l.medicine && <div className="confirm-chips"><span className="confirm-chip"><em>medicine</em></span></div>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="modal-foot confirm-foot">
          <span className="muted">One Undo brings it all back.</span>
          <div className="spacer" />
          <button className="pill-btn" onClick={onCancel}>Cancel</button>
          <button className="seg-btn on" onClick={onApply}>Clear section</button>
        </div>
      </div>
    </div>
  );
}
