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

// Look-only edits and lists, for COMMANDS ONLY (uploads keep the five text operations). The browser applies them
// (client/src/lib/voiceEdit.js) without changing any words.
export const COMMAND_OPERATIONS = ['set', 'replace_text', 'append', 'clear', 'insert_after', 'format', 'change_case', 'to_list', 'unlist'];
export const STYLES = ['bold', 'italic', 'underline', 'not_bold', 'not_italic', 'not_underline'];
export const CASES = ['upper', 'lower', 'title', 'sentence'];
export const LIST_TYPES = ['ordered', 'bullet'];
// to_list select: the kinds of medicine lines the BROWSER picks from the document (client/src/lib/voiceEdit.js)
export const SELECT_KINDS = ['all_medicines', 'tablets', 'capsules', 'syrups', 'suspensions', 'injections', 'drops', 'ointments', 'sachets', 'powders', 'inhalers'];
// the extra fields of one edit (the same in the Live function, server/liveVoice.js)
export const extraEditFields = (T) => ({
  style: { type: T.STRING, enum: STYLES },
  case: { type: T.STRING, enum: CASES },
  list_type: { type: T.STRING, enum: LIST_TYPES },
  lines: { type: T.ARRAY, items: { type: T.STRING } },
  select: { type: T.ARRAY, items: { type: T.STRING, enum: SELECT_KINDS } },
  last_block_id: { type: T.STRING },
  duplicate_ok: { type: T.BOOLEAN },
});

