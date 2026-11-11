import { classifyCommand, understandRemoval, asksForPatterns } from './commandIntent.js';
import { categoryOfTerm, formsFromCommand } from './medicineText.js';

// The AI may restate a command it understood ("Understood: remove the Oral route and all frequency instructions
// from all medicines in Advice."). That restatement is NEVER trusted by itself. This file checks it against the
// person's ORIGINAL words (typed text or the transcript "heard"):
//
//   - only a medicine REMOVAL may come from an interpretation (never a section clear or anything else),
//   - the plan is built by browser code from the document (the AI's own edits are never applied),
//   - the action, the parts (route / frequency ...), the medicine types and the medicine names must all be
//     found in the original words; anything that does not match -> ask, nothing changes.
//   - a removal whose action word the app cannot check (Malayalam, Hindi "hatao" ...) is never carried out:
//     the app asks for it again with an English removal word.
//
// Malayalam: the app cannot yet check Malayalam action words (they must first be validated by a fluent speaker).
// A command written in Malayalam script with no supported action word is NEVER carried out.

const MALAYALAM = /[ഀ-ൿ]/;
// action words the app can check (English only, for now)
const ACTION = /\b(?:remove|delete|drop|take\s+out|erase|clear|wipe|omit|change|replace|update|set|make|put|add|insert|write|correct)\b/i;
const REMOVE_ACTION = /\b(?:remove|delete|drop|strip|take\s+out|erase|omit|get\s+rid\s+of|clear|wipe)\b/i;
const THIS_ONE = /\b(?:this|that|current|selected)\s+(?:medicine|medication|drug|one|line|entry|tablet|syrup|capsule|injection)\b/i;
const CATEGORY_EVIDENCE = {
  route: /\b(?:routes?|administration)\b/i,
  frequency: /\b(?:frequenc(?:y|ies)|how often|dosing schedule|dose timings?)\b/i,
  generic: /\b(?:generics?|generic\s+names?|salt\s+names?|composition)\b/i,
  description: /\b(?:descriptions?|antacid|probiotic|prebiotic|supplement|multivitamin|mineral)s?\b/i,
  as_needed: /\b(?:as[\s-]needed|sos|prn|when required)\b/i,
  food: /\b(?:food|meals?|breakfast|lunch|dinner|empty stomach)\b/i,
};

const squash = (t) => ` ${String(t || '').toLowerCase().replace(/[^a-z0-9ഀ-ൿ\s-]/g, ' ').replace(/\s+/g, ' ').trim()} `;

export const hasMalayalam = (text) => MALAYALAM.test(String(text || ''));
export const hasSupportedAction = (text) => ACTION.test(String(text || ''));

// The sentence after "Understood:" in the AI's summary, or ''
export function understoodFrom(summary) {
  const m = String(summary || '').match(/Understood:\s*([\s\S]*?)(?:\.(?=\s+[A-Z][a-z])|\.?\s*$)/);
  return m ? m[1].trim() : '';
}

// A Malayalam command whose action the app cannot check. Returns a question (string) or ''.
export function malayalamStop(original, understood = '') {
  if (!hasMalayalam(original) || hasSupportedAction(original)) return '';
  const u = understood ? `I understood: "${understood}" (your words: "${String(original).trim()}"). ` : '';
  return `${u}The app cannot confirm the action in Malayalam yet. Please say it again using a word like "remove" or "change", or type the command. Nothing was changed.`;
}

// Checks the AI's interpretation against the original words.
// Returns { type: 'none' }                          not a medicine removal: the normal path continues
//         { type: 'ask', question }                 does not match / cannot be checked: ask, nothing changes
//         { type: 'remove', kind, intent, plan, understood, original }   show the confirm window
export function checkInterpretation(doc, { original, understood, cursor } = {}) {
  const said = String(original || '').trim();
  const u = String(understood || '').trim();
  if (!said || !u) return { type: 'none' };
  const r = classifyCommand(doc, u, { cursor });
  // the interpretation itself is unclear or unsafe ("this medicine" with no medicine at the cursor, doses of
  // several medicines ...): ask, nothing changes
  if (r.type === 'ask') return { type: 'ask', question: r.question };
  if (r.type !== 'remove') return { type: 'none' }; // only medicine removals may come from an interpretation
  const intent = r.intent || {};
  const ask = (why) => ({
    type: 'ask',
    question: `I understood: "${u}" (your words: "${said}"), but ${why}. Please say it again more simply, or type the command. Nothing was changed.`,
  });

  // 1. the action: a removal word the app can check must be in the original words. If not (Malayalam, Hindi
  //    "hatao" ...), the removal is NOT carried out and the AI's edits are not used: ask for an English removal word.
  if (!REMOVE_ACTION.test(said)) {
    return {
      type: 'ask',
      question: `I understood: "${u}" (your words: "${said}"), but the app cannot confirm the action in your words. ` +
        `Please say it again using an English removal word such as "remove" (for example "remove oral from all tablets"). Nothing was changed.`,
    };
  }
  const s = squash(said);
  const what = understandRemoval(said);
  // 2. the parts: every category / word to remove must be in the original words
  for (const k of intent.categories || []) {
    const shown = CATEGORY_EVIDENCE[k]?.test(said) || what.categories.includes(k) || what.phrases.some((p) => categoryOfTerm(p) === k);
    if (!shown) return ask(`"${k.replace('_', ' ')}" is not in your words`);
  }
  for (const p of intent.phrases || []) {
    if (!s.includes(squash(p))) return ask(`"${p}" is not in your words`);
  }
  // dosing patterns are ticked only when the person's OWN words ask for them ("pattern", "1-0-1")
  if (intent.patterns && !asksForPatterns(said)) return ask('your words do not ask to remove the dosing patterns');
  // 3. the medicine types: exactly the types said
  const saidForms = formsFromCommand(said).sort().join(',');
  if (saidForms !== [...(intent.forms || intent.entries?.forms || [])].sort().join(',')) {
    return ask('the medicine types do not match your words');
  }
  // 4. the medicines: every name must be in the original words; "this medicine" must have been said
  for (const n of intent.names || []) {
    if (!s.includes(squash(n))) return ask(`the medicine "${n.toUpperCase()}" is not in your words`);
  }
  if ((intent.entries || []).length && !THIS_ONE.test(said)) return ask('your words do not say which medicine');
  // 5. the original words must not name a medicine the interpretation left out
  if (!(intent.names || []).length && !(intent.entries || []).length) {
    const own = classifyCommand(doc, said, { cursor });
    if (own.type === 'remove' && ((own.intent?.names || []).length || (own.intent?.entries || []).length)) {
      return ask('your words name a medicine that the interpretation left out');
    }
  }
  return { type: 'remove', kind: r.kind, intent, plan: r.plan, understood: u, original: said };
}

