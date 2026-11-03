import { getBlocks } from './outline';
import { flashKey } from './flash';

// Read aloud with the browser's built-in speech engine: free, no key, no model.

let runId = 0; // lets us ignore events from a reading that was already stopped

export const ttsSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

// Highlights the block being read (index -1 clears the highlight)
function setHighlight(editor, index) {
  if (!editor || editor.isDestroyed) return;
  const b = getBlocks(editor.state.doc)[index];
  const meta = b ? { from: b.pos, to: b.pos + b.node.nodeSize } : null;
  editor.view.dispatch(editor.state.tr.setMeta(flashKey, meta).setMeta('addToHistory', false));
}

export function stopReading(editor) {
  runId++;
  if (ttsSupported()) window.speechSynthesis.cancel();
  setHighlight(editor, -1);
}

export function readDocument(editor, { onEnd } = {}) {
  const synth = window.speechSynthesis;
  const id = ++runId;
  synth.cancel();

  const blocks = getBlocks(editor.state.doc)
    .map((b) => ({
      index: b.index,
      text: b.node.textContent.replace(/[—–]/g, ', ').replace(/\s+/g, ' ').trim(),
    }))
    .filter((b) => b.text);

  if (!blocks.length) { onEnd?.(); return; }

  const finish = () => {
    if (id !== runId) return;
    setHighlight(editor, -1);
    onEnd?.();
  };

  // One utterance per block: long single utterances get cut off by Chrome after ~15 seconds
  blocks.forEach((b, i) => {
    const u = new SpeechSynthesisUtterance(b.text);
    u.onstart = () => { if (id === runId) setHighlight(editor, b.index); };
    u.onend = () => { if (i === blocks.length - 1) finish(); };
    u.onerror = (e) => { if (e.error !== 'canceled' && e.error !== 'interrupted') finish(); };
    synth.speak(u);
  });
}