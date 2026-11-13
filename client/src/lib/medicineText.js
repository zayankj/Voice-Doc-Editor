import { getBlocks } from './outline.js';
import { getSections, findSectionsInCommand } from './sections.js';
import { isLockedLabel, labelPrefix } from './guards.js';
import { flashKey } from './flash.js';

// Deterministic removals inside ONE section, done by code (the AI never rewrites medicine lines).
//
//   Generic names:   "(Ciprofloxacin)" after the brand          -> category 'generic'
//   Descriptions:    "(Antacid)", "(Probiotic)" after the brand -> category 'description' (only when asked)
//   Route:           Oral, IV, IM, Topical, Inhalation ...      -> category 'route'
//   Frequency:       Once/Twice/Three Times Daily, OD, BD ...    -> category 'frequency'
//   As needed:       As Needed (SOS), PRN, When required ...     -> category 'as_needed' (only when asked)
//   Food timing:     After Food, 10 mins before food ...         -> category 'food'      (only when asked)
//   Literal phrases: exactly the words the user listed           -> kind 'phrase'
//
// Medicines are handled one ENTRY at a time. An entry is one medicine: a paragraph is split at every
// line break (hard break) and wherever a new "Tab. / Cap. / Syp. / Inj." starts, so medicines written in
// one paragraph with line breaks are never treated as one long line.
//
// planRemoval() works out EXACTLY which characters would be deleted (nothing is changed);
// applyRemovals() deletes only those characters, in one step (one Undo), after the user confirmed.
//
// A plan is { section, changes, unchanged, counts, notFound }
//   changes   = [{ block, entry, before, removals: [{ from, to, text, kind, selected }] }]
//               (from/to = character offsets inside the entry; they include ONE neighbouring separator)
//   unchanged = [{ block, entry, before }]   medicine entries in the section that would not change

