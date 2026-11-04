import { getBlocks } from './outline';
import { flashKey } from './flash';
import { scrollToFirstChange } from './scroll';

let timer;

// Highlights every block that still says "Not Specified" and scrolls to the first one.
// Returns how many were found.
export function findMissingFields(editor, ms = 5000) {
  const missing = getBlocks(editor.state.doc).filter((b) =>
    /^not specified\.?$/i.test(b.node.textContent.trim())
  );
  if (!missing.length) return 0;

  editor.view.dispatch(editor.state.tr.setMeta(flashKey, null).setMeta('addToHistory', false));
  for (const b of missing) {
    editor.view.dispatch(
      editor.state.tr
        .setMeta(flashKey, { add: { from: b.pos, to: b.pos + b.node.nodeSize } })
        .setMeta('addToHistory', false)
    );
  }
  scrollToFirstChange(editor);

  clearTimeout(timer);
  timer = setTimeout(() => {
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(flashKey, null).setMeta('addToHistory', false));
  }, ms);

  return missing.length;
}