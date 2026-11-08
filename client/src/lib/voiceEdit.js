import { getBlocks } from './outline';
import { flashKey } from './flash';
import { getPatientFacts, syncPatientFacts, setHeaderGender } from './consistency';
import { lockReason, changesGender, isLockedLabel, isLabelText } from './guards';

export { getPatientFacts };

const HIGHLIGHT_MS = 5000; // how long changed text stays highlighted (5 seconds)
let clearTimer;

// One shared timer: every new edit restarts it, so all highlights from one batch
// disappear together, 5 seconds after the LAST change.
function scheduleClear(editor) {
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

// Applies ONE edit instruction to ONE text block. Everything else stays untouched.
// Formatting (bold, italic...) of the edited text is preserved by ProseMirror's insertText.
// allowGender = false: refuse edits that change gender words (the command did not mention gender)
export function applyVoiceEdit(editor, args, { allowGender = true } = {}) {
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
    const insertPos = pos + node.nodeSize;
    const para = editor.schema.nodes.paragraph.create(null, editor.schema.text(new_value));
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
    case 'append':
      from = end; to = end; insert = before ? ` ${new_value}` : new_value; after = text + insert;
      break;
    case 'replace_text': {
      const i = find_text ? text.toLowerCase().indexOf(find_text.toLowerCase()) : -1;
      if (i === -1) return { ok: false, error: `"${find_text}" not found in ${block_id}. Use operation "set" instead.` };
      from = map[i];
      to = map[i + find_text.length - 1] + 1;
      insert = new_value;
      after = text.slice(0, i) + new_value + text.slice(i + find_text.length);
      break;
    }
    default:
      return { ok: false, error: `Unknown operation: ${operation}` };
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
        return { ...applyVoiceEdit(editor, moved, { allowGender }), moved: true };
      }
    }
    return { ok: false, blocked: true, error: locked };
  }
  if (!allowGender && changesGender(text, after)) {
    return { ok: false, blocked: true, error: 'it would change the gender, which you did not ask for' };
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