const nice = (t) => t.replace(/\s*:\s*$/, '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const REMOVE_VERB = /\b(?:remove|delete|drop|strip|take\s+out|erase)\b/i;
const GENERIC_WORDS = /\b(?:generics?|generic\s+names?|salt\s+names?)\b/i;
// "remove everything / all the content" is the CLEAR-SECTION command (sectionCommands.js), never handled here
const CLEAR_ALL = /\b(everything|all(?: of)?(?: the)? (?:content|contents|text|data|details|lines|information|matter)|(?:whole|entire) (?:section|content|contents|text|thing)|completely|blank|empty)\b/i;

// ---------- medicine forms ----------
// Medicine forms written at the start of an entry, and the words people use for them in a command
export const FORMS = [
  { key: 'tab', line: 'tab|tabs|tablet|tablets', said: 'tab|tabs|tablet|tablets' },
  { key: 'cap', line: 'cap|caps|capsule|capsules', said: 'cap|caps|capsule|capsules' },
  { key: 'syp', line: 'syp|syr|syrup|syrups', said: 'syp|syrup|syrups' },
  { key: 'susp', line: 'susp|suspension', said: 'suspension|suspensions' },
  { key: 'inj', line: 'inj|injection|injections', said: 'inj|injection|injections' },
  { key: 'drops', line: 'drop|drops|eye drops|ear drops', said: 'drop|drops' },
  { key: 'oint', line: 'oint|ointment|cream|gel|lotion', said: 'ointment|ointments|cream|creams|gel|gels|lotion|lotions' },
  { key: 'sachet', line: 'sachet|sachets|powder', said: 'sachet|sachets|powder|powders' },
  { key: 'inhaler', line: 'inhaler|neb|nebulisation|nebulization|spray|rotacap', said: 'inhaler|inhalers|nebulisation|nebulization|spray|sprays' },
];
export const FORM_AT_START = new RegExp(`^\\s*(${FORMS.map((f) => f.line).join('|')})\\.?\\s+`, 'i');
export const formKeyOf = (word) => FORMS.find((f) => new RegExp(`^(?:${f.line})$`, 'i').test(word.trim()))?.key || null;
// A NEW medicine starting in the middle of a line: "... 2 daysTab. METRONIDAZOLE ..." (needs the dot)
const MID_START = /(?:Tab|Tabs|Cap|Caps|Syp|Syr|Inj|Susp)\.\s+(?=[A-Za-z(])/gi;
// A strength / amount: "200 mg", "10 ml", "2 scoops"
export const STRENGTH = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|gm|ml|iu|units?|scoops?|puffs?|drops?|sachets?|tabs?|caps?)\b/i;

// ---------- generic names (brackets right after the brand) ----------
//   "Tab. CIPLOX (Ciprofloxacin) 200 mg ..." -> "(Ciprofloxacin)". The bracket must be the FIRST bracket of
//   the entry and come before any number or dash.
const WITH_FORM = new RegExp(`^(\\s*(?:${FORMS.map((f) => f.line).join('|')})\\.?\\s+[^()\\d—–]+?)(\\s*)\\(([^()]*)\\)`, 'i');
//   "AZIPROPROTEIN POWDER (Protein Supplement) 2 scoops" (no form word in front; only in a medicine section):
//   brand of 1-4 words, then the bracket, then a STRENGTH NUMBER (so "Follow up in OPD (Dr. Arjun)" never matches)
const WITHOUT_FORM = /^(\s*(?:[A-Za-z][\w.'&/-]*\s+){0,3}[A-Za-z][\w.'&/-]*)(\s*)\(([^()]*)\)(?=\s*\d)/;
// Brackets that are NEVER a generic name: instructions, frequencies, doctors (and anything with a digit)
const INSTRUCTION = /\b(sos|stat|prn|hs|od|bd|bid|tds|tid|qid|qds|qhs|ac|pc|as needed|after food|before food|with food|empty stomach|if fever|if pain|if needed|when required|at night|morning|evening|night|daily|weekly|twice|once|thrice|times|days?|weeks?|months?|apply|local|external|oral|iv|im|sc|topical|stop|continue|dr|doctor)\b/i;
const NAME_LIKE = /^[A-Za-z][A-Za-z\s/+,.'-]*$/;
// Words that describe WHAT KIND of medicine it is (not an ingredient)
const DESCRIPTION_WORDS = new Set([
  'antacid', 'probiotic', 'probiotics', 'prebiotic', 'supplement', 'supplements', 'protein', 'multivitamin', 'multivitamins',
  'vitamin', 'vitamins', 'mineral', 'minerals', 'antibiotic', 'analgesic', 'painkiller', 'antipyretic', 'laxative',
  'antiemetic', 'antihistamine', 'antispasmodic', 'steroid', 'tonic', 'electrolyte', 'electrolytes', 'enzyme', 'enzymes',
  'digestive', 'nutritional', 'nutrition', 'syrup', 'and', 'with',
]);

// The generic-name bracket of one medicine entry, or null.  { from, to, text, kind, form }
export function findGenericBracket(line, { allowWithoutForm = false } = {}) {
  let m = line.match(WITH_FORM);
  const form = m ? formKeyOf(line.match(FORM_AT_START)[1]) : null;
  if (!m && allowWithoutForm) m = line.match(WITHOUT_FORM);
  if (!m) return null;
  const inner = m[3].trim();
  if (!inner || inner.length > 60) return null;
  if (/\d/.test(inner)) return null; // (1-0-1), (500 mg), (Vitamin D3) ...
  if (INSTRUCTION.test(inner)) return null; // (SOS), (after food), (Twice daily) ...
  if (!NAME_LIKE.test(inner)) return null;
  const from = m[1].length; // the space before "(" goes with it
  const to = m[0].length;
  const words = inner.toLowerCase().split(/[\s/+,]+/).filter(Boolean);
  const kind = words.every((w) => DESCRIPTION_WORDS.has(w)) ? 'description' : 'generic';
  return { from, to, text: line.slice(from, to), kind, form };
}

// ---------- categories of instructions (controlled lists; regex pieces, matched as whole words) ----------
export const CATEGORIES = {
  route: {
    label: 'route',
    terms: [
      'per oral', 'per os', 'orally', 'oral', 'p\\.o\\.', 'po',
      'intravenously', 'intravenous', 'i\\.v\\.', 'iv',
      'intramuscularly', 'intramuscular', 'i\\.m\\.', 'im',
      'subcutaneously', 'subcutaneous', 's\\.c\\.', 'sc',
      'topically', 'topical', 'local application', 'locally',
      'by inhalation', 'inhalation', 'inhaled', 'nebuli[sz]ation', 'nebuli[sz]ed',
      'sublingually', 'sublingual', 's/l', 'per rectal', 'per rectum', 'rectally', 'rectal',
      'intranasally', 'intranasal', 'nasally', 'nasal', 'transdermal',
    ],
  },
  frequency: {
    label: 'frequency',
    terms: [
      '(?:once|twice|thrice|three times|four times|1 time|2 times|3 times|4 times) (?:daily|a day|per day|in a day)',
      'once daily', 'twice daily', 'thrice daily', 'thrice', 'daily', 'every day',
      'every morning', 'every night', 'every evening', 'every (?:\\d+|four|six|eight|twelve) (?:hours|hrs|hourly)',
      '(?:\\d+|four|six|eight|twelve) hourly', '(?:once|twice) (?:weekly|a week)', 'weekly',
      'on alternate days', 'alternate days?', 'every other day', 'at bedtime',
      'o\\.d\\.', 'od', 'b\\.d\\.', 'bd', 'bid', 't\\.d\\.s\\.', 'tds', 'tid', 'qid', 'qds', 'h\\.s\\.', 'hs', 'qhs', 'q\\d+h',
      '\\(\\s*(?:od|bd|bid|tds|tid|qid|hs)\\s*\\)',
    ],
  },
  as_needed: {
    label: 'as needed',
    terms: [
      'as needed\\s*\\(\\s*sos\\s*\\)', 'as needed', 'as required', 'as and when required', 'when required', 'when needed',
      'if needed', 'if required', '\\(\\s*(?:sos|prn)\\s*\\)', 's\\.o\\.s\\.', 'sos', 'p\\.r\\.n\\.', 'prn',
    ],
  },
  food: {
    label: 'food timing',
    terms: [
      '(?:\\d+\\s*(?:mins?|minutes?|hrs?|hours?)\\s+)?(?:after|before|with) (?:food|meals?|breakfast|lunch|dinner)',
      'on an empty stomach', 'on empty stomach', 'empty stomach',
    ],
  },
};
// these two are brackets after the brand (found by findGenericBracket), not word lists
export const BRACKET_CATEGORIES = { generic: { label: 'generic name' }, description: { label: 'description' } };

// Numeric dosing patterns: "(1-0-1)", "(1-1-1)", "(0-0-1)", "(½-0-½)", "1-0-1", "(1-1-1-1)".
// Every part is ONE digit 0-4 (or ½), 3 or 4 parts: dates ("12-05-2026") and "1-2 tablets" never match.
// They tell the patient how often to take the medicine, so they are NEVER ticked automatically:
//   - a line that loses a frequency word shows its pattern as a separate, UNTICKED box (the user may tick it);
//   - they are ticked only when the command explicitly asks for them ("remove the dosing patterns", "remove 1-0-1");
//   - route removals, generic names and every other edit never show or touch them.
export const DOSING_PATTERN =
  /\(\s*[0-4½](?:\s*-\s*[0-4½]){2,3}\s*\)|(?<![\d½-])[0-4½](?:-[0-4½]){2,3}(?![\d½-])/g;

const sortedTerms = (terms) => [...terms].sort((a, b) => b.length - a.length);
export const categoryRegex = (key) =>
  new RegExp(`(?<![A-Za-z0-9])(?:${sortedTerms(CATEGORIES[key].terms).join('|')})(?![A-Za-z0-9])`, 'gi');

// Which category does one example term belong to? "Oral" -> 'route', "Twice Daily" -> 'frequency', "SOS" -> 'as_needed'
export function categoryOfTerm(term) {
  const t = String(term || '').trim();
  for (const key of Object.keys(CATEGORIES)) {
    const re = new RegExp(`^(?:${sortedTerms(CATEGORIES[key].terms).join('|')})$`, 'i');
    if (re.test(t)) return key;
  }
  return null;
}

// ---------- entries ----------
// Splits ONE text block into entries: at every line break (or other non-text item) and wherever a new
// "Tab. / Cap. / Syp. / Inj." starts. Each entry: { block, entry, text, map } where map[i] is the document
// position of character i (taken from the real text pieces, so bold/italic pieces and line breaks are respected).
export function entriesOfBlock(block, blockIndex) {
  const pieces = [];
  let text = '';
  let map = [];
  const finish = () => {
    if (text.trim()) pieces.push({ text, map });
    text = '';
    map = [];
  };
  block.node.forEach((child, offset) => {
    if (child.isText) {
      for (let k = 0; k < child.text.length; k++) map.push(block.pos + 1 + offset + k);
      text += child.text;
    } else {
      finish(); // hard break (line break), image ...: a new entry starts
    }
  });
  finish();

  const out = [];
  pieces.forEach((piece, p) => {
    const cuts = [0];
    // "Advice : Tab. DOLO 650 mg ...": the medicine-section label at the very start of the paragraph is its OWN
    // entry (never part of the first medicine), so removing that medicine never removes the label
    const label = p === 0 ? labelPrefix(piece.text) : '';
    const labelCut = label && MEDICINE_TITLE.test(label) && piece.text.slice(label.length).trim() ? piece.text.match(/^[^:]*:\s*/)[0].length : 0;
    if (labelCut) cuts.push(labelCut);
    for (const m of piece.text.matchAll(MID_START)) if (m.index > labelCut && m.index > 0) cuts.push(m.index);
    cuts.push(piece.text.length);
    for (let i = 0; i < cuts.length - 1; i++) {
      const t = piece.text.slice(cuts[i], cuts[i + 1]);
      // midLine: this medicine started in the middle of a line ("... Treated with Syp. ONDEM ...")
      // (the text right after a label starts a line of its own)
      if (t.trim()) out.push({ text: t, map: piece.map.slice(cuts[i], cuts[i + 1]), midLine: i > 0 && cuts[i] !== labelCut });
    }
  });
  return out.map((e, i) => ({ block: blockIndex, entry: i, ...e }));
}

// All entries of a section's body (headings and locked labels are never included)
export function sectionEntries(doc, section) {
  const blocks = getBlocks(doc);
  return section.body
    .filter((i) => blocks[i] && !isLockedLabel(doc, blocks[i]))
    .flatMap((i) => entriesOfBlock(blocks[i], i));
}

export const MEDICINE_TITLE = /\b(advice|medication|medications|medicine|medicines|treatment|drugs?|prescription|rx)\b/i;

export const isMedicineEntry = (text, medicineSection) =>
  FORM_AT_START.test(text) ||
  (medicineSection && (STRENGTH.test(text) || Boolean(findGenericBracket(text, { allowWithoutForm: true }))) && /^\s*[A-Za-z]/.test(text));

function isMedicineSection(doc, section) {
  if (MEDICINE_TITLE.test(section.title)) return true;
  // a medicine must START a line; one mentioned inside a sentence ("Treated with Syp. ONDEM") does not count
  return sectionEntries(doc, section).some((e) => !e.midLine && FORM_AT_START.test(e.text));
}

// Where removable instructions may start in a medicine entry: after the brand name, i.e. from the first
// strength number or the first dash. (So a brand like "IMOL" or "Inj. IV PARACETAMOL" is never touched.)
function tailStart(text) {
  const positions = [text.search(/\d/), text.search(/[—–]/)].filter((i) => i >= 0);
  return positions.length ? Math.min(...positions) : text.length;
}

// ---------- the planning engine ----------
// Turns core matches into removals with ONE neighbouring separator each, never overlapping each other.
function withSeparators(text, cores) {
  const sorted = [...cores].sort((a, b) => a.from - b.from);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const nextFrom = i + 1 < sorted.length ? sorted[i + 1].from : text.length;
    const prevTo = out.length ? out[out.length - 1].to : 0;
    let from = c.from;
    let to = c.to;
    const rest = text.slice(to, nextFrom);
    const right = rest.match(/^\s*[—–,]\s*|^\s+/);
    if (!text.slice(to).trim()) {
      // last thing in the entry: take the separator in front ("... — As Needed (SOS) — Oral" -> drop "— Oral")
      const left = text.slice(prevTo, from).match(/\s*[—–,]\s*$|\s+$/);
      if (left) from -= left[0].length;
    } else if (right) {
      to += right[0].length;
    }
    out.push({ ...c, from, to });
  }
  return out;
}

// What to remove from one entry. wanted = { categories: Set, phrases: [] }
function removalsForEntry(text, isMedicine, wanted, medicineSection) {
  const cores = [];
  const taken = (s, e) => cores.some((c) => s < c.to && e > c.from);

  // brackets after the brand: generic names / descriptions
  if (isMedicine && (wanted.categories.has('generic') || wanted.categories.has('description'))) {
    const hit = findGenericBracket(text, { allowWithoutForm: medicineSection });
    if (hit) {
      const asked = wanted.categories.has(hit.kind);
      // with "generic names", descriptions are SHOWN (so the user knows) but not ticked
      if (asked || (hit.kind === 'description' && wanted.categories.has('generic'))) {
        cores.push({ from: hit.from, to: hit.to, text: hit.text.trim(), kind: hit.kind, selected: asked, bracket: true });
      }
    }
  }

  // words: literal phrases and instruction categories, longest match first, only after the brand name
  const from = isMedicine ? tailStart(text) : 0;
  const found = [];
  for (const phrase of wanted.phrases) {
    const re = new RegExp(`(?<![A-Za-z0-9])${esc(phrase).replace(/\s+/g, '\\s+')}(?![A-Za-z0-9])`, 'gi');
    for (const m of text.matchAll(re)) found.push({ from: m.index, to: m.index + m[0].length, text: m[0], kind: 'phrase', phrase });
  }
  for (const key of Object.keys(CATEGORIES)) {
    if (!wanted.categories.has(key)) continue;
    for (const m of text.matchAll(categoryRegex(key))) found.push({ from: m.index, to: m.index + m[0].length, text: m[0], kind: key });
  }
  found.sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from);
  for (const f of found) {
    if (f.from < from || taken(f.from, f.to)) continue;
    cores.push({ ...f, selected: true });
  }
  // numeric dosing patterns: ticked only when explicitly asked; otherwise shown UNTICKED on a line that loses
  // a frequency word (so the user can choose), and not shown at all for any other removal
  const losesFrequency = cores.some((c) => c.kind === 'frequency' || (c.kind === 'phrase' && categoryOfTerm(c.text) === 'frequency'));
  if (isMedicine && (wanted.patterns || losesFrequency)) {
    for (const m of text.matchAll(DOSING_PATTERN)) {
      const [s, e] = [m.index, m.index + m[0].length];
      if (s < from || taken(s, e)) continue;
      cores.push({ from: s, to: e, text: m[0], kind: 'pattern', selected: Boolean(wanted.patterns) });
    }
  }
  if (!cores.length) return [];

  // separators: brackets keep their own space in front; words take one neighbouring separator;
  // a dosing pattern right after a word ("Twice Daily (1-0-1) — 2 days") takes only the space in front of it,
  // so removing it alone gives "Twice Daily — 2 days" (never "Twice Daily 2 days")
  const isPattern = (c) => c.kind === 'pattern';
  const words = withSeparators(text, cores.filter((c) => !c.bracket && !isPattern(c)));
  const patterns = cores.filter(isPattern).map((c) => {
    const left = text.slice(0, c.from).match(/(\S)(\s+)$/);
    if (left && !/[—–,]/.test(left[1])) return { ...c, from: c.from - left[2].length };
    return withSeparators(text, [c])[0];
  });
  return [...cores.filter((c) => c.bracket), ...words, ...patterns].sort((a, b) => a.from - b.from).map(({ bracket, ...r }) => r);
}

// The engine. options = { phrases: [], categories: [], forms: [], names: [], entries: [], patterns: false }
//   patterns: true only when the command EXPLICITLY asks to remove dosing patterns (then they are ticked)
//   categories: any of 'generic', 'description', 'route', 'frequency', 'as_needed', 'food'
//   forms: [] = all medicines, or e.g. ['tab', 'syp'] (only those entries)
//   names: [] = all medicines, or e.g. ['dolo'] (only entries with that brand / generic name)
//   entries: [] = all, or ['<block>-<entry>'] (only those entries: "this medicine" = the one at the cursor)
// plan.untyped = medicine entries left out by a form filter because they have no form word ("DOLO 650 mg")
export function planRemoval(doc, section, { phrases = [], categories = [], forms = [], names = [], entries = [], patterns = false } = {}) {
  const wanted = { categories: new Set(categories), phrases: [...new Set(phrases.filter(Boolean))], patterns };
  const medicineSection = isMedicineSection(doc, section);
  const changes = [];
  const unchanged = [];
  const counts = {};
  let untyped = 0;
  for (const e of sectionEntries(doc, section)) {
    const isMedicine = isMedicineEntry(e.text, medicineSection);
    // in a medicine section only medicine entries are touched; elsewhere every line can be
    if (medicineSection && !isMedicine) continue;
    if (forms.length) {
      const f = e.text.match(FORM_AT_START);
      if (!f) { if (isMedicine) untyped++; continue; }
      if (!forms.includes(formKeyOf(f[1]))) continue;
    }
    if (names.length && !names.some((n) => entryMatchesName(e.text, n))) continue;
    if (entries.length && !entries.includes(`${e.block}-${e.entry}`)) continue;
    const removals = removalsForEntry(e.text, isMedicine, wanted, medicineSection);
    if (removals.length) {
      changes.push({ block: e.block, entry: e.entry, before: e.text, removals });
      for (const r of removals) {
        const key = r.kind === 'phrase' ? r.phrase : r.kind;
        // shown-but-unticked suggestions (descriptions, dosing patterns) are not counted as "found"
        if ((r.kind !== 'description' || wanted.categories.has('description')) && (r.kind !== 'pattern' || wanted.patterns)) {
          counts[key] = (counts[key] || 0) + 1;
        }
      }
    } else if (isMedicine) {
      unchanged.push({ block: e.block, entry: e.entry, before: e.text });
    }
  }
  for (const c of changes) for (const r of c.removals) delete r.phrase;
  const notFound = [
    ...wanted.phrases.filter((p) => !counts[p]),
    ...[...wanted.categories].filter((k) => k !== 'description' && !counts[k]).map((k) => (CATEGORIES[k] || BRACKET_CATEGORIES[k]).label),
    ...(wanted.patterns && !counts.pattern ? ['dosing pattern'] : []),
  ];
  return {
    section: { title: nice(section.title), headingIndex: section.headingIndex }, changes, unchanged, counts, notFound, untyped,
    medicines: medicineSection, // the lines are medicines (for the message: "from 3 medicines" / "from 3 lines")
  };
}

// What was ACTUALLY removed, in words, built only from the ticked removals of a plan:
//   "Removed the Oral route, frequency instructions and dosing patterns from 3 medicines."
const titleCase = (t) => t.trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Od|Bd|Bid|Tds|Tid|Qid|Qds|Hs|Sos|Prn|Iv|Im|Sc)\b/g, (w) => w.toUpperCase());
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
export function removalSummary(plan, kind) {
  const lines = plan.changes.filter((c) => c.removals.some((r) => r.selected));
  const sel = lines.flatMap((c) => c.removals.filter((r) => r.selected));
  const medicines = plan.medicines ?? ((plan.unchanged || []).length > 0 || sel.some((r) => r.kind !== 'phrase'));
  const n = lines.length;
  const where = `${n} ${medicines ? 'medicine' : 'line'}${n === 1 ? '' : 's'}`;
  if (kind === 'entries') return `Removed ${where}.`;
  const has = (k) => sel.some((r) => r.kind === k);
  const phrases = (cat) => [...new Set(sel.filter((r) => r.kind === 'phrase' && categoryOfTerm(r.text) === cat).map((r) => titleCase(r.text)))];
  const parts = [];
  const routes = phrases('route');
  if (has('route')) parts.push('route instructions');
  else if (routes.length) parts.push(`the ${andList(routes)} route${routes.length > 1 ? 's' : ''}`);
  if (has('frequency')) parts.push('frequency instructions');
  if (has('pattern')) parts.push('dosing patterns');
  const freq = phrases('frequency');
  if (freq.length) parts.push(andList(freq));
  if (has('generic')) parts.push('generic names');
  if (has('description')) parts.push('descriptions');
  if (has('as_needed')) parts.push('as-needed instructions');
  if (has('food')) parts.push('food timing');
  for (const cat of ['as_needed', 'food']) { const p = phrases(cat); if (p.length) parts.push(andList(p)); }
  const other = [...new Set(sel.filter((r) => r.kind === 'phrase' && !categoryOfTerm(r.text)).map((r) => `"${r.text.trim()}"`))];
  if (other.length) parts.push(andList(other));
  return `Removed ${andList(parts)} from ${where}.`;
}

