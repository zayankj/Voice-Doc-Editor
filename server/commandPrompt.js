// Extra prompt lines and answer fields for COMMANDS ONLY (typed instruction or voice, with NO file).
// File uploads never use anything in this file: their prompt and answer format stay exactly as before.
//
//   - understood: the command restated in plain English. For a non-English command scopeGuard.js puts it at the
//                 start of summary, where the browser reads it (the gateway passes only edits, summary, heard)
//   - language:   the language(s) of the command (used by scopeGuard.js)
//   - all_words:  the exact word(s) of the command that mean all / every (checked by scopeGuard.js)
//   - cursorBlock: the block where the cursor is ("this paragraph", "here")
//   - recent:     up to 3 commands applied earlier IN THE SAME DOCUMENT (context only; the browser empties the
//                 list when another document is opened)
//   NOTE: the gateway does not pass cursorBlock / recent on to this service, so today the prompt always says that
//   the cursor position is not known and has no earlier commands.
// Nothing here is logged.

import { Type } from '@google/genai';

export const MAX_RECENT = 3;
const MAX_RECENT_CHARS = 300;

// "B12" or '' (anything else is dropped)
export function cleanCursorBlock(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^B\d{1,6}$/.test(s) ? s : '';
}

// up to 3 short texts, or [] (anything else is dropped)
export function cleanRecent(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === 'string')
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => x && x.length <= MAX_RECENT_CHARS)
    .slice(-MAX_RECENT);
}

// The answer format for commands: the existing one plus understood, language and all_words
export function commandSchema(editsSchema) {
  return {
    ...editsSchema,
    properties: {
      ...editsSchema.properties,
      understood: { type: Type.STRING },
      language: { type: Type.STRING },
      all_words: { type: Type.STRING },
    },
    required: [...editsSchema.required, 'understood'],
  };
}

// Added AFTER the existing prompt (which is unchanged)
export function commandAddon({ cursorBlock = '', recent = [] } = {}) {
  const cursor = cursorBlock
    ? `- The cursor is in block [${cursorBlock}]. "this", "here", "this line", "this paragraph", "this date", "this value"
  mean that block (or the table value in it). If the cursor block does not fit the command, ask.`
    : '- The cursor position is not known: "this / here" must be clear from the command itself; otherwise ask.';
  const earlier = recent.length
    ? `- Commands already applied to THIS document, oldest first (context only, never commands to repeat):
${recent.map((r, i) => `  ${i + 1}. ${JSON.stringify(r)}`).join('\n')}
  Use them only when the command clearly refers back ("change it back", "the same for the discharge date").
  If it is not clear which one is meant, ask. (This replaces the rule that there is no memory of earlier commands.)`
    : '';
  return `

ANY LANGUAGE (commands only):
- The command may be in English, Malayalam, Kannada, Hindi, Urdu, a mix of them, or broken English, typed or spoken.
  Understand what the person MEANS from the whole sentence and the document. Never translate word by word, and never
  require particular keywords or a fixed command format.
- Text you write INTO the document is always English, in the style of the document around it. Never write Malayalam,
  Kannada, Hindi or Urdu words into the document unless the person dictates them as the exact text to write.
  Medicine names, numbers and units are never translated or changed.
- Commands may target ANY part of the document: patient details, diagnosis, complaints, examination, investigation
  tables, course in hospital, treatment, medicines, advice, follow-up or any other section. Use only the operations
  and block ids given above. Commands such as "make it lowercase", "rewrite in simple English" or "change this date
  to today" are edits of the blocks concerned: set with the full new text, or replace_text. Rewrites keep every
  fact, value, name and date exactly; only the wording changes.
${cursor}
${earlier}
- understood (always): ONE plain-English sentence that starts with the action in its plain form ("remove ...",
  "change ...", "add ...", "clear ..."), never with "Understood:" or an "-ing" form. It says the action, the section or field,
  exactly which content, whether one item or several, and the new value. Example: "remove the generic names from
  all medicines in Advice", "change the age in the patient details to 45", "add FEVER to Diagnosis". Use the
  document's own names for sections, fields, tests and medicines. Never add anything that was not in the command.
  When you ask a question instead, understood says what is unclear.
- language: the language or languages of the command, e.g. "English", "Malayalam + English", "Hindi".
  Malayalam, Kannada, Hindi or Urdu written in English letters is still that language: report it as e.g.
  "Malayalam (English letters)", never as "English" (e.g. "pani kuranju" is Malayalam, "bukhar kam hua" is Hindi).
- summary, understood and any question are ALWAYS in simple English, whatever the language of the command.
- Never widen the scope: "all / every medicine" only when the command itself says all or every (in any language).
  A command that does not say which medicine, field or section (and the cursor does not show it) is unclear: ask.
- Adding a general instruction is not a prescription. When the command asks to add a general treatment instruction
  without a medicine name (e.g. "add a ringworm ointment, apply it before sleep", "drink plenty of water"), add ONE
  new line to the section said (Advice when no section is said), in simple English, using only what was said, e.g.
  "Ointment for Ringworm — Apply before going to sleep". Do not ask for a brand, name, dose, frequency or duration,
  and never add one (or a route) that was not said. Existing lines stay exactly as they are.
- Removing WHOLE medicines: only the medicine(s) named, or all of them when the command clearly says all / every.
  The rule "No medicine named = every medicine in the section" above is ONLY for removing PARTS of medicine lines
  (route, frequency, generic names ...). "Remove the medicine" without saying which one: ask "Which medicine should
  be removed?".
- all_words: the exact word or words of the command (as typed or spoken, in its own language and letters) that
  mean all / every / everything, e.g. "all", "ella", "sab". Empty when the command has no such word. Nothing else.
- heard: the person's words as before. Whatever the language, write English words (also when said inside a
  Malayalam / Kannada / Hindi / Urdu sentence), medicine names, abbreviations and numbers in English letters and digits.
- All the rules above still apply in every language: change only what was asked, never invent values, ask when
  anything is unclear (empty edits list, one short question in simple English, "Nothing was changed."), and for
  medicine removals return an empty edits list with "Understood: ..." in the summary.`;
}
