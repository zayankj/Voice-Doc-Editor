import { readPatient } from './summaries';

// Documents created from department templates, saved in THIS browser (kept apart from discharge summaries).
//   template-docs-v1            -> the list: [{ id, templateId, deptId, patientName, createdAt, updatedAt }]
//   template-doc-html:<id>      -> the document itself (HTML)
// Every "Open" creates a NEW document from a fresh copy of the template.

const LIST_KEY = 'template-docs-v1';
const htmlKey = (id) => `template-doc-html:${id}`;
const FULL = 'Browser storage is full. Delete old documents or remove large images.';

function readList() {
  try {
    return JSON.parse(localStorage.getItem(LIST_KEY) || '[]');
  } catch {
    return [];
  }
}
function saveList(list) {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(list));
  } catch {
    throw new Error(FULL);
  }
  return list;
}

export const listTemplateDocs = readList;
export const getTemplateDocMeta = (id) => readList().find((d) => d.id === id) || null;

export function getTemplateDocHtml(id) {
  try { return localStorage.getItem(htmlKey(id)); } catch { return null; }
}

// "{{patient_name}}" is a placeholder, not a name
const real = (v) => (v && !v.includes('{{') ? v : '');

// Returns { doc, list }
export function createTemplateDoc(tpl, deptId, html) {
  const now = new Date().toISOString();
  const doc = {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    templateId: tpl.id,
    deptId,
    patientName: '',
    createdAt: now,
    updatedAt: now,
  };
  try {
    localStorage.setItem(htmlKey(doc.id), html);
  } catch {
    throw new Error(FULL);
  }
  return { doc, list: saveList([doc, ...readList()]) };
}

// Saves the document and refreshes the patient name shown in the list
export function saveTemplateDocHtml(id, html, pmDoc) {
  try {
    localStorage.setItem(htmlKey(id), html);
  } catch {
    throw new Error(FULL);
  }
  const patientName = real(readPatient(pmDoc).name);
  return saveList(readList().map((d) => (d.id === id ? { ...d, patientName, updatedAt: new Date().toISOString() } : d)));
}

export function deleteTemplateDoc(id) {
  try { localStorage.removeItem(htmlKey(id)); } catch { /* ignore */ }
  return saveList(readList().filter((d) => d.id !== id));
}
