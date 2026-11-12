// Builds ONE timing line for the server terminal. Performance logs only: never sent to the browser.
// PRIVACY: a line holds only numbers, yes/no and the FIXED labels below. Any other text (a transcript, a name,
// document text, a medicine, a key ...) is printed as "?", so content can never reach the log, even by mistake.

// Every reason liveVoice.js can give (its LiveError messages), plus the fixed outcome words
export const LIVE_REASONS = [
  'live is off', 'timeout', 'no function call', 'model spoke instead of calling the function', 'connection error', 'connection failed', 'closed',
  'audio is not a WAV file', 'WAV format block is broken', 'WAV data is cut off', 'WAV has no format block',
  'WAV is not 16-bit 16 kHz mono PCM', 'WAV has no audio', 'WAV audio length is odd', 'WAV is too long',
  'empty transcript', 'too many edits',
  'invalid function arguments (not an object)', 'invalid function arguments (edits not a list)',
  'invalid function arguments (summary, heard or language not text)', 'invalid function arguments (all_words not text)',
  'invalid function arguments (understood missing)',
  'invalid edit (not an object)', 'invalid edit (block_id not like B12)', 'invalid edit (unknown operation)',
  'invalid edit (field_label missing)', 'invalid edit (new_value or find_text not text)', 'invalid edit (new_value missing)',
  'invalid edit (replace_text needs find_text and new_value)', 'invalid edit (unknown style)', 'invalid edit (unknown case)',
  'invalid edit (unknown list_type)', 'invalid edit (last_block_id not like B12)', 'invalid edit (duplicate_ok not true/false)',
  'invalid edit (lines not a valid list)', 'invalid edit (format needs style)', 'invalid edit (change_case needs case)',
  'invalid edit (select not a valid list)', 'invalid edit (to_list needs list_type and lines or select)',
];
const WORDS = ['ok', 'failed', 'done', 'error', 'skipped'];
const CLOSED = /^closed \d{1,5}$/; // "closed 1007": a WebSocket close code, a number only

export const safeLabel = (v) => (typeof v === 'string' && (LIVE_REASONS.includes(v) || WORDS.includes(v) || CLOSED.test(v)) ? v : '?');

// timingLine('Voice timing', { live: 'ok', connect_ms: 170, edits: 1 }) -> 'Voice timing: live=ok connect_ms=170 edits=1'
export function timingLine(title, fields = {}) {
  const head = ['Voice timing', 'Backup timing'].includes(title) ? title : 'Timing';
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (!/^[a-z_]{1,24}$/.test(k)) continue; // field names come from the code, never from content
    let out;
    if (typeof v === 'number') out = Number.isFinite(v) ? String(Math.round(v)) : '?';
    else if (typeof v === 'boolean') out = v ? 'yes' : 'no';
    else if (v === undefined || v === null) out = '-';
    else {
      const label = safeLabel(v);
      out = label.includes(' ') ? `"${label}"` : label;
    }
    parts.push(`${k}=${out}`);
  }
  return `${head}: ${parts.join(' ')}`;
}
