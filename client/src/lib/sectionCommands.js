import { getBlocks } from './outline.js';
import { getSections, findSectionsInCommand, nameWords } from './sections.js';
import { flashKey } from './flash.js';
import { entriesOfBlock, planEntryRemoval } from './medicineText.js';

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

// Is this a "clear a section" command? Returns null (no), { ambiguous, candidates } (ask), or { section }.
export function findClearSectionCommand(doc, command) {
  const c = String(command || '');
  const removeAll = REMOVE_WORDS.test(c) && (ALL_WORDS.test(c) || BARE_ALL.test(c) || ALL_OF.test(c));
  if (!CLEAR_WORDS.test(c) && !removeAll) return null;
  if (OTHER_JOB.test(c.replace(/\b(make|leave|keep)\b.*$/i, ''))) return null;
  const found = findSectionsInCommand(getSections(doc), c);
  if (found.best) {
    // "remove all of the old notes from ..." is not a clear: "all of" must be followed by the section's name
    if (!CLEAR_WORDS.test(c) && !ALL_WORDS.test(c) && !BARE_ALL.test(c) && !allOfSection(c, found.best)) return null;
    return { section: found.best };
  }
  if (found.ambiguous || found.candidates.length > 1) return { ambiguous: true, candidates: found.candidates };
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
