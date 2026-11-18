// R4 (D3): which of Gemini's edits DELETE existing text. Decided by the OPERATION only - never by the words of the
// command, the section, the language or the medicines. Used by App.jsx: a command or upload that contains a deletion
// is shown in the confirmation window first; everything else is applied directly.
//   - clear of a block that has text
//   - set with an empty text ("") on a block that has text
//   - replace_text with an empty new_value ("" = remove the found text)
// Replacements, corrections, additions, formatting and lists are not deletions.
import { getBlocks } from './outline.js';

export function isDeletion(doc, e) {
  const op = e?.operation;
  if (op !== 'clear' && op !== 'set' && op !== 'replace_text') return false;
  const b = getBlocks(doc)[parseInt(String(e.block_id).replace(/\D/g, ''), 10)];
  const hasText = Boolean(b && b.node.textContent.trim());
  if (op === 'clear') return hasText;
  if (op === 'set') return hasText && typeof e.new_value === 'string' && !e.new_value.trim();
  return typeof e.new_value === 'string' && e.new_value === '' && typeof e.find_text === 'string' && e.find_text !== '';
}

export const hasDeletion = (doc, edits) => (edits || []).some((e) => isDeletion(doc, e));
