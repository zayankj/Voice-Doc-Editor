import { docxToText } from './docxImport.js';

const MAX_MB = 15;

// ---------- which files can be uploaded ----------
// Images and PDFs are sent as they are; the gateway accepts ONLY these types (gateway/index.js FILE_TYPES).
// Word and text files are turned into text in the browser first.
const SENT_AS_FILE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);
// type from the name, when the browser gives none (HEIC photos on Windows often have no type)
const TYPE_BY_EXT = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
export const ALLOWED_FILES = 'a photo or scan (PNG, JPEG, WEBP, HEIC), a PDF, a Word file (.docx) or a text file (.txt, .csv, .md)';
// for the file picker
export const FILE_ACCEPT = 'image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif,.pdf,.docx,.txt,.csv,.md';

// What is this file? { kind: 'docx' | 'text' | 'file', mimeType } or { error: 'message for the user' }.
// Checked as soon as a file is attached (picker and drag-and-drop), so a wrong file is never sent.
export function checkFile({ name = '', type = '', size = 0 }) {
  const n = String(name).toLowerCase();
  const ext = n.includes('.') ? n.split('.').pop() : '';
  if (size > MAX_MB * 1024 * 1024) return { error: `The file is too large (max ${MAX_MB} MB).` };
  if (ext === 'docx') return { kind: 'docx' };
  if (ext === 'doc') return { error: 'Old Word files (.doc) cannot be read. Save it as .docx and attach it again.' };
  if (String(type).startsWith('text/') || ['txt', 'csv', 'md'].includes(ext)) return { kind: 'text' };
  const mimeType = SENT_AS_FILE.has(type) ? type : !type || type === 'application/octet-stream' ? TYPE_BY_EXT[ext] : '';
  if (mimeType) return { kind: 'file', mimeType };
  return { error: `This file type cannot be used (${ext ? `.${ext}` : type || 'unknown type'}). Use ${ALLOWED_FILES}.` };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

// Images and PDFs go to the server as-is. Word and text files are turned into text first.
async function toPayload(file) {
  const c = checkFile(file);
  if (c.error) throw new Error(c.error);
  if (c.kind === 'docx') return { text: await docxToText(file) };
  if (c.kind === 'text') return { text: await file.text() };
  return { base64: await fileToBase64(file), mimeType: c.mimeType };
}

// file, instruction and audio are all optional, but at least one is needed.
// audio = { base64, mimeType } (a recorded voice command). Returns { edits, summary, heard }.
// templateId: only for department templates (e.g. "nursing-assessment"). Summaries send none,
// so the server uses exactly the same discharge summary prompt as before.
// cursorBlock / recent: COMMANDS only (never sent with a file): the block the cursor is in ("B12") and up to 3
// commands applied earlier in the same document. Returns also understood and language for commands.
export async function extractEdits({ file, instruction = '', audio = null, outline, today, templateId = '', cursorBlock = '', recent = [] }) {
  const payload = file ? await toPayload(file) : {};

  const body = { outline, today, instruction: instruction.trim(), fileName: file?.name, ...payload };
  if (templateId) body.templateId = templateId;
  if (!file) {
    if (cursorBlock) body.cursorBlock = cursorBlock;
    if (recent.length) body.recent = recent.slice(-3);
  }
  if (audio) {
    body.audioBase64 = audio.base64;
    body.audioMimeType = audio.mimeType;
  }

  const res = await fetch('/api/extract-edits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not apply the edit');
  return data;
}