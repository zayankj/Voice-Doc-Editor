import { getBlocks } from './outline';

// Keeps the patient's age and gender the same everywhere in the document.
// The header states them (e.g. "21 Y / MALE"); the narrative repeats them
// (e.g. "60 -YEAR OLD FEMALE CAME WITH..."). When an edit changes the header,
// syncPatientFacts() rewrites the narrative phrases to match. It does not rely on the AI model.

const GENDER_CODE = { m: 'male', male: 'male', f: 'female', female: 'female' };

// Header forms: "21 Y / MALE", "21 Yrs/M", "MALE / 21", "Age: 21", "Sex: Male", "Gender : Female"
const AGE_GENDER = /\b(\d{1,3})\s*(?:y|yr|yrs|years?)\s*\/\s*(male|female|m|f)\b/i;
const GENDER_AGE = /\b(male|female)\s*\/\s*(\d{1,3})\b/i;
const AGE_LABEL = /^\s*age\s*[:\-]?\s*(\d{1,3})?\b/i;
const GENDER_LABEL = /^\s*(?:sex|gender)\s*[:\-]?\s*(male|female|m|f)?\b/i;

// Reads the patient's age and gender from the first place that states them (the header).
export function getPatientFacts(doc) {
  const blocks = getBlocks(doc).map((b) => b.node.textContent);
  let age = null;
  let gender = null;

  for (let i = 0; i < blocks.length && (age == null || gender == null); i++) {
    const t = blocks[i];
    let m;
    if ((m = t.match(AGE_GENDER))) {
      age ??= m[1];
      gender ??= GENDER_CODE[m[2].toLowerCase()];
      continue;
    }
    if ((m = t.match(GENDER_AGE))) {
      age ??= m[2];
      gender ??= GENDER_CODE[m[1].toLowerCase()];
      continue;
    }
    // "Age: 21" in one block, or "Age" in one table cell and "21" in the next
    if (age == null && (m = t.match(AGE_LABEL))) {
      const v = m[1] || (blocks[i + 1] || '').match(/^\s*(\d{1,3})\b/)?.[1];
      if (v) age = v;
    }
    if (gender == null && (m = t.match(GENDER_LABEL))) {
      const v = m[1] || (blocks[i + 1] || '').match(/^\s*(male|female|m|f)\b/i)?.[1];
      if (v) gender = GENDER_CODE[v.toLowerCase()];
    }
  }
  return { age, gender };
}

// ---------- the phrases that are kept in line with the patient's age and gender ----------

// "60 -YEAR OLD FEMALE", "48-year-old male", "35 yrs old lady", "70 year old patient"
const PHRASE =
  /\b(\d{1,3})(\s*-?\s*(?:years?|yrs?|yr)\s*-?\s*old\s*-?\s*)(male|female|man|woman|lady|gentleman|boy|girl|patient|pt)\b/gi;
// "male patient", "Female pt" (without an age in front)
const GENDER_PATIENT = /\b(male|female)(\s+(?:patient|pt)\b)/gi;
// he / she, his / her ... (only words that refer to a person)
const PRONOUN = /\b(he|she|him|his|her|hers|himself|herself)\b/gi;

const TO_FEMALE = { male: 'female', man: 'woman', gentleman: 'lady', boy: 'girl' };
const TO_MALE = { female: 'male', woman: 'man', lady: 'gentleman', girl: 'boy' };
const PRONOUN_TO_FEMALE = { he: 'she', him: 'her', his: 'her', himself: 'herself' };
const PRONOUN_TO_MALE = { she: 'he', hers: 'his', herself: 'himself' }; // "her" is decided below

// After these words "her" means "him" ("advised her" -> "advised him"); otherwise "his" ("her pain" -> "his pain")
const HER_AS_HIM_NEXT = /^(?:$|[.,;:!?)]|and\b|or\b|to\b|with\b|for\b|on\b|in\b|at\b|from\b|about\b|that\b|as\b|again\b|today\b|home\b)/i;