// How many medicine LINES the document has: entries that start a line with a medicine form ("Tab. / Syp. ...").
// Used to stop AI edits that would remove several medicines at once without the confirmation window.
export function countMedicineLines(doc) {
  let n = 0;
  getBlocks(doc).forEach((b, i) => {
    for (const e of entriesOfBlock(b, i)) if (!e.midLine && FORM_AT_START.test(e.text)) n++;
  });
  return n;
}

// The medicine entry the cursor is in (document position pos), or null. Used for "this medicine".
export function medicineEntryAt(doc, section, pos) {
  if (!Number.isInteger(pos)) return null;
  const medicineSection = isMedicineSection(doc, section);
  return sectionEntries(doc, section).find((e) =>
    isMedicineEntry(e.text, medicineSection) && e.map.length && pos >= e.map[0] && pos <= e.map[e.map.length - 1] + 1) || null;
}

// ---------- removing WHOLE medicine entries ----------
// The brand name of a medicine entry: "Tab. DOLO (Paracetamol) 650 mg ..." -> "DOLO";
// "AZIPROPROTEIN POWDER (Protein Supplement) 2 scoops ..." -> "AZIPROPROTEIN POWDER"
export function brandOf(text) {
  const rest = String(text).replace(FORM_AT_START, '');
  return rest.split(/[(\d—–]/)[0].trim();
}
const formOf = (text) => {
  const m = String(text).match(FORM_AT_START);
  return m ? formKeyOf(m[1]) : null;
};
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

// Does this entry match a spoken medicine name? Brand ("Dolo", "CIPLOX") or the generic name in its
// brackets ("Paracetamol"). Whole words only; names of 3+ letters.
function entryMatchesName(text, name) {
  const n = words(name).join(' ');
  if (n.length < 3) return false;
  const brand = words(brandOf(text));
  const generic = words(findGenericBracket(text, { allowWithoutForm: true })?.text || '');
  const has = (list) => list.join(' ') === n || (` ${list.join(' ')} `).includes(` ${n} `);
  return has(brand) || has(generic);
}

// Proposes whole medicine entries for removal.
//   forms: ['syp'] -> every syrup; names: ['dolo'] -> every entry with that brand (or generic) name.
//   Both given ("the tablet Dolo") -> entries that match the name AND are of that form.
// Returns a plan like planRemoval(): every proposed entry has ONE removal of kind 'entry' covering the whole line.
//   all: true -> EVERY medicine entry of the section ("remove all medicines"); lines that are not medicines
//   (advice text, follow-up, review dates, the heading) are never part of the plan, so they stay.
export function planEntryRemoval(doc, section, { forms = [], names = [], all = false } = {}) {
  const medicineSection = isMedicineSection(doc, section);
  const changes = [];
  const unchanged = [];
  const found = new Map(names.map((n) => [n, 0]));
  for (const e of sectionEntries(doc, section)) {
    if (!isMedicineEntry(e.text, medicineSection)) continue;
    const formOk = !forms.length || forms.includes(formOf(e.text));
    const hitNames = names.filter((n) => entryMatchesName(e.text, n));
    const match = all || (names.length ? hitNames.length > 0 && formOk : formOk && forms.length > 0);
    if (match) {
      for (const n of hitNames) found.set(n, found.get(n) + 1);
      changes.push({
        block: e.block, entry: e.entry, before: e.text,
        removals: [{ from: 0, to: e.text.length, text: e.text.trim(), kind: 'entry', selected: true }],
      });
    } else {
      unchanged.push({ block: e.block, entry: e.entry, before: e.text });
    }
  }
  return {
    section: { title: nice(section.title), headingIndex: section.headingIndex },
    changes,
    unchanged,
    counts: changes.length ? { entry: changes.length } : {},
    notFound: names.filter((n) => found.get(n) === 0),
    medicines: true,
  };
}

// Kept for the existing callers
export const planPhraseRemoval = (doc, section, phrases) => planRemoval(doc, section, { phrases });
export const planGenericRemoval = (doc, section, forms = []) => planRemoval(doc, section, { categories: ['generic'], forms });

// ---------- what exactly is deleted (selected removals + tidy separators/spaces they leave behind) ----------
// Returns sorted character ranges [[from, to], ...] of the entry text to delete. Only deletes, never types.
export function deletionRanges(change) {
  const text = change.before;
  const gone = new Array(text.length).fill(false);
  for (const r of change.removals) if (r.selected) for (let i = r.from; i < r.to; i++) gone[i] = true;
  if (!gone.some(Boolean)) return [];

  // tidy up, only where a removal left something behind
  for (let round = 0; round < 4; round++) {
    const keptIdx = [];
    for (let i = 0; i < text.length; i++) if (!gone[i]) keptIdx.push(i);
    const r = keptIdx.map((i) => text[i]).join('');
    const nearGap = (s, e) => {
      for (let k = Math.max(s, 1); k <= Math.min(e, keptIdx.length - 1); k++) if (keptIdx[k] !== keptIdx[k - 1] + 1) return true;
      return (s === 0 && keptIdx[0] !== 0) || (e >= keptIdx.length - 1 && keptIdx[keptIdx.length - 1] !== text.length - 1);
    };
    let changed = false;
    const drop = (s, e) => {
      for (let k = s; k < e; k++) if (!gone[keptIdx[k]]) { gone[keptIdx[k]] = true; changed = true; }
    };
    // "— —" / ", —": two separators in a row -> drop the first one
    for (const m of r.matchAll(/[—–,]\s*(?=[—–,])/g)) if (nearGap(m.index, m.index + m[0].length)) drop(m.index, m.index + m[0].length);
    // a separator left at the start or end of the entry
    const lead = r.match(/^\s*[—–,]\s*/);
    if (lead && !/^\s*[—–,]/.test(text) && nearGap(0, lead[0].length)) drop(0, lead[0].length);
    const trail = r.match(/\s*[—–,]\s*$/);
    if (trail && !/[—–,]\s*$/.test(text) && nearGap(trail.index, r.length)) drop(trail.index, r.length);
    // double spaces created by a removal -> one space
    for (const m of r.matchAll(/\s{2,}/g)) if (nearGap(m.index, m.index + m[0].length)) drop(m.index + 1, m.index + m[0].length);
    // a space left in front of . , ; : ) by a removal ("Patient is stable." minus "stable" -> "Patient is.")
    for (const m of r.matchAll(/\s+(?=[.,;:)])/g)) if (nearGap(m.index, m.index + m[0].length + 1)) drop(m.index, m.index + m[0].length);
    if (!changed) break;
  }

  const ranges = [];
  for (let i = 0; i < text.length; i++) {
    if (!gone[i]) continue;
    if (ranges.length && ranges[ranges.length - 1][1] === i) ranges[ranges.length - 1][1] = i + 1;
    else ranges.push([i, i + 1]);
  }
  return ranges;
}

// The text of an entry after its SELECTED removals
export function textAfter(change) {
  let t = change.before;
  for (const [a, b] of [...deletionRanges(change)].reverse()) t = t.slice(0, a) + t.slice(b);
  return t;
}

// ---------- which section ----------
// Which section does the command mean? { section } | { ask: 'question' }
export function pickSection(doc, command, { medicineOnly = false } = {}) {
  const sections = getSections(doc).filter((s) => s.headingIndex !== -1);
  const found = findSectionsInCommand(sections, command);
  if (found.best) return { section: found.best };
  if (found.ambiguous) return { ask: `Which section did you mean: ${found.candidates.map((s) => nice(s.title)).join(' or ')}? Nothing was changed.` };
  if (!medicineOnly) return { ask: 'Which section should I change? Please name it, for example "from Advice". Nothing was changed.' };
  const withMedicines = sections.filter((s) => isMedicineSection(doc, s) && sectionEntries(doc, s).some((e) => isMedicineEntry(e.text, true)));
  if (withMedicines.length === 1) return { section: withMedicines[0] };
  // several, but exactly one is named like a medicine section (Advice, Medications, Treatment ...): use that one
  const titled = withMedicines.filter((s) => MEDICINE_TITLE.test(s.title));
  if (titled.length === 1) return { section: titled[0] };
  if (withMedicines.length === 0) return { ask: 'I could not find any medicines in this document. Nothing was changed.' };
  return { ask: `Medicines are in more than one section: ${withMedicines.map((s) => nice(s.title)).join(' or ')}. Which one? Nothing was changed.` };
}

