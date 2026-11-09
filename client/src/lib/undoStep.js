import { closeHistory } from '@tiptap/pm/history';

// Runs fn() so that EVERY document change it makes becomes ONE undo step, even when the changes are far
// apart in the document (the editor's history normally only joins changes that are close together and
// within 500 ms). Used for one AI instruction that changes several places ("change the age to 31").
//
//   - the first change starts a NEW undo step (closeHistory), so it is never joined with earlier typing
//   - every later change is marked as part of that step ("appendedTransaction": the marker ProseMirror
//     itself uses for follow-up changes that belong to an earlier change)
//   - changes that are not in the undo history (highlights) are left alone
//
// fn must be synchronous. The editor's normal dispatch is always restored, also after an error.
export function asOneUndoStep(view, fn) {
  const original = view.dispatch;
  const ownProperty = Object.prototype.hasOwnProperty.call(view, 'dispatch'); // the real editor: a class method
  let first = null;
  view.dispatch = (tr) => {
    if (tr.docChanged && tr.getMeta('addToHistory') !== false) {
      if (!first) {
        closeHistory(tr);
        first = tr;
      } else {
        tr.setMeta('appendedTransaction', first);
      }
    }
    return original.call(view, tr);
  };
  try {
    return fn();
  } finally {
    if (ownProperty) view.dispatch = original;
    else delete view.dispatch; // back to the class method, exactly as before
  }
}