// ---------- commands the app cannot check against the person's own words (approved option A) ----------
// Non-English commands (any script other than Latin, or a language other than English reported by the AI, e.g.
// Hindi / Urdu / Kannada written in English letters) are understood by the AI, but the app's checks above can only
// read English. Such a command is NEVER applied directly: the AI's plain-English restatement ("understood") is run
// through the existing checks and shown in a window next to the person's own words, and nothing changes until the
// person presses Apply. English commands keep the path above, unchanged.

// letters that are not Latin (Malayalam, Kannada, Devanagari, Arabic / Urdu ...)
const NON_LATIN_LETTER = /(?![A-Za-zÀ-ɏ])\p{L}/u;
// words that describe the KIND of English, not another language ("broken English", "informal English")
const ENGLISH_KIND = /\b(?:broken|informal|simple|simplified|spoken|typed|casual|indian|grammatically|incorrect|poor|non-native|with|errors?|mixed|english)\b/gi;

// The language(s) reported by the AI: true when any of them is not English. Empty / unknown -> false (the English
// checks then run on the person's own words, which is the existing, stricter path).
export function reportedNonEnglish(language) {
  const parts = String(language || '').toLowerCase().replace(/\([^)]*\)/g, ' ').split(/[+,&/;]|\band\b/);
  return parts.some((p) => p.replace(ENGLISH_KIND, ' ').replace(/[^a-z]/g, '') !== '' && !/english/.test(p));
}

// Must this command be shown in a window before anything changes?
export function needsPreview(original, language = '') {
  return NON_LATIN_LETTER.test(String(original || '')) || reportedNonEnglish(language);
}

// A command that reached the English checks (written in English letters, language reported as English or not at
// all) but whose words contain NO English removal word, while the AI understood something: e.g. Malayalam / Hindi
// written in English letters ("advice ella medicines um ozhivakki kalayan"). The English checks cannot read its
// action, so instead of asking for an English word it is handled like a non-English command (window first).
export function englishChecksCannotRead(original, understood) {
  return Boolean(String(understood || '').trim()) && !REMOVE_ACTION.test(String(original || ''));
}

// Option A: the AI service puts the English interpretation of a non-English command at the start of summary
// ("Understood: ... ."), because the gateway passes only edits / summary / heard. It is used for the checks, but
// never shown: this is the summary without that sentence (no interpretation lines in windows or the side panel).
export function summaryToShow(summary) {
  return String(summary || '').replace(/^\s*Understood:\s*[\s\S]*?(?:\.(?=\s+[A-Z][a-z])|\.?\s*$)/, '').trim();
}

// What the AI's restatement means for the app (the person's words are NOT word-checked here; the window is the check)
// Returns { type: 'ask', question }                     unclear / unsafe: ask, nothing changes
//         { type: 'remove', kind, intent, plan }         a medicine removal: the existing medicine window
//         { type: 'clear', section, preview }            clearing a section: the existing Clear-section window
//         { type: 'edits' }                              anything else: the AI's edits go to the preview window
export function interpretForPreview(doc, { original, understood, cursor } = {}) {
  // the AI may write "Understood: remove all medicines from Advice." - the engine reads the plain command
  const u = String(understood || '').trim().replace(/^understood\s*:\s*/i, '').replace(/\.\s*$/, '').trim();
  if (!u) return { type: 'ask', question: 'The command was not understood clearly. Please say it again, or type it. Nothing was changed.' };
  const r = classifyCommand(doc, u, { cursor });
  if (r.type === 'ask') return { type: 'ask', question: r.question };
  if (r.type === 'clear') return { type: 'clear', section: r.section, preview: r.preview };
  if (r.type !== 'remove') return { type: 'edits' };
  // dosing patterns are ticked only when the person's OWN words ask for them (e.g. "1-0-1"); otherwise shown unticked
  if (r.intent?.patterns && !asksForPatterns(original)) {
    const plan = {
      ...r.plan,
      changes: r.plan.changes.map((c) => ({ ...c, removals: c.removals.map((x) => (x.kind === 'pattern' ? { ...x, selected: false } : x)) })),
    };
    return { type: 'remove', kind: r.kind, intent: r.intent, plan };
  }
  return { type: 'remove', kind: r.kind, intent: r.intent, plan: r.plan };
}
