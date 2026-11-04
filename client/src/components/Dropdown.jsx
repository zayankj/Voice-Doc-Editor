import { useEffect, useRef, useState } from 'react';

// A button that opens a small menu. items: { label, hint, onClick, disabled } | { divider: true } | { info: 'text' }
export default function Dropdown({ label, items, className = '', align = 'left', title }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className={`dd ${className}`} ref={ref}>
      <button
        className="dd-btn"
        title={title}
        onMouseDown={(e) => e.preventDefault()} // keeps the text selection in the editor
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <div className={`dd-menu ${align}`}>
          {items.map((it, i) => {
            if (it.divider) return <div key={i} className="dd-sep" />;
            if (it.info) return <div key={i} className="dd-info">{it.info}</div>;
            return (
              <button
                key={i}
                className="dd-item"
                disabled={it.disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setOpen(false);
                  it.onClick?.();
                }}
              >
                <span>{it.label}</span>
                {it.hint && <span className="dd-hint">{it.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}