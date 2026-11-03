import { getBlocks } from './outline';
import { flashKey } from './flash';

// Applies ONE edit instruction from the model to ONE text block. Everything else stays untouched.
// Formatting (bold, italic...) of the edited text is preserved by ProseMirror's insertText.
export function applyVoiceEdit(editor, { block_id, operation, new_value = '', find_text = '' }) {
  const index = parseInt(String(block_id).replace(/\D/g, ''), 10);
  const blocks = getBlocks(editor.state.doc);
  const target = blocks[index];
  if (!target) return { ok: false, error: `Block ${block_id} does not exist` };

  const { pos, node } = target;
  const start = pos + 1; // first position inside the block
  const end = pos + node.nodeSize - 1; // last position inside the block
  const before = node.textContent;

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
  tr.setMeta(flashKey, { from: pos, to: pos + changed.nodeSize });
  editor.view.dispatch(tr);

  setTimeout(() => {
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(flashKey, null).setMeta('addToHistory', false));
  }, 2500);

  return { ok: true, before, after: changed.textContent };
}
