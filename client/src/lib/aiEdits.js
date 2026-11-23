// Gemini's list of edits, prepared ONCE when the answer arrives (App.jsx runEdits), so the deletion check, the dry
// run, the confirmation window and the editor all see exactly the same edits:
//   withRealLineBreaks - a line break Gemini escaped twice ("\" + "n" as two characters) becomes a real line break
//   bottomUp           - the order the edits are applied in
// No content is logged here.

// new_value holding "\n" as two characters (backslash + n, also "\r\n") -> a real line break. Other fields and
// edits without it are returned unchanged (the same object). applyVoiceEdit (voiceEdit.js) does exactly the same
// (its own copy, so it needs no import; tests/stage1Safety.test.mjs checks that both give the same result).
export function withRealLineBreaks(edit) {
  if (typeof edit?.new_value === 'string' && /\\n/.test(edit.new_value)) {
    return { ...edit, new_value: edit.new_value.replace(/(?:\\r)?\\n/g, '\n') };
  }
  return edit;
}

const blockNo = (ed) => {
  const n = parseInt(String(ed?.block_id).replace(/\D/g, ''), 10);
  return Number.isNaN(n) ? -1 : n;
};

// The order the edits are applied in:
//   - different blocks: from the bottom of the document upwards, so a newly inserted line never shifts the blocks
//     that are still waiting to be edited
//   - the same block: in Gemini's order ("set" then "append" -> the append is kept; two appends stay in order)
//   - except insert_after: each one goes DIRECTLY after its block (or after the line / table row it names), so
//     several insert_after edits of one block are applied last-first - then they read in Gemini's order. They keep
//     their places among the other edits of that block.
//   - insert_before: applied AFTER the other edits of its block (a new line before a block moves that block's
//     number down, so an edit applied later would hit the new line). Several insert_before edits of one block with
//     the same find_text become ONE edit (their lines joined in Gemini's order), so they read in Gemini's order in
//     every layout (list items, lines of a paragraph, paragraphs).
export function bottomUp(edits) {
  return withInsertBeforeLast(insertAfterOrder(edits));
}

const isBefore = (ed) => ed?.operation === 'insert_before';
function withInsertBeforeLast(sorted) {
  const out = [];
  for (let s = 0; s < sorted.length;) {
    let e = s;
    while (e < sorted.length && blockNo(sorted[e]) === blockNo(sorted[s])) e++;
    const group = sorted.slice(s, e);
    const merged = new Map(); // find_text -> one insert_before edit
    const alone = []; // an insert_before without text: kept as it is (applyVoiceEdit refuses it with its reason)
    for (const ed of group.filter(isBefore)) {
      if (typeof ed.new_value !== 'string') { alone.push(ed); continue; }
      const key = String(ed.find_text ?? '').trim();
      const m = merged.get(key);
      if (!m) merged.set(key, { ...ed });
      else {
        m.new_value = `${m.new_value}\n${ed.new_value}`;
        if (ed.duplicate_ok === true) m.duplicate_ok = true;
      }
    }
    out.push(...group.filter((ed) => !isBefore(ed)), ...merged.values(), ...alone);
    s = e;
  }
  return out;
}

function insertAfterOrder(edits) {
  const sorted = edits
    .map((ed, i) => ({ ed, i }))
    .sort((a, b) => blockNo(b.ed) - blockNo(a.ed) || a.i - b.i)
    .map((x) => x.ed);
  const out = [];
  for (let s = 0; s < sorted.length;) {
    let e = s;
    while (e < sorted.length && blockNo(sorted[e]) === blockNo(sorted[s])) e++;
    const group = sorted.slice(s, e);
    const slots = group.map((ed, k) => (ed?.operation === 'insert_after' ? k : -1)).filter((k) => k >= 0);
    const inserts = slots.map((k) => group[k]).reverse();
    slots.forEach((k, j) => { group[k] = inserts[j]; });
    out.push(...group);
    s = e;
  }
  return out;
}
