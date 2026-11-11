// Runs on every COMMAND answer (typed, Gemini Live voice, backup voice path) before it leaves the AI service.
// Never used for file uploads.
//
// 1. Scope check: an answer that would remove WHOLE medicines (several at once, none named) is only allowed when
//    the person's OWN words say "all / every". The model reports the exact word(s) it took as "all" (all_words);
//    they must really be in the person's words (typed text, Google's transcript or the model's transcript).
//    English "all / every" in the words also counts. Otherwise the answer becomes a question and nothing changes.
//    ("dawai hata do" understood as "remove all medicines" -> "Which medicine should be removed?")
//    Removing PARTS of medicine lines (route, frequency, generic names ...) and named medicines are not affected.
// 2. Option A: the gateway passes only { edits, summary, heard } to the browser, so for a NON-ENGLISH command the
//    English interpretation is put at the start of summary ("Understood: <interpretation>. ..."), where the
//    browser reads it. English commands keep their summary unchanged.
// No language word lists: the words that mean "all" come from the model and are only CHECKED here.

const QUESTION = 'Which medicine should be removed? Please name the medicine, or say that all medicines should be removed. Nothing was changed.';

const REMOVE = /\b(?:remove|delete|clear|drop|erase|empty|take\s+out|omit|discontinue|stop)\b/i;
// whole medicines (a medicine word) or "everything"
const WHOLE = /\b(?:everything|medicines?|medications?|drugs?|tablets?|tabs?|capsules?|caps?|syrups?|suspensions?|injections?|drops|ointments?|creams?|gels?|sachets?|inhalers?)\b/i;
// parts of medicine lines: removing them is not removing medicines (existing behaviour, unchanged)
const PARTS = /\b(?:generics?|salt|routes?|oral|frequenc(?:y|ies)|doses?|dosage|strengths?|durations?|timings?|food|meals?|patterns?|descriptions?|as[\s-]needed|sos|instructions?)\b/i;
const THIS_ONE = /\b(?:this|that|current|selected)\s+(?:medicine|medication|drug|one|line|entry|tablet|syrup|capsule|injection)\b/i;
const ENGLISH_ALL = /\b(?:all|every|everything|entire|whole)\b/i;
const NON_LATIN_LETTER = /(?![A-Za-zÀ-ɏ])\p{L}/u;
// words that describe the KIND of English (same rule as the browser's reportedNonEnglish)
const ENGLISH_KIND = /\b(?:broken|informal|simple|simplified|spoken|typed|casual|indian|grammatically|incorrect|poor|non-native|with|errors?|mixed|english)\b/gi;

const norm = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "Understood: remove all medicines from Advice." -> "remove all medicines from Advice"
export const plainInterpretation = (s) => String(s || '').trim().replace(/^understood\s*:\s*/i, '').replace(/\.\s*$/, '').trim();

// the sentence after "Understood:" in a summary (same rule as the browser's understoodFrom)
export function understoodFrom(summary) {
  const m = String(summary || '').match(/Understood:\s*([\s\S]*?)(?:\.(?=\s+[A-Z][a-z])|\.?\s*$)/);
  return m ? m[1].trim() : '';
}

// medicine names in the document (the word after Tab. / Cap. / Syp. / Inj. ...)
export function medicineNames(outline) {
  const names = new Set();
  // line breaks inside a block appear as the two characters \n in the outline (JSON text)
  for (const m of String(outline || '').replace(/\\n/g, ' ').matchAll(/\b(?:Tab|Tablet|Cap|Capsule|Syp|Syrup|Susp|Inj|Injection)\.?\s+([A-Za-z][A-Za-z0-9-]{2,})/g)) names.add(m[1].toLowerCase());
  return [...names];
}

// Does this interpretation remove whole medicines without naming one?
export function removesUnnamedMedicines(interpretation, outline) {
  const u = plainInterpretation(interpretation);
  if (!u || !REMOVE.test(u) || !WHOLE.test(u) || PARTS.test(u) || THIS_ONE.test(u)) return false;
  return !medicineNames(outline).some((n) => new RegExp(`\\b${escape(n)}\\b`, 'i').test(u));
}

// Do the person's own words say "all / every"? allWords = the model's report; it must really be in the words.
export function saysAll(allWords, saidTexts) {
  const said = saidTexts.map(norm).filter(Boolean);
  if (said.some((s) => ENGLISH_ALL.test(s))) return true;
  // an "all" word is short (1-2 words), and never the whole sentence
  const pieces = String(allWords || '').split(/[,;/|]/).map(norm).filter((p) => p.length >= 2 && p.length <= 16 && p.split(' ').length <= 2);
  return pieces.some((p) => said.some((s) => s !== p && s.includes(p)));
}

export function reportedNonEnglish(language) {
  const parts = String(language || '').toLowerCase().replace(/\([^)]*\)/g, ' ').split(/[+,&/;]|\band\b/);
  return parts.some((p) => p.replace(ENGLISH_KIND, ' ').replace(/[^a-z]/g, '') !== '' && !/english/.test(p));
}

// answer: { edits, summary, heard, understood, language, all_words }; said: the person's words (typed text and/or
// transcripts). Returns { edits, summary, heard } - the fields the gateway passes on.
export function finishCommand(answer, { outline, said = [] }) {
  const edits = Array.isArray(answer.edits) ? answer.edits : [];
  const summary = String(answer.summary || '');
  const heard = String(answer.heard || '');
  const interpretation = plainInterpretation(answer.understood) || understoodFrom(summary);

  // 1. scope check
  if (removesUnnamedMedicines(interpretation, outline) && !saysAll(answer.all_words, [...said, heard])) {
    return { edits: [], summary: QUESTION, heard };
  }
  // 2. Option A: the English interpretation of a non-English command travels in summary
  const nonEnglish = reportedNonEnglish(answer.language) || [...said, heard].some((s) => NON_LATIN_LETTER.test(String(s || '')));
  if (!nonEnglish || !interpretation || /\?/.test(summary)) return { edits, summary, heard };
  const rest = summary.replace(/^\s*Understood:\s*[\s\S]*?(?:\.(?=\s+[A-Z][a-z])|\.?\s*$)/, '').trim();
  return { edits, summary: `Understood: ${interpretation}.${rest ? ` ${rest}` : ''}`, heard };
}
