import { getBlocks } from './outline.js';
import { getSections, sectionOf, findSectionsInCommand, nameWords } from './sections.js';
import { cellAt, dataCellRole, rowName, rowNames } from './tables.js';
import {
  FORMS, FORM_AT_START, formKeyOf, CATEGORIES, categoryRegex, categoryOfTerm, isMedicineEntry, brandOf, findGenericBracket,
  sectionEntries,
} from './medicineText.js';

// Checks the AI's edits BEFORE they are applied.
//
// Named section: when the command NAMES a section ("inside COURSE IN HOSPITAL add ..."),
// every edit must land in that section.
//   - text the AI ADDS somewhere else (append / insert_after) is moved: it becomes a new line
//     at the end of the named section
//   - anything else the AI changes in another section -> the whole command is refused (nothing applied)
//   - table cells (header fields such as Age / Sex) are always allowed (patient facts kept consistent)
//   - section name unclear while text is being added -> refused with a question
//   - no section named -> the edits are returned unchanged
//
// Returns { edits, moved } (edits possibly adjusted; moved = [{ section }] for each moved text)
//      or { reject: 'message for the Smart Edit panel' }

const ADDING = new Set(['append', 'insert_after']);
const LOOK_ONLY = new Set(['format', 'change_case', 'to_list', 'unlist']);

function inTableCell(doc, b) {
  const $p = doc.resolve(b.pos);
  for (let d = $p.depth; d > 0; d--) if (/^table(Cell|Header)$/.test($p.node(d).type.name)) return true;
  return false;
}

