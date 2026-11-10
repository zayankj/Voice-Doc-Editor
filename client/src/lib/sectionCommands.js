import { getBlocks } from './outline.js';
import { getSections, findSectionsInCommand, nameWords, isSectionTitle } from './sections.js';
import { flashKey } from './flash.js';
import { entriesOfBlock, planEntryRemoval, MEDICINE_TITLE } from './medicineText.js';
import { isLabelText } from './guards.js';

// Commands that are carried out by CODE (not by the AI), so they always do exactly what was said.
//
// "Clear a section":  "remove everything from the course in hospital", "delete all the content in advice",
//                     "make the presenting complaint blank", "clear the diagnosis"
//   -> everything under that heading (up to the next heading) is removed; the heading stays.
//   One step: one Undo brings it all back.

// "clear / erase / wipe" or "blank / empty" always mean the whole section
const CLEAR_WORDS = /\b(clear|erase|wipe|blank|empty)\b/i;
// "remove / delete" only with "everything / all the content / the whole section / completely".
// ("remove the line about malaria" is NOT a clear: that part is left to the AI)
const REMOVE_WORDS = /\b(remove|delete)\b/i;
const ALL_WORDS = /\b(everything|all(?: of)?(?: the)? (?:content|contents|text|data|details|lines|information|matter)|(?:whole|entire) (?:section|content|contents|text|thing)|completely)\b/i;
// a plain "all" right before the place: "remove all from Advice", "delete all in the advice section"
// ("remove all syrups from Advice" is NOT this: a word stands between "all" and "from")
export const BARE_ALL = /\ball\s+(?:from|in|inside|within)\b/i;
// "remove all of Advice": only when the words after "all of" ARE the section's name
const ALL_OF = /\ball\s+of\s+(?:the\s+)?([a-z][\w\s]*)/i;
const allOfSection = (c, section) => {
  const m = c.match(ALL_OF);
  const said = m ? nameWords(m[1]) : [];
  const name = nameWords(section.title);
  return name.length > 0 && name.every((w, i) => said[i] === w);
};
// a second job in the same command ("remove everything and write ...") -> leave it to the AI
const OTHER_JOB = /\b(add|write|put|insert|type|replace|change|update|set|with)\b/i;

