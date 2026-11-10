import { useEffect, useMemo, useState } from 'react';
import { deletionRanges, textAfter } from '../lib/medicineText';

// Preview window for code-based removals (generic names, route / frequency ..., exact words).
// One row per MEDICINE ENTRY: the original (deleted parts struck out) -> the proposed text, and one tick box
// per proposed removal. The preview uses the same calculation as Apply, so what is shown is exactly what
// will be deleted. Nothing changes until Apply; Cancel / Esc / clicking outside changes nothing.
//
// Props:
//   kind      'generic' | 'phrases' | 'entries'     ('entries' = whole medicines are removed)
//   plan      from lib/medicineText.js: { section, changes, unchanged, counts, notFound }
//   onApply   called with a COPY of the plan that has the user's tick-box choices
//   onCancel  called when the window is closed without applying
//   understood, original  (optional) when the plan came from the AI's interpretation of the command: both are
//             shown, so the user sees how the command was understood next to their own words

const KIND_LABEL = {
  generic: 'generic name', description: 'description', route: 'route', frequency: 'frequency',
  as_needed: 'as needed', food: 'food timing', phrase: 'word', entry: 'whole medicine', pattern: 'dosing pattern',
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const kindLabel = (k) => KIND_LABEL[k] || k;

// Splits an entry into pieces [{ text, removed }] using the SAME deletion as Apply
export function segments(change) {
  const out = [];
  let at = 0;
  for (const [a, b] of deletionRanges(change)) {
    if (a > at) out.push({ text: change.before.slice(at, a), removed: false });
    out.push({ text: change.before.slice(a, b), removed: true });
    at = b;
  }
  if (at < change.before.length) out.push({ text: change.before.slice(at), removed: false });
  return out;
}

// "route ×5, frequency ×5, Oral ×2"  (category keys get readable names; exact words stay as said)
export function countsSummary(counts = {}) {
  return Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${KIND_LABEL[k] || k} ×${n}`).join(', ');
}

const copyPlan = (plan) => plan.changes.map((c) => ({ ...c, removals: c.removals.map((r) => ({ ...r })) }));
const entryOn = (row) => row.removals.some((r) => r.selected);

// The whole-entry tick box: off -> nothing ticked; on -> back to the PROPOSED ticks (so an unticked suggestion,
// such as a dosing pattern or a description, is never ticked just by re-ticking the line).
// defaults = the entry's removals as proposed. If none was proposed ticked, everything is ticked.
export function toggleEntryRemovals(row, defaults) {
  const on = !entryOn(row);
  const anyDefault = defaults.some((d) => d.selected);
  return { ...row, removals: row.removals.map((r, k) => ({ ...r, selected: on && (anyDefault ? Boolean(defaults[k]?.selected) : true) })) };
}

export default function ConfirmChanges({ kind, plan, onApply, onCancel, understood = '', original = '' }) {
  const [rows, setRows] = useState(() => copyPlan(plan)); // the user's tick-box choices

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // one removal on / off
  const toggleOne = (i, k) =>
    setRows((rs) => rs.map((row, n) => (n !== i ? row : {
      ...row, removals: row.removals.map((r, m) => (m === k ? { ...r, selected: !r.selected } : r)),
    })));
  // one entry off / back to its proposed ticks
  const toggleEntry = (i) =>
    setRows((rs) => rs.map((row, n) => (n !== i ? row : toggleEntryRemovals(row, plan.changes[i].removals))));

  const chosen = useMemo(() => rows.filter(entryOn).length, [rows]);
  const unchanged = plan.unchanged || [];
  const total = rows.length + unchanged.length;
  const medicines = unchanged.length > 0 || rows.some((r) => r.removals.some((x) => x.kind !== 'phrase'));
  const unit = medicines ? `medicine entr${total === 1 ? 'y' : 'ies'}` : `line${total === 1 ? '' : 's'}`;
  const wholeMedicines = kind === 'entries';
  const title = wholeMedicines
    ? `Remove medicines from ${plan.section.title}`
    : kind === 'generic' ? `Remove generic names from ${plan.section.title}` : `Remove from ${plan.section.title}`;
  // whole medicines: "2 medicines will be removed · 4 will remain unchanged" (counts follow the tick boxes)
  const removalSummary = `${plural(chosen, 'medicine', 'medicines')} will be removed · ${total - chosen} will remain unchanged`;

  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal confirm" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <b>{title}</b>
            <span>Check every entry. Nothing is changed until you press Apply. Only the {plan.section.title} section is affected.</span>
          </div>
          <button className="icon-btn" onClick={onCancel} aria-label="Close without changing">✕</button>
        </div>

        <div className="modal-body confirm-body">
          {understood && (
            <p className="confirm-note warn">
              Understood by AI: <b>{understood}</b>
              <br />
              Your words: <i>{original}</i>
              <br />
              The app checked this against your words. Please make sure it is what you meant.
            </p>
          )}
          {plan.untyped > 0 && (
            <p className="confirm-note">
              {plural(plan.untyped, 'medicine has', 'medicines have')} no type word (Tab. / Cap. / Syp. …), so{' '}
              {plan.untyped === 1 ? 'it was' : 'they were'} not included.
            </p>
          )}
          {wholeMedicines
            ? <p className="confirm-note">{removalSummary}</p>
            : countsSummary(plan.counts) && <p className="confirm-note">Found: {countsSummary(plan.counts)}</p>}
          {plan.notFound?.length > 0 && (
            <p className="confirm-note warn">
              {wholeMedicines
                ? `Not found in ${plan.section.title} (nothing removed for these): ${plan.notFound.join(', ')}`
                : `Not found in ${plan.section.title}: ${plan.notFound.join(', ')}`}
            </p>
          )}
          {rows.some((r) => r.removals.some((x) => x.kind === 'description' && !x.selected)) && (
            <p className="confirm-note">
              Items marked <i>description</i> say what kind of medicine it is (for example Antacid), not its ingredient.
              They are not ticked. Tick them only if you want them removed too.
            </p>
          )}

          {rows.some((r) => r.removals.some((x) => x.kind === 'pattern' && !x.selected)) && (
            <p className="confirm-note">
              Dosing patterns such as (1-0-1) are shown but not ticked. Tick them only if you want them removed too.
            </p>
          )}

          <ul className="confirm-list">
            {rows.map((row, i) => {
              const on = entryOn(row);
              return (
                <li key={`${row.block}-${row.entry}`} className={on ? '' : 'off'}>
                  <div className="confirm-row">
                    <label className="confirm-entry-toggle" title="Tick or untick everything in this entry">
                      <input type="checkbox" checked={on} onChange={() => toggleEntry(i)} aria-label="Change this entry" />
                    </label>
                    <div className="confirm-lines">
                      <div className="confirm-before">
                        {segments(row).map((s, k) => (s.removed ? <del key={k}>{s.text}</del> : <span key={k}>{s.text}</span>))}
                      </div>
                      <div className="confirm-after">
                        {row.removals.some((r) => r.kind === 'entry')
                          ? (on ? '→ Medicine removed' : `→ Kept: ${row.before.trim()}`)
                          : `→ ${textAfter(row)}`}
                      </div>
                      <div className="confirm-chips">
                        {row.removals.map((r, k) => (
                          <label key={k} className={`confirm-chip ${r.selected ? 'on' : ''}`}>
                            <input type="checkbox" checked={r.selected} onChange={() => toggleOne(i, k)} />
                            <span>{r.text.trim()}</span>
                            <em>{kindLabel(r.kind)}</em>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {unchanged.length > 0 && (
            <details className="confirm-unchanged">
              <summary>
                {wholeMedicines
                  ? `${plural(unchanged.length, 'medicine', 'medicines')} will remain unchanged`
                  : `${unchanged.length} ${unchanged.length === 1 ? 'entry' : 'entries'} will not change`}
              </summary>
              <ul>
                {unchanged.map((u) => <li key={`${u.block}-${u.entry}`}>{u.before}</li>)}
              </ul>
            </details>
          )}
        </div>

        <div className="modal-foot confirm-foot">
          <span className="muted">{wholeMedicines ? removalSummary : `${chosen} of ${total} ${unit} will change`}</span>
          <div className="spacer" />
          <button className="pill-btn" onClick={onCancel}>Cancel</button>
          <button className="seg-btn on" disabled={!chosen} onClick={() => onApply({ ...plan, changes: rows })}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