const nice = (t) => t.replace(/\s*:\s*$/, '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// The words the user wants added, taken from the command itself:
//   "Inside COURSE IN THE HOSPITAL, add that the patient was diagnosed with malaria." -> "The patient was diagnosed with malaria."
//   "add patient is stable to the course in hospital"                               -> "Patient is stable."
// Returns '' when the command has no clear "add / write / put ..." part.
function contentFromCommand(command, sectionTitle) {
  const m = String(command).match(/\b(?:add|write|put|include|mention|note|insert)\b\s*(?:that\s+|this\s*:?\s*|the following\s*:?\s*)?(.+)$/i);
  if (!m) return '';
  // stop at a second command in the same sentence: "... and change age to 31"
  let text = m[1].split(/\s+(?:and|then|also)\s+(?:change|update|set|make|correct|delete|remove|replace|add)\b/i)[0].trim();
  // drop a trailing "to / in / into the <section name>"
  const words = sectionTitle.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const tail = new RegExp(`\\s*\\b(?:to|in|into|inside|under)\\b(?:\\s+the)?\\s+(?:${words.map((w) => `${w}|`).join('')}the|in|of|\\s)+[.!]?$`, 'i');
  text = text.replace(tail, '').trim().replace(/[,;:\s]+$/, '');
  if (text.split(/\s+/).length < 2) return '';
  text = text[0].toUpperCase() + text.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function checkNamedSection(doc, command, edits) {
  if (!command || !edits.length) return { edits, moved: [] };
  const sections = getSections(doc);
  const found = findSectionsInCommand(sections, command);
  const adding = edits.some((e) => ADDING.has(e.operation));

  if (!found.best) {
    // Only part of a section name was said ("in the examination" when there are PHYSICAL and SYSTEMIC
    // EXAMINATION): ask, but only when that word follows "in / inside / into / to / under (the)", so a
    // content word ("... has history of fever") never triggers a question
    const placed = String(command).toLowerCase().match(/\b(?:in|inside|into|to|under)\s+(?:the\s+)?([a-z]+)/g) || [];
    const placeWords = placed.map((s) => s.split(/\s+/).pop().replace(/s$/, ''));
    const partial = found.candidates.filter((s) =>
      s.title.toLowerCase().split(/[^a-z]+/).some((w) => w && placeWords.includes(w.replace(/s$/, '')))
    );
    if ((found.ambiguous || partial.length > 1) && adding) {
      if (!found.ambiguous) found.candidates = partial;
      const names = found.candidates.map((s) => nice(s.title)).join(' or ');
      return { reject: `Which section did you mean: ${names}? Nothing was changed.` };
    }
    return { edits, moved: [] }; // no section named: nothing to check here
  }

  const target = found.best;
  const blocks = getBlocks(doc);
  // Moving text "from <section> to <section>": the command names BOTH sections, so the removal in the source section
  // is allowed (the text added there is still moved to the destination, as before). Only when "from" comes right
  // before the other section's name, so a section merely mentioned is never opened up.
  const source = found.matches.find((s) => s !== target &&
    new RegExp(`\\bfrom\\s+(?:the\\s+)?${nameWords(s.title).map((w) => `${w}\\w*`).join('\\W+(?:\\w+\\W+)?')}`, 'i').test(command));
  // last line of text in the named section (not inside a table); the heading when the section is empty
  const lastLine = [...target.body].reverse().find((i) => !inTableCell(doc, blocks[i])) ?? target.headingIndex;

  const out = [];
  const moved = [];
  const skipped = []; // age / gender "consistency" edits outside the named section: not applied (Patient Details rule)
  // the new text written INTO the named section (to recognise a header change that only copies an age / sex from it)
  const intoTarget = edits.filter((e) => { const k = parseInt(String(e.block_id).replace(/\D/g, ''), 10); return blocks[k] && sectionOf(sections, k) === target; })
    .map((e) => String(e.new_value || '')).join('\n');
  for (const e of edits) {
    const i = parseInt(String(e.block_id).replace(/\D/g, ''), 10);
    const b = blocks[i];
    if (!b) { out.push(e); continue; } // unknown block: applyVoiceEdit reports it
    const inTarget = sectionOf(sections, i) === target;
    if (inTarget) { out.push(e); continue; }
    // Patient Details (Age / Sex in the header) change only when asked, never because the text dictated for the
    // named section mentions another age or sex ("… add: a 22-year-old male presented …")
    if (inTableCell(doc, b)) {
      if (copiesFactFromText(doc, b, e, intoTarget)) { skipped.push(placeLabel(doc, b, sections, i)); continue; }
      out.push(e);
      continue;
    }
    // another section changed ONLY in its age / gender words: the AI keeping the document "consistent" - not applied
    if (onlyPatientFacts(b.node.textContent, e)) { skipped.push(placeLabel(doc, b, sections, i)); continue; }
    if (source && sectionOf(sections, i) === source && !ADDING.has(e.operation)) { out.push(e); continue; }
    if (ADDING.has(e.operation)) {
      // the AI's text when it is a real sentence ("She is stable."); when it is a fragment shaped for the
      // wrong section (", MALARIA"), the user's own words from the command
      const ai = String(e.new_value || '').trim();
      const sentence = !/^[,;:]/.test(ai) && ai.split(/\s+/).length >= 3;
      const words = (sentence ? ai : contentFromCommand(command, target.title)) || ai.replace(/^[\s,;:]+/, '');
      out.push({ ...e, block_id: `B${lastLine}`, operation: 'insert_after', new_value: words, field_label: nice(target.title) });
      moved.push({ section: nice(target.title) });
      continue;
    }
    const other = sectionOf(sections, i);
    return {
      reject: `You asked about ${nice(target.title)}, but the change was for ${other?.title ? nice(other.title) : 'another part'}. Nothing was changed. Please say it again.`,
    };
  }
  return { edits: out, moved, skipped };
}

// ---------- age / gender: Patient Details are the source ----------
const AGE_WORDS = /\b\d{1,3}(\s*-?\s*(?:years?|yrs?|yr|y)\b(?:\s*-?\s*old)?)/gi;
const GENDER_WORD = /\b(?:male|female|man|woman|lady|gentleman|boy|girl|he|she|him|his|her|hers|himself|herself|mr|ms|mrs|miss|m|f)\b/gi;
const factless = (t) => String(t).toLowerCase().replace(AGE_WORDS, '#$1').replace(GENDER_WORD, '@').replace(/\s+/g, ' ').trim();

// Would this edit change ONLY ages and gender words of the block ("49-year-old" -> "22-year-old")?
function onlyPatientFacts(oldText, e) {
  let next;
  if (e.operation === 'set') next = String(e.new_value ?? '');
  else if (e.operation === 'replace_text' && e.find_text) {
    const at = oldText.toLowerCase().indexOf(String(e.find_text).toLowerCase());
    if (at === -1) return false;
    next = oldText.slice(0, at) + String(e.new_value ?? '') + oldText.slice(at + String(e.find_text).length);
  } else return false;
  return next !== oldText && factless(next) === factless(oldText);
}

// A header Age / Sex value whose new value only repeats the age / sex of the text written into the named section
function copiesFactFromText(doc, b, e, intoTarget) {
  const info = cellAt(doc, b.pos);
  if (!info || info.col === 0 || !intoTarget) return false;
  const label = info.row.child(info.col - 1).textContent.trim().toLowerCase().replace(/[\s:.]+$/, '');
  const value = String(e.new_value ?? e.find_text ?? '');
  if (/^(?:age|age\/sex|age\/gender)$/.test(label) || /^age\b/.test(label)) {
    const n = value.match(/\d{1,3}/)?.[0];
    return Boolean(n) && new RegExp(`\\b${n}\\s*-?\\s*(?:years?|yrs?|yr|y)\\b`, 'i').test(intoTarget);
  }
  if (/^(?:sex|gender|sex\/age|gender\/age)$/.test(label)) {
    const g = value.trim().toLowerCase();
    const word = g.startsWith('f') ? /\b(?:female|woman|lady|girl|she|her)\b/i : g.startsWith('m') ? /\b(?:male|man|gentleman|boy|he|his|him)\b/i : null;
    return Boolean(word) && word.test(intoTarget);
  }
  return false;
}

const placeLabel = (doc, b, sections, i) => {
  const info = cellAt(doc, b.pos);
  if (info && info.col > 0) return info.row.child(info.col - 1).textContent.trim().replace(/[\s:]+$/, '');
  return nice(sectionOf(sections, i)?.title || 'another section');
};

// ---------- table rows: the right row, the number that was said ----------
// For a typed or spoken command that changes a DATA TABLE (Lab Investigations: "Investigation | Result"):
//   - the row's name must be in the command ("serum creatinine", "creatinine", "SGPT", "T L C" ...),
//     and no other row may match the command better (otherwise: "which one?")
//   - every number written into the table must be in the command ("2.9", "586000", "5 lakh 86 thousand")
//     or already in that row (e.g. "control - 14 seconds")
// Edits that fail are not applied; the reason is shown. Not used for uploaded files (the file is the source).
// Returns { edits, blocked: ['FIELD: reason', ...] }

// Other names for common investigations (all lower case)
const ALIASES = {
  hb: ['haemoglobin', 'hemoglobin', 'hgb'],
  tlc: ['total leucocyte count', 'total leukocyte count', 'wbc', 'white cell count', 'white blood cell count', 'total count'],
  'platelet count': ['platelet', 'platelets', 'plt'],
  'serum creatinine': ['creatinine', 's creatinine'],
  'total bilirubin': ['bilirubin'],
  sgpt: ['alt'],
  sgot: ['ast'],
  alp: ['alkaline phosphatase'],
  crp: ['c reactive protein'],
  pt: ['prothrombin time'],
  'blood urea': ['urea'],
  rbs: ['random blood sugar'],
  fbs: ['fasting blood sugar'],
};
const WEAK = new Set(['serum', 'total', 'count', 'level', 'levels', 'blood', 'test', 'value', 'the', 'and', 'of']);

// lower case, punctuation -> spaces, letters spelled one by one joined ("t l c" -> "tlc")
function plain(t) {
  return ` ${String(t || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\.(?!\d)/g, ' ')
    .replace(/\b(?:[a-z] )+[a-z]\b/g, (m) => m.replace(/ /g, '')).replace(/\s+/g, ' ').trim()} `;
}
const has = (cmd, phrase) => phrase && cmd.includes(` ${phrase} `);

// 2 = the full name (or one of its other names) is in the command, 1 = only a word of it, 0 = not at all
function mentionScore(cmd, name) {
  const n = plain(name).trim();
  if (!n) return 0;
  if (has(cmd, n) || (ALIASES[n] || []).some((a) => has(cmd, a))) return 2;
  return n.split(' ').some((w) => w.length >= 3 && !WEAK.has(w) && has(cmd, w)) ? 1 : 0;
}

// ---------- numbers said in a command ----------
const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const MULT = { hundred: 100, thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, million: 1e6, crore: 1e7, crores: 1e7 };

// "eighty six" -> "86", "two point nine" -> "2.9", "86,000" -> "86000"
function wordsToDigits(t) {
  let s = ` ${t} `.replace(/(\d),(?=\d)/g, '$1');
  const tens = TENS.filter(Boolean).join('|');
  s = s.replace(new RegExp(`\\b(${tens})[\\s-](${SMALL.slice(1, 10).join('|')})\\b`, 'g'),
    (_m, a, b) => String(TENS.indexOf(a) * 10 + SMALL.indexOf(b)));
  s = s.replace(new RegExp(`\\b(${tens})\\b`, 'g'), (m) => String(TENS.indexOf(m) * 10));
  s = s.replace(new RegExp(`\\b(${SMALL.join('|')})\\b`, 'g'), (m) => String(SMALL.indexOf(m)));
  return s.replace(/\b(\d+) point (\d+)\b/g, '$1.$2');
}

// A number written right next to a unit or ending ("500mg", "1.5g", "5days", "20th") is split from it, so the
// number is read. Only these known units / endings ("b12", "d3" stay one word, as before).
const UNIT_SUFFIX = 'mg|mgs|mcg|µg|ug|g|gm|gms|kg|ml|mls|iu|units?|days?|weeks?|wks?|months?|years?|yrs?|hrs?|hours?|mins?|minutes?|tabs?|caps?|puffs?|drops?|scoops?|sachets?|st|nd|rd|th|lakhs?|lacs?';
const splitUnits = (t) => String(t).replace(new RegExp(`(\\d)(${UNIT_SUFFIX})(?![a-z])`, 'gi'), '$1 $2');
// (Spoken "six fifty" stays 6 and 50, never 650: it could also mean 6.50. Refused, never guessed - as before.)

// Every number the command states, also spoken ones: "5 lakh 86 thousand" -> 586000 (and 5, 86); "500mg" -> 500
export function numbersSaid(command) {
  return numbersOf(splitUnits(String(command || '').toLowerCase()));
}

function numbersOf(text) {
  // (a full stop at the end of a sentence is not part of the number: "... to 2.2.")
  const words = wordsToDigits(text).split(/[^a-z0-9.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, '')).filter(Boolean);
  const out = new Set();
  let total = null;
  let lastMult = Infinity;
  for (let i = 0; i < words.length; i++) {
    if (!/^\d+(?:\.\d+)?$/.test(words[i])) {
      if (words[i] !== 'and') { if (total != null) out.add(total); total = null; lastMult = Infinity; }
      continue;
    }
    const v = parseFloat(words[i]);
    out.add(v);
    const m = MULT[words[i + 1]];
    if (m) {
      i++;
      if (total != null && m < lastMult) total += v * m; // "5 lakh 86 thousand"
      else { if (total != null) out.add(total); total = v * m; }
      lastMult = m;
      out.add(total);
    } else if (total != null && v < lastMult) {
      out.add(total + v); // "5 lakh 86000"
      out.add(total);
      total = null; lastMult = Infinity;
    }
  }
  if (total != null) out.add(total);
  return [...out];
}

const numbersIn = (t) => (String(t || '').replace(/(\d),(?=\d)/g, '$1').match(/\d+(?:\.\d+)?/g) || []).map(parseFloat);
const nice2 = (t) => t.trim().toUpperCase();

// A NEW medicine line added by a typed / spoken command (Advice, Medications, Treatment ...): every number in it
// (strength, dose, dosing pattern, duration) must have been said - the same rule as for lab values above, so a
// strength or duration the AI made up ("Tab. DOLO 650 mg ... 5 days" when only "Dolo at night" was said) is never
// added. (Words such as a route or frequency cannot be checked this way; the AI is told never to add them.)
const MEDICINE_SECTION = /\b(advice|medication|medications|medicine|medicines|treatment|drugs?|prescription|rx)\b/i;
const MEDICINE_LINE = /^\s*(?:tab|tabs|tablet|tablets|cap|caps|capsule|capsules|syp|syr|syrup|syrups|susp|suspension|inj|injection|drop|drops|oint|ointment|cream|gel|lotion|sachet|powder|inhaler|neb|nebulisation|nebulization|spray|rotacap)(?:\.\s*|\s+)\S/i; // "Tab. X", "Tab X", "TAB.X"

// Dosing patterns: "1-0-1", "(0-0-1)", "1-0-0-1" in a medicine line (digits 0-3 joined by dashes)
const DOSING_IN_LINE = /(?<![\d.])[0-3](?:\s*[-–]\s*[0-3]){2,3}(?!\.?\d)/g;
// The patterns a command says, as digit strings ("001"): "001", "0-0-1", "0 0 1", "zero zero one", "1-0-0-1".
// Only digits 0-3 make a pattern, so a strength such as "500" is never read as one.
export function patternsSaid(command) {
  const s = wordsToDigits(String(command || '').toLowerCase());
  const out = new Set();
  // (a full stop at the end of the sentence is not a decimal point: "... daily night 001.")
  for (const m of s.matchAll(/(?<![\d.])[0-3](?:[\s,\-–/]*[0-3]){2,3}(?!\.?\d)/g)) out.add(m[0].replace(/\D/g, ''));
  return out;
}

export function checkTableEdits(doc, command, edits) {
  if (!command || !edits.length) return { edits, blocked: [] };
  const blocks = getBlocks(doc);
  const sections = getSections(doc);
  const cmd = plain(command);
  const said = numbersSaid(command);
  const out = [];
  const blocked = [];
  for (const e of edits) {
    // bold / italic / capital letters / lists change no row and no number: nothing to check here
    if (LOOK_ONLY.has(e.operation)) { out.push(e); continue; }
    const at = parseInt(String(e.block_id).replace(/\D/g, ''), 10);
    const b = blocks[at];
    const info = b && cellAt(doc, b.pos);
    // the text a command ADDS: append / insert_after, or what a replace_text adds after the text it keeps
    // ("sleep" -> "sleep, Tab. DOLO …"); a separator in front (", Tab. DOLO …") is not part of the new entry
    const keeps = e.operation === 'replace_text' && e.find_text && String(e.new_value || '').toLowerCase().startsWith(String(e.find_text).toLowerCase());
    const addedText = ADDING.has(e.operation) ? String(e.new_value || '') : keeps ? String(e.new_value).slice(String(e.find_text).length) : '';
    if (b && !info && addedText && MEDICINE_SECTION.test(sectionOf(sections, at)?.title || '')) {
      const newMeds = addedText.split(/\r?\n/).map((l) => l.replace(/^[\s,;:—–-]+/u, '').trim()).filter((l) => MEDICINE_LINE.test(l));
      // a dosing pattern ("(0-0-1)") is checked as ONE pattern against the patterns said ("001", "0-0-1", "0 0 1",
      // "zero zero one"); every other number (strength, dose, duration) must have been said, as before
      const patterns = patternsSaid(command);
      const badPatterns = [];
      const rest = newMeds.map((l) => l.replace(DOSING_IN_LINE, (m) => {
        if (!patterns.has(m.replace(/\D/g, ''))) badPatterns.push(m.replace(/\s+/g, ''));
        return ' ';
      }));
      const unsaid = [...new Set([...badPatterns, ...rest.flatMap(numbersIn).filter((n) => !said.some((s) => Math.abs(s - n) < 1e-9))])];
      if (unsaid.length) {
        blocked.push(`${nice2(e.field_label || 'Advice')}: the new medicine line contains ${unsaid.join(', ')}, which was not in your command, so it was not added. Please say the medicine again with only the details you want`);
        continue;
      }
    }
    const role = dataCellRole(info);
    if (!role || role === 'title') { out.push(e); continue; } // not a data-table row: other checks apply

    const adding = e.operation === 'insert_after';
    const parts = String(e.new_value || '').split('|');
    const name = adding ? parts[0].trim() : rowName(info);
    const field = nice2(name || e.field_label || e.block_id);

    // 1. the right row
    const score = mentionScore(cmd, name);
    if (!score) {
      blocked.push(`${field}: your command does not name ${field}, so it was not changed. Please say which investigation to change`);
      continue;
    }
    if (!adding && score === 1) {
      // only part of the name was said ("bilirubin" with TOTAL and DIRECT BILIRUBIN in the table): which row?
      const rivals = rowNames(info.table).filter((n) => n !== name && mentionScore(cmd, n) >= score);
      if (rivals.length) {
        blocked.push(`${field}: it is not clear which row you meant (${[name, ...rivals].map(nice2).join(' or ')}). Nothing was changed there`);
        continue;
      }
    }

    // 2. only numbers that were said (or are already in that row)
    if (e.operation !== 'clear') {
      const known = adding ? [] : numbersIn(info.row.textContent);
      const written = numbersIn(adding ? parts.slice(1).join(' ') : e.new_value);
      const unsaid = written.filter((n) => !said.some((s) => Math.abs(s - n) < 1e-9) && !known.some((k) => Math.abs(k - n) < 1e-9));
      if (unsaid.length) {
        blocked.push(`${field}: the value ${unsaid.join(', ')} was not in your command, so it was not changed. Please say the number again`);
        continue;
      }
    }
    out.push(e);
  }
  return { edits: out, blocked };
}

// =====================================================================================================================
// MEDICINE SAFETY for typed and spoken commands (never file uploads): checkMedicineEdits(doc, { said, extra, edits })
//
// Every edit that adds or changes text in a medicine section (Advice, Medications, Treatment ...) is checked against
// the PERSON'S OWN WORDS (`said`: the typed text and / or the voice transcript). Nothing is guessed:
//   a NEW medicine entry (a line starting with Tab. / Cap. / ..., or with a strength, dosing pattern or generic bracket):
//     - name: the name from the AI is used for now (not matched; proper name rules come later). Placeholders
//       ("NEW MEDICINE") are refused.
//     - optional details NOT said are REMOVED from the line (not refused): form (Tab. / Cap. / Syp. ...; "tablet" =
//       Tab.), generic / description bracket, route, frequency, food timing, as needed (the controlled lists of
//       medicineText.js, in any of the equivalent forms: "BD" = "twice a day" = "Twice Daily"; "orally" = "Oral"),
//       and phrases such as "as directed", "as prescribed"
//     - every number said; every dosing pattern said; every number WITH ITS UNIT said (strict: "650" said -> "650 mg"
//       is refused; mg = milligram, ml = millilitre ...); durations with their unit ("5 days" needs 5 days said)
//     - an ADD of a medicine already in that section (name or generic) always adds a NEW line; the existing entry is
//       never changed. (Any other operation still asks, unless the words explicitly ask for another entry.)
//       duplicate_ok is set from this check, never from the AI's own flag.
//   a CHANGED medicine entry: everything new follows the rules above; a part that disappears or is replaced (name,
//     form, number, route, frequency, food timing, as needed, generic) needs the command to name that kind of part
//   a REMOVED medicine entry: its name must be in the command
//   an ordinary ADVICE line (not a medicine entry): no invented route / frequency / food / as-needed words or phrases,
//     and a medicine named inside it ("... Tab. DOLO ...") must have been said. Numbers are not checked here (dates).
// `extra` (only for commands the app cannot read word by word, e.g. Malayalam): the AI's plain-English restatement,
// used ONLY for route / frequency / food / as-needed words and phrases - never for names, forms, numbers or units.
// Those commands always end in a window that the person checks before Apply.
//
// Returns { medicine: boolean (a medicine entry is added, changed or removed), newEntries: [indexes of `edits` that add
// a new line of a medicine that is already there], edits: [the edits, with the details nobody said removed from new
// medicine lines - App.jsx applies THESE], reject?: 'message' }.
// One failing check refuses the WHOLE command (all or nothing).

const MED_SECTION = /\b(advice|medication|medications|medicine|medicines|treatment|drugs?|prescription|rx)\b/i; // = MEDICINE_SECTION
const WORDS_ONLY = new Set(['append', 'insert_after', 'set', 'replace_text', 'clear']);
const ADD_OPS = new Set(['insert_after', 'append']); // operations that only ADD text (existing lines stay as they are)

// units, with the words people say for them
const UNIT_CANON = [
  ['mg', 'mg|mgs|milligrams?'], ['mcg', 'mcg|µg|ug|micrograms?'], ['g', 'g|gm|gms|grams?'], ['kg', 'kg|kilograms?'],
  ['ml', 'ml|mls|millilit(?:re|er)s?'], ['iu', 'iu|i\\.u\\.|international units?'], ['unit', 'units?'],
  ['day', 'days?'], ['week', 'weeks?|wks?'], ['month', 'months?'], ['year', 'years?|yrs?'], ['hour', 'hours?|hrs?'],
  ['min', 'mins?|minutes?'], ['tab', 'tabs?|tablets?'], ['cap', 'caps?|capsules?'], ['puff', 'puffs?'], ['drop', 'drops?'],
  ['scoop', 'scoops?'], ['sachet', 'sachets?'],
];
const UNIT_RE = () => new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_CANON.map(([, r]) => r).join('|')})(?![a-z])`, 'gi');
const unitKey = (u) => UNIT_CANON.find(([, r]) => new RegExp(`^(?:${r})$`, 'i').test(u))?.[0] || u.toLowerCase();

// the person's words, ready for matching: lower case, numbers split from units, spoken numbers as digits; also with
// "a week" read as "1 week" (the reading without it stays, so "twice a day" is still a frequency)
function saidForms(text) {
  const digits = wordsToDigits(splitUnits(String(text || '').toLowerCase()));
  return [...new Set([digits, digits.replace(/\b(?:a|an)\s+(day|week|month|year|hour)\b/g, '1 $1')])];
}
const pairsIn = (text) => new Set([...splitUnits(String(text || '')).matchAll(UNIT_RE())].map((m) => `${parseFloat(m[1])} ${unitKey(m[2])}`));
// in the words said, the whole number before a unit counts ("6 hundred 50 mg" -> 650 mg)
const NUM_PART = '(?:\\d+(?:\\.\\d+)?|hundred|thousand|lakhs?|lacs?|crores?|million|and)';
const SAID_UNIT_RE = () => new RegExp(`(${NUM_PART}(?:\\s+${NUM_PART})*)\\s*(${UNIT_CANON.map(([, r]) => r).join('|')})(?![a-z])`, 'gi');
const saidPairsIn = (text) => new Set([...String(text || '').matchAll(SAID_UNIT_RE())]
  .flatMap((m) => numbersOf(m[1]).map((n) => `${n} ${unitKey(m[2])}`)));

// route / frequency / food / as needed: every term, as a canonical value ("frequency:x2"), so equivalent forms match
const NUM_WORD = { four: 4, six: 6, eight: 8, twelve: 12 };
function canonTerm(key, term) {
  const t = term.toLowerCase().replace(/[().]/g, '').replace(/\s+/g, ' ').trim();
  if (key === 'route') {
    if (/^(?:per oral|per os|orally|oral|po)$/.test(t)) return 'oral';
    if (/^(?:intravenous(?:ly)?|iv)$/.test(t)) return 'iv';
    if (/^(?:intramuscular(?:ly)?|im)$/.test(t)) return 'im';
    if (/^(?:subcutaneous(?:ly)?|sc)$/.test(t)) return 'sc';
    if (/^(?:topical(?:ly)?|local application|locally)$/.test(t)) return 'topical';
    if (/inhal|nebuli/.test(t)) return 'inhaled';
    if (/^(?:sublingual(?:ly)?|s\/l)$/.test(t)) return 'sublingual';
    if (/rect/.test(t)) return 'rectal';
    if (/nasal/.test(t)) return 'nasal';
    return t;
  }
  if (key === 'frequency') {
    const per = '(?: daily| a day| per day| in a day)';
    if (new RegExp(`^(?:(?:once|1 time)${per}|daily|every day|od)$`).test(t)) return 'x1';
    if (new RegExp(`^(?:(?:twice|2 times)${per}|bd|bid)$`).test(t)) return 'x2';
    if (new RegExp(`^(?:(?:thrice|three times|3 times)${per}|thrice|tds|tid)$`).test(t)) return 'x3';
    if (new RegExp(`^(?:(?:four times|4 times)${per}|qid|qds)$`).test(t)) return 'x4';
    if (/^(?:hs|qhs|at bedtime)$/.test(t)) return 'bedtime';
    if (/^(?:weekly|once weekly|once a week)$/.test(t)) return 'week1';
    if (/^(?:twice weekly|twice a week)$/.test(t)) return 'week2';
    if (/^(?:on alternate days?|alternate days?|every other day)$/.test(t)) return 'alternate';
    const h = t.match(/^(?:every (\d+|four|six|eight|twelve) (?:hours|hrs|hourly)|(\d+|four|six|eight|twelve) hourly|q(\d+)h)$/);
    if (h) { const n = h[1] || h[2] || h[3]; return `every${NUM_WORD[n] || n}h`; }
    return t;
  }
  if (key === 'as_needed') return 'as needed';
  if (key === 'food') {
    if (/empty stomach/.test(t)) return 'empty stomach';
    const f = t.match(/(after|before|with) (food|meals?|breakfast|lunch|dinner)$/);
    return f ? `${f[1]} ${/^meals?$/.test(f[2]) ? 'food' : f[2]}` : t;
  }
  return t;
}
const CATEGORY_NAME = { route: 'route', frequency: 'frequency', as_needed: '"as needed" (SOS)', food: 'food timing' };
function termsIn(text) {
  const out = new Map(); // "frequency:x2" -> the words as written
  for (const key of Object.keys(CATEGORIES)) {
    for (const m of String(text || '').matchAll(categoryRegex(key))) out.set(`${key}:${canonTerm(key, m[0])}`, m[0].trim());
  }
  return out;
}
// words of a kind of part, for "the command names this kind of part"
const PART_WORDS = {
  route: /\b(?:route|routes)\b/i, frequency: /\b(?:frequenc(?:y|ies)|how often|times?|timings?|schedule)\b/i,
  as_needed: /\b(?:as needed|sos|prn|when required|if needed)\b/i, food: /\b(?:food|meals?|stomach|timings?)\b/i,
};
// "as directed / as prescribed / as advised / as per doctor": never added unless said
const PHRASE_RE = () => /\bas\s+(?:directed|prescribed|advised|instructed)\b|\bas\s+per\s+(?:the\s+)?(?:doctor|physician|consultant|advice)\b/gi;
const phrasesIn = (text) => new Set([...String(text || '').matchAll(PHRASE_RE())].map((m) => m[0].toLowerCase().replace(/\s+/g, ' ')));

// names: words as plain() writes them; "a new entry / a new line / another entry / a second entry / a separate line"
// = explicitly another entry ("again", "another Dolo" alone are not)
const PLACEHOLDER = new Set(['new', 'medicine', 'medicines', 'medication', 'medications', 'drug', 'drugs', 'test', 'name', 'placeholder',
  'unknown', 'sample', 'dummy', 'brand', 'entry', 'item', 'xyz', 'abc', 'another', 'some', 'other']);
const FORM_WORD = new RegExp(`^(?:${FORMS.map((f) => `${f.line}|${f.said}`).join('|')})$`, 'i');
const ANOTHER_ENTRY = /\b(?:new|another|second|2nd|separate|additional|one more)\s+(?:separate\s+|new\s+)?(?:entry|entries|line)\b/i;
const nameWordsOf = (t) => plain(t).trim().split(' ').filter((w) => w && !/^\d/.test(w) && !FORM_WORD.test(w) && !categoryOfTerm(w));
// medicine named inside an ordinary sentence: "... Tab. DOLO ..." (form word, then the name)
const MID_MEDICINE = /\b(tab|tabs|tablet|tablets|cap|caps|capsule|capsules|syp|syr|syrup|inj|injection|susp|suspension)\.?\s+([A-Za-z][A-Za-z0-9-]*)/gi;
const DETAIL_WORDS = /\b(?:doses?|dosages?|strengths?|durations?|days?|weeks?|months?|mg|mcg|ml|g|grams?|units?|quantity)\b/i;
const FORM_PART = /\b(?:form|formulation)\b/i;
const GENERIC_PART = /\b(?:generics?|salt|composition|brackets?)\b/i;

// The text of a block, one entry per line (line breaks -> "\n")
const blockLines = (node) => node.textBetween(0, node.content.size, '\n', '\n').split('\n').map((l) => l.trim()).filter(Boolean);
const linesOfValue = (t) => String(t).split('\n').map((l) => l.trim()).filter(Boolean);

export function checkMedicineEdits(doc, { said = '', extra = '', edits = [] } = {}) {
  const blocks = getBlocks(doc);
  const sections = getSections(doc);
  const forms = saidForms(said);
  const saidPlain = plain(said).trim();
  const saidList = saidPlain ? saidPlain.split(' ') : [];
  const saidWords = new Set(saidList);
  const saidJoins = new Set();
  for (let i = 0; i < saidList.length; i++) for (let k = 1; k <= 4 && i + k <= saidList.length; k++) saidJoins.add(saidList.slice(i, i + k).join(''));
  const saidNumbers = [...new Set([...numbersSaid(said), ...forms.flatMap(numbersOf)])]; // + "for a week" = 1
  const saidPatterns = patternsSaid(said);
  const saidPairs = new Set(forms.flatMap((f) => [...saidPairsIn(f)]));
  const saidTerms = new Set(forms.flatMap((f) => [...termsIn(f).keys()]));
  const saidPhrases = new Set(phrasesIn(said));
  if (extra) {
    for (const k of termsIn(wordsToDigits(String(extra).toLowerCase())).keys()) saidTerms.add(k);
    for (const p of phrasesIn(extra)) saidPhrases.add(p);
  }
  const anyTermOf = (key) => [...saidTerms].some((k) => k.startsWith(`${key}:`)) || PART_WORDS[key].test(said);
  const nameSaid = (words) => words.length > 0 && (saidJoins.has(words.join('')) || words.every((w) => saidWords.has(w)));
  const formSaid = (key) => {
    const f = FORMS.find((x) => x.key === key);
    return !f || new RegExp(`\\b(?:${f.line}|${f.said})\\b`, 'i').test(said);
  };
  const NAME = (t) => t.toUpperCase();
  const refuse = (section, why) => ({ medicine: true, reject: `${section}: ${why}. Nothing was changed. Please say it again with only the details you want` });
  let medicine = false;
  const newEntries = new Set(); // edits adding a new line of a medicine that is already in that section
  const out = [...edits]; // the edits, with the details nobody said removed from NEW medicine lines
  const wasMedicine = new Set(); // cleaned lines that were medicine lines before cleaning

  // A NEW medicine line: the optional details the AI added that were NOT said are REMOVED (not the whole command
  // refused): a form at the start (Tab. / Cap. ...), a generic / description bracket, route, frequency, food timing,
  // as needed (SOS) and phrases such as "as directed". Numbers, units and dosing patterns are never removed: an
  // invented one still refuses the command (checked below). The line is only ever shortened, never added to.
  const FILLER_LEFT = /^(?:\s|\b(?:route|routes|by|the|for|with|at|in|and|of|on|a|an|to)\b|[.;:])*$/i;
  const tidy = (t) => t.replace(/\(\s*\)/g, ' ')
    .replace(/\s*([—–,])(?:\s*[—–,])+/g, ' $1') // a run of separators -> the first
    .replace(/\s+/g, ' ').replace(/\s+,/g, ',')
    .replace(/^[\s—–,]+|[\s—–,]+$/g, '')
    .replace(/\s*([—–])\s*/g, ' $1 ').replace(/,(?=\S)/g, ', ')
    .trim();
  const trimUnsaid = (line) => {
    let l = line;
    let changed = false;
    const fm = l.match(FORM_AT_START);
    if (fm && !formSaid(formKeyOf(fm[1]))) { l = l.slice(fm[0].length); changed = true; }
    const br = findGenericBracket(l, { allowWithoutForm: true });
    if (br && !nameSaid(nameWordsOf(br.text))) { l = l.slice(0, br.from) + l.slice(br.to); changed = true; }
    // only AFTER the medicine's name (a name such as "Inj. IV PARACETAMOL" is never cut)
    const brand = brandOf(l);
    const cut = brand ? l.indexOf(brand) + brand.length : 0;
    const parts = l.slice(cut).split(/([—–,])/).map((seg, i) => {
      if (i % 2) return seg; // a separator
      if ([...phrasesIn(seg)].some((p) => !saidPhrases.has(p))) { changed = true; return ''; } // "as directed by ..." -> the part
      let s = seg;
      for (const key of Object.keys(CATEGORIES)) {
        // removed only when the person said NOTHING of that kind; a DIFFERENT one than said ("Twice Daily" when "once
        // daily" was said) is a mistake, not an extra: it stays, and the check below refuses the command
        const saidKind = [...saidTerms].some((k) => k.startsWith(`${key}:`));
        s = s.replace(categoryRegex(key), (m) => (saidKind || saidTerms.has(`${key}:${canonTerm(key, m)}`) ? m : ((changed = true), '')));
      }
      return s !== seg && FILLER_LEFT.test(s.replace(/\(\s*\)/g, '')) ? '' : s;
    });
    return changed ? tidy(l.slice(0, cut) + parts.join('')) : line;
  };

  // the parts of one line
  const partsOf = (line) => {
    const bracket = findGenericBracket(line, { allowWithoutForm: true });
    const formMatch = line.match(FORM_AT_START);
    return {
      name: nameWordsOf(brandOf(line)),
      generic: bracket ? nameWordsOf(bracket.text) : [],
      form: formMatch ? formKeyOf(formMatch[1]) : null,
      formWord: formMatch ? formMatch[1].trim() : '',
      patterns: (line.match(DOSING_IN_LINE) || []).map((m) => m.replace(/\D/g, '')),
      numbers: numbersIn(line.replace(DOSING_IN_LINE, ' ')),
      pairs: pairsIn(line),
      terms: termsIn(line),
      phrases: phrasesIn(line),
    };
  };

  // the checks for what a line ADDS (everything of a new line; of a changed line only what is new in it)
  function checkAdded(line, now, before, isMed) {
    const quoted = `"${line}"`;
    for (const [k, words] of now.terms) {
      if (before?.terms.has(k)) continue;
      if (!saidTerms.has(k)) return `${quoted} contains the ${CATEGORY_NAME[k.split(':')[0]]} "${words}", which was not in your command`;
    }
    for (const p of now.phrases) if (!before?.phrases.has(p) && !saidPhrases.has(p)) return `${quoted} contains "${p}", which was not in your command`;
    if (!isMed) {
      // (the medicine's NAME is not matched for now: the name from the AI is used - proper name rules come later)
      for (const m of line.matchAll(MID_MEDICINE)) {
        if (!formSaid(formKeyOf(m[1]))) return `${quoted} names a medicine form (${m[1]}) that was not in your command`;
      }
      return '';
    }
    const nameChanged = !before || before.name.join('') !== now.name.join('');
    if (nameChanged) {
      if (!now.name.length || now.name.every((w) => PLACEHOLDER.has(w))) return `${quoted} has no real medicine name`;
      // a NEW medicine: the name from the AI is used (not matched for now; proper name rules come later).
      // Another name for an EXISTING medicine still needs the new name in the words said.
      if (before && !nameSaid(now.name)) return `the medicine name ${NAME(now.name.join(' '))} was not in your command (names must match exactly). Please say the medicine name clearly`;
    }
    if (now.generic.length && (!before || before.generic.join('') !== now.generic.join('')) && !nameSaid(now.generic)) {
      return `${quoted} adds "${NAME(now.generic.join(' '))}" in brackets, which was not in your command`;
    }
    if (now.form && (!before || before.form !== now.form) && !formSaid(now.form)) {
      return `${quoted} starts with a medicine form (${now.formWord}) that was not in your command`;
    }
    for (const p of now.patterns) {
      if (!before?.patterns.includes(p) && !saidPatterns.has(p)) return `${quoted} contains the dosing pattern ${p.split('').join('-')}, which was not in your command`;
    }
    for (const n of now.numbers) {
      if (!before?.numbers.includes(n) && !saidNumbers.some((s) => Math.abs(s - n) < 1e-9)) return `${quoted} contains ${n}, which was not in your command`;
    }
    for (const pr of now.pairs) {
      if (!before?.pairs.has(pr) && !saidPairs.has(pr)) return `${quoted} contains "${pr}", which was not in your command (a number needs the same unit as said)`;
    }
    return '';
  }

  // the checks for what disappears from a changed medicine line
  function checkRemoved(now, before) {
    const name = NAME(before.name.join(' ') || 'this medicine');
    // another medicine in its place: only when the command names the old one ("replace DOLO with CROCIN");
    // then the whole entry is replaced (what is new in it was checked above)
    if (before.name.join('') !== now.name.join('')) return nameSaid(before.name) ? '' : `it would replace ${name}, which your command did not name`;
    for (const [k] of before.terms) {
      if (now.terms.has(k)) continue;
      const key = k.split(':')[0];
      if (!saidTerms.has(k) && !anyTermOf(key)) return `it would change or remove the ${CATEGORY_NAME[key]} of ${name}, which your command did not ask for`;
    }
    const lostNumber = before.numbers.some((n) => !now.numbers.includes(n)) || [...before.pairs].some((p) => !now.pairs.has(p));
    if (lostNumber && !saidNumbers.length && !DETAIL_WORDS.test(said)) return `it would change the strength, dose or duration of ${name}, which your command did not ask for`;
    if (before.patterns.some((p) => !now.patterns.includes(p)) && !saidPatterns.size && !/\bpatterns?\b/i.test(said)) {
      return `it would change the dosing pattern of ${name}, which your command did not ask for`;
    }
    if (before.form && before.form !== now.form && !FORM_PART.test(said) && !(now.form && formSaid(now.form))) return `it would change the form of ${name}, which your command did not ask for`;
    if (before.generic.length && before.generic.join('') !== now.generic.join('') && !GENERIC_PART.test(said) && !nameSaid(before.generic)) {
      return `it would change the bracket of ${name}, which your command did not ask for`;
    }
    return '';
  }

  for (const [index, e] of edits.entries()) {
    if (!WORDS_ONLY.has(e.operation)) continue; // bold / capitals / lists change no words
    const at = parseInt(String(e.block_id).replace(/\D/g, ''), 10);
    const b = blocks[at];
    if (!b || cellAt(doc, b.pos)) continue; // table cells: checkTableEdits
    const section = sectionOf(sections, at);
    if (!section || !MED_SECTION.test(section.title)) continue;
    const title = nice2(section.title.replace(/\s*:\s*$/, ''));

    const isMed = (l) => isMedicineEntry(l, true) || new RegExp(DOSING_IN_LINE.source).test(l);
    // a NEW line (insert_after): details nobody said are removed from its medicine lines first
    if (e.operation === 'insert_after' && typeof e.new_value === 'string') {
      const cleaned = e.new_value.split('\n').map((l) => {
        if (!isMed(l.trim())) return l;
        const c = trimUnsaid(l.trim());
        wasMedicine.add(c); // still checked as a medicine line ("Tab. NEW MEDICINE" -> "NEW MEDICINE": a placeholder)
        return c;
      }).join('\n');
      if (cleaned !== e.new_value) out[index] = { ...e, new_value: cleaned };
    }

    // the lines of this block before and after the edit
    const old = blockLines(b.node);
    const value = String(out[index].new_value ?? '');
    let next;
    if (e.operation === 'insert_after') next = [...old, ...linesOfValue(value)];
    else if (e.operation === 'append') next = linesOfValue(old.join('\n') + value);
    else if (e.operation === 'set') next = linesOfValue(value);
    else if (e.operation === 'clear') next = [];
    else {
      const text = old.join('\n');
      const find = String(e.find_text || '');
      let i = find ? text.indexOf(find) : -1;
      if (i === -1 && find) i = text.toLowerCase().indexOf(find.toLowerCase());
      if (i === -1) continue; // not found: the edit itself fails later (nothing changes)
      next = linesOfValue(text.slice(0, i) + value + text.slice(i + find.length));
    }
    // lines that stay exactly the same are not checked
    const removed = [...old];
    const added = [];
    for (const l of next) {
      const k = removed.indexOf(l);
      if (k !== -1) removed.splice(k, 1);
      else added.push(l);
    }

    // a changed line (as many lines out as in): compared with the line it replaces
    if (removed.length && removed.length === added.length) {
      for (let k = 0; k < added.length; k++) {
        const was = removed[k];
        const now = added[k];
        const medNow = isMed(now);
        const medWas = isMed(was);
        if (medNow || medWas) medicine = true;
        const p0 = partsOf(was);
        const p1 = partsOf(now);
        const why = checkAdded(now, p1, medWas ? p0 : null, medNow) || (medWas ? checkRemoved(p1, p0) : '');
        if (why) return refuse(title, why);
      }
      continue;
    }
    for (const was of removed) {
      if (!isMed(was)) continue;
      medicine = true;
      const name = partsOf(was).name;
      if (!nameSaid(name)) return refuse(title, `it would remove ${NAME(name.join(' ') || was)}, which your command did not name`);
    }
    if (!added.length) continue;
    // existing medicine entries of this section (for the duplicate check)
    const existing = sectionEntries(doc, section).map((x) => x.text.trim()).filter((t) => isMedicineEntry(t, true)).map(partsOf);
    for (const line of added) {
      const med = isMed(line) || wasMedicine.has(line);
      const p = partsOf(line);
      const why = checkAdded(line, p, null, med);
      if (why) return refuse(title, why);
      if (!med) continue;
      medicine = true;
      // the same medicine already in this section (its name or its generic name): an ADD (insert_after / append) always
      // adds a NEW line and never changes the existing one (the existing lines stay exactly as they are - see above);
      // any other operation still asks, unless the words explicitly ask for another entry
      const keys = [p.name.join(''), p.generic.join('')].filter(Boolean);
      const same = existing.find((x) => [x.name.join(''), x.generic.join('')].filter(Boolean).some((k) => keys.includes(k)));
      if (same && !ADD_OPS.has(e.operation) && !ANOTHER_ENTRY.test(said)) {
        const n = NAME(same.name.join(' '));
        return {
          medicine: true,
          reject: `${n} is already in ${title}. Do you want to change the existing entry, or add another ${n} entry? Nothing was changed. `
            + `To add a second one, say "add ${n} … as a new entry"`,
        };
      }
      if (same) newEntries.add(index);
    }
  }
  return { medicine, newEntries: [...newEntries], edits: out };
}

// duplicate_ok follows the PERSON'S words, never the AI's flag: the AI's own duplicate_ok is removed from every edit,
// and set only on the edits checkMedicineEdits found to be an explicitly asked-for second entry ("as a new entry").
// Every other edit that adds a medicine already in its section is then asked about by the apply step (voiceEdit.js).
export function withDuplicateChoice(edits, newEntries = []) {
  return edits.map((e, i) => {
    const { duplicate_ok: _fromAi, ...rest } = e;
    return newEntries.includes(i) ? { ...rest, duplicate_ok: true } : rest;
  });
}

// The section title of a block ("ADVICE")
export function sectionTitleOf(doc, blockId) {
  const at = parseInt(String(blockId).replace(/\D/g, ''), 10);
  const s = sectionOf(getSections(doc), at);
  return s?.title ? nice2(s.title.replace(/\s*:\s*$/, '')) : '';
}
