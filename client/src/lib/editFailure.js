// Why an AI edit was not applied: a FIXED reason code for the console log, and a plain sentence for the person.
// The editor (voiceEdit.js applyVoiceEdit) returns { ok: false, error } for an edit it cannot make, or
// { ok: false, blocked: true, error } when a safety / validation check refused it. Its error text may contain
// document words (e.g. the text it looked for), so that text is NEVER logged: only the codes below are.

export const REASON_CODES = ['text_not_found', 'no_such_block', 'missing_value', 'unknown_operation', 'rejected_by_check', 'not_applied'];

// The sentence shown in the note for each code (no document text in it)
export const REASON_TEXT = {
  text_not_found: 'the text to replace was not found there',
  no_such_block: 'the place it pointed to does not exist in the document',
  missing_value: 'the AI did not give the new text',
  unknown_operation: 'the AI asked for a kind of change the editor cannot make',
  rejected_by_check: 'it was refused by a safety check',
  not_applied: 'the editor could not make this change',
};

// A failed result of applyVoiceEdit -> one code from REASON_CODES
export function reasonCode(result) {
  if (result?.blocked) return 'rejected_by_check';
  const e = String(result?.error || '');
  if (/^Block \S* does not exist$/.test(e)) return 'no_such_block';
  if (/^".*" not found in B\d+/s.test(e)) return 'text_not_found';
  if (/^(insert_after|append) needs new_value$/.test(e)) return 'missing_value';
  if (/^Unknown operation: /.test(e)) return 'unknown_operation';
  return 'not_applied';
}

// The note part for edits that could not be applied (not the safety-check refusals: those keep their own 🔒 note).
// failed: [{ code, label }] with label = the AI's field label ("Diagnosis"), shown on screen only.
export function notAppliedNote(failed) {
  if (!failed.length) return '';
  const parts = failed.map((f) => {
    const why = REASON_TEXT[f.code] || REASON_TEXT.not_applied;
    const label = String(f.label || '').trim();
    return label ? `${label}: ${why}` : why;
  });
  return `${failed.length} could not be applied (${parts.join('; ')}).`;
}

// ONE console line for the edits of a command that were not applied: fixed codes and counts only. Anything that is
// not a known code is printed as "?", so content can never reach the console, even by mistake.
// editFailureLine(['text_not_found', 'rejected_by_check']) -> 'Edit not applied: count=2 reasons=text_not_found,rejected_by_check'
export function editFailureLine(codes) {
  const list = (Array.isArray(codes) ? codes : []).map((c) => (REASON_CODES.includes(c) ? c : '?'));
  return `Edit not applied: count=${list.length} reasons=${list.join(',') || '-'}`;
}
