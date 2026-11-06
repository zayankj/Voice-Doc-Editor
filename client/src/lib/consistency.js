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

// "60 -YEAR OLD FEMALE", "48-year-old male", "35 yrs old lady", "70 year old patient"
const PHRASE =
  /\b(\d{1,3})(\s*-?\s*(?:years?|yrs?|yr)\s*-?\s*old\s*-?\s*)(male|female|man|woman|lady|gentleman|boy|girl|patient|pt)\b/gi;

const TO_FEMALE = { male: 'female', man: 'woman', gentleman: 'lady', boy: 'girl' };
const TO_MALE = { female: 'male', woman: 'man', lady: 'gentleman', girl: 'boy' };

// Copies the letter case of the original word ("FEMALE" -> "MALE", "Female" -> "Male")
function matchCase(word, like) {
  if (like === like.toUpperCase()) return word.toUpperCase();
  if (like[0] === like[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

function fixPhrase(full, age, middle, noun, facts) {
  const newAge = facts.age ?? age;
  let newNoun = noun;
  const map = facts.gender === 'male' ? TO_MALE : facts.gender === 'female' ? TO_FEMALE : null;
  const swap = map?.[noun.toLowerCase()];
  if (swap) newNoun = matchCase(swap, noun);
  return `${newAge}${middle}${newNoun}`;
}

// Rewrites every narrative age/gender phrase so it matches `facts`.
// Only the changed characters are replaced, so bold/italic formatting stays.
// Returns the list of changed blocks: [{ pos, before, after }]
export function syncPatientFacts(editor, facts, onBlockChanged) {
  if (!facts.age && !facts.gender) return [];
  const changes = [];
  const blocks = getBlocks(editor.state.doc);

  // From the bottom up, so earlier positions stay valid
  for (let b = blocks.length - 1; b >= 0; b--) {
    const { pos, node } = blocks[b];
    const start = pos + 1;
    let text = '';
    const map = [];
    node.forEach((child, offset) => {
      if (child.isText) {
        for (let k = 0; k < child.text.length; k++) map.push(start + offset + k);
        text += child.text;
      }
    });

    const hits = [];
    for (const m of text.matchAll(PHRASE)) {
      const fixed = fixPhrase(m[0], m[1], m[2], m[3], facts);
      if (fixed !== m[0]) hits.push({ i: m.index, len: m[0].length, fixed });
    }
    if (!hits.length) continue;

    const before = node.textContent;
    let tr = editor.state.tr;
    for (const h of hits.reverse()) {
      tr = tr.insertText(h.fixed, map[h.i], map[h.i + h.len - 1] + 1);
    }
    const changed = tr.doc.nodeAt(pos);
    onBlockChanged?.(tr, pos, changed);
    editor.view.dispatch(tr);
    changes.push({ pos, before, after: changed.textContent });
  }
  return changes;
}
