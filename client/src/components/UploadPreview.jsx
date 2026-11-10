import { useEffect, useMemo, useState } from 'react';

// Preview window for an uploaded file: every change the file would make, BEFORE anything is changed.
// The rows come from a dry run on a copy of the document (lib/previewEdits.js), so they show what Apply does.
//   - one tick box per change: field, old value (struck out) -> new value
//   - PATIENT DETAILS (name, age, sex, IP No, dates ... and any gender change) start UNTICKED with a warning:
//     they are only applied when the user ticks them
//   - the age / gender step ("make age and gender match everywhere") is shown separately, also unticked
//   - changes that will NOT be applied are listed with the reason
// Nothing changes until Apply; Cancel / Esc / clicking outside changes nothing.
//
// Props:
//   fileName   the uploaded file's name
//   summary    the AI's own summary (shown as "AI: ...")
//   preview    first dry run: { items, blocked, unchanged, consistency }
//   recompute  (selected: Set of edit indexes, consistency: boolean) -> dry run for exactly that choice
//   onApply    called with { selected: Set, consistency: boolean }
//   onCancel   called when the window is closed without applying

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const show = (t) => (String(t || '').trim() ? t : '(empty)');

export default function UploadPreview({ fileName, summary, preview, recompute, onApply, onCancel }) {
  // patient details are not ticked until the user confirms them
  const [ticks, setTicks] = useState(() => new Set(preview.items.filter((i) => !i.patient).map((i) => i.index)));
  const [syncOn, setSyncOn] = useState(false);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // the age / gender step for exactly the ticked changes (it depends on them)
  const sync = useMemo(() => (ticks.size ? recompute(ticks, true).consistency : []), [ticks, recompute]);

  const toggle = (index) =>
    setTicks((t) => {
      const next = new Set(t);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const patients = preview.items.filter((i) => i.patient).length;
  const chosen = ticks.size + (syncOn && sync.length ? 1 : 0);
  const title = `Changes from ${fileName ? `"${fileName}"` : 'the uploaded file'}`;
  // nothing selected: Apply stays usable and only closes the window (the document is not touched)
  const footer = chosen
    ? `${ticks.size} of ${plural(preview.items.length, 'change', 'changes')} selected`
    : 'Nothing selected: Apply closes the window and leaves the document unchanged.';

  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal confirm" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <b>{title}</b>
            <span>Check every change against the file. Nothing is changed until you press Apply. All applied changes are one Undo step.</span>
          </div>
          <button className="icon-btn" onClick={onCancel} aria-label="Close without changing">✕</button>
        </div>

        <div className="modal-body confirm-body">
          {summary && <p className="confirm-note">AI: {summary}</p>}
          {(patients > 0 || sync.length > 0) && (
            <p className="confirm-note warn">
              Patient details (marked <i>patient detail</i>) and gender changes are NOT ticked. Check them against the file
              and tick them only if they are correct.
            </p>
          )}
          {preview.items.length === 0 && <p className="confirm-note">The file does not change anything in this document.</p>}

          <ul className="confirm-list">
            {preview.items.map((item) => {
              const on = ticks.has(item.index);
              return (
                <li key={item.index} className={on ? '' : 'off'}>
                  <div className="confirm-row">
                    <label className="confirm-entry-toggle">
                      <input type="checkbox" checked={on} onChange={() => toggle(item.index)} aria-label={`Apply the change to ${item.field}`} />
                    </label>
                    <div className="confirm-lines">
                      <div className="confirm-chips">
                        <label className={`confirm-chip ${on ? 'on' : ''}`}>
                          <span>{item.field}</span>
                          {item.patient && <em>patient detail</em>}
                        </label>
                      </div>
                      <div className="confirm-before"><del>{show(item.before)}</del></div>
                      <div className="confirm-after">→ {show(item.after)}</div>
                      {item.also.map((a, k) => (
                        <div key={k} className="confirm-before">
                          Also changes: <del>{show(a.before)}</del> → {show(a.after)}
                        </div>
                      ))}
                    </div>
                  </div>
                </li>
              );
            })}

            {sync.length > 0 && (
              <li className={syncOn ? '' : 'off'}>
                <div className="confirm-row">
                  <label className="confirm-entry-toggle">
                    <input type="checkbox" checked={syncOn} onChange={() => setSyncOn((v) => !v)} aria-label="Make age and gender match everywhere" />
                  </label>
                  <div className="confirm-lines">
                    <div className="confirm-chips">
                      <label className={`confirm-chip ${syncOn ? 'on' : ''}`}>
                        <span>Make age / gender match everywhere ({plural(sync.length, 'place', 'places')})</span>
                        <em>patient detail</em>
                      </label>
                    </div>
                    {sync.map((a, k) => (
                      <div key={k}>
                        <div className="confirm-before"><del>{show(a.before)}</del></div>
                        <div className="confirm-after">→ {show(a.after)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </li>
            )}
          </ul>

          {preview.blocked.length > 0 && (
            <details className="confirm-unchanged" open>
              <summary>{plural(preview.blocked.length, 'change', 'changes')} from the file will NOT be applied</summary>
              <ul>
                {preview.blocked.map((b) => <li key={b.index}>{b.field}: {b.reason}</li>)}
              </ul>
            </details>
          )}
          {preview.unchanged > 0 && (
            <p className="confirm-note">{plural(preview.unchanged, 'value', 'values')} in the file already match the document (nothing to change).</p>
          )}
        </div>

        <div className="modal-foot confirm-foot">
          <span className="muted">{footer}</span>
          <div className="spacer" />
          <button className="pill-btn" onClick={onCancel}>Cancel</button>
          <button className="seg-btn on" onClick={() => onApply({ selected: new Set(ticks), consistency: syncOn && sync.length > 0 })}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
