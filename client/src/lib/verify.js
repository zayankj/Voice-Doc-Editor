import { getBlocks } from './outline.js';
import { getSections, sectionOf, findSectionsInCommand, nameWords } from './sections.js';
import { cellAt, dataCellRole, rowName, rowNames } from './tables.js';

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

// Every number the command states, also spoken ones: "5 lakh 86 thousand" -> 586000 (and 5, 86)
export function numbersSaid(command) {
  // (a full stop at the end of a sentence is not part of the number: "... to 2.2.")
  const words = wordsToDigits(String(command || '').toLowerCase()).split(/[^a-z0-9.]+/)
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
