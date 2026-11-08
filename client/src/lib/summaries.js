import { getBlocks } from './outline';
import { getPatientFacts } from './consistency';

// All summaries are saved in THIS browser (localStorage) for now.
//   summaries-v1        -> the list: [{ id, caseNo, status, type, patient, createdAt, updatedAt }]
//   summary-html:<id>   -> the document of one summary (HTML)
// Later this moves to the backend (through the gateway); the rest of the app only uses the functions below.

const LIST_KEY = 'summaries-v1';
const COUNTER_KEY = 'summaries-counter';
const OLD_KEY = 'voice-doc-html'; // where the single document was saved before
const htmlKey = (id) => `summary-html:${id}`;

export const STATUSES = [
  { id: 'draft', label: 'Draft' },
  { id: 'ready', label: 'Ready' },
  { id: 'signed', label: 'Signed' },
];
export const TYPES = [
  { id: 'medical', label: 'Medical' },
  { id: 'surgical', label: 'Surgical' },
  { id: 'death', label: 'Death' },
];

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

// Throws a clear message when the browser storage is full
function write(key, value) {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    throw new Error('Browser storage is full. Delete old summaries or remove large images.');
  }
}

function nextCaseNo() {
  const n = (Number(read(COUNTER_KEY, 0)) || 0) + 1;
  write(COUNTER_KEY, String(n));
  return `DS-${new Date().getFullYear()}-${String(n).padStart(5, '0')}`;
}

export function listSummaries() {
  return read(LIST_KEY, null) ?? migrateOldDocument();
}

function saveList(list) {
  write(LIST_KEY, list);
  return list;
}

// First run after the update: the single document you had before becomes the first summary.
// The old copy is NOT deleted, so nothing can be lost.
function migrateOldDocument() {
  let oldHtml = '';
  try {
    oldHtml = localStorage.getItem(OLD_KEY) || '';
  } catch { /* ignore */ }
  const list = [];
  saveList(list);
  if (oldHtml && !oldHtml.includes('to load a document, then use the mic')) {
    return createSummary(oldHtml).list;
  }
  return list;
}

export function getSummaryHtml(id) {
  try {
    return localStorage.getItem(htmlKey(id));
  } catch {
    return null;
  }
}

// Adds a new summary. Returns { summary, list }
export function createSummary(html, doc = null) {
  const now = new Date().toISOString();
  const summary = {
    id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    caseNo: nextCaseNo(),
    status: 'draft',
    type: 'medical',
    patient: doc ? readPatient(doc) : readPatientFromHtml(html),
    createdAt: now,
    updatedAt: now,
  };
  write(htmlKey(summary.id), html);
  const list = saveList([summary, ...(read(LIST_KEY, []) || [])]);
  return { summary, list };
}

// Saves the document of a summary and refreshes the patient details shown on its card
export function saveSummaryHtml(id, html, doc) {
  write(htmlKey(id), html);
  const list = (read(LIST_KEY, []) || []).map((s) =>
    s.id === id ? { ...s, patient: readPatient(doc), updatedAt: new Date().toISOString() } : s
  );
  return saveList(list);
}

// Changes status / type of one summary
export function updateSummary(id, changes) {
  const list = (read(LIST_KEY, []) || []).map((s) => (s.id === id ? { ...s, ...changes } : s));
  return saveList(list);
}

export function deleteSummary(id) {
  try {
    localStorage.removeItem(htmlKey(id));
  } catch { /* ignore */ }
  return saveList((read(LIST_KEY, []) || []).filter((s) => s.id !== id));
}

// ---------- reading patient details from the document text ----------

const NOT_A_NAME = /hospital|summary|discharge|clinic|medical|cent(re|er)|report|department|institute|patient|consultant|diagnosis/i;

function labelValue(texts, labelRe) {
  for (let i = 0; i < texts.length; i++) {
    const m = texts[i].match(labelRe);
    if (!m) continue;
    const v = (m[1] || texts[i + 1] || '').trim(); // "Name : X" in one block, or "Name" | "X" in two table cells
    if (v) return v;
  }
  return '';
}

// { name, mrn, age, gender } read from a ProseMirror document. Missing values are ''.
export function readPatient(doc) {
  const texts = getBlocks(doc).map((b) => b.node.textContent.trim()).filter(Boolean);

  let name = labelValue(texts, /^(?:patient'?s?\s*name|name\s*of\s*(?:the\s*)?patient|name)\s*(?:[:\-]\s*(.*)|$)/i);
  if (!name) {
    // Many summaries start with the patient name on its own line, e.g. "MUHAMMAD ZAYAN"
    name = texts.find((t) => t.length <= 60 && /^(?:(?:mr|mrs|ms|miss|master|baby|dr)\.?\s*)?[A-Za-z][A-Za-z .']+$/i.test(t) && !NOT_A_NAME.test(t)) || '';
  }

  // "MRN 98956", "RegNo : 959856", or "MRN" in one table cell and "98956" in the next
  const MRN_LABEL = /\b(?:MRN|UHID|Reg(?:istration)?\.?\s*No)\b/i;
  const at = texts.findIndex((t) => MRN_LABEL.test(t));
  let mrn = '';
  if (at !== -1) {
    mrn = texts[at].match(/\b(?:MRN|UHID|Reg(?:istration)?\.?\s*No)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-/]*)/i)?.[1] || '';
    if (!mrn) mrn = (texts[at + 1] || '').match(/^([A-Z0-9][A-Z0-9\-/]*)$/i)?.[1] || '';
  }

  const { age, gender } = getPatientFacts(doc);
  return { name: name.slice(0, 80), mrn, age: age || '', gender: gender || '' };
}

function readPatientFromHtml(html) {
  // Used only when no editor document is at hand (first-run migration): a quick text-only parse
  // DOMParser only reads the HTML, it never runs anything inside it
  const box = new DOMParser().parseFromString(html, 'text/html').body;
  const blocks = [...box.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th')]
    .filter((el) => !el.querySelector('p, h1, h2, h3, h4, h5, h6'))
    .map((el) => el.textContent);
  // Wrap the text blocks so readPatient can use the same code
  const fake = {
    descendants(fn) {
      blocks.forEach((t, i) => fn({ isTextblock: true, textContent: t }, i));
    },
  };
  return readPatient(fake);
}