// Copies the letter case of the original word ("FEMALE" -> "MALE", "Female" -> "Male")
function matchCase(word, like) {
  if (like === like.toUpperCase()) return word.toUpperCase();
  if (like[0] === like[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

const swapNoun = (noun, gender) => {
  const map = gender === 'male' ? TO_MALE : gender === 'female' ? TO_FEMALE : null;
  const swap = map?.[noun.toLowerCase()];
  return swap ? matchCase(swap, noun) : noun;
};

// ---------- someone OTHER than the patient (a relative, an attender ...) ----------
// "Mother is a 60 year old female with diabetes", "his father, a 70-year-old man, ...", "Wife: 45 years old lady":
// that age / sex / pronoun belongs to the relative and is never changed to the patient's. The patient's own words
// still follow Patient Details ("His mother ..." - "his" is the patient; "a 30 year old male patient whose mother ...").
const OTHER_PERSON = /\b(?:mother|father|mom|mum|dad|parents?|wife|husband|spouse|sons?|daughters?|child(?:ren)?|kids?|baby|brothers?|sisters?|siblings?|grand(?:mother|father|son|daughter|child|parent)s?|uncles?|aunts?|aunty|nephews?|nieces?|cousins?|in-?laws?|relatives?|relations?|friends?|neighbou?rs?|attender|attendant|caretaker|guardian|bystander)\b/i;
const SENTENCE_START = /[.!?]\s+(?=\S)|\n+/g;
// where the sentence containing position i starts, and where the sentence before it starts
function sentenceBounds(text, i) {
  let start = 0;
  let prev = 0;
  for (const m of text.matchAll(SENTENCE_START)) {
    const s = m.index + m[0].length;
    if (s > i) break;
    prev = start;
    start = s;
  }
  return { start, prev };
}
// is the phrase / pronoun at position i about another person? (a relative named BEFORE it in its own sentence; or a
// he / she that starts a sentence right after a sentence about a relative that does not mention the patient)
function aboutOtherPerson(text, i, { pronounAtStart = false } = {}) {
  const { start, prev } = sentenceBounds(text, i);
  if (OTHER_PERSON.test(text.slice(start, i))) return true;
  if (pronounAtStart && start > 0 && !text.slice(start, i).trim()) {
    const before = text.slice(prev, start);
    return OTHER_PERSON.test(before) && !/\b(?:patient|pt)\b/i.test(before);
  }
  return false;
}

// All the places in one text that must change: [{ i, len, fixed }] (no overlaps)
function findFixes(text, facts) {
  const hits = [];
  for (const m of text.matchAll(PHRASE)) {
    // "... a 60 year old female" after "Mother is" belongs to the mother ("... patient" is always the patient)
    if (!/^(?:patient|pt)$/i.test(m[3]) && aboutOtherPerson(text, m.index)) continue;
    const fixed = `${facts.age ?? m[1]}${m[2]}${swapNoun(m[3], facts.gender)}`;
    if (fixed !== m[0]) hits.push({ i: m.index, len: m[0].length, fixed });
  }
  if (facts.gender) {
    for (const m of text.matchAll(GENDER_PATIENT)) {
      const fixed = swapNoun(m[1], facts.gender);
      if (fixed !== m[1]) hits.push({ i: m.index, len: m[1].length, fixed });
    }
    for (const m of text.matchAll(PRONOUN)) {
      const w = m[1].toLowerCase();
      // a pronoun about a relative ("Mother is diabetic and she takes insulin") stays; "His mother" (the patient's) changes
      if (aboutOtherPerson(text, m.index, { pronounAtStart: /^(?:he|she)$/.test(w) })) continue;
      let to;
      if (facts.gender === 'female') to = PRONOUN_TO_FEMALE[w];
      else if (w === 'her') to = HER_AS_HIM_NEXT.test(text.slice(m.index + 3).trimStart()) ? 'him' : 'his';
      else to = PRONOUN_TO_MALE[w];
      if (to) hits.push({ i: m.index, len: m[1].length, fixed: matchCase(to, m[1]) });
    }
  }
  // keep the first of any overlapping hits ("25-year-old male patient" is matched twice)
  hits.sort((a, b) => a.i - b.i);
  return hits.filter((h, k) => k === 0 || h.i >= hits[k - 1].i + hits[k - 1].len);
}

// Text of a block plus the document position of every character (so only changed letters are replaced)
function blockText(pos, node) {
  const start = pos + 1;
  let text = '';
  const map = [];
  node.forEach((child, offset) => {
    if (child.isText) {
      for (let k = 0; k < child.text.length; k++) map.push(start + offset + k);
      text += child.text;
    }
  });
  return { text, map };
}

// Replaces the hits inside one block (formatting such as bold stays). Returns { before, after } or null.
function applyHits(editor, pos, node, map, hits, onBlockChanged) {
  if (!hits.length) return null;
  const before = node.textContent;
  let tr = editor.state.tr;
  for (const h of [...hits].reverse()) tr = tr.insertText(h.fixed, map[h.i], map[h.i + h.len - 1] + 1);
  const changed = tr.doc.nodeAt(pos);
  onBlockChanged?.(tr, pos, changed);
  editor.view.dispatch(tr);
  return { pos, before, after: changed.textContent };
}

// Rewrites every age/gender phrase, "male patient", he/she words and the name title (Mr./Ms.)
// so they match `facts`. The header value itself is not touched here (see setHeaderGender).
// only (optional): (node) => true for the blocks that may change (e.g. only the text a command just wrote);
// without it every block is checked, as before.
// Returns the list of changed blocks: [{ pos, before, after }]
export function syncPatientFacts(editor, facts, onBlockChanged, only = null) {
  if (!facts.age && !facts.gender) return [];
  const changes = [];
  const blocks = getBlocks(editor.state.doc);
  const nameIdx = facts.gender && !only ? findNameBlock(blocks.map((b) => b.node.textContent)) : -1;

  // From the bottom up, so earlier positions stay valid
  for (let b = blocks.length - 1; b >= 0; b--) {
    const { pos, node } = blocks[b];
    if (only && !only(node)) continue;
    const { text, map } = blockText(pos, node);
    const hits = findFixes(text, facts);
    if (b === nameIdx) {
      // "Mr. FATIMA SAFA" -> "Ms. FATIMA SAFA" when the patient is female (Mrs./Miss/Ms. are kept)
      const t = text.match(/^(\s*)(mr|ms|mrs|miss)\b\.?/i);
      if (t) {
        const isMale = t[2].toLowerCase() === 'mr';
        if (facts.gender === 'female' && isMale) hits.unshift({ i: t[1].length, len: 2, fixed: matchCase('ms', t[2]) });
        if (facts.gender === 'male' && !isMale) hits.unshift({ i: t[1].length, len: t[2].length, fixed: matchCase('mr', t[2]) });
      }
    }
    const c = applyHits(editor, pos, node, map, hits, onBlockChanged);
    if (c) changes.push(c);
  }
  return changes;
}

// The block that holds the patient's name: the value after a "Name" / "Patient Name" label
function findNameBlock(texts) {
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i].trim();
    if (/^(?:patient'?s?\s*name|name\s*of\s*(?:the\s*)?patient|name)\s*:?$/i.test(t)) return i + 1; // label cell + value cell
    if (/^(?:patient'?s?\s*name|name)\s*:\s*\S/i.test(t)) return i; // "Name : X" in one block
  }
  return -1;
}

// Changes the gender in the header ("21 Y / MALE", "Sex : Male", or the cell after "SEX") to `gender`.
// Returns the changed block or null.
export function setHeaderGender(editor, gender, onBlockChanged) {
  const blocks = getBlocks(editor.state.doc);
  const texts = blocks.map((b) => b.node.textContent);
  const word = (like) => (/^[mf]$/i.test(like) ? matchCase(gender[0], like) : matchCase(gender, like));

  for (let b = 0; b < blocks.length; b++) {
    const t = texts[b];
    let target = -1;
    let m = t.match(AGE_GENDER);
    let at = -1;
    let old = '';
    if (m) {
      target = b; old = m[2]; at = m.index + m[0].length - m[2].length;
    } else if ((m = t.match(GENDER_AGE))) {
      target = b; old = m[1]; at = m.index;
    } else if ((m = t.match(GENDER_LABEL))) {
      if (m[1]) {
        target = b; old = m[1]; at = m.index + m[0].length - m[1].length;
      } else {
        const v = (texts[b + 1] || '').match(/^(\s*)(male|female|m|f)\b/i);
        if (v) { target = b + 1; old = v[2]; at = v[1].length; }
      }
    }
    if (target === -1) continue;
    if (GENDER_CODE[old.toLowerCase()] === gender) return null; // already right
    const { pos, node } = blocks[target];
    const { map } = blockText(pos, node);
    return applyHits(editor, pos, node, map, [{ i: at, len: old.length, fixed: word(old) }], onBlockChanged);
  }
  return null;
}
