// Runs on every COMMAND answer (typed, Gemini Live voice, backup voice path, streaming) before it leaves the AI service.
// Never used for file uploads.
//
// R3 (D1, D4): Gemini decides the edits. This step only checks that every edit is COMPLETE (R1) and passes the answer
// on as Gemini wrote it - no scope rules, no word lists, no language rules, no rewriting of the summary.
// Returns { edits, summary, heard } - the fields the gateway passes on.

// Stage R1: the minimum technical check of the edits (the same rule as the browser's incompleteEdit in
// client/src/lib/voiceEdit.js; the Live path already checks this in checkLiveResult). An edit whose text is MISSING:
// set without new_value, append / insert_after without text, replace_text without find_text or new_value.
// Never about the words or the medicines.
export function incompleteEdit(e) {
  const op = e?.operation;
  if (op === 'set' && typeof e.new_value !== 'string') return true;
  if ((op === 'append' || op === 'insert_after') && (typeof e.new_value !== 'string' || !e.new_value.trim())) return true;
  if (op === 'replace_text' && (typeof e.find_text !== 'string' || !e.find_text || typeof e.new_value !== 'string')) return true;
  return false;
}
export const INCOMPLETE_ANSWER = "The AI's answer was incomplete (a change had no text), so nothing was changed. Please say it again.";

// answer: { edits, summary, heard, ... }. The second argument ({ outline, said }) is accepted for the callers' unchanged
// signature and not used.
export function finishCommand(answer, _context = {}) {
  const heard = String(answer?.heard || '');
  // (Stage R1) one incomplete edit = the whole answer is not used (never a part of a command): nothing changes
  if (Array.isArray(answer?.edits) && answer.edits.some(incompleteEdit)) {
    return { edits: [], summary: INCOMPLETE_ANSWER, heard };
  }
  return { edits: Array.isArray(answer?.edits) ? answer.edits : [], summary: String(answer?.summary || ''), heard };
}
