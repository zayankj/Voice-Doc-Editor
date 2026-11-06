import { getBlocks } from './outline';
import { flashKey } from './flash';
import { getPatientFacts, syncPatientFacts } from './consistency';

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

// Applies ONE edit instruction to ONE text block. Everything else stays untouched.
// Formatting (bold, italic...) of the edited text is preserved by ProseMirror's insertText.
export function applyVoiceEdit(editor, args) {
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
  switch (operation) {
    case 'set':
      from = start; to = end; insert = new_value;
      break;
    case 'clear':
      from = start; to = end; insert = '';
      break;
    case 'append':
      from = end; to = end; insert = before ? ` ${new_value}` : new_value;
      break;
    case 'replace_text': {
      const i = find_text ? text.toLowerCase().indexOf(find_text.toLowerCase()) : -1;
      if (i === -1) return { ok: false, error: `"${find_text}" not found in ${block_id}. Use operation "set" instead.` };
      from = map[i];
      to = map[i + find_text.length - 1] + 1;
      insert = new_value;
      break;
    }
    default:
      return { ok: false, error: `Unknown operation: ${operation}` };
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