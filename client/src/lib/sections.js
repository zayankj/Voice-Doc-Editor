import { isLabelText } from './guards.js';

// Sections of a document: a heading ("COURSE IN HOSPITAL") and the blocks under it, up to the next heading.
// Blocks before the first heading (title, header table) belong to a "header" section with no heading.
// Also matches section names loosely, the way people say them:
//   "course in the hospital" = "hospital course" = "COURSE IN HOSPITAL :"
//   "presenting complaints"  = "PRESENTING COMPLAINT"

// Is the block anywhere inside a table or a list? (checks EVERY container around it, so a list
// inside a table cell, or a merged cell, is still recognised)
function insideTableOrList(doc, b) {
  const $pos = doc.resolve(b.pos);
  for (let d = $pos.depth; d > 0; d--) {
    const name = $pos.node(d).type.name;
    if (name === 'tableCell' || name === 'tableHeader' || name === 'listItem') return true;
  }
  return false;
}

// Every text piece of the block is bold (section titles in Word files are bold paragraphs)
function allBold(node) {
  let any = false;
  let all = true;
  node.forEach((c) => {
    if (!c.isText || !c.text.trim()) return;
    any = true;
    if (!c.marks.some((m) => m.type.name === 'bold')) all = false;
  });
  return any && all;
}

// Does this block start a new section?
//   - never inside a table or a list
//   - a real heading, or a known label line ("DIAGNOSIS", "Advice :")
//   - or a short bold ALL-CAPS line ("SIGMOIDOSCOPY"): at most 6 words, no digits, no full stop at the end
export function isSectionTitle(doc, b) {
  if (insideTableOrList(doc, b)) return false;
  const t = b.node.textContent.trim();
  if (!t) return false;
  if (b.node.type.name === 'heading') return true;
  if (isLabelText(t)) return true;
  return (
    t.length <= 40 &&
    t.split(/\s+/).length <= 6 &&
    /^[A-Z][A-Z &/()',-]*:?$/.test(t) && // capitals only: no digits, no full stop
    allBold(b.node)
  );
}

// R6: the section-name matching for commands (getSections, findSectionsInCommand ...) was removed with the
// code-run commands; Gemini decides which section an instruction means.
