// Safety checks for AI edits. They run in the browser BEFORE an AI edit is applied,
// so a wrong answer from the AI cannot change these things. (Typing by hand is never blocked.)
//
// 1. LABELS ARE LOCKED: field labels like "Name", "AGE", "SEX", "IP No", "DIAGNOSIS" can never be
//    changed by the AI. In "Label : value" lines the label part must stay as it is.
// 2. GENDER IS PROTECTED: an AI edit that changes gender words (male/female, he/she, ...) is only
//    allowed when the command itself talks about gender, or a file was attached (the file is the source).

import { cellAt, dataCellRole } from './tables.js';

// Field and section labels used in hospital documents (compared in lower case, without ":" or ".")
const LABELS = new Set([
  'name', 'patient name', 'name of patient', 'name of the patient', 'patients name', "patient's name",
  'age', 'sex', 'gender', 'age/sex', 'sex/age', 'age/gender', 'gender/age', 'dob', 'date of birth',
  'address', 'ip no', 'ipno', 'op no', 'opno', 'uhid', 'mrn', 'reg no', 'regno', 'registration no', 'case no',
  'mobile', 'mobile no', 'phone', 'phone no', 'contact no', 'patient mobile no', 'email', 'blood group',
  'ward', 'ward name', 'bed no', 'room no', 'consultant', 'consultant(s)', 'consultants', 'doctor', 'department',
  'admission date', 'date of admission', 'admitted on', 'discharge date', 'date of discharge', 'discharged on',
  'diagnosis', 'final diagnosis', 'provisional diagnosis', 'presenting complaint', 'presenting complaints',
  'chief complaint', 'chief complaints', 'history', 'past history', 'past medical history', 'history of present illness',
  'physical examination', 'examination', 'clinical examination', 'general examination', 'systemic examination',
  'investigations', 'lab investigations', 'course in hospital', 'course in the hospital', 'hospital course',
  'treatment', 'treatment given', 'medications', 'medicines', 'discharge medications', 'advice', 'advice on discharge',
  'follow up', 'follow-up', 'review', 'condition at discharge', 'condition on discharge', 'procedure', 'procedures',
  'allergies', 'vitals', 'vital signs', 'remarks', 'signature', 'signed by', 'discharge summary',
]);

const norm = (t) =>
  String(t || '')
    .toLowerCase()
    .replace(/\s*\/\s*/g, '/') // "Age / Sex" -> "age/sex"
    .replace(/[\s.:\-–]+$/g, '') // drop trailing ":" "." "-" and spaces
    .replace(/\s+/g, ' ')
    .trim();

export const isLabelText = (t) => LABELS.has(norm(t));

// "Patient mobile no : 9494705601" -> "Patient mobile no :" (only when the part before ":" is a known label)
export function labelPrefix(text) {
  const m = String(text || '').match(/^(\s*[^:]{1,40}?\s*:)/);
  return m && isLabelText(m[1]) ? m[1] : '';
}

const isCell = (node) => node.type.name === 'tableCell' || node.type.name === 'tableHeader';

// Is this block a locked label? block = { pos, node } from getBlocks(), doc = the editor document.
// Decided by the cell's ROLE, not its type: Word files often make EVERY cell a header cell (<th>),
// values included, so "header cell" alone does not mean "label".
export function isLockedLabel(doc, block) {
  const text = block.node.textContent;
  if (isLabelText(text)) return true; // "Name", "AGE", "SEX", "IP No", "DIAGNOSIS" ...

  const $pos = doc.resolve(block.pos);
  const cell = $pos.parent; // the table cell the block sits in (or the page)
  if (!isCell(cell)) return false;
  if (/^\s*[^:]{1,40}:\s*$/.test(text)) return true; // a "Label :" cell

  // Data tables ("Investigation | Result"): the column titles and the row names (HB, SGPT ...) are labels,
  // the results are values
  const role = dataCellRole(cellAt(doc, block.pos));
  if (role === 'title' || role === 'name') return true;
  if (role === 'value') return false;

  const row = $pos.node($pos.depth - 1);
  const col = $pos.index($pos.depth - 1); // which column this cell is in (0, 1, 2 ...)
  const cells = [];
  row.forEach((c) => cells.push(c));

  // Template style: shaded header cells beside normal cells in the same row are labels
  if (cell.type.name === 'tableHeader' && cells.some((c) => c.type.name === 'tableCell')) return true;

  // "label | value | label | value" rows: when the label columns (0, 2, ...) hold a known label,
  // every cell in those columns is a label too (e.g. an unusual label like "Ward Name")
  if (cells.length >= 2 && cells.length % 2 === 0 && col % 2 === 0) {
    return cells.some((c, i) => i % 2 === 0 && isLabelText(c.textContent));
  }
  return false;
}

// Checks the text an edit will produce. Returns '' when fine, or the reason it is blocked.
export function lockReason(doc, block, operation, resultText) {
  if (operation === 'insert_after') return ''; // adds a new line after the block, the block itself stays
  const text = block.node.textContent;
  if (isLockedLabel(doc, block)) return `"${text.trim()}" is a label and is locked`;
  const prefix = labelPrefix(text);
  if (prefix && !String(resultText).trimStart().toLowerCase().startsWith(prefix.trim().toLowerCase())) {
    return `the label "${prefix.trim()}" is locked`;
  }
  // a section heading on the FIRST LINE of a paragraph ("ADVICE↵Tab. DOLO ...", "DIAGNOSIS↵Enteric fever"):
  // it must stay at the start, unchanged (the AI may change the lines after it, never remove or rename it)
  const head = firstLineHeading(block.node);
  if (head && !String(resultText).trimStart().toLowerCase().startsWith(head.toLowerCase())) {
    return `the heading "${head}" is locked`;
  }
  return '';
}

// The first line of a paragraph (the text before its first line break) when it is a known section label
// ("ADVICE", "Diagnosis :"). Only KNOWN labels: capital-letter content ("ENTERIC FEVER↵SEPSIS") stays editable.
function firstLineHeading(node) {
  let first = '';
  let broke = false;
  node.forEach((child) => {
    if (broke) return;
    if (child.isText) first += child.text;
    else broke = true;
  });
  const head = first.trim();
  if (!broke || !head) return '';
  return isLabelText(head) ? head : '';
}

// ---------- gender ----------
const GENDER_WORDS = /\b(male|female|man|woman|men|women|boy|girl|gentleman|lady|he|she|him|his|her|hers|himself|herself)\b/gi;
const ABOUT_GENDER = /\b(male|female|gender|sex|man|woman|boy|girl|gentleman|lady|he|she|him|his|her)\b/i;

const genderWords = (t) => (String(t || '').match(GENDER_WORDS) || []).map((w) => w.toLowerCase());

// True when the edit would ADD or SWAP gender words ("male" -> "female", or a new "he" ...).
// Only REMOVING words is not a gender change: clearing a section that says "60-year-old female"
// is allowed. (Each gender word of the new text must already be in the old text.)
export function changesGender(before, after) {
  const left = genderWords(before);
  for (const w of genderWords(after)) {
    const k = left.indexOf(w);
    if (k === -1) return true; // a gender word that was not there before
    left.splice(k, 1);
  }
  return false;
}

// May the AI change gender words for this command?
export function genderChangeAllowed({ instruction = '', heard = '', hasFile = false }) {
  return hasFile || ABOUT_GENDER.test(`${instruction} ${heard}`);
}
