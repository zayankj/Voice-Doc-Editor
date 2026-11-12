// Builds ONE timing line for the browser console (F12) per voice command. Performance only; nothing is sent anywhere.
// PRIVACY: a line holds only numbers and the fixed outcome words below. Any other text (a transcript, a name,
// document text, a medicine ...) is printed as "?", so content can never reach the console, even by mistake.

const OUTCOMES = ['applied', 'window', 'none', 'error'];

// voiceTimingLine({ clip_s: 5.04, request_ms: 3700, outcome: 'applied' }) -> 'Voice timing: clip_s=5.0 request_ms=3700 outcome=applied'
export function voiceTimingLine(fields = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (!/^[a-z_]{1,24}$/.test(k)) continue; // field names come from the code, never from content
    let out;
    if (typeof v === 'number') out = Number.isFinite(v) ? (k.endsWith('_s') ? v.toFixed(1) : String(Math.round(v))) : '?';
    else if (v === undefined || v === null) out = '-';
    else out = OUTCOMES.includes(v) ? v : '?';
    parts.push(`${k}=${out}`);
  }
  return `Voice timing: ${parts.join(' ')}`;
}
