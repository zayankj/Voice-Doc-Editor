// Regression tests for uploaded files (Phase 2): DOCX tables keep their rows, and the browser accepts exactly the
// file types the gateway accepts. Dummy data only.
// Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, Packer, Paragraph, Table, TableRow, TableCell } from 'docx';
import { htmlToText, docxToText } from '../src/lib/docxImport.js';
import { checkFile, FILE_ACCEPT } from '../src/lib/fileExtract.js';

// ---------- DOCX ----------
// the dummy lab report of the audit: the SGPT result is EMPTY
async function labDocx() {
  const row = (a, b) => new TableRow({ children: [a, b].map((x) => new TableCell({ children: [new Paragraph(x)] })) });
  const doc = new Document({ sections: [{ children: [new Paragraph('LAB REPORT (dummy)'), new Table({
    rows: [row('test', 'value'), row('platelet count', '2,10,000 /cumm'), row('s. creatinine', '2.4 mg/dl'), row('sgpt', ''), row('sgot', '39 u/l')],
  })] }] });
  const buf = await Packer.toBuffer(doc);
  return { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
}

test('DOCX (audit): every table row stays ONE line, so a value is never paired by position', async () => {
  const text = await docxToText(await labDocx());
  assert.equal(text, [
    'LAB REPORT (dummy)', '', 'test | value', 'platelet count | 2,10,000 /cumm', 's. creatinine | 2.4 mg/dl', 'sgpt |', 'sgot | 39 u/l',
  ].join('\n'));
  // before the fix the AI received "...sgpt\n\n\n\nsgot\n\n39 u/l": 39 could be read as the SGPT value
  assert.doesNotMatch(text, /sgpt\s*\n+\s*sgot/);
});

test('htmlToText: cells with several paragraphs, lists, headings, entities', () => {
  const html = '<h1>Report</h1><p>Seen by Dr. A &amp; Dr. B</p><table><tr><th>Test</th><th>Result</th></tr>' +
    '<tr><td><p>PT</p></td><td><p>17.9 seconds</p><p>(control 14)</p></td></tr></table><ul><li>Tab. DOLO</li><li>Syp. ONDEM</li></ul>';
  assert.equal(htmlToText(html), 'Report\nSeen by Dr. A & Dr. B\n\nTest | Result\nPT | 17.9 seconds / (control 14)\n\n- Tab. DOLO\n- Syp. ONDEM');
});

// ---------- file types ----------
test('the file types the gateway accepts are accepted (images and PDFs keep their type)', () => {
  assert.deepEqual(checkFile({ name: 'lab.png', type: 'image/png', size: 1000 }), { kind: 'file', mimeType: 'image/png' });
  assert.deepEqual(checkFile({ name: 'scan.JPG', type: 'image/jpeg', size: 1000 }), { kind: 'file', mimeType: 'image/jpeg' });
  assert.deepEqual(checkFile({ name: 'note.webp', type: 'image/webp', size: 1000 }), { kind: 'file', mimeType: 'image/webp' });
  assert.deepEqual(checkFile({ name: 'report.pdf', type: 'application/pdf', size: 1000 }), { kind: 'file', mimeType: 'application/pdf' });
  assert.deepEqual(checkFile({ name: 'summary.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 1000 }), { kind: 'docx' });
  for (const name of ['note.txt', 'labs.csv', 'notes.md']) assert.equal(checkFile({ name, type: '', size: 10 }).kind, 'text', name);
});

test('HEIC photos without a type (Windows) are recognised from the name', () => {
  assert.deepEqual(checkFile({ name: 'IMG_0012.HEIC', type: '', size: 1000 }), { kind: 'file', mimeType: 'image/heic' });
  assert.deepEqual(checkFile({ name: 'photo.heif', type: 'application/octet-stream', size: 1000 }), { kind: 'file', mimeType: 'image/heif' });
});

test('types the gateway would refuse are refused at once with a clear message (GIF, BMP, TIFF, SVG, .doc, zip)', () => {
  for (const [name, type] of [['a.gif', 'image/gif'], ['a.bmp', 'image/bmp'], ['a.tiff', 'image/tiff'], ['a.svg', 'image/svg+xml'], ['a.zip', 'application/zip']]) {
    assert.match(checkFile({ name, type, size: 1000 }).error, /cannot be used .*PNG, JPEG, WEBP, HEIC.*PDF.*\.docx/, name);
  }
  assert.match(checkFile({ name: 'old.doc', type: 'application/msword', size: 1000 }).error, /Save it as \.docx/);
});

test('files over 15 MB are refused before sending; the file picker lists only usable types', () => {
  assert.match(checkFile({ name: 'big.pdf', type: 'application/pdf', size: 16 * 1024 * 1024 }).error, /too large \(max 15 MB\)/);
  assert.doesNotMatch(FILE_ACCEPT, /image\/\*/);
  for (const t of ['image/png', 'image/jpeg', 'image/webp', '.heic', '.pdf', '.docx', '.txt', '.csv']) assert.ok(FILE_ACCEPT.includes(t), t);
});