// ---------- reading a command (kept for the existing caller; file 2 replaces this with commandIntent.js) ----------
export function phrasesFromCommand(command, sectionTitle) {
  const c = String(command || '');
  const quoted = [...c.matchAll(/["“”']([^"“”']{1,40})["“”']/g)].map((m) => m[1].trim()).filter(Boolean);
  if (quoted.length) return quoted;
  const v = c.match(REMOVE_VERB);
  if (!v) return [];
  let s = c.slice(v.index + v[0].length);
  if (sectionTitle) {
    const words = sectionTitle.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
    const title = words.map(esc).join('(?:\\s+(?:the|in|of))*\\s+');
    s = s.replace(new RegExp(`\\s*\\b(?:from|in|inside|within|under|of)?\\s*(?:the\\s+)?${title}(?:\\s+section)?\\b`, 'gi'), ' ');
  }
  s = s
    .replace(/^\s*(?:all\s+)?(?:the\s+)?(?:following\s+)?(?:phrases?|words?|terms?|text)?\s*(?:such\s+as|like|:)?\s*/i, '')
    .replace(/[.!?]+\s*$/, '');
  return s
    .split(/\s*,\s*|\s+(?:and|or)\s+/i)
    .map((x) => x.trim().replace(/^(?:the|a|an)\s+/i, ''))
    .filter((x) => x && x.length <= 40 && x.split(/\s+/).length <= 5);
}

