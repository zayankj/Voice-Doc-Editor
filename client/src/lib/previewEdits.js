// Upload preview: a DRY RUN of the AI's edits on a COPY of the document.
// The copy is changed with exactly the same code as Apply (applyVoiceEdit + the age / gender steps), so the
// preview shows what Apply will do. The real editor, its Undo history and its highlights are never touched.
import { EditorState } from '@tiptap/pm/state';
import { applyVoiceEdit } from './voiceEdit.js';

import { changesGender, isLabelText } from './guards.js';
import { cellAt, dataCellRole, rowName } from './tables.js';


// A throw-away editor holding a copy of the document
function copyEditor(doc) {
  const ed = { state: EditorState.create({ doc }), schema: doc.type.schema, isDestroyed: false, dryRun: true };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
}

// A readable name for the changed place: the investigation ("SERUM CREATININE"), the field label ("IP No"),
// or the AI's own name for it
function placeName(doc, pos, fallback) {
  const info = pos != null && pos <= doc.content.size ? cellAt(doc, pos) : null;
  if (info) {
    if (dataCellRole(info) === 'value') return rowName(info);
    if (info.col > 0) {
      const left = info.row.child(info.col - 1).textContent.trim();
      if (left) return left;
    }
  }
  return fallback;
}

// A patient detail: a header field (Name, Age, Sex, IP No, Address, dates ...) or any change of gender words
function isPatientDetail(doc, pos, before, after) {
  if (changesGender(before, after) || changesGender(after, before)) return true;
  const info = pos != null && pos <= doc.content.size ? cellAt(doc, pos) : null;
  if (!info || dataCellRole(info) || info.col === 0) return false;
  return isLabelText(info.row.child(info.col - 1).textContent);
}

// edits: the AI's edits in the order App.jsx applies them (bottom of the document first)
// selected: indexes of the edits to include (default: all)
// Returns {
//   items:       [{ index, field, before, after, patient, also: [] }]  edits that change something
//   blocked:     [{ index, field, reason }]                             edits that will not be applied
//   unchanged:   number of edits that would change nothing
//   consistency: []   (R3, D5: the app no longer rewrites age / gender after the edits; kept empty for the window)
// }
// The dry run uses exactly the code Apply uses (applyVoiceEdit), so the window shows what Apply will do.
export function previewEdits(doc, edits, { fromFile = true, selected = null } = {}) {
  const ed = copyEditor(doc);
  const items = [];
  const blocked = [];
  let unchanged = 0;
  edits.forEach((e, index) => {
    if (selected && !selected.has(index)) return;
    const before = ed.state.doc;
    const r = applyVoiceEdit(ed, e, { fromFile });
    const fallback = e.field_label || e.block_id;
    if (!r.ok) {
      blocked.push({ index, field: fallback, reason: r.error || 'could not be applied' });
      return;
    }
    if (ed.state.doc.eq(before)) {
      unchanged++;
      return;
    }
    const now = ed.state.doc;
    items.push({
      index,
      field: placeName(now, r.pos, fallback),
      before: r.before || '',
      after: r.after || '',
      patient: isPatientDetail(now, r.pos, r.before || '', r.after || ''),
      also: [],
    });
  });
  ed.isDestroyed = true;
  return { items, blocked, unchanged, consistency: [], doc: ed.state.doc };
}
