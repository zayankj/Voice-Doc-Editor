// Medicine TEXT recognition used by the editor for technical formatting only (lib/voiceEdit.js): which line is a
// medicine entry, so new entries go on their own lines. No interpretation of commands, no medicine rules.
// R6: the old deterministic removal engine (planRemoval / applyRemovals / detectMedicineCommand ...) was removed;
// Gemini decides every change (D1, D6).


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

const sortedTerms = (terms) => [...terms].sort((a, b) => b.length - a.length);

// Which category does one example term belong to? "Oral" -> 'route', "Twice Daily" -> 'frequency', "SOS" -> 'as_needed'
export function categoryOfTerm(term) {
  const t = String(term || '').trim();
  for (const key of Object.keys(CATEGORIES)) {
    const re = new RegExp(`^(?:${sortedTerms(CATEGORIES[key].terms).join('|')})$`, 'i');
    if (re.test(t)) return key;
  }
  return null;
}

export const MEDICINE_TITLE = /\b(advice|medication|medications|medicine|medicines|treatment|drugs?|prescription|rx)\b/i;

export const isMedicineEntry = (text, medicineSection) =>
  FORM_AT_START.test(text) ||
  (medicineSection && (STRENGTH.test(text) || Boolean(findGenericBracket(text, { allowWithoutForm: true }))) && /^\s*[A-Za-z]/.test(text));
