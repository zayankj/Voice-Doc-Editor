// R4 (D3): which of Gemini's edits DELETE existing text. Decided by the OPERATION only - never by the words of the
// command, the section, the language or the medicines. (Since 23 Nov the confirmation window is decided by
// needsConfirmation below: only medicine removals; other removals are applied directly, with Undo.)
//   - clear of a block that has text
//   - set with an empty text ("") on a block that has text
//   - replace_text with an empty new_value ("" = remove the found text)
// Replacements, corrections, additions, formatting and lists are not deletions.
//   - (Stage 1) the new text is checked as it will be applied: "\n" written as two characters is a line break
//     (aiEdits.js), so set "\n" empties the block and is a deletion
//   - (Stage 1) replace_text whose new text is only spaces, tabs or line breaks: a deletion when the removed text has
//     a letter or a number in it, or is the whole text of the block. Turning ", " into a line break ("each diagnosis
//     on its own line") removes no words or numbers and is applied directly.
import { getBlocks } from './outline.js';
import { withRealLineBreaks } from './aiEdits.js';
import { isMedicineEntry } from './medicineText.js';

const squash = (t) => String(t).replace(/\s+/g, ' ').trim();

export function isDeletion(doc, edit) {
  const e = withRealLineBreaks(edit);
  const op = e?.operation;
  if (op !== 'clear' && op !== 'set' && op !== 'replace_text') return false;
  const b = getBlocks(doc)[parseInt(String(e.block_id).replace(/\D/g, ''), 10)];
  const hasText = Boolean(b && b.node.textContent.trim());
  if (op === 'clear') return hasText;
  if (op === 'set') return hasText && typeof e.new_value === 'string' && !e.new_value.trim();
  if (typeof e.new_value !== 'string' || typeof e.find_text !== 'string' || e.find_text === '') return false;
  if (e.new_value === '') return true;
  if (e.new_value.trim()) return false; // real text replaces it: a replacement, not a deletion
  if (/[\p{L}\p{N}]/u.test(e.find_text)) return true; // words or numbers would disappear
  return hasText && squash(e.find_text) === squash(b.node.textContent); // the block would be emptied
}

export const hasDeletion = (doc, edits) => (edits || []).some((e) => isDeletion(doc, e));

// ---------- the confirmation window: ONLY when an existing MEDICINE is removed or replaced ----------
// Gemini says it: removes_medicine on each clear / set / replace_text (true = an existing medicine is removed or
// replaced by a different medicine; false = other text, or only a dose / timing / duration of a medicine that stays).
// The app does not decide what the person meant. It only makes sure a missing, invalid or contradicting answer can
// never skip the window:
//   - removes_medicine true                      -> the window
//   - false, and the edit REMOVES text           -> applied directly, unless the removed text is a medicine line by
//                                                   the app's existing medicine check (isMedicineEntry) - then the
//                                                   answer contradicts itself and the window is shown
//   - false, and the edit changes text           -> applied directly (a dose change, a correction ...)
//   - missing / not true or false                -> the window for every removal, and for every change of a line the
//                                                   existing medicine check recognises; otherwise applied directly
// Additions, inserts, formatting and lists never open the window.

const blockOf = (doc, e) => getBlocks(doc)[parseInt(String(e?.block_id).replace(/\D/g, ''), 10)];
// the existing text the edit takes away or replaces: the whole block (clear / set), or find_text (replace_text)
function touchedText(doc, e) {
  if (e.operation === 'replace_text') return typeof e.find_text === 'string' ? e.find_text : '';
  const b = blockOf(doc, e);
  return b ? b.node.textBetween(0, b.node.content.size, '\n', '\n') : '';
}
const hasMedicineLine = (text) => String(text).split('\n').some((l) => l.trim() && isMedicineEntry(l.trim(), true));

export function needsMedicineConfirmation(doc, edit) {
  const e = withRealLineBreaks(edit);
  const op = e?.operation;
  if (op !== 'clear' && op !== 'set' && op !== 'replace_text') return false;
  if (e.removes_medicine === true) return true;
  const old = touchedText(doc, e);
  if (!old.trim()) return false; // no existing text is touched (e.g. writing into an empty block)
  const removes = isDeletion(doc, e);
  const medicineLine = hasMedicineLine(old);
  if (e.removes_medicine === false) return removes && medicineLine;
  return removes || medicineLine;
}

export const needsConfirmation = (doc, edits) => (edits || []).some((e) => needsMedicineConfirmation(doc, e));
