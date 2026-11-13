import { getBlocks } from './outline';
import { flashKey } from './flash';
import { getPatientFacts, syncPatientFacts, setHeaderGender } from './consistency';
import { lockReason, changesGender, isLockedLabel, isLabelText, labelPrefix } from './guards';
import { cellAt, isDataTable, hasTitleRow, rowNames, valueCellAfter, keepValueFormat } from './tables.js';

export { getPatientFacts };

const HIGHLIGHT_MS = 5000; // how long changed text stays highlighted (5 seconds)
let clearTimer;

// One shared timer: every new edit restarts it, so all highlights from one batch
// disappear together, 5 seconds after the LAST change.
function scheduleClear(editor) {
  if (editor.dryRun) return; // a preview copy (lib/previewEdits.js): never touch the real editor's timer
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(flashKey, null).setMeta('addToHistory', false));
  }, HIGHLIGHT_MS);
}

// ---------- sections: a heading ("COURSE IN HOSPITAL") and the text under it ----------
const inTable = (doc, b) => /^table(Cell|Header)$/.test(doc.resolve(b.pos).parent.type.name);

// Does this block start a new section? (a heading, a known label line, or a short ALL-CAPS title like "SIGMOIDOSCOPY")
function isSectionTitle(doc, b) {
  if (inTable(doc, b)) return false;
  if (b.node.type.name === 'heading') return true;
  const t = b.node.textContent.trim();
  if (!t) return false;
  if (isLabelText(t)) return true;
  return t.length <= 40 && /^[A-Z][A-Z &/().,'-]*:?$/.test(t);
}

// Where text "added to a section" should go: the last line of text under the heading
// (before the next section). Returns that block's index, or -1 when the section is still empty.
function sectionBodyEnd(doc, blocks, headingIdx) {
  let last = -1;
  for (let j = headingIdx + 1; j < blocks.length && !isSectionTitle(doc, blocks[j]); j++) {
    if (!inTable(doc, blocks[j])) last = j;
  }
  return last;
}

// ---------- medicine lists (Advice / Medications ...) ----------
// Medicines are often ONE paragraph with line breaks between them. The edit code below must never glue a new
// medicine onto the last line, merge two lines, or overwrite the whole list. Medicine lines are only recognised
// in a MEDICINE SECTION (by its heading) and only when the line STARTS with a medicine form, so ordinary text
// in other sections ("Treated with Tab. DOLO ...") is never treated as a medicine list.
const MEDICINE_TITLE = /\b(advice|medication|medications|medicine|medicines|treatment|drugs?|prescription|rx)\b/i;
const FORM_START = /^\s*(?:tab|tabs|tablet|tablets|cap|caps|capsule|capsules|syp|syr|syrup|syrups|susp|suspension|inj|injection|drop|drops|oint|ointment|cream|gel|lotion|sachet|powder|inhaler|neb|nebulisation|nebulization|spray|rotacap)(?:\.\s*|\s+)\S/i; // "Tab. X", "Tab X", "TAB.X"
// a medicine that starts in the middle of a line ("... 2 daysTab. METRONIDAZOLE ...")
const MID_MEDICINE = /(?:Tab|Tabs|Cap|Caps|Syp|Syr|Inj|Susp)\.\s+(?=[A-Za-z(])/gi;
const isMedicineLine = (t) => FORM_START.test(t);

// Is this block inside a medicine section? (the nearest section heading above it is Advice / Medications ...)
function inMedicineSection(doc, blocks, index) {
  // the paragraph itself STARTS with a medicine-section heading: "ADVICE↵Tab. DOLO ..." or "Advice : Tab. DOLO ..."
  // (the heading shares the paragraph with the medicines, so it is not a heading block of its own)
  const own = blocks[index]?.node;
  if (own) {
    let first = '';
    let broke = false;
    own.forEach((c) => { if (!broke) { if (c.isText) first += c.text; else broke = true; } });
    if (broke && isLabelText(first) && MEDICINE_TITLE.test(first)) return true;
    const prefix = labelPrefix(own.textContent);
    if (prefix && MEDICINE_TITLE.test(prefix)) return true;
  }
  for (let j = index - 1; j >= 0; j--) {
    if (isSectionTitle(doc, blocks[j])) return MEDICINE_TITLE.test(blocks[j].node.textContent);
  }
  return false;
}

// The lines of a paragraph (split at line breaks): [{ text, map }], map[i] = document position of character i
function linesOf(node, start) {
  const lines = [{ text: '', map: [] }];
  node.forEach((child, offset) => {
    if (child.isText) {
      const line = lines[lines.length - 1];
      for (let k = 0; k < child.text.length; k++) line.map.push(start + offset + k);
      line.text += child.text;
    } else {
      lines.push({ text: '', map: [] }); // a line break (or image): a new line starts
    }
  });
  return lines;
}

// How many medicines are in this block (whole lines + medicines glued into a line)
function medicineCount(lines) {
  let n = 0;
  for (const l of lines) {
    if (isMedicineLine(l.text)) n++;
    for (const m of l.text.matchAll(MID_MEDICINE)) if (m.index > 0) n++;
  }
  return n;
}

// Splits text into lines: at new lines, and where a medicine starts in the middle ("Tab. A 5 mg Tab. B 10 mg")
function proposedLines(value) {
  const out = [];
  for (const raw of String(value).split(/\r?\n/)) {
    const cuts = [0];
    for (const m of raw.matchAll(MID_MEDICINE)) if (m.index > 0) cuts.push(m.index);
    cuts.push(raw.length);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const t = raw.slice(cuts[i], cuts[i + 1]).trim();
      if (t) out.push(t);
    }
  }
  return out;
}

// Splits added text into medicine lines ("Tab. A 5 mg\nSyp. B 10 ml", or glued "Tab. A 5 mg Tab. B 10 mg")
// Returns [] when the added text is not a medicine.
function medicineLinesIn(value) {
  const out = proposedLines(value);
  return out.length && out.every(isMedicineLine) ? out : [];
}

// Adds medicines as NEW LINES: after a line break in the same paragraph when the list uses line breaks,
// otherwise as new paragraphs after the block. Returns the dispatched result.
// (same paragraph after a line break when the list uses line breaks; new paragraphs, or new list items in a list,
// otherwise - see addNewLines). afterLine: the index of the line they go after (default: at the end).
function addMedicineLines(editor, target, newLines, afterLine = null) {
  return addNewLines(editor, target, newLines, afterLine);
}

// A paragraph that is the ONLY content of a list item: { from, to } of that item, its list and the list's parent, or
// null. (Same as listItemOf in medicineText.js; kept here so this file needs no other module.)
function listItemOf(doc, paraPos) {
  const $p = doc.resolve(paraPos);
  if ($p.depth < 2 || $p.parent.type.name !== 'listItem' || $p.parent.childCount !== 1) return null;
  const from = $p.before($p.depth);
  return { from, to: from + $p.parent.nodeSize, listPos: $p.before($p.depth - 1), list: $p.node($p.depth - 1), listParent: $p.node($p.depth - 2) };
}

// The position where the list holding this block starts (its outermost list), or null
function listStartOf(doc, b) {
  const $p = doc.resolve(b.pos);
  for (let d = 1; d <= $p.depth; d++) {
    const n = $p.node(d);
    if (n.type.name === 'orderedList' || n.type.name === 'bulletList') return $p.before(d);
  }
  return null;
}

// NEW medicines go right after the LAST MEDICINE ENTRY of the section - the next item of a numbered list, never after
// a "Review after 1 week …" line, a general instruction or the heading. When the place the AI chose IS a medicine
// entry ("after HYDROXYZINE"), that place is kept.
// atStart (set by the check in verify.js from the PERSON'S words "at the top" / "as the first medicine", never by the
// AI): a medicine aimed at the heading (or another non-medicine line) goes BEFORE the FIRST medicine entry instead -
// the first item of a numbered list (the others renumber by themselves).
// beforeEntry (set by the check in verify.js from the PERSON'S words "before X", never by the AI): the exact text of
// the medicine entry X; the new medicine goes directly BEFORE it, whatever place the AI aimed at. X not found (the
// document changed): nothing is changed.
function placeNewMedicines(editor, blocks, index, medLines, afterLine = null, atStart = false, beforeEntry = null) {
  const doc = editor.state.doc;
  const target = blocks[index];
  if (typeof beforeEntry === 'string' && beforeEntry.trim()) {
    const want = squash(beforeEntry);
    const area = isHeadingBlock(doc, target) ? bodyUnder(doc, blocks, index) : sectionBlocks(doc, blocks, index);
    const spots = [];
    for (const b of area) {
      if (inTable(doc, b)) continue;
      linesOf(b.node, b.pos + 1).forEach((l, k) => { if (squash(l.text) === want) spots.push([b, k]); });
    }
    if (!spots.length) { // the entry may sit after a label on its line ("Advice : Tab. DOLO ...")
      for (const b of area) {
        if (inTable(doc, b)) continue;
        linesOf(b.node, b.pos + 1).forEach((l, k) => { if (squash(l.text).includes(want)) spots.push([b, k]); });
      }
    }
    if (spots.length !== 1) {
      return { ok: false, blocked: true, error: `the medicine "${beforeEntry.trim()}" to add before was ${spots.length ? 'found more than once' : 'not found'} in this section. Nothing was changed` };
    }
    return addLinesBefore(editor, spots[0][0], medLines, spots[0][1]);
  }
  const lines = linesOf(target.node, target.pos + 1);
  const spot = afterLine != null ? lines[afterLine]?.text : lines[lines.length - 1]?.text;
  if (!isHeadingBlock(doc, target) && isMedicineLine(spot || '')) return addMedicineLines(editor, target, medLines, afterLine);
  const section = isHeadingBlock(doc, target) ? bodyUnder(doc, blocks, index) : sectionBlocks(doc, blocks, index);
  if (atStart) {
    for (const b of section) {
      if (inTable(doc, b)) continue;
      const ls = linesOf(b.node, b.pos + 1);
      const k = ls.findIndex((l) => isMedicineLine(l.text));
      if (k !== -1) return addLinesBefore(editor, b, medLines, k);
    }
  }
  for (let i = section.length - 1; i >= 0; i--) {
    const b = section[i];
    if (inTable(doc, b)) continue;
    const ls = linesOf(b.node, b.pos + 1);
    let k = ls.length - 1;
    while (k >= 0 && !isMedicineLine(ls[k].text)) k--;
    if (k < 0) continue;
    // inside a list: after the LAST item of that list (the next number), whatever that item is
    const listAt = listStartOf(doc, b);
    if (listAt != null) {
      const items = section.filter((x) => listStartOf(doc, x) === listAt && inListItem(doc, x));
      const lastItem = items[items.length - 1];
      return addMedicineLines(editor, lastItem, medLines, null);
    }
    return addMedicineLines(editor, b, medLines, ls.length > 1 ? k : null);
  }
  return addMedicineLines(editor, target, medLines, afterLine); // no medicine in the section yet: where the AI said
}

const squash = (t) => String(t).replace(/\s+/g, ' ').trim().toLowerCase();
// "Tab. DOLO (Paracetamol) 650 mg" -> "tab dolo": the form and the name of a medicine
const medicineKey = (t) => squash(t).replace(/[.()]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
// "Tab. DOLO (Paracetamol) 650 mg" -> "dolo": the name only (the form may be written differently: Tab / Tablet)
// ("Ointment for Ringworm …" -> "ringworm": small linking words after the form are skipped)
const medicineName = (t) => squash(t).replace(/[.()]/g, ' ').split(/\s+/).filter(Boolean).slice(1)
  .find((w) => !/^(?:for|of|to|the|a|an|on|in)$/.test(w)) || '';
// ", Tab. DOLO …" -> "Tab. DOLO …": a separator the AI put in front of a new entry is not part of it
const stripLead = (v) => String(v).replace(/^[\s,;:—–-]+/u, '');

// ---------- new lines (a new entry is never glued onto an existing line) ----------
// Is this text block the paragraph of a list item?
const inListItem = (doc, b) => {
  const $p = doc.resolve(b.pos);
  return $p.depth > 0 && $p.parent.type.name === 'listItem';
};

// A section HEADING, strictly: a heading node, a known label line ("ADVICE", "Diagnosis :"), or a short ALL-CAPS line
// that is entirely bold - never inside a table or a list. (Plain capital-letter content such as "ENTERIC FEVER" is not
// a heading.) Same rule as isSectionTitle in sections.js.
function isHeadingBlock(doc, b) {
  if (!b) return false;
  const $p = doc.resolve(b.pos);
  for (let d = $p.depth; d > 0; d--) if (/^(tableCell|tableHeader|listItem)$/.test($p.node(d).type.name)) return false;
  const t = b.node.textContent.trim();
  if (!t) return false;
  if (b.node.type.name === 'heading' || isLabelText(t)) return true;
  let any = false;
  let allBold = true;
  b.node.forEach((c) => { if (c.isText && c.text.trim()) { any = true; if (!c.marks.some((m) => m.type.name === 'bold')) allBold = false; } });
  return any && allBold && t.length <= 40 && t.split(/\s+/).length <= 6 && /^[A-Z][A-Z &/()',-]*:?$/.test(t);
}

// The text blocks of the section this block is in (between the headings around it; the headings themselves excluded)
function sectionBlocks(doc, blocks, index) {
  let a = index;
  while (a > 0 && !isHeadingBlock(doc, blocks[a])) a--;
  let z = index + 1;
  while (z < blocks.length && !isHeadingBlock(doc, blocks[z])) z++;
  return blocks.slice(isHeadingBlock(doc, blocks[a]) ? a + 1 : a, z);
}

// The blocks under a heading (up to the next heading)
function bodyUnder(doc, blocks, headingIndex) {
  const out = [];
  for (let j = headingIndex + 1; j < blocks.length && !isHeadingBlock(doc, blocks[j]); j++) out.push(blocks[j]);
  return out;
}

// A NEW medicine whose name is already in the same section (e.g. Tab. DOLO added to an Advice that has Tab. DOLO).
// Returns that name, or ''. The AI sets duplicate_ok only when the command clearly asks for another entry.
function duplicateMedicine(doc, blocks, index, newLines) {
  const have = new Set();
  for (const b of sectionBlocks(doc, blocks, index)) {
    for (const l of linesOf(b.node, b.pos + 1)) if (isMedicineLine(l.text)) have.add(medicineName(l.text));
  }
  const dup = newLines.filter(isMedicineLine).map(medicineName).find((n) => n && have.has(n));
  return dup || '';
}

// The line of a paragraph (with line breaks) that find_text points at: the line equal to it, else the ONE line
// containing it. Returns its index, -1 (not found) or -2 (more than one line contains it).
function lineIndexOf(lines, find) {
  const f = squash(find);
  if (!f) return -1;
  const equal = lines.findIndex((l) => squash(l.text) === f);
  if (equal !== -1) return equal;
  const hits = lines.map((l, i) => (squash(l.text).includes(f) ? i : -1)).filter((i) => i !== -1);
  return hits.length === 1 ? hits[0] : hits.length ? -2 : -1;
}

// Adds lines as NEW lines next to target, in the layout of the place:
//   - a paragraph with line breaks: line break + line, after line `afterLine` (default: the last line)
//   - a list item: new list items after it
//   - otherwise: new paragraphs after the block
// Nothing that exists is changed. Returns the result for applyVoiceEdit.
// Where each line of a paragraph ENDS (the position just before the next line break, or the paragraph's end)
function lineEnds(node, pos) {
  const ends = [];
  node.forEach((child, offset) => { if (child.type.name === 'hardBreak') ends.push(pos + 1 + offset); });
  ends.push(pos + node.nodeSize - 1);
  return ends;
}

function addNewLines(editor, target, newLines, afterLine = null) {
  const { pos, node } = target;
  const schema = editor.schema;
  const doc = editor.state.doc;
  const ends = lineEnds(node, pos);
  let tr = editor.state.tr;
  if (ends.length > 1) {
    const insertAt = ends[afterLine ?? ends.length - 1];
    tr = tr.insert(insertAt, newLines.flatMap((l) => [schema.nodes.hardBreak.create(), schema.text(l)]));
    tr.setMeta(flashKey, { add: { from: pos, to: pos + tr.doc.nodeAt(pos).nodeSize } });
  } else if (inListItem(doc, target)) {
    const $p = doc.resolve(pos);
    const at = $p.after($p.depth); // after the list item
    const items = newLines.map((l) => schema.nodes.listItem.create(null, schema.nodes.paragraph.create(null, schema.text(l))));
    tr = tr.insert(at, items);
    tr.setMeta(flashKey, { add: { from: at, to: at + items.reduce((n, x) => n + x.nodeSize, 0) } });
  } else {
    const at = pos + node.nodeSize;
    const paragraphs = newLines.map((l) => schema.nodes.paragraph.create(null, schema.text(l)));
    tr = tr.insert(at, paragraphs);
    tr.setMeta(flashKey, { add: { from: at, to: at + paragraphs.reduce((n, x) => n + x.nodeSize, 0) } });
  }
  editor.view.dispatch(tr);
  scheduleClear(editor);
  // before = '' : nothing existing changes, lines are only ADDED
  return { ok: true, before: '', after: newLines.join('\n'), pos };
}

// The same, but BEFORE line `beforeLine` of target (a medicine added "at the top"), in the layout of the place:
//   - a paragraph with line breaks: line + line break, before that line
//   - a list item: new list items before it (the numbers follow by themselves)
//   - otherwise: new paragraphs before the block
function addLinesBefore(editor, target, newLines, beforeLine = 0) {
  const { pos, node } = target;
  const schema = editor.schema;
  const doc = editor.state.doc;
  const lines = linesOf(node, pos + 1);
  let tr = editor.state.tr;
  if (lines.length > 1) {
    const at = lines[beforeLine].map[0];
    tr = tr.insert(at, newLines.flatMap((l) => [schema.text(l), schema.nodes.hardBreak.create()]));
    tr.setMeta(flashKey, { add: { from: pos, to: pos + tr.doc.nodeAt(pos).nodeSize } });
  } else if (inListItem(doc, target)) {
    const $p = doc.resolve(pos);
    const at = $p.before($p.depth); // before the list item
    const items = newLines.map((l) => schema.nodes.listItem.create(null, schema.nodes.paragraph.create(null, schema.text(l))));
    tr = tr.insert(at, items);
    tr.setMeta(flashKey, { add: { from: at, to: at + items.reduce((n, x) => n + x.nodeSize, 0) } });
  } else {
    const paragraphs = newLines.map((l) => schema.nodes.paragraph.create(null, schema.text(l)));
    tr = tr.insert(pos, paragraphs);
    tr.setMeta(flashKey, { add: { from: pos, to: pos + paragraphs.reduce((n, x) => n + x.nodeSize, 0) } });
  }
  editor.view.dispatch(tr);
  scheduleClear(editor);
  return { ok: true, before: '', after: newLines.join('\n'), pos };
}

// ---------- look-only edits and lists (commands): the WORDS never change ----------
// format       style: bold | italic | underline | not_bold | not_italic | not_underline
// change_case  case:  upper | lower | title | sentence  (only the case of letters; same length, marks and breaks kept)
// Both work on one block, on find_text inside it, or on a range of blocks (block_id .. last_block_id).
// to_list      list_type: ordered | bullet; lines: the exact lines to put in the list (paragraphs or lines of a
//              paragraph with line breaks); the other lines stay where they are, as they are
// unlist       the list that contains block_id becomes normal paragraphs
const STYLES = {
  bold: ['bold', true], italic: ['italic', true], underline: ['underline', true],
  not_bold: ['bold', false], not_italic: ['italic', false], not_underline: ['underline', false],
};
const CASES = new Set(['upper', 'lower', 'title', 'sentence']);
const fail = (error) => ({ ok: false, error });

// The blocks an edit covers: block_id alone, or block_id .. last_block_id
function blockRange(blocks, index, lastId) {
  if (lastId == null || String(lastId).trim() === '') return [blocks[index]];
  const last = parseInt(String(lastId).replace(/\D/g, ''), 10);
  if (Number.isNaN(last) || last < index || !blocks[last]) return null;
  return blocks.slice(index, last + 1);
}

// The block's text with "\n" for line breaks, and the document position of every character (-1 for a break)
function textWithBreaks(node, start) {
  let text = '';
  const map = [];
  node.forEach((child, offset) => {
    if (child.isText) {
      for (let k = 0; k < child.text.length; k++) map.push(start + offset + k);
      text += child.text;
    } else {
      map.push(-1);
      text += '\n';
    }
  });
  return { text, map };
}

// The part of a block an edit covers: [{ from, to, text }] (find_text: its first match; else the whole text)
function spansOf(b, find) {
  const { text, map } = textWithBreaks(b.node, b.pos + 1);
  if (!text.trim()) return [];
  if (!find) return [{ block: b, from: b.pos + 1, to: b.pos + b.node.nodeSize - 1, text, map, i: 0 }];
  const i = text.toLowerCase().indexOf(find.toLowerCase());
  if (i === -1 || map[i] === -1 || map[i + find.length - 1] === -1) return [];
  return [{ block: b, from: map[i], to: map[i + find.length - 1] + 1, text: text.slice(i, i + find.length), map: map.slice(i, i + find.length), i }];
}

// Same-length case change (letters whose upper / lower form has another length stay as they are)
function recase(text, kind) {
  const one = (c, up) => { const x = up ? c.toUpperCase() : c.toLowerCase(); return x.length === 1 ? x : c; };
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (kind === 'upper') out.push(one(c, true));
    else if (kind === 'lower') out.push(one(c, false));
    else if (kind === 'title') out.push(one(c, !/[\p{L}\p{N}'’]/u.test(text[i - 1] || '')));
    else {
      // sentence: the first letter of the text, of each line and after . ! ? is a capital; the rest small
      const before = text.slice(0, i).replace(/[\s"'(“‘]+$/u, '');
      out.push(one(c, before === '' || /[.!?\n]$/.test(before)));
    }
  }
  return out.join('');
}

function applyLook(editor, blocks, index, args) {
  const isCase = args.operation === 'change_case';
  let markType = null;
  let add = true;
  if (isCase) {
    if (!CASES.has(args.case)) return fail(`change_case needs case: upper, lower, title or sentence (got "${args.case ?? ''}")`);
  } else {
    const spec = STYLES[args.style];
    if (!spec) return fail(`format needs style: bold, italic, underline, not_bold, not_italic or not_underline (got "${args.style ?? ''}")`);
    markType = editor.schema.marks[spec[0]];
    if (!markType) return fail(`${spec[0]} is not available in this editor`);
    add = spec[1];
  }
  const range = blockRange(blocks, index, args.last_block_id);
  if (!range) return fail(`last_block_id ${args.last_block_id} is not a block after ${args.block_id}`);
  const find = String(args.find_text ?? '').trim();
  const spans = range.flatMap((b) => spansOf(b, find));
  if (!spans.length) return fail(find ? `"${find}" not found in ${args.block_id}` : 'there is no text to change there');

  let tr = editor.state.tr;
  const before = [];
  const after = [];
  for (const s of spans) {
    before.push(s.text);
    if (!isCase) {
      tr = add ? tr.addMark(s.from, s.to, markType.create()) : tr.removeMark(s.from, s.to, markType);
      continue;
    }
    // the case is worked out on the WHOLE block text (sentences, words); each piece of text keeps its own marks
    const fresh = recase(textWithBreaks(s.block.node, 0).text, args.case).slice(s.i, s.i + s.text.length);
    after.push(fresh);
    const k0 = new Map(s.map.map((p, k) => [p, k]));
    const pieces = [];
    editor.state.doc.nodesBetween(s.from, s.to, (n, p) => {
      if (!n.isText) return;
      const a = Math.max(p, s.from);
      const z = Math.min(p + n.nodeSize, s.to);
      const now = fresh.slice(k0.get(a), k0.get(z - 1) + 1);
      if (now !== n.text.slice(a - p, z - p)) pieces.push({ a, z, now, marks: n.marks });
    });
    // same length: the positions of the other pieces stay valid
    for (const x of pieces) tr = tr.replaceWith(x.a, x.z, editor.schema.text(x.now, x.marks));
  }
  const from = range[0].pos;
  const last = range[range.length - 1];
  tr.setMeta(flashKey, { add: { from, to: last.pos + tr.doc.nodeAt(last.pos).nodeSize } });
  editor.view.dispatch(tr);
  scheduleClear(editor);
  const show = (xs) => xs.join(' | ').replace(/\n/g, ' / ');
  return { ok: true, before: show(before), after: isCase ? show(after) : `${show(before)} (${args.style.replace('_', ' ')})`, pos: from };
}

// The lines of a top-level paragraph: [{ nodes, text }] (split at line breaks; marks kept)
function paragraphLines(node) {
  const out = [{ nodes: [], text: '' }];
  node.forEach((c) => {
    if (c.type.name === 'hardBreak') out.push({ nodes: [], text: '' });
    else { out[out.length - 1].nodes.push(c); if (c.isText) out[out.length - 1].text += c.text; }
  });
  return out;
}
// ---------- which lines a list takes (to_list "select") ----------
// Medicine forms at the start of a line: the same forms as FORMS in medicineText.js (the medicine engine)
const FORM_LINES = {
  tab: 'tab|tabs|tablet|tablets', cap: 'cap|caps|capsule|capsules', syp: 'syp|syr|syrup|syrups', susp: 'susp|suspension',
  inj: 'inj|injection|injections', drops: 'drop|drops|eye drops|ear drops', oint: 'oint|ointment|cream|gel|lotion',
  sachet: 'sachet|sachets|powder', inhaler: 'inhaler|neb|nebulisation|nebulization|spray|rotacap',
};
const FORM_WORDS = Object.values(FORM_LINES).join('|');
const kindAtStart = (t) => Object.keys(FORM_LINES).find((k) => new RegExp(`^\\s*(?:${FORM_LINES[k]})(?:\\.\\s*|\\s+)\\S`, 'i').test(t)) || null;
// select values -> form keys (all_medicines = any form)
const SELECT_KINDS = {
  all_medicines: '*', tablets: ['tab'], capsules: ['cap'], syrups: ['syp'], suspensions: ['susp'], injections: ['inj'],
  drops: ['drops'], ointments: ['oint'], sachets: ['sachet'], powders: ['sachet'], inhalers: ['inhaler'],
};
const kindWanted = (kinds, k) => kinds.some((s) => SELECT_KINDS[s] === '*' || SELECT_KINDS[s]?.includes(k));
// Where a SECOND entry starts inside a line: after a comma / semicolon ("…sleep,Tab. DOLO …", "…; Ointment X …"),
// or a short form with a dot in the middle of the line ("… 2 daysTab. Y …" - the same rule as MID_MEDICINE above)
const JOIN_AT = new RegExp(`(?:[,;]\\s*)(?=(?:${FORM_WORDS})\\.?\\s+\\S)|(?=(?:Tab|Tabs|Cap|Caps|Syp|Syr|Inj|Susp)\\.\\s+[A-Za-z(])`, 'gi');
// A line split into its entries (one piece = one entry)
function entryPieces(text) {
  const cuts = [0];
  for (const m of String(text).matchAll(JOIN_AT)) if (m.index > 0) cuts.push(m.index);
  cuts.push(text.length);
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) out.push(text.slice(cuts[i], cuts[i + 1]).replace(/^[\s,;]+/, ''));
  return out.filter((p) => p.trim());
}
// The kinds of the entries in a line: [] (no medicine), ['tab'], or several when entries are joined ('oint', 'tab')
function kindsOfLine(text) {
  const pieces = entryPieces(text);
  if (pieces.length > 1) return pieces.map((p) => kindAtStart(p) || 'text');
  const k = kindAtStart(text);
  return k ? [k] : [];
}
// For comparing lines: dashes, spaces (also non-breaking), capitals and a trailing comma / full stop do not matter.
// (Used only to FIND a line; the document's own text and positions are what change.)
const normLine = (t) => String(t).normalize('NFC').toLowerCase().replace(/[\s ]+/g, ' ').replace(/\s*[—–-]\s*/g, ' - ')
  .replace(/[\s,.;]+$/, '').trim();

const LIST_TYPES = { ordered: 'orderedList', bullet: 'bulletList' };
const isList = (n) => n.type.name === 'orderedList' || n.type.name === 'bulletList';
// is this text block inside a list?
function blocksInList(doc, b) {
  const $p = doc.resolve(b.pos);
  for (let d = 1; d <= $p.depth; d++) if (isList($p.node(d))) return true;
  return false;
}

function applyToList(editor, blocks, index, args) {
  const listName = LIST_TYPES[args.list_type];
  const schema = editor.schema;
  if (!listName || !schema.nodes[listName]) return fail('it was not clear whether the list should be numbered or bulleted. Please say "numbered list" or "bullet list". Nothing was changed');
  const wanted = (Array.isArray(args.lines) ? args.lines : []).map((l) => String(l)).filter((l) => l.trim());
  const kinds = (Array.isArray(args.select) ? args.select : args.select ? [args.select] : []).map((s) => String(s));
  const unknownKind = kinds.find((k) => !SELECT_KINDS[k]);
  if (unknownKind) return fail(`"${unknownKind}" is not a kind of entry the app can pick. Nothing was changed`);
  if (!wanted.length && !kinds.length) return fail('it was not clear which lines should be in the list. Please name them (for example "all the tablets in Advice"). Nothing was changed');
  const doc = editor.state.doc;
  const own = doc.resolve(blocks[index].pos).index(0); // the top-level node of the AI's block

  // already a list: change its kind (bullet <-> numbered) when exactly its items were asked for
  const top = doc.child(own);
  if (isList(top)) {
    const items = [];
    top.forEach((li) => items.push(normLine(li.textContent)));
    const asked = wanted.length ? wanted.map(normLine) : [];
    const byKind = [];
    top.forEach((li) => { if (kinds.length && kindsOfLine(li.textContent).some((k) => kindWanted(kinds, k))) byKind.push(normLine(li.textContent)); });
    const named = [...new Set([...asked, ...byKind])];
    if (named.length !== items.length || !named.every((w) => items.includes(w))) {
      return fail('only part of an existing list was named; to change a list, name all of its lines. Nothing was changed');
    }
    if (top.type.name === listName) return { ok: true, before: '', after: '', pos: blocks[index].pos, unchanged: true };
    let at = 0;
    for (let i = 0; i < own; i++) at += doc.child(i).nodeSize;
    const tr = editor.state.tr.setNodeMarkup(at, schema.nodes[listName], listName === 'orderedList' ? { start: 1 } : null);
    tr.setMeta(flashKey, { add: { from: at, to: at + top.nodeSize } });
    editor.view.dispatch(tr);
    scheduleClear(editor);
    return { ok: true, before: wanted.join('\n'), after: wanted.map((w, i) => (listName === 'orderedList' ? `${i + 1}. ${w}` : `• ${w}`)).join('\n'), pos: at };
  }

  // the region: the WHOLE section of that block ("all the syrups" means all of them, wherever the AI's block_id is),
  // or block_id .. last_block_id when a range was given
  let startIdx = index;
  if (!args.last_block_id) {
    while (startIdx > 0 && !isHeadingBlock(doc, blocks[startIdx - 1]) && !isHeadingBlock(doc, blocks[startIdx])) startIdx--;
  }
  const start = doc.resolve(blocks[startIdx].pos).index(0);
  let endBlock = index;
  if (args.last_block_id) {
    endBlock = parseInt(String(args.last_block_id).replace(/\D/g, ''), 10);
    if (Number.isNaN(endBlock) || endBlock < index || !blocks[endBlock]) return fail(`last_block_id ${args.last_block_id} is not a block after ${args.block_id}`);
  } else {
    while (endBlock + 1 < blocks.length && !isHeadingBlock(doc, blocks[endBlock + 1])) endBlock++;
  }
  const end = doc.resolve(blocks[endBlock].pos).index(0);

  // every line of every top-level paragraph in the region
  const rows = []; // { child, lines: [{ nodes, text, pick }] } or { child } for anything that is not a paragraph
  for (let i = start; i <= end; i++) {
    const child = doc.child(i);
    rows.push(child.type.name === 'paragraph' ? { child, lines: paragraphLines(child).map((l) => ({ ...l, pick: false })) } : { child });
  }
  const all = rows.flatMap((r) => r.lines || []);
  const joinedMsg = (l) => `two entries appear to be joined on one line: "${l.text.trim()}". Please put each entry on its own line and try again. Nothing was changed`;

  // 1. the kinds asked for ("all medicines", "tablets", "syrups" ...): picked by the browser from the document itself
  //    (a line counts when it STARTS with that medicine form, the same rule as the medicine checks)
  for (const l of all) {
    if (!kinds.length || !l.text.trim()) continue;
    const pieces = kindsOfLine(l.text);
    if (pieces.length > 1 && pieces.some((k) => kindWanted(kinds, k))) return fail(joinedMsg(l)); // e.g. "…sleep,Tab. DOLO …"
    if (pieces.length === 1 && kindWanted(kinds, pieces[0])) l.pick = true;
  }
  // 2. the lines the AI named (e.g. a supplement written without "Tab." / "Syp."): each must be exactly ONE whole line
  //    of the section, compared without differences in dashes, spaces, capitals or a trailing comma / full stop
  for (const w of wanted) {
    const f = normLine(w);
    const hits = all.filter((l) => normLine(l.text) === f);
    if (hits.length > 1) return fail(`the line "${w}" appears more than once in that section; it is not clear which one is meant. Nothing was changed`);
    if (hits.length === 1) {
      if (kindsOfLine(hits[0].text).length > 1) return fail(joinedMsg(hits[0]));
      hits[0].pick = true;
      continue;
    }
    // part of a line that holds two entries ("Tab. DOLO …" inside "…sleep,Tab. DOLO …")
    const glued = all.find((l) => kindsOfLine(l.text).length > 1 && entryPieces(l.text).some((p) => normLine(p) === f));
    if (glued) return fail(joinedMsg(glued));
    return fail(`the line "${w}" was not found in that section. Nothing was changed`);
  }
  if (!all.some((l) => l.pick)) {
    // those lines are already in a list (e.g. a second edit of the same command): nothing more to do
    const listed = rows.some((r) => !r.lines && isList(r.child) && kinds.length &&
      (() => { let hit = false; r.child.forEach((li) => { if (kindsOfLine(li.textContent).some((k) => kindWanted(kinds, k))) hit = true; }); return hit; })());
    if (listed && !wanted.length) return { ok: true, before: '', after: '', pos: blocks[index].pos, unchanged: true };
    return fail(`no ${kinds.join(' / ').replace(/_/g, ' ')} were found in that section. Nothing was changed`);
  }
  const first = rows.findIndex((r) => r.lines?.some((l) => l.pick));
  const lastRow = rows.length - 1 - [...rows].reverse().findIndex((r) => r.lines?.some((l) => l.pick));
  const span = rows.slice(first, lastRow + 1);

  // rebuild that span: picked lines -> list items; the other lines stay together in their paragraph (line breaks kept);
  // a numbered list that is interrupted continues its numbering (1, 2, <syrup line>, 3)
  const out = [];
  let items = [];
  let count = 0;
  const flushList = () => {
    if (!items.length) return;
    out.push(schema.nodes[listName].create(listName === 'orderedList' ? { start: count - items.length + 1 } : null, items));
    items = [];
  };
  for (const r of span) {
    if (!r.lines) { flushList(); out.push(r.child); continue; }
    let plain = [];
    const flushPlain = () => {
      if (!plain.length) return;
      out.push(schema.nodes.paragraph.create(r.child.attrs, plain.flatMap((l, k) => (k ? [schema.nodes.hardBreak.create(), ...l.nodes] : l.nodes))));
      plain = [];
    };
    for (const l of r.lines) {
      if (l.pick) { flushPlain(); items.push(schema.nodes.listItem.create(null, schema.nodes.paragraph.create(r.child.attrs, l.nodes))); count++; }
      else { flushList(); plain.push(l); }
    }
    flushPlain();
  }
  flushList();

  // safety: exactly the same words before and after (only the structure changes)
  const words = (nodes) => nodes.map((n) => n.textContent).join('').replace(/\s+/g, '');
  if (words(span.map((r) => r.child)) !== words(out)) return fail('the list would change the text, so nothing was changed');
  let from = 0;
  for (let i = 0; i < start + first; i++) from += doc.child(i).nodeSize;
  const to = from + span.reduce((n, r) => n + r.child.nodeSize, 0);
  const tr = editor.state.tr.replaceWith(from, to, out);
  tr.setMeta(flashKey, { add: { from, to: from + out.reduce((n, x) => n + x.nodeSize, 0) } });
  editor.view.dispatch(tr);
  scheduleClear(editor);
  const picked = all.filter((l) => l.pick).map((l) => l.text);
  return { ok: true, before: picked.join('\n'), after: picked.map((t, i) => (listName === 'orderedList' ? `${i + 1}. ${t}` : `• ${t}`)).join('\n'), pos: from };
}

function applyUnlist(editor, blocks, index) {
  const doc = editor.state.doc;
  const $p = doc.resolve(blocks[index].pos);
  let depth = -1;
  for (let d = 1; d <= $p.depth; d++) if (isList($p.node(d))) { depth = d; break; } // the outermost list
  if (depth === -1) return fail(`${'B' + index} is not in a list`);
  const list = $p.node(depth);
  const paragraphs = [];
  list.descendants((n) => {
    if (n.isTextblock) { paragraphs.push(n.type.name === 'paragraph' ? n : editor.schema.nodes.paragraph.create(n.attrs, n.content)); return false; }
    return true;
  });
  const from = $p.before(depth);
  const tr = editor.state.tr.replaceWith(from, from + list.nodeSize, paragraphs);
  tr.setMeta(flashKey, { add: { from, to: from + paragraphs.reduce((n, x) => n + x.nodeSize, 0) } });
  editor.view.dispatch(tr);
  scheduleClear(editor);
  const texts = paragraphs.map((n) => n.textContent);
  return { ok: true, before: texts.map((t) => `• ${t}`).join('\n'), after: texts.join('\n'), pos: from };
}

// A WHOLE medicine list proposed by the AI (e.g. from an uploaded prescription), compared line by line with the list
// in the document. Returns
//   { same: true }                      nothing differs
//   { add: [lines] }                    every current medicine is still there (same order) + new medicines
//   { change: [{ line, text }] }        the same number of lines; only the lines that differ change
//   null                                a medicine would disappear or the lines do not match: not allowed here
function medicineListUpdate(lines, value) {
  const old = lines.filter((l) => l.text.trim());
  if (old.some((l) => [...l.text.matchAll(MID_MEDICINE)].some((m) => m.index > 0))) return null; // glued lines: unclear
  const proposed = proposedLines(value);
  if (!proposed.length) return null;
  let k = 0;
  const extra = [];
  for (const p of proposed) {
    if (k < old.length && squash(p) === squash(old[k].text)) k++;
    else extra.push(p);
  }
  if (k === old.length) {
    if (!extra.length) return { same: true };
    return extra.every(isMedicineLine) ? { add: extra } : null;
  }
  // a changed line must still be the SAME medicine ("Tab. DOLO 650 mg" -> "Tab. DOLO 500 mg"); a different medicine in
  // its place means one was removed (or the order changed): not allowed here
  const sameMedicine = (a, b) => !isMedicineLine(a) || medicineKey(a) === medicineKey(b);
  if (proposed.length === old.length && proposed.every((p, i) => sameMedicine(old[i].text, p))) {
    return { change: old.map((line, i) => ({ line, text: proposed[i] })).filter((c) => squash(c.text) !== squash(c.line.text)) };
  }
  return null;
}

// Changes only the differing part of each changed line ("650 mg" -> "500 mg"): line breaks and the formatting
// of the unchanged words (bold brand names ...) stay. One transaction.
function changeMedicineLines(editor, target, changes) {
  const { pos, node } = target;
  let tr = editor.state.tr;
  for (const { line, text } of [...changes].reverse()) { // last line first: earlier positions stay valid
    const old = line.text;
    let a = 0;
    while (a < old.length && a < text.length && old[a] === text[a]) a++;
    let b = 0;
    while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
    const from = a < old.length ? line.map[a] : line.map[old.length - 1] + 1;
    const to = old.length - b > a ? line.map[old.length - 1 - b] + 1 : from;
    tr = tr.insertText(text.slice(a, text.length - b), from, to);
  }
  tr.setMeta(flashKey, { add: { from: pos, to: pos + tr.doc.nodeAt(pos).nodeSize } });
  editor.view.dispatch(tr);
  scheduleClear(editor);
  // only the changed lines, old and new (the other medicines are not touched)
  return { ok: true, before: changes.map((c) => c.line.text).join('\n'), after: changes.map((c) => c.text).join('\n'), pos };
}

// ---------- tables ----------
const sameWords = (a, b) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

// The AI aimed at a LABEL cell ("IP No", "SERUM CREATININE"), but the value belongs in the cell next to it, in the
// SAME row. Returns that edit for the value cell, or null when it is not clear (then the edit stays blocked).
// "clear" is never moved: emptying a value must be aimed at the value itself.
function toValueCell(editor, blocks, target, args, labelText) {
  const info = cellAt(editor.state.doc, target.pos);
  const value = info && valueCellAfter(info);
  const vIndex = value ? blocks.findIndex((b) => b.pos === value.pos) : -1;
  if (vIndex === -1 || isLockedLabel(editor.state.doc, blocks[vIndex])) return null;
  const valueText = value.node.textContent;
  const block_id = `B${vIndex}`;

  if (args.operation === 'replace_text') {
    const find = String(args.find_text || '');
    return find && valueText.toLowerCase().includes(find.toLowerCase()) ? { ...args, block_id } : null;
  }
  if (args.operation !== 'set' && args.operation !== 'append') return null;
  // "IP No: IP00019515" or "IP00019515" -> "IP00019515" (the label is not part of the value)
  let v = String(args.new_value ?? '').trim();
  const label = labelText.trim();
  if (label && v.toLowerCase().startsWith(label.toLowerCase())) v = v.slice(label.length);
  v = v.replace(/^[\s:\-–=]+/, '').trim();
  if (!v) return null;
  if (args.operation === 'append' && valueText.trim()) return null; // a value is already there: unclear what was meant
  return { ...args, block_id, operation: 'set', new_value: v };
}

// A new row for a table ("CRP | 48.9 MG/L"): never a paragraph pushed inside a cell.
// Same cell types and formatting as the rows around it; one value per column.
function addTableRow(editor, info, value) {
  const { table } = info;
  const parts = String(value).split('|').map((s) => s.trim());
  // copy the look of a data row (not of the column-title row)
  const model = info.rowIndex === 0 && hasTitleRow(table) && table.childCount > 1 ? table.child(1) : info.row;
  const cells = [];
  model.forEach((c) => cells.push(c));
  const simple = cells.every((c) => (c.attrs.colspan || 1) === 1 && (c.attrs.rowspan || 1) === 1);
  if (parts.length !== cells.length || !simple || parts.some((p) => !p)) {
    return {
      ok: false,
      blocked: true,
      error: `a new line cannot be put inside a table cell; to add a table row, give one value for each of the ${cells.length} columns`,
    };
  }
  if (isDataTable(table) && rowNames(table).some((n) => sameWords(n, parts[0]))) {
    return { ok: false, blocked: true, error: `"${parts[0]}" is already in the table; change its value instead of adding a row` };
  }
  const schema = editor.schema;
  const newCells = cells.map((c, i) => {
    const para = c.firstChild?.type.name === 'paragraph' ? c.firstChild : null;
    const marks = para?.firstChild?.marks || [];
    return c.type.create(c.attrs, schema.nodes.paragraph.create(para?.attrs || null, schema.text(parts[i], marks)));
  });
  const newRow = model.type.create(model.attrs, newCells);
  const at = info.rowPos + info.row.nodeSize; // right after the row the AI pointed at
  const tr = editor.state.tr.insert(at, newRow);
  tr.setMeta(flashKey, { add: { from: at, to: at + newRow.nodeSize } });
  editor.view.dispatch(tr);
  scheduleClear(editor);
  return { ok: true, before: '', after: parts.join(' | '), pos: at };
}

// ---------- headings stay locked, the content under them stays editable ----------
// A new text without the heading / label the AI may have repeated in front of it ("COURSE IN HOSPITAL : Patient …")
const withoutLabel = (value, label) => {
  const v = String(value ?? '');
  const l = String(label).trim().replace(/[\s:]+$/, '');
  return l && v.trim().toLowerCase().startsWith(l.toLowerCase()) ? v.trim().slice(l.length).replace(/^[\s:\-–]+/, '') : v.trim();
};
const textNodes = (schema, value) => String(value).split(/\r?\n/).flatMap((l, i) => [...(i ? [schema.nodes.hardBreak.create()] : []), ...(l ? [schema.text(l)] : [])]);

// set / clear aimed at a section HEADING (its own paragraph): the paragraphs UNDER it change; the heading does not.
// One paragraph -> that paragraph is set / cleared with all the usual checks. Several plain paragraphs -> replaced by
// one in ONE step. Returns null (= stay blocked) when it is not safe: tables or lists under the heading, medicines
// (they are removed only through the confirmation window), or a gender change that was not asked for.
function replaceSectionContent(editor, blocks, index, args, opts) {
  const doc = editor.state.doc;
  const body = bodyUnder(doc, blocks, index);
  const heading = blocks[index].node.textContent;
  const value = args.operation === 'set' ? withoutLabel(args.new_value, heading) : '';
  if (!body.length) {
    if (args.operation === 'clear') return { ok: true, before: '', after: '', pos: blocks[index].pos, unchanged: true };
    return value ? { ...applyVoiceEdit(editor, { ...args, operation: 'insert_after', new_value: value }, opts), redirected: true } : null;
  }
  if (body.length === 1) return { ...applyVoiceEdit(editor, { ...args, block_id: `B${body[0].index}`, new_value: value }, opts), redirected: true };
  if (body.some((b) => doc.resolve(b.pos).depth !== 0)) return null; // a table or a list under the heading: say which part
  const oldText = body.map((b) => b.node.textContent).join('\n');
  if (body.some((b) => linesOf(b.node, b.pos + 1).some((l) => isMedicineLine(l.text)))) return null;
  if (opts.allowGender === false && changesGender(oldText, value)) {
    return { ok: false, blocked: true, error: 'it would change the gender, which you did not ask for' };
  }
  const from = body[0].pos;
  const last = body[body.length - 1];
  const para = editor.schema.nodes.paragraph.create(body[0].node.attrs, textNodes(editor.schema, value));
  const tr = editor.state.tr.replaceWith(from, last.pos + last.node.nodeSize, para);
  tr.setMeta(flashKey, { add: { from, to: from + para.nodeSize } });
  editor.view.dispatch(tr);
  scheduleClear(editor);
  return { ok: true, before: oldText, after: value, pos: from };
}

// set / clear of a paragraph that STARTS with its label or heading ("Course in Hospital : text", "COURSE IN
// HOSPITAL↵text"): the label / heading stays exactly as it is (its words and its bold), only the text after it
// changes. Returns null (= stay blocked) when there is no such label, or the text holds medicines.
function replaceAfterLabel(editor, target, args, opts) {
  const { pos, node } = target;
  const schema = editor.schema;
  const full = node.textContent;
  let contentFrom = null; // where the content starts
  let label = '';
  let firstLine = false;
  const prefix = labelPrefix(full);
  if (prefix) {
    label = prefix;
    // the position after the label and the spaces that follow it
    const { text: withBreaks, map } = textWithBreaks(node, pos + 1); // same characters as the text, "\n" = a break
    let n = prefix.length;
    while (n < withBreaks.length && (map[n] === -1 || /\s/.test(withBreaks[n]))) n++;
    contentFrom = n < map.length ? map[n] : pos + node.nodeSize - 1;
  } else {
    let head = '';
    let br = -1;
    node.forEach((c, offset) => { if (br === -1) { if (c.isText) head += c.text; else br = offset; } });
    if (br === -1 || !isLabelText(head.trim())) return null;
    label = head;
    firstLine = true;
    contentFrom = pos + 1 + br + 1; // after the line break
  }
  const end = pos + node.nodeSize - 1;
  const oldContent = editor.state.doc.textBetween(contentFrom, end, '\n');
  const lines = linesOf(node, pos + 1);
  if (lines.some((l) => isMedicineLine(l.text)) || [...full.matchAll(MID_MEDICINE)].length) return null; // medicines: existing rules
  const value = args.operation === 'set' ? withoutLabel(args.new_value, label) : '';
  if (opts.allowGender === false && changesGender(oldContent, value)) {
    return { ok: false, blocked: true, error: 'it would change the gender, which you did not ask for' };
  }
  let tr = editor.state.tr;
  if (value) tr = tr.replaceWith(contentFrom, end, textNodes(schema, value));
  else tr = tr.delete(firstLine ? contentFrom - 1 : contentFrom, end); // clear: the heading line alone (no empty line)
  tr.setMeta(flashKey, { add: { from: pos, to: pos + tr.doc.nodeAt(pos).nodeSize } });
  editor.view.dispatch(tr);
  scheduleClear(editor);
  return { ok: true, before: full, after: tr.doc.nodeAt(pos).textContent, pos };
}

// Applies ONE edit instruction to ONE text block. Everything else stays untouched.
// Formatting (bold, italic...) of the edited text is preserved by ProseMirror's insertText.
// allowGender = false: refuse edits that change gender words (the command did not mention gender)
export function applyVoiceEdit(editor, args, opts = {}) {
  // fromFile = true: the edit comes from an uploaded file. A file may fill in, change and add, but never delete.
  const { allowGender = true, fromFile = false } = opts;
  const { block_id, operation } = args;
  const new_value = args.new_value ?? '';
  const find_text = args.find_text ?? '';

  const index = parseInt(String(block_id).replace(/\D/g, ''), 10);
  const blocks = getBlocks(editor.state.doc);
  const target = blocks[index];
  if (!target) return { ok: false, error: `Block ${block_id} does not exist` };

  const { pos, node } = target;
  const start = pos + 1; // first position inside the block
  const end = pos + node.nodeSize - 1; // last position inside the block
  const before = node.textContent;

  // Look-only edits and lists (typed / spoken commands only; an uploaded file never sends them): the words stay the
  // same, so no medicine can be lost; the medicine count check in App.jsx still runs on them like on every edit
  if (['format', 'change_case', 'to_list', 'unlist'].includes(operation)) {
    if (fromFile) return { ok: false, blocked: true, error: 'an uploaded file cannot change formatting or lists' };
    const doc = editor.state.doc;
    let a = args;
    let i = index;
    // aimed at a section HEADING (without find_text): it means the section's text, as for added text (the heading
    // itself is only changed with find_text = its words, or as part of a range that goes beyond its section)
    if (!String(args.find_text ?? '').trim() && isHeadingBlock(doc, target)) {
      const body = bodyUnder(doc, blocks, index);
      if (!body.length) return { ok: false, blocked: true, error: `there is no text under ${before.trim()}` };
      const lastIdx = args.last_block_id ? parseInt(String(args.last_block_id).replace(/\D/g, ''), 10) : index;
      const insideSection = lastIdx <= body[body.length - 1].index;
      if (insideSection) {
        if (operation === 'unlist') {
          const inList = body.find((b) => doc.resolve(b.pos).depth > 0 && blocksInList(doc, b));
          if (!inList) return { ok: false, blocked: true, error: `there is no list under ${before.trim()}` };
          i = inList.index;
        } else {
          i = body[0].index;
          if (operation !== 'to_list') a = { ...args, last_block_id: `B${body[body.length - 1].index}` };
        }
        a = { ...a, block_id: `B${i}` };
      }
    }
    // refusals here are shown with their reason (nothing was changed)
    const r = operation === 'to_list' ? applyToList(editor, blocks, i, a)
      : operation === 'unlist' ? applyUnlist(editor, blocks, i)
        : applyLook(editor, blocks, i, a);
    return r.ok ? r : { ...r, blocked: true };
  }

  // A medicine that is already in this section: ask, unless the command clearly asked for another entry
  // (duplicate_ok). Not for uploaded files (a prescription is compared with the list instead).
  const isDuplicate = (newLines) => {
    if (fromFile || args.duplicate_ok === true) return '';
    const name = duplicateMedicine(editor.state.doc, blocks, index, newLines);
    return name ? `${name.toUpperCase()} is already in this section. Do you want to change the existing entry, or add another ${name.toUpperCase()} entry? Nothing was changed` : '';
  };

  // Add NEW line(s) after this block - or, in a paragraph with line breaks, after the line find_text points at
  if (operation === 'insert_after') {
    if (!new_value.trim()) return { ok: false, error: 'insert_after needs new_value' };
    if (!allowGender && changesGender('', new_value)) {
      return { ok: false, blocked: true, error: 'it would add gender details you did not ask for' };
    }
    // inside a table cell: a new ROW ("CRP | 48.9 MG/L"), never a paragraph pushed into the cell.
    // (A single value added to a cell of an ordinary table, e.g. a second address line, works as before.)
    const cellInfo = cellAt(editor.state.doc, pos);
    if (cellInfo && (isDataTable(cellInfo.table) || new_value.includes('|'))) return addTableRow(editor, cellInfo, new_value);
    // which line it goes after: find_text in a paragraph with line breaks ("after the DOLO line")
    const lines = linesOf(node, start);
    let afterLine = null;
    if (find_text.trim() && lines.length > 1) {
      afterLine = lineIndexOf(lines, find_text);
      if (afterLine === -1) return { ok: false, error: `"${find_text}" not found in ${block_id}` };
      if (afterLine === -2) return { ok: false, blocked: true, error: `more than one line contains "${find_text}"; say which line` };
    }
    // a medicine added to a medicine list: each medicine on its own line, in the same layout as the list
    // (a separator the AI put in front - ", Tab. DOLO …" - is not part of the new entry)
    if ((inMedicineSection(editor.state.doc, blocks, index) || (isHeadingBlock(editor.state.doc, target) && MEDICINE_TITLE.test(before))) && node.textContent.trim()) {
      const medLines = medicineLinesIn(stripLead(new_value));
      if (medLines.length) {
        const dup = isDuplicate(medLines);
        if (dup) return { ok: false, blocked: true, error: dup };
        return placeNewMedicines(editor, blocks, index, medLines, afterLine, args.at_start === true, args.before_entry);
      }
    }
    // a place asked for by the person ("before X" / "at the top", set by the check in verify.js) is never ignored, also
    // for a medicine line written without a form ("CETIRIZINE 10 mg": a form nobody said was removed)
    if ((typeof args.before_entry === 'string' || args.at_start === true) && !fromFile && node.textContent.trim()) {
      const asked = String(new_value).split(/\r?\n/).map((l) => l.replace(/^[\s,;]+/, '').trim()).filter(Boolean);
      const dup = isDuplicate(asked);
      if (dup) return { ok: false, blocked: true, error: dup };
      if (typeof args.before_entry === 'string') return placeNewMedicines(editor, blocks, index, asked, null, false, args.before_entry);
      if (isHeadingBlock(editor.state.doc, target)) return placeNewMedicines(editor, blocks, index, asked, null, true);
    }
    // a new line never starts or ends with stray spaces (or a stray comma); several lines -> several new lines
    const newLines = String(new_value).split(/\r?\n/).map((l) => l.replace(/^[\s,;]+/, '').trim()).filter(Boolean);
    if (afterLine != null) return addNewLines(editor, target, newLines, afterLine);
    if (inListItem(editor.state.doc, target)) return addNewLines(editor, target, newLines);
    const insertPos = pos + node.nodeSize;
    const paras = newLines.map((l) => editor.schema.nodes.paragraph.create(null, editor.schema.text(l)));
    const tr = editor.state.tr.insert(insertPos, paras);
    tr.setMeta(flashKey, { add: { from: insertPos, to: insertPos + paras.reduce((n, x) => n + x.nodeSize, 0) } });
    editor.view.dispatch(tr);
    scheduleClear(editor);
    return { ok: true, before: '', after: new_value, pos: insertPos };
  }

  // "append" whose text starts with a new line: the AI means a NEW line, never glued onto the last one
  if (operation === 'append' && /^[ \t]*\r?\n/.test(new_value) && node.textContent.trim() && !inTable(editor.state.doc, target)) {
    const newLines = String(new_value).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!newLines.length) return { ok: false, error: 'append needs new_value' };
    if (!allowGender && changesGender('', new_value)) {
      return { ok: false, blocked: true, error: 'it would add gender details you did not ask for' };
    }
    if (inMedicineSection(editor.state.doc, blocks, index)) {
      const dup = isDuplicate(newLines);
      if (dup) return { ok: false, blocked: true, error: dup };
      if (newLines.every(isMedicineLine)) return placeNewMedicines(editor, blocks, index, newLines, null, args.at_start === true, args.before_entry);
    }
    return addNewLines(editor, target, newLines);
  }

  // Map every character of the block's text to its document position
  let text = '';
  const map = [];
  node.forEach((child, offset) => {
    if (child.isText) {
      for (let k = 0; k < child.text.length; k++) map.push(start + offset + k);
      text += child.text;
    }
  });

  let from, to, insert;
  let after; // the text of the block after this edit (checked by the guards below)
  switch (operation) {
    case 'set':
      from = start; to = end; insert = new_value; after = new_value;
      break;
    case 'clear':
      from = start; to = end; insert = ''; after = '';
      break;
    case 'append': {
      // exactly ONE space between the old and the added text: none when the old text already ends with a
      // space or the added text starts with punctuation (", MALARIA"); the AI's leading spaces are dropped
      const added = new_value.replace(/^\s+/, '').replace(/\s+$/, '');
      const space = text && !/\s$/.test(text) && !/^[,.;:)]/.test(added) ? ' ' : '';
      from = end; to = end; insert = space + added; after = text + insert;
      break;
    }
    case 'replace_text': {
      const i = find_text ? text.toLowerCase().indexOf(find_text.toLowerCase()) : -1;
      if (i === -1) {
        // aimed at a table LABEL, but the text to replace is in the value next to it ("1.9" next to "SERUM CREATININE")
        if (inTable(editor.state.doc, target) && isLockedLabel(editor.state.doc, target)) {
          const v = toValueCell(editor, blocks, target, args, text);
          if (v) return { ...applyVoiceEdit(editor, v, opts), redirected: true };
        }
        return { ok: false, error: `"${find_text}" not found in ${block_id}. Use operation "set" instead.` };
      }
      from = map[i];
      to = map[i + find_text.length - 1] + 1;
      insert = new_value;
      after = text.slice(0, i) + new_value + text.slice(i + find_text.length);
      break;
    }
    default:
      return { ok: false, error: `Unknown operation: ${operation}` };
  }

  // An uploaded file never deletes: no clearing, no emptying, no replacing text with nothing
  // (e.g. "ALP is not in the new report, so clear it"). Deleting needs a typed or spoken command.
  if (fromFile && text.trim() && (operation === 'clear' || (operation !== 'append' && !new_value.trim()))) {
    return { ok: false, blocked: true, error: 'an uploaded file cannot delete information; to remove it, give a typed or spoken command' };
  }

  // Number values in tables ("1.9 MG/DL", "3,86,000/CUMM", "40 Y") keep their unit, number style and capitals.
  // A value that would only change capitals or spacing is not changed at all.
  if (operation !== 'clear' && inTable(editor.state.doc, target) && /^\s*\d/.test(text)) {
    const kept = keepValueFormat(text, after);
    if (kept === text) return { ok: true, before, after: before, pos, unchanged: true }; // nothing really changes
    if (kept !== after) {
      from = start; to = end; insert = kept; after = kept;
    }
  }

  // Guards: labels are locked, and gender only changes when the command asked for it
  const locked = lockReason(editor.state.doc, target, operation, after);
  if (locked) {
    // "Add this inside COURSE IN HOSPITAL": the AI sometimes adds the text to the HEADING line.
    // The heading stays locked, but the new text is moved to where it belongs: under the heading.
    const head = text.trim();
    const isHeading = !inTable(editor.state.doc, target) && isLockedLabel(editor.state.doc, target);
    // (set = replace: "COURSE IN HOSPITAL: <new text>" replaces the section's text - see replaceSectionContent below)
    if (isHeading && operation !== 'set' && after.trim().toLowerCase().startsWith(head.toLowerCase())) {
      const extra = after.trim().slice(head.length).replace(/^[\s:\-–]+/, '').trim();
      if (extra) {
        const end = sectionBodyEnd(editor.state.doc, blocks, index);
        const moved =
          end === -1
            ? { ...args, block_id: `B${index}`, operation: 'insert_after', new_value: extra } // empty section: new line under the heading
            : { ...args, block_id: `B${end}`, operation: 'append', new_value: extra }; // end of the section's text
        return { ...applyVoiceEdit(editor, moved, opts), moved: true };
      }
    }
    // A table LABEL ("IP No", "SERUM CREATININE"): the label stays locked, the new value goes to the value cell
    // next to it in the same row
    if (inTable(editor.state.doc, target) && isLockedLabel(editor.state.doc, target)) {
      const v = toValueCell(editor, blocks, target, args, text);
      if (v) return { ...applyVoiceEdit(editor, v, opts), redirected: true };
    }
    // "Clear / rewrite <section>" aimed at the heading or label: the HEADING stays locked, the CONTENT changes
    // (typed and spoken commands; an uploaded file still cannot delete)
    if (!fromFile && (operation === 'set' || operation === 'clear')) {
      if (isHeading) {
        const r = replaceSectionContent(editor, blocks, index, args, opts);
        if (r) return r;
      } else if (!inTable(editor.state.doc, target)) {
        const r = replaceAfterLabel(editor, target, args, opts);
        if (r) return r;
      }
    }
    return { ok: false, blocked: true, error: locked };
  }
  if (!allowGender && changesGender(text, after)) {
    return { ok: false, blocked: true, error: 'it would change the gender, which you did not ask for' };
  }

  // Medicine lists (only inside a medicine section such as Advice)
  if (inMedicineSection(editor.state.doc, blocks, index)) {
    const lines = linesOf(node, start);
    // a NEW entry is never joined onto an existing line ("…going to sleep, Tab. DOLO …"): when the text was only ADDED
    // at the end of a line, the new medicine becomes its own line right after it; anything else is refused
    if ((operation === 'append' || operation === 'replace_text') && text.trim()) {
      const k = operation === 'append' ? lines.length - 1 : lines.findIndex((l) => l.map.includes(from));
      const line = lines[k];
      if (line && line.map.length) {
        const a = operation === 'append' ? line.text.length : line.map.indexOf(from);
        const lineAfter = line.text.slice(0, a) + insert + line.text.slice(a + (to - from));
        if (entryPieces(lineAfter).length > entryPieces(line.text).length && kindsOfLine(lineAfter).some((x) => x !== 'text')) {
          const atLineEnd = to === line.map[line.map.length - 1] + 1;
          const added = operation === 'append' ? insert
            : atLineEnd && new_value.toLowerCase().startsWith(find_text.toLowerCase()) ? new_value.slice(find_text.length) : null;
          const newMeds = added != null ? medicineLinesIn(stripLead(added)) : [];
          if (!newMeds.length) {
            return { ok: false, blocked: true, error: `this would join a new entry onto the line "${line.text.trim()}"; a new entry must be on its own line. Nothing was changed` };
          }
          const dup = isDuplicate(newMeds);
          if (dup) return { ok: false, blocked: true, error: dup };
          return operation === 'append'
            ? placeNewMedicines(editor, blocks, index, newMeds, lines.length > 1 ? k : null, args.at_start === true, args.before_entry)
            : addMedicineLines(editor, target, newMeds, lines.length > 1 ? k : null);
        }
      }
    }
    // a NEW medicine goes on its own line, never onto the end of the last medicine
    if (operation === 'append' && text.trim()) {
      const medLines = medicineLinesIn(stripLead(new_value));
      if (medLines.length) {
        const dup = isDuplicate(medLines);
        if (dup) return { ok: false, blocked: true, error: dup };
        return placeNewMedicines(editor, blocks, index, medLines, null, args.at_start === true, args.before_entry);
      }
      // a new instruction ("Take only if ...", "Avoid oily food.") after a medicine line is a NEW line, never glued
      // onto that medicine: text that starts like a sentence (a capital letter, two or more words), or a whole
      // sentence after a dash ("— Take only if the temperature is above 100 F": five or more words before any further
      // dash). Text that only continues the line (", SOS", "— 5 days", "— Once Daily before food", "for 5 days") is
      // still appended.
      const added = new_value.trim();
      const lastLine = lines[lines.length - 1].text;
      const afterDash = added.match(/^[—–-]\s*(.+)$/u)?.[1] || '';
      const sentenceAfterDash = /^\p{Lu}/u.test(afterDash) && afterDash.split(/\s+[—–-]\s+/u)[0].split(/\s+/).length >= 5;
      if (isMedicineLine(lastLine) && ((/^\p{Lu}/u.test(added) && added.split(/\s+/).length >= 2) || sentenceAfterDash)) {
        return addNewLines(editor, target, [sentenceAfterDash ? afterDash.trim() : added]);
      }
    }
    const count = medicineCount(lines);
    // The AI sent the WHOLE list again (an uploaded prescription, or "change the Dolo dose"): compare it line by
    // line. Added medicines go on their own lines; changed medicines change only their own line. A list that would
    // lose a medicine is refused (removing has its own command with a confirm window).
    if (operation === 'set' && count >= 1 && (count >= 2 || proposedLines(new_value).length > 1)) {
      const plan = medicineListUpdate(lines, new_value);
      if (plan?.same) return { ok: true, before, after: before, pos, unchanged: true };
      if (plan?.add) {
        const dup = isDuplicate(plan.add);
        if (dup) return { ok: false, blocked: true, error: dup };
        return addMedicineLines(editor, target, plan.add);
      }
      if (plan?.change) return changeMedicineLines(editor, target, plan.change);
      return {
        ok: false,
        blocked: true,
        error: `this paragraph contains ${count} medicine${count > 1 ? 's' : ''}; the proposed list would remove or rewrite medicines, which is not allowed here. To remove a medicine say "remove ...", to change one say which medicine to change`,
      };
    }
    if (count >= 2) {
      // never overwrite or empty a whole list of medicines at once (whole-section clearing has its own command)
      if (operation === 'clear') {
        return {
          ok: false,
          blocked: true,
          error: `this paragraph contains ${count} medicines; changing them all at once is not allowed. Say which medicine to change`,
        };
      }
      // a text replacement must stay inside ONE medicine: never across a line break or into the next medicine
      if (operation === 'replace_text') {
        const i = text.toLowerCase().indexOf(find_text.toLowerCase());
        const last = i + find_text.length - 1;
        const crossesBreak = map[last] - map[i] !== last - i; // a line break sits inside the range
        const crossesMedicine = [...text.matchAll(MID_MEDICINE)].some((m) => m.index > i && m.index <= last);
        if (crossesBreak || crossesMedicine) {
          return { ok: false, blocked: true, error: 'the text to replace spans more than one medicine line; that would merge medicine lines' };
        }
      }
    }
  }

  // An uploaded file may add to a paragraph of text, but not replace it with something different
  // (table values, short fields and one medicine line may change: they are shown in the upload preview)
  if (fromFile && operation === 'set' && !inTable(editor.state.doc, target) && text.trim().length > 40 &&
      !squash(new_value).includes(squash(text)) && !(isMedicineLine(text) && isMedicineLine(new_value))) {
    return { ok: false, blocked: true, error: 'the file would replace the existing text of this paragraph; a file may add to it, but not replace it' };
  }

  // Removing ONE WHOLE LINE of a paragraph with line breaks ("remove Drink plenty of water"): its line break goes
  // too, so no empty line is left and the lines around it are never joined
  if (operation === 'replace_text' && !new_value && !fromFile) {
    const lines = linesOf(node, start);
    if (lines.length > 1) {
      const k = lines.findIndex((l) => l.map.length && l.map[0] === from && l.map[l.map.length - 1] + 1 === to);
      if (k > 0) from = lines[k - 1].map.length ? lines[k - 1].map[lines[k - 1].map.length - 1] + 1 : from - 1; // the break before it
      else if (k === 0) to += 1; // the first line: the break after it
    }
  }

  // Emptying a block (clear, or set / replace_text that leaves no text) - never for an uploaded file:
  //   - the only paragraph of a LIST ITEM: the whole item goes, so no empty numbered entry is left (the numbers of the
  //     other items follow by themselves; a list without numbers never gets any). The list's only item: the list
  //     goes, or, when nothing else is in the section, an empty paragraph stays in its place.
  //   - a paragraph of its own (not a table cell) when its section has other text: the empty paragraph goes too (a
  //     removed instruction leaves no blank line). A section's only paragraph stays, empty.
  const empties = !fromFile && text.trim() && !after.trim() && (operation === 'clear' || operation === 'set' || operation === 'replace_text');
  const otherText = () => sectionBlocks(editor.state.doc, blocks, index).some((b) => b !== target && b.node.textContent.trim());
  if (empties) {
    const item = listItemOf(editor.state.doc, pos);
    if (item) {
      let tr = editor.state.tr;
      if (item.list.childCount > 1) tr = tr.delete(item.from, item.to);
      else if (item.listParent.childCount > 1 && otherText()) tr = tr.delete(item.listPos, item.listPos + item.list.nodeSize);
      else tr = tr.replaceWith(item.listPos, item.listPos + item.list.nodeSize, editor.schema.nodes.paragraph.create());
      editor.view.dispatch(tr);
      scheduleClear(editor);
      return { ok: true, before, after: '', pos: Math.min(item.from, tr.doc.content.size) };
    }
    if (editor.state.doc.resolve(pos).depth === 0 && otherText()) {
      const tr = editor.state.tr.delete(pos, pos + node.nodeSize);
      editor.view.dispatch(tr);
      scheduleClear(editor);
      return { ok: true, before, after: '', pos: Math.min(pos, tr.doc.content.size) };
    }
  }

  const tr = editor.state.tr.insertText(insert, from, to);
  const changed = tr.doc.nodeAt(pos);
  tr.setMeta(flashKey, { add: { from: pos, to: pos + changed.nodeSize } });
  editor.view.dispatch(tr);
  scheduleClear(editor);

  return { ok: true, before, after: changed.textContent, pos };
}

// If the patient's age or gender in the header changed (factsBefore -> now), update every
// narrative phrase like "60 -YEAR OLD FEMALE" to match. Changed blocks are highlighted too.
export function applyPatientConsistency(editor, factsBefore) {
  const now = getPatientFacts(editor.state.doc);
  const ageChanged = now.age && now.age !== factsBefore.age;
  const genderChanged = now.gender && now.gender !== factsBefore.gender;
  if (!ageChanged && !genderChanged) return [];

  const changes = syncPatientFacts(editor, now, (tr, pos, node) => {
    tr.setMeta(flashKey, { add: { from: pos, to: pos + node.nodeSize } });
  });
  if (changes.length) scheduleClear(editor);
  return changes;
}
// Makes age and gender the same EVERYWHERE (also repairs places that were already wrong).
// targetGender: the gender the user just set somewhere (e.g. in Course in Hospital). It becomes the
// header value too. Without it, the header is the truth and the rest of the document follows it.
// Returns the changed blocks: [{ pos, before, after }]
// only (optional): limit the narrative fixes to these blocks ((node) => boolean), e.g. the text a command just wrote:
// Patient Details stay the truth and no other section is touched.
export function ensurePatientConsistency(editor, targetGender = null, only = null) {
  const flash = (tr, pos, node) => tr.setMeta(flashKey, { add: { from: pos, to: pos + node.nodeSize } });
  const changes = [];
  if (targetGender) {
    const c = setHeaderGender(editor, targetGender, flash);
    if (c) changes.push(c);
  }
  const facts = getPatientFacts(editor.state.doc);
  if (targetGender) facts.gender = targetGender;
  changes.push(...syncPatientFacts(editor, facts, flash, only));
  if (changes.length) scheduleClear(editor);
  return changes;
}
