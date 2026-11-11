// Upload preview: a DRY RUN of the AI's edits on a COPY of the document.
// The copy is changed with exactly the same code as Apply (applyVoiceEdit + the age / gender steps), so the
// preview shows what Apply will do. The real editor, its Undo history and its highlights are never touched.
import { EditorState } from '@tiptap/pm/state';
import { applyVoiceEdit, applyPatientConsistency, ensurePatientConsistency, getPatientFacts } from './voiceEdit.js';
import { getBlocks } from './outline.js';
import { changesGender, isLabelText } from './guards.js';
import { cellAt, dataCellRole, rowName } from './tables.js';
import { countMedicineLines } from './medicineText.js';

// How many medicine lines a set of AI edits (typed / spoken command) would remove, worked out on a COPY with
// exactly the same code as Apply. The app refuses edits that remove 2 or more: several medicines are removed
// only through the confirmation window ("remove all medicines", "remove all syrups", "remove dolo and ciplox").
export function medicinesLostByEdits(doc, edits, allowGender = true) {
  const dry = previewEdits(doc, edits, { allowGender, fromFile: false });
  return countMedicineLines(doc) - countMedicineLines(dry.doc);
}

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
// selected: indexes of the edits to include (default: all); consistency: also run the final age / gender step
// Returns {
//   items:       [{ index, field, before, after, patient, also: [{ before, after }] }]  edits that change something
//   blocked:     [{ index, field, reason }]                                            edits that will not be applied
//   unchanged:   number of edits that would change nothing
//   consistency: [{ before, after }]   extra places the final age / gender step would change
// }
export function previewEdits(doc, edits, { allowGender = true, fromFile = true, selected = null, consistency = true } = {}) {
  const ed = copyEditor(doc);
  const items = [];
  const blocked = [];
  let unchanged = 0;
  edits.forEach((e, index) => {
    if (selected && !selected.has(index)) return;
    const before = ed.state.doc;
    const facts = getPatientFacts(before);
    const r = applyVoiceEdit(ed, e, { allowGender, fromFile });
    const fallback = e.field_label || e.block_id;
    if (!r.ok) {
      blocked.push({ index, field: fallback, reason: r.error || 'could not be applied' });
      return;
    }
    if (ed.state.doc.eq(before)) {
      unchanged++;
      return;
    }
    // the header age / gender changed: the matching narrative phrases follow (as handleEdit does in App.jsx)
    const also = applyPatientConsistency(ed, facts).map((c) => ({ before: c.before, after: c.after }));
    const now = ed.state.doc;
    items.push({
      index,
      field: placeName(now, r.pos, fallback),
      before: r.before || '',
      after: r.after || '',
      patient: also.length > 0 || isPatientDetail(now, r.pos, r.before || '', r.after || ''),
      also,
    });
  });
  // the final age / gender step, exactly as App.jsx applyAiEdits does it: Patient Details (the header) are the source;
  // when they did not change, only the text these edits wrote follows them (no other place, never the header)
  let extra = [];
  if (items.length && consistency) {
    const start = getPatientFacts(doc);
    const now = getPatientFacts(ed.state.doc);
    const oldTexts = new Set(getBlocks(doc).map((b) => b.node.textContent));
    const detailsChanged = now.age !== start.age || now.gender !== start.gender;
    extra = (detailsChanged ? ensurePatientConsistency(ed) : ensurePatientConsistency(ed, null, (node) => !oldTexts.has(node.textContent)))
      .map((c) => ({ before: c.before, after: c.after }));
  }
  ed.isDestroyed = true;
  return { items, blocked, unchanged, consistency: extra, doc: ed.state.doc };
}