// The answer format for commands: the existing one plus understood, language and all_words, and the edits may also
// use the look-only / list operations and their fields. The existing schema object is not changed.
export function commandSchema(editsSchema) {
  const item = editsSchema.properties.edits.items;
  return {
    ...editsSchema,
    properties: {
      ...editsSchema.properties,
      edits: {
        ...editsSchema.properties.edits,
        items: {
          ...item,
          properties: {
            ...item.properties,
            operation: { ...item.properties.operation, enum: COMMAND_OPERATIONS },
            ...extraEditFields(Type),
          },
        },
      },
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
  (Adding a NEW medicine without a section is the exception: see "Adding a medicine" below.)
- Adding a general instruction is not a prescription. When the command asks to add a general treatment instruction
  without a medicine name (e.g. "add a ringworm ointment, apply it before sleep", "drink plenty of water"), add ONE
  new line to the section said (Advice when no section is said), in simple English, using only what was said, e.g.
  "Ointment for Ringworm — Apply before going to sleep". Do not ask for a brand, name, dose, frequency or duration,
  and never add one (or a route) that was not said. Existing lines stay exactly as they are.
- Removing WHOLE medicines: only the medicine(s) named, or all of them when the command clearly says all / every.
  The rule "No medicine named = every medicine in the section" above is ONLY for removing PARTS of medicine lines
  (route, frequency, generic names ...). "Remove the medicine" without saying which one: ask "Which medicine should
  be removed?".
- Formatting, lists and capital letters ARE edits for commands (this replaces the rule above that formatting is done
  with the toolbar). Colour, font, size, alignment, saving, printing and reading aloud are still done with the toolbar.
  These operations change only the look or the case, never the words:
  format: style = bold | italic | underline | not_bold | not_italic | not_underline.
  change_case: case = upper | lower | title | sentence. "Capitalize" / "capital letters" = upper. Use change_case
  (never set) for every change of capital letters.
  For both: the whole block, or only find_text inside it (one word, one name or one line); for a whole section or the
  whole document use ONE edit with block_id = the first block and last_block_id = the last block. The scope is exactly
  what was asked: a word, a line, a section (the text UNDER its heading, not the heading) or the whole document.
  To change a heading itself, use find_text = the heading's words.
  to_list: list_type = ordered (numbered) | bullet; block_id = a block of that section. Say WHICH lines with select
  and/or lines: select = the kinds of medicine asked for (all_medicines | tablets | capsules | syrups | suspensions |
  injections | drops | ointments | sachets | powders | inhalers); the app finds those lines itself (a line that starts
  with that form, e.g. "Tab." / "Syp."). lines = the exact text, copied from the document, of other lines to include:
  for "all medicines" also every medicine or treatment line that does not start with a form (e.g. a supplement or
  powder written by its name); for specific lines asked for, only those. (A line is a paragraph, or one line of a
  paragraph with line breaks.) Only what was asked ("all the tablets" = select tablets only); the other lines stay as
  they are. to_list ALWAYS needs select or lines (without them nothing changes).
  unlist: block_id = a block inside the list; the whole list becomes normal paragraphs.
- A NEW entry, line, medicine or instruction is ALWAYS insert_after (never append, never set): block_id = the block it
  goes after; when that block has several lines (line breaks), find_text = the exact line it goes after. No position
  said: after the last line of the section. append only continues the SAME line (e.g. ", TYPHOID" after a diagnosis).
- Adding a medicine: one new line, in the style of the existing lines, with ONLY what was said (name, and any strength,
  route, frequency, timing or duration that was said); never add one that was not said. Keep every other word said
  about the medicine (e.g. "TO CONTINUE", "till next review") exactly, in the order said; never drop it. Write the medicine name
  exactly as said, a form (Tab. / Cap. / Syp. ...) only when it was said, and a unit (mg, mcg, g, ml ...) only when
  it was said with that number ("Dolo 650" -> "DOLO 650", never "DOLO 650 mg").
  A missing strength, route, frequency, food timing or duration is NOT a reason to ask (for these parts this replaces
  "a new value is missing" in the rules above): add the line with only what was said, and write words such as
  "as prescribed" or "as directed" as said. Still ask when the medicine name is missing or unclear. This rule never
  allows skipping that question.
  No section said (and none shown by the cursor): the section where the discharge medicines are listed (Advice,
  Discharge Medications, Medications on Discharge ...); do not ask which section. Treatment Given (what was given in
  hospital) only when it is named. Ask about the section only when the document has no such section.
  A medicine line said on its own, without an action word (e.g. "Tab. Amoxil 500 mg oral once daily before food"),
  means: add it.
  No position said: it goes right after the LAST
  MEDICINE entry of the section (block_id = that entry; when the medicines are a numbered or bullet list, its last
  item), never after a review / follow-up line or other advice below the medicines. "At the bottom / at the end": the
  same. A position said: "at the top" / "as the first medicine" -> block_id = the section heading (the app puts it
  before the first medicine); "after X" -> block_id = X; "before X" -> block_id = the medicine just before X (the
  section heading when X is the first medicine). Adding never replaces an existing entry.
- The same medicine already there: a command that ADDS a medicine always adds a NEW line, also when the same
  medicine is already in that section; set duplicate_ok = true and do not ask. Never change, replace or remove the
  existing entry in order to add the new one.
- Changing an existing medicine: change only the part the command names. Its name, form (Tab. / Cap. / Syp. ...),
  strength, route, frequency, food timing and duration stay exactly as they are unless the command says to change them.
- A sentence of advice that is not a medicine to take (e.g. "Do not stop medication without cardiologist advice",
  "Continue medication as directed by the treating physician", "Come after the medicine completes") is ONE ordinary
  line, written as said: never a medicine entry (no Tab. / Cap., no dashes, no dose, route or frequency added) and
  never inside or between the medicine entries. No position said: after the last line of the section.
- Age and gender: Patient Details (the header) are the source. When the text to write states another age or gender,
  write it as said - the app puts the Patient Details age / gender into it - and NEVER change Patient Details or any
  other section because of it. Change Patient Details (and the other places) only when the command explicitly asks
  to change the patient's age or gender. (For commands this replaces the rule above about updating every block that
  states the age or gender.)
- Moving text to another section: remove it from where it is (replace_text with an empty new_value, or clear) and add
  it at the new place, in the same answer.
- The app cannot see the selected text or the cursor: "the selected text", "this word" must be clear from the command
  itself; otherwise ask.
- all_words: the exact word or words of the command (as typed or spoken, in its own language and letters) that
  mean all / every / everything, e.g. "all", "ella", "sab". Empty when the command has no such word. Nothing else.
- heard: the person's words as before. Whatever the language, write English words (also when said inside a
  Malayalam / Kannada / Hindi / Urdu sentence), medicine names, abbreviations and numbers in English letters and digits.
- All the rules above still apply in every language: change only what was asked, never invent values, ask when
  anything is unclear (empty edits list, one short question in simple English, "Nothing was changed."), and for
  medicine removals return an empty edits list with "Understood: ..." in the summary.`;
}
