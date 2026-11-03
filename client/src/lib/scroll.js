import { getFlashRanges } from './flash';

// Smoothly scrolls the page so the block at document position `pos` is in the middle of the screen.
// onlyIfHidden = true: do nothing when the block is already fully visible.
export function scrollToPos(editor, pos, onlyIfHidden = false) {
  let el = null;
  try {
    el = editor.view.nodeDOM(pos);
  } catch {
    return;
  }
  if (el && el.nodeType === 3) el = el.parentElement;
  if (!el || !el.scrollIntoView) return;

  if (onlyIfHidden) {
    const box = el.getBoundingClientRect();
    const area = (el.closest('.desk') || document.documentElement).getBoundingClientRect();
    const visible = box.top >= area.top + 8 && box.bottom <= area.bottom - 8;
    if (visible) return;
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Scrolls to the highest changed block that is currently highlighted
export function scrollToFirstChange(editor) {
  const ranges = getFlashRanges(editor.state);
  if (!ranges.length) return;
  scrollToPos(editor, Math.min(...ranges.map((r) => r.from)), false);
}