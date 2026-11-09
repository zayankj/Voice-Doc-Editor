import mammoth from 'mammoth/mammoth.browser.js';

// .docx file -> HTML (headings, paragraphs, bold/italic, lists, tables are kept)
export async function docxToHtml(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer });
  return result.value;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (t) =>
  t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

// The text of one table cell: its paragraphs joined with " / " (a cell never becomes several lines)
const cellText = (inner) =>
  inner
    .replace(/<br\s*\/?>|<\/(?:p|h[1-6]|li)>/gi, ' / ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:\s*\/\s*)+|(?:\s*\/\s*)+$/g, '')
    .trim();

// HTML from mammoth -> plain text that keeps the STRUCTURE the AI needs:
//   each table row is ONE line with its cells side by side ("platelet count | 2,10,000 /cumm"),
//   an empty cell stays visible ("sgpt | "), list items start with "- ", paragraphs are lines.
// So a value is never paired with a test name just because of its position in a list of lines.
export function htmlToText(html) {
  const text = String(html || '')
    .replace(/<table\b[^>]*>/gi, '\n')
    .replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row) => {
      const cells = [...row.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => cellText(c[2]));
      return `${cells.join(' | ')}\n`;
    })
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|h[1-6]|li|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decode(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// .docx file -> text (used when a .docx is uploaded as source material). Tables keep their rows.
export async function docxToText(file) {
  return htmlToText(await docxToHtml(file));
}
