import mammoth from 'mammoth/mammoth.browser.js';

// .docx file -> HTML (headings, paragraphs, bold/italic, lists, tables are kept)
export async function docxToHtml(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer });
  return result.value;
}
