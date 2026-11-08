import { useEffect } from 'react';

// Read-only preview of a template (the "View Template" window).
// It shows our own fixed layout HTML with the same styles as the editor page. It is NOT an editor.
export default function TemplatePreview({ tpl, dept, html, onClose }) {
  // Esc closes the window
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Preview: ${tpl.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <b>{tpl.name}</b>
            <span>{dept.name} · {tpl.status === 'sample' ? 'Sample layout – awaiting hospital approval' : 'Demo template'}</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close preview">✕</button>
        </div>
        <div className="modal-body">
          {/* Our own static template HTML (from src/data/layouts), never user input */}
          <div className="page tpl-doc preview">
            <div className="ProseMirror" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        </div>
        <div className="modal-foot">
          <button className="seg-btn on" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