const nice = (t) => t.replace(/\s*:\s*$/, '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// Does the command ask to clear / empty something? ("clear advice", "empty the advice section",
// "remove everything from advice") - a second job ("... and write ...") is not a clear
export function isClearIntent(command) {
  const c = String(command || '');
  const removeAll = REMOVE_WORDS.test(c) && (ALL_WORDS.test(c) || BARE_ALL.test(c) || ALL_OF.test(c));
  if (!CLEAR_WORDS.test(c) && !removeAll) return false;
  return !OTHER_JOB.test(c.replace(/\b(make|leave|keep)\b.*$/i, ''));
}

// ---------- a medicine-section heading that SHARES its paragraph with the medicines ----------
//   "ADVICE↵Tab. DOLO ...↵Syp. ..."   (heading, line break, medicines - all one paragraph)
//   "Advice : Tab. DOLO ...↵Syp. ..." (label at the start of the first line)
// Such a heading is not a paragraph of its own, so it is not found as a section. Only MEDICINE section names
// (Advice, Medications, Treatment ...) are looked for this way.
// The first entry of that paragraph is the heading (entriesOfBlock makes it a separate entry).
// Returns a section { title, headingIndex, body, inline: true, headEnd, nextPos } or null.
function inlineHeadingSection(doc, blocks, i) {
  const b = blocks[i];
  if (b.node.type.name !== 'paragraph' || doc.resolve(b.pos).depth !== 0) return null;
  const entries = entriesOfBlock(b, i);
  if (entries.length < 2) return null;
  const head = entries[0].text.trim();
  if (head.length > 40 || !MEDICINE_TITLE.test(head)) return null;
  if (!isLabelText(head) && !/^[A-Z][A-Z &/()',-]*:?$/.test(head)) return null;
  // the body: the rest of this paragraph, and the blocks after it up to the next section heading
  const body = [i];
  let nextPos = doc.content.size;
  for (let j = i + 1; j < blocks.length; j++) {
    if (isSectionTitle(doc, blocks[j]) && doc.resolve(blocks[j].pos).depth === 0) { nextPos = blocks[j].pos; break; }
    body.push(j);
  }
  const e0 = entries[0];
  return { title: head, headingIndex: i, body, inline: true, headEnd: e0.map[e0.map.length - 1] + 1, nextPos };
}

// The medicine section with its heading inside a paragraph that the command means.
//   named: the command names it ("clear advice"); medicine: also accept it when no section is named
// Returns { section } | { ambiguous: true, candidates } | null
export function findInlineSection(doc, command, { medicine = false } = {}) {
  const blocks = getBlocks(doc);
  const all = blocks.map((_, i) => inlineHeadingSection(doc, blocks, i)).filter(Boolean);
  if (!all.length) return null;
  const named = findSectionsInCommand(all, command);
  if (named.best) return { section: named.best };
  if (named.ambiguous) return { ambiguous: true, candidates: named.candidates };
  if (medicine && all.length === 1 && !findSectionsInCommand(getSections(doc), command).best) return { section: all[0] };
  if (medicine && all.length > 1) return { ambiguous: true, candidates: all };
  return null;
}

// Is this a "clear a section" command? Returns null (no), { ambiguous, candidates } (ask), or { section }.
export function findClearSectionCommand(doc, command) {
  const c = String(command || '');
  if (!isClearIntent(c)) return null;
  const found = findSectionsInCommand(getSections(doc), c);
  if (found.best) {
    // "remove all of the old notes from ..." is not a clear: "all of" must be followed by the section's name
    if (!CLEAR_WORDS.test(c) && !ALL_WORDS.test(c) && !BARE_ALL.test(c) && !allOfSection(c, found.best)) return null;
    return { section: found.best };
  }
  if (found.ambiguous || found.candidates.length > 1) return { ambiguous: true, candidates: found.candidates };
  // the Advice heading may share its paragraph with the medicines ("ADVICE↵Tab. ...", "Advice : Tab. ...")
  const inline = findInlineSection(doc, c);
  if (inline) return inline;
  return null; // no section named: not this kind of command
}

// What clearing this section would remove (READ ONLY, changes nothing), for the confirmation window.
// Returns { title, lines: [{ text, medicine }], medicines }  (lines split at line breaks, like the medicine window)
export function clearPreview(doc, section) {
  const blocks = getBlocks(doc);
  const meds = new Set(planEntryRemoval(doc, section).unchanged.map((e) => `${e.block}-${e.entry}`));
  const lines = section.body
    .filter((i) => blocks[i])
    .flatMap((i) => entriesOfBlock(blocks[i], i))
    // a heading inside the paragraph ("ADVICE↵...", "Advice : ...") is not removed, so it is not listed
    .filter((e) => !(section.inline && e.block === section.headingIndex && e.entry === 0))
    .map((e) => ({ text: e.text.trim(), medicine: meds.has(`${e.block}-${e.entry}`) }))
    .filter((l) => l.text);
  return { title: nice(section.title), lines, medicines: lines.filter((l) => l.medicine).length };
}

// Empties one section. Returns { ok, title, before } or { ok: false, error }.
export function clearSection(editor, section) {
  const doc = editor.state.doc;
  const blocks = getBlocks(doc);
  const heading = blocks[section.headingIndex];
  if (!heading) return { ok: false, error: 'Section not found' };
  if (section.inline) return clearInline(editor, section, heading);
  // the first heading is the document title ("DISCHARGE SUMMARY"): under it are the patient details table
  // and everything else -> never wipe that by voice
  const first = getSections(doc).find((s) => s.headingIndex !== -1);
  if (first && first.headingIndex === section.headingIndex) {
    return { ok: false, error: `"${nice(section.title)}" is the title of the whole document, so it cannot be cleared by voice` };
  }
  if (doc.resolve(heading.pos).depth !== 0) return { ok: false, error: 'This heading is inside another element' };

  // from just after the heading, up to the next section heading (or the end of the document)
  const from = heading.pos + heading.node.nodeSize;
  const sections = getSections(doc);
  const next = sections.find((s) => s.headingIndex > section.headingIndex && s.headingIndex !== -1);
  let to = doc.content.size;
  if (next) {
    const nb = blocks[next.headingIndex];
    if (doc.resolve(nb.pos).depth !== 0) return { ok: false, error: 'The next heading is inside another element' };
    to = nb.pos;
  }
  const before = section.body.map((i) => blocks[i].node.textContent).filter((t) => t.trim()).join(' / ');
  if (from >= to || !before) return { ok: true, title: nice(section.title), before: '', alreadyEmpty: true };

  // replace everything under the heading with one empty line
  const tr = editor.state.tr.replaceWith(from, to, editor.state.schema.nodes.paragraph.create());
  tr.setMeta(flashKey, { add: { from: heading.pos, to: heading.pos + heading.node.nodeSize } }); // show which section
  editor.view.dispatch(tr);
  // the yellow fades after 5 seconds, like every other change
  setTimeout(() => {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(flashKey, null).setMeta('addToHistory', false));
  }, 5000);
  return { ok: true, title: nice(section.title), before, pos: heading.pos };
}

// The heading shares its paragraph with the content ("ADVICE↵Tab. ...", "Advice : Tab. ..."): everything AFTER
// the heading text (rest of the paragraph + the blocks up to the next section) is removed; the heading text stays
// exactly as it is. One transaction (one Undo).
function clearInline(editor, section, block) {
  const doc = editor.state.doc;
  const paraEnd = block.pos + block.node.nodeSize; // just after the paragraph
  const contentEnd = paraEnd - 1;
  // the document must still be as when the command was understood
  const now = findInlineSection(doc, section.title);
  if (!now?.section || now.section.headingIndex !== section.headingIndex || now.section.headEnd !== section.headEnd) {
    return { ok: false, error: 'The document changed. Please give the command again' };
  }
  const before = clearPreview(doc, section).lines.map((l) => l.text).join(' / ');
  if (!before) return { ok: true, title: nice(section.title), before: '', alreadyEmpty: true };
  let tr = editor.state.tr;
  if (section.nextPos > paraEnd) tr = tr.delete(paraEnd, section.nextPos); // the blocks after the paragraph (first: later positions)
  if (contentEnd > section.headEnd) tr = tr.delete(section.headEnd, contentEnd); // the rest of the paragraph
  tr.setMeta(flashKey, { add: { from: block.pos, to: block.pos + tr.doc.nodeAt(block.pos).nodeSize } });
  editor.view.dispatch(tr);
  setTimeout(() => {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(flashKey, null).setMeta('addToHistory', false));
  }, 5000);
  return { ok: true, title: nice(section.title), before, pos: block.pos };
}