export function formsFromCommand(command) {
  const c = String(command || '');
  return FORMS.filter((f) => new RegExp(`\\b(?:${f.said})\\b`, 'i').test(c)).map((f) => f.key);
}

export function detectMedicineCommand(doc, command) {
  const c = String(command || '');
  if (!REMOVE_VERB.test(c)) return null;
  if (GENERIC_WORDS.test(c)) {
    const pick = pickSection(doc, c, { medicineOnly: true });
    if (pick.ask) return { ask: pick.ask };
    const plan = planGenericRemoval(doc, pick.section, formsFromCommand(c));
    if (!plan.changes.length) return { ask: `I found no generic names in brackets in ${plan.section.title}. Nothing was changed.` };
    return { kind: 'generic', plan };
  }
  if (CLEAR_ALL.test(c)) return null;
  const listed = /["“”']|\b(?:phrases?|words?|terms?|such\s+as|like)\b/i.test(c) || (c.match(/,/g) || []).length >= 1;
  if (!listed) return null;
  const pick = pickSection(doc, c);
  if (pick.ask) return { ask: pick.ask };
  const phrases = phrasesFromCommand(c, pick.section.title);
  if (!phrases.length) return { ask: `Which words should I remove from ${nice(pick.section.title)}? Nothing was changed.` };
  const plan = planPhraseRemoval(doc, pick.section, phrases);
  if (!plan.changes.length) return { ask: `None of these were found in ${plan.section.title}: ${phrases.join(', ')}. Nothing was changed.` };
  return { kind: 'phrases', plan };
}

// ---------- applying ----------
// A paragraph that is the ONLY content of a list item (a numbered or bulleted medicine): removing its text must remove
// the whole ITEM, so no empty numbered entry is left (the numbers of the other items follow by themselves; a list
// without numbers never gets any). Returns { from, to, listPos, list } for the item, or null when the paragraph is not
// alone in a list item. `list` is the list node (for "was this its only item?").
export function listItemOf(doc, paraPos) {
  const $p = doc.resolve(paraPos);
  if ($p.depth < 2 || $p.parent.type.name !== 'listItem' || $p.parent.childCount !== 1) return null;
  const from = $p.before($p.depth);
  return { from, to: from + $p.parent.nodeSize, listPos: $p.before($p.depth - 1), list: $p.node($p.depth - 1), listParent: $p.node($p.depth - 2) };
}

// Deletes the selected removals (plus the tidy-up) in ONE step (one Undo). Only characters are deleted;
// nothing is typed. If any entry changed after the preview was made, NOTHING is applied.
// Returns { ok, lines } or { ok: false, error }
export function applyRemovals(editor, plan) {
  const blocks = getBlocks(editor.state.doc);
  const todo = plan.changes.filter((c) => c.removals.some((r) => r.selected));
  const entryCache = new Map();
  const currentEntry = (c) => {
    if (!entryCache.has(c.block)) entryCache.set(c.block, blocks[c.block] ? entriesOfBlock(blocks[c.block], c.block) : []);
    return entryCache.get(c.block)[c.entry];
  };
  for (const c of todo) {
    if (currentEntry(c)?.text !== c.before) {
      return { ok: false, error: 'The document changed after the preview. Nothing was changed; please say the command again.' };
    }
  }
  if (!todo.length) return { ok: true, lines: 0 };

  // every deletion as document positions; then delete from the end of the document backwards
  const deletes = [];
  const wholeEntry = (c) => c.removals.some((r) => r.kind === 'entry' && r.selected);
  // parts of a line (generic names, route, frequency, words)
  for (const c of todo.filter((x) => !wholeEntry(x))) {
    const { map } = currentEntry(c);
    for (const [a, b] of deletionRanges(c)) deletes.push([map[a], map[b - 1] + 1]);
  }
  // whole medicine entries, worked out per paragraph so the remaining medicines keep exactly one line break
  const goneParagraphs = new Set();
  const goneItems = new Map(); // list position -> { list, listParent, ranges } (list items that go completely)
  for (const blockIndex of new Set(todo.filter(wholeEntry).map((c) => c.block))) {
    const block = blocks[blockIndex];
    const all = entryCache.get(blockIndex);
    const removed = new Set(todo.filter((c) => c.block === blockIndex && wholeEntry(c)).map((c) => c.entry));
    const start = (e) => e.map[0];
    const end = (e) => e.map[e.map.length - 1] + 1;
    const kept = all.filter((e) => !removed.has(e.entry));
    if (!kept.length) {
      // every medicine of this paragraph goes: remove the paragraph (a table cell keeps one, emptied).
      // The only paragraph of a list item: the whole item goes (no empty numbered entry is left)
      const item = listItemOf(editor.state.doc, block.pos);
      if (item) {
        if (!goneItems.has(item.listPos)) goneItems.set(item.listPos, { ...item, ranges: [] });
        goneItems.get(item.listPos).ranges.push([item.from, item.to]);
        goneParagraphs.add(blockIndex);
        continue;
      }
      const parent = editor.state.doc.resolve(block.pos).parent;
      if (parent.childCount > 1) {
        deletes.push([block.pos, block.pos + block.node.nodeSize]);
        goneParagraphs.add(blockIndex);
      } else {
        deletes.push([block.pos + 1, block.pos + block.node.nodeSize - 1]);
      }
      continue;
    }
    const contentStart = block.pos + 1;
    const contentEnd = block.pos + block.node.nodeSize - 1;
    const first = kept[0];
    const last = kept[kept.length - 1];
    if (first.entry > 0) deletes.push([contentStart, start(first)]); // removed lines before the first kept one
    for (let i = 0; i + 1 < kept.length; i++) {
      const a = kept[i];
      const b = kept[i + 1];
      // keep a's own line break (up to the next entry), delete the removed lines between a and b
      if (b.entry > a.entry + 1) deletes.push([start(all[a.entry + 1]), start(b)]);
    }
    if (last.entry < all.length - 1) deletes.push([end(last), contentEnd]); // removed lines after the last kept one
  }
  // list items that go completely; every item of a list goes -> the list goes (inside a table cell or a list item
  // where it is the only content, an empty paragraph stays in its place)
  for (const [listPos, g] of goneItems) {
    if (g.ranges.length < g.list.childCount) deletes.push(...g.ranges);
    else if (g.listParent.childCount > 1) deletes.push([listPos, listPos + g.list.nodeSize]);
    else deletes.push([listPos, listPos + g.list.nodeSize, 'paragraph']);
  }
  deletes.sort((x, y) => y[0] - x[0]);
  let tr = editor.state.tr;
  for (const [from, to, keep] of deletes) {
    if (keep) tr = tr.replaceWith(from, to, editor.state.schema.nodes.paragraph.create());
    else if (to > from) tr = tr.delete(from, to);
  }

  const changedBlocks = [...new Set(todo.map((c) => c.block))]
    .filter((i) => !goneParagraphs.has(i))
    .map((i) => tr.mapping.map(blocks[i].pos));
  editor.view.dispatch(tr); // the removal itself: ONE step in the undo history

  // highlight every changed paragraph (not part of the undo history), fade after 5 s
  for (const from of changedBlocks) {
    const node = editor.state.doc.nodeAt(from);
    if (node) editor.view.dispatch(editor.state.tr.setMeta(flashKey, { add: { from, to: from + node.nodeSize } }).setMeta('addToHistory', false));
  }
  setTimeout(() => {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(flashKey, null).setMeta('addToHistory', false));
  }, 5000);
  return { ok: true, lines: todo.length };
}
