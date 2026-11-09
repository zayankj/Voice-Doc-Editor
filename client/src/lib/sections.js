import { getBlocks } from './outline.js';
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

// [{ headingIndex, title, body: [block indexes] }]. The first entry may have headingIndex -1 (the header part).
export function getSections(doc) {
  const blocks = getBlocks(doc);
  const sections = [];
  let cur = { headingIndex: -1, title: '', body: [] };
  blocks.forEach((b, i) => {
    if (isSectionTitle(doc, b)) {
      if (cur.headingIndex !== -1 || cur.body.length) sections.push(cur);
      cur = { headingIndex: i, title: b.node.textContent.trim(), body: [] };
    } else {
      cur.body.push(i);
    }
  });
  if (cur.headingIndex !== -1 || cur.body.length) sections.push(cur);
  return sections;
}

// The section a block belongs to (by block index), or null
export function sectionOf(sections, blockIndex) {
  return sections.find((s) => s.headingIndex === blockIndex || s.body.includes(blockIndex)) || null;
}

// ---------- loose name matching ----------
const FILLER = new Set(['the', 'in', 'of', 'a', 'an', 'and', 'on', 'at', 'to', 'for', 'section', 'part', 'heading', 'inside', 'under', 'into', 'within']);
const PLACE_WORDS = new Set(['in', 'inside', 'into', 'to', 'under', 'within']); // "in the X", "inside X", "add to X"
const SKIP_BEFORE = new Set(['the', 'a', 'an', 'section', 'part']);

const stem = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const rawWords = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

// "COURSE IN THE HOSPITAL :" -> ["course", "hospital"] ; "complaints" -> "complaint"
export function nameWords(text) {
  return rawWords(text).filter((w) => !FILLER.has(w)).map(stem);
}

// How well does a section title appear in the command?
//   0 = not all words present; 1 = all words present but scattered; 2 = present as a phrase (in order)
//   place = true when the phrase comes right after "in / inside / into / to / under" ("inside the presenting complaints")
function scoreTitle(title, raw) {
  const words = nameWords(title);
  if (!words.length) return { score: 0, place: false };
  // command words without filler, remembering where each came from in the raw command
  const kept = [];
  raw.forEach((w, i) => { if (!FILLER.has(w)) kept.push({ w: stem(w), i }); });
  const have = new Set(kept.map((k) => k.w));
  if (!words.every((w) => have.has(w))) return { score: 0, place: false };

  for (let s = 0; s + words.length <= kept.length; s++) {
    if (words.every((w, k) => kept[s + k].w === w)) {
      let j = kept[s].i - 1; // look at the raw word just before the phrase, skipping "the", "a" ...
      while (j >= 0 && SKIP_BEFORE.has(raw[j])) j--;
      return { score: 2, place: j >= 0 && PLACE_WORDS.has(raw[j]) };
    }
  }
  return { score: 1, place: false };
}

// Which section does this command talk about?
// Returns { matches, best, ambiguous, candidates }
//   matches    every section whose title words all appear in the command (strongest first)
//   best       the one section to use, or null
//   ambiguous  true when it cannot be decided -> the app must ASK, never guess
//   candidates sections sharing some words with the command, for the question ("Did you mean ...?")
//              (filled when nothing matched completely, or when it is ambiguous)
export function findSectionsInCommand(sections, command) {
  const raw = rawWords(command);
  const said = new Set(nameWords(command));
  const named = sections.filter((s) => s.headingIndex !== -1 && nameWords(s.title).length);

  let matches = named
    .map((s) => ({ s, ...scoreTitle(s.title, raw), len: nameWords(s.title).length }))
    .filter((m) => m.score > 0);

  // a title fully contained in a longer matching title loses ("diagnosis" inside "final diagnosis")
  matches = matches.filter((m) => {
    const w = nameWords(m.s.title);
    return !matches.some((o) => o !== m && o.len > m.len && w.every((x) => nameWords(o.s.title).includes(x)));
  });
  matches.sort((a, b) => b.score - a.score || Number(b.place) - Number(a.place) || b.len - a.len);

  let best = null;
  let ambiguous = false;
  if (matches.length) {
    const top = matches.filter((m) => m.score === matches[0].score);
    const placed = top.filter((m) => m.place);
    const pick = top.length === 1 ? top : placed.length === 1 ? placed : null;
    if (pick) best = pick[0].s;
    else ambiguous = true;
    // the same title written twice in the document -> cannot tell which one
    if (best) {
      const key = nameWords(best.title).sort().join(' ');
      if (named.filter((s) => nameWords(s.title).sort().join(' ') === key).length > 1) {
        best = null;
        ambiguous = true;
      }
    }
  }

  const candidates =
    !best
      ? (ambiguous ? matches.map((m) => m.s) : named.filter((s) => nameWords(s.title).some((w) => said.has(w))))
      : [];

  return { matches: matches.map((m) => m.s), best, ambiguous, candidates };
}
