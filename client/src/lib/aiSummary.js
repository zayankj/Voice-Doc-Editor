// The AI's summary as it is shown to the person: an "Understood: ..." restatement at its start is left out
// (display only; moved here from the removed lib/interpretation.js in R6).
export function summaryToShow(summary) {
  return String(summary || '').replace(/^\s*Understood:\s*[\s\S]*?(?:\.(?=\s+[A-Z][a-z])|\.?\s*$)/, '').trim();
}
