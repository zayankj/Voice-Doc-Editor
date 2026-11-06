import { docxToText } from './docxImport';

const MAX_MB = 15;

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
  const name = file.name.toLowerCase();
  if (name.endsWith('.docx')) return { text: await docxToText(file) };
  if (file.type.startsWith('text/') || /\.(txt|csv|md)$/.test(name)) return { text: await file.text() };

  const mimeType = file.type || (name.endsWith('.pdf') ? 'application/pdf' : '');
  if (mimeType === 'application/pdf' || mimeType.startsWith('image/')) {
    return { base64: await fileToBase64(file), mimeType };
  }
  throw new Error('Unsupported file. Use an image, PDF, .docx or .txt file.');
}

// file, instruction and audio are all optional, but at least one is needed.
// audio = { base64, mimeType } (a recorded voice command). Returns { edits, summary, heard }.
export async function extractEdits({ file, instruction = '', audio = null, outline, today }) {
  if (file && file.size > MAX_MB * 1024 * 1024) throw new Error(`File is too large (max ${MAX_MB} MB)`);
  const payload = file ? await toPayload(file) : {};

  const body = { outline, today, instruction: instruction.trim(), fileName: file?.name, ...payload };
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