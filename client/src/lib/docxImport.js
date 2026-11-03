import mammoth from 'mammoth/mammoth.browser.js';

// .docx file -> HTML (headings, paragraphs, bold/italic, lists, tables are kept)
export async function docxToHtml(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer });
  return result.value;
}

// .docx file -> plain text (used when a .docx is uploaded as source material)
export async function docxToText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}