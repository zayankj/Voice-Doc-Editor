import { getBlocks } from './outline';
import { flashKey } from './flash';
import { getPatientFacts, syncPatientFacts, setHeaderGender } from './consistency';
import { lockReason, changesGender, isLockedLabel, isLabelText } from './guards';
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
const FORM_START = /^\s*(?:tab|tabs|tablet|tablets|cap|caps|capsule|capsules|syp|syr|syrup|syrups|susp|suspension|inj|injection|drop|drops|oint|ointment|cream|gel|lotion|sachet|powder|inhaler|neb|nebulisation|nebulization|spray|rotacap)\.?\s+\S/i;
// a medicine that starts in the middle of a line ("... 2 daysTab. METRONIDAZOLE ...")
const MID_MEDICINE = /(?:Tab|Tabs|Cap|Caps|Syp|Syr|Inj|Susp)\.\s+(?=[A-Za-z(])/gi;
const isMedicineLine = (t) => FORM_START.test(t);

// Is this block inside a medicine section? (the nearest section heading above it is Advice / Medications ...)
function inMedicineSection(doc, blocks, index) {
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
function addMedicineLines(editor, target, newLines) {
  const { pos, node } = target;
  const schema = editor.schema;
  const usesLineBreaks = linesOf(node, pos + 1).length > 1;
  let tr = editor.state.tr;
  if (usesLineBreaks) {
    // same paragraph: line break + medicine, for each new medicine (highlight the paragraph)
    const end = pos + node.nodeSize - 1;
    tr = tr.insert(end, newLines.flatMap((l) => [schema.nodes.hardBreak.create(), schema.text(l)]));
    tr.setMeta(flashKey, { add: { from: pos, to: pos + tr.doc.nodeAt(pos).nodeSize } });
  } else {
    // medicines in separate paragraphs: one new paragraph per medicine (highlight the first new one)
    const at = pos + node.nodeSize;
    const paragraphs = newLines.map((l) => schema.nodes.paragraph.create(null, schema.text(l)));
    tr = tr.insert(at, paragraphs);
    tr.setMeta(flashKey, { add: { from: at, to: at + paragraphs[0].nodeSize } });
  }
  editor.view.dispatch(tr);
  scheduleClear(editor);
  // before = '' : nothing existing changes, lines are only ADDED (the upload preview must not look like a deletion)
  return { ok: true, before: '', after: newLines.join('\n'), pos };
}

const squash = (t) => String(t).replace(/\s+/g, ' ').trim().toLowerCase();
// "Tab. DOLO (Paracetamol) 650 mg" -> "tab dolo": the form and the name of a medicine
const medicineKey = (t) => squash(t).replace(/[.()]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');

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

  // Add a NEW paragraph after this block (used by file uploads)
  if (operation === 'insert_after') {
    if (!new_value.trim()) return { ok: false, error: 'insert_after needs new_value' };
    if (!allowGender && changesGender('', new_value)) {
      return { ok: false, blocked: true, error: 'it would add gender details you did not ask for' };
    }
    // inside a table cell: a new ROW ("CRP | 48.9 MG/L"), never a paragraph pushed into the cell.
    // (A single value added to a cell of an ordinary table, e.g. a second address line, works as before.)
    const cellInfo = cellAt(editor.state.doc, pos);
    if (cellInfo && (isDataTable(cellInfo.table) || new_value.includes('|'))) return addTableRow(editor, cellInfo, new_value);
    // a medicine added to a medicine list: each medicine on its own line, in the same layout as the list
    if (inMedicineSection(editor.state.doc, blocks, index) && node.textContent.trim()) {
      const medLines = medicineLinesIn(new_value);
      if (medLines.length) return addMedicineLines(editor, target, medLines);
    }
    const insertPos = pos + node.nodeSize;
    // a new line never starts or ends with stray spaces
    const para = editor.schema.nodes.paragraph.create(null, editor.schema.text(new_value.trim()));
    const tr = editor.state.tr.insert(insertPos, para);
    tr.setMeta(flashKey, { add: { from: insertPos, to: insertPos + para.nodeSize } });
    editor.view.dispatch(tr);
    scheduleClear(editor);
    return { ok: true, before: '', after: new_value, pos: insertPos };
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
    if (isHeading && after.trim().toLowerCase().startsWith(head.toLowerCase())) {
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
    return { ok: false, blocked: true, error: locked };
  }
  if (!allowGender && changesGender(text, after)) {
    return { ok: false, blocked: true, error: 'it would change the gender, which you did not ask for' };
  }

  // Medicine lists (only inside a medicine section such as Advice)
  if (inMedicineSection(editor.state.doc, blocks, index)) {
    const lines = linesOf(node, start);
    // a NEW medicine goes on its own line, never onto the end of the last medicine
    if (operation === 'append' && text.trim()) {
      const medLines = medicineLinesIn(new_value);
      if (medLines.length) return addMedicineLines(editor, target, medLines);
    }
    const count = medicineCount(lines);
    // The AI sent the WHOLE list again (an uploaded prescription, or "change the Dolo dose"): compare it line by
    // line. Added medicines go on their own lines; changed medicines change only their own line. A list that would
    // lose a medicine is refused (removing has its own command with a confirm window).
    if (operation === 'set' && count >= 1 && (count >= 2 || proposedLines(new_value).length > 1)) {
      const plan = medicineListUpdate(lines, new_value);
      if (plan?.same) return { ok: true, before, after: before, pos, unchanged: true };
      if (plan?.add) return addMedicineLines(editor, target, plan.add);
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
export function ensurePatientConsistency(editor, targetGender = null) {
  const flash = (tr, pos, node) => tr.setMeta(flashKey, { add: { from: pos, to: pos + node.nodeSize } });
  const changes = [];
  if (targetGender) {
    const c = setHeaderGender(editor, targetGender, flash);
    if (c) changes.push(c);
  }
  const facts = getPatientFacts(editor.state.doc);
  if (targetGender) facts.gender = targetGender;
  changes.push(...syncPatientFacts(editor, facts, flash));
  if (changes.length) scheduleClear(editor);
  return changes;
}
