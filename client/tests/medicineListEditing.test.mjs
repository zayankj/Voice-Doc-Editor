// Medicine list editing (MOCKED AI edits on real TipTap documents - no Gemini call here). Dummy medicines only.
//   PART 1  removing a medicine from a numbered / bulleted list: the whole item goes, no empty numbered entry is left,
//           the numbers follow by themselves, an unnumbered list never gets numbers; one Undo restores everything
//   PART 2  where a new medicine goes: "at the top" -> before the first medicine (only from the PERSON'S words),
//           "after X" -> after X, nothing said / "at the end" -> after the last medicine; nothing is ever replaced
//   PART 3  wording: words said such as "TO CONTINUE" are kept; unsaid details are still removed / refused
// Run:  cd client  &&  node --test tests/
// voiceEdit.js imports its neighbours without ".js" (fine for Vite, not for plain Node), so this test makes a
// temporary copy with the endings added, imports it, and deletes the copy afterwards.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState } from '@tiptap/pm/state';
import { history, undo, undoDepth } from '@tiptap/pm/history';
import {  } from '../src/lib/medicineText.js';
import {  } from '../src/lib/sections.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-medlist');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'medicineText', 'sections']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit]);
const BOLD = () => [schema.marks.bold.create()];
const t = (s, m) => schema.text(s, m);
const br = () => schema.nodes.hardBreak.create();
const para = (...k) => schema.node('paragraph', null, k);
const heading = (s) => para(t(s, BOLD()));
const brPara = (lines) => para(...lines.flatMap((l, i) => (i ? [br(), t(l)] : [t(l)])));
const list = (type, lines) => schema.node(type, null, lines.map((l) => schema.node('listItem', null, [para(t(l))])));

const MEDS = [
  'Tab. CIPLOX 500 mg — Twice Daily — 5 days',
  'Tab. DOLO 650 mg — As Needed (SOS)',
  'Cap. PAN-D 40 mg — Once Daily — 5 days',
  'Syp. CREMAFFIN 15 ml — At night',
];
const NEW_MED = 'Tab. AMOXICILLIN 500 mg — To continue';

// blocks: B0 DIAGNOSIS, B1 text, B2 ADVICE, B3.. advice blocks, then FOLLOW UP + text
class FakeView { constructor(o) { this.o = o; } dispatch(tr) { this.o.state = this.o.state.apply(tr); } }
function makeEditor(adviceBlocks) {
  const doc = schema.node('doc', null, [heading('DIAGNOSIS'), para(t('ENTERIC FEVER')), heading('ADVICE'), ...adviceBlocks,
    heading('FOLLOW UP'), para(t('Review after 5 days'))]);
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), schema, isDestroyed: false };
  ed.view = new FakeView(ed);
  return ed;
}
const done = (ed) => { ed.isDestroyed = true; };
const child = (ed, i) => ed.state.doc.child(i);
const linesOf = (node) => { const out = ['']; node.forEach((n) => { if (n.isText) out[out.length - 1] += n.text; else out.push(''); }); return out; };
// the list right after the ADVICE heading: its type and the text of each item
const listAt = (ed, i = 3) => ({ type: child(ed, i).type.name, items: Array.from({ length: child(ed, i).childCount }, (_, k) => child(ed, i).child(k).textContent) });
const undoAll = (ed) => undo(ed.state, (tr) => { ed.state = ed.state.apply(tr); });

// ---------------- PART 1: removing ----------------




for (const [label, edit] of [
  ['clear', { operation: 'clear' }],
  ['set ""', { operation: 'set', new_value: '' }],
  ['replace_text -> ""', { operation: 'replace_text', find_text: MEDS[1], new_value: '' }],
]) {
  test(`AI edit ${label} on a numbered-list medicine -> the item goes, the others renumber`, () => {
    const ed = makeEditor([list('orderedList', MEDS)]);
    const original = ed.state.doc;
    const r = applyVoiceEdit(ed, { block_id: 'B4', ...edit }); // B4 = the DOLO item
    assert.equal(r.ok, true, r.error);
    const l = listAt(ed);
    assert.equal(l.type, 'orderedList');
    assert.deepEqual(l.items, [MEDS[0], MEDS[2], MEDS[3]]);
    undoAll(ed);
    assert.ok(ed.state.doc.eq(original));
    done(ed);
  });

  test(`AI edit ${label} on a plain-paragraph medicine -> no blank line left`, () => {
    const ed = makeEditor(MEDS.map((m) => para(t(m))));
    const r = applyVoiceEdit(ed, { block_id: 'B4', ...edit });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual([3, 4, 5].map((i) => child(ed, i).textContent), [MEDS[0], MEDS[2], MEDS[3]]);
    assert.equal(child(ed, 6).textContent, 'FOLLOW UP');
    done(ed);
  });
}

test('AI clears the only medicine and nothing else is in the section -> an empty paragraph, no list, heading kept', () => {
  const ed = makeEditor([list('orderedList', [MEDS[1]])]);
  assert.equal(applyVoiceEdit(ed, { block_id: 'B3', operation: 'clear' }).ok, true);
  assert.equal(child(ed, 2).textContent, 'ADVICE');
  assert.equal(child(ed, 3).type.name, 'paragraph');
  assert.equal(child(ed, 3).textContent, '');
  assert.equal(child(ed, 4).textContent, 'FOLLOW UP');
  done(ed);
});

test('a list item with a nested list is not deleted by emptying its own line (only fully empty items go)', () => {
  const nested = schema.node('listItem', null, [para(t(MEDS[0])), list('bulletList', [MEDS[1]])]);
  const ed = makeEditor([schema.node('orderedList', null, [nested, schema.node('listItem', null, [para(t(MEDS[2]))])])]);
  const r = applyVoiceEdit(ed, { block_id: 'B3', operation: 'set', new_value: '' });
  assert.equal(r.ok, true);
  assert.equal(child(ed, 3).childCount, 2); // both items still there
  assert.ok(child(ed, 3).textContent.includes('DOLO'));
  done(ed);
});

// ---------------- PART 2: where a new medicine goes ----------------
const LAYOUTS = {
  'numbered list': () => [list('orderedList', MEDS)],
  'bulleted list': () => [list('bulletList', MEDS)],
  'one paragraph with line breaks': () => [brPara(MEDS)],
  'separate paragraphs': () => MEDS.map((m) => para(t(m))),
};

for (const [layout, blocks] of Object.entries(LAYOUTS)) {
}

test('"after DOLO" -> right after DOLO in a numbered list (also with the top flag: the medicine the AI named wins)', () => {
  for (const flag of [false, true]) {
    const ed = makeEditor([list('orderedList', MEDS)]);
    assert.equal(applyVoiceEdit(ed, { block_id: 'B4', operation: 'insert_after', new_value: NEW_MED, at_start: flag }).ok, true);
    assert.deepEqual(listAt(ed).items, [MEDS[0], MEDS[1], NEW_MED, MEDS[2], MEDS[3]]);
    done(ed);
  }
});

test('"before PAN-D" (the AI aims at the medicine just before it, DOLO) -> directly before PAN-D', () => {
  const ed = makeEditor([list('orderedList', MEDS)]);
  assert.equal(applyVoiceEdit(ed, { block_id: 'B4', operation: 'insert_after', new_value: NEW_MED }).ok, true);
  assert.equal(listAt(ed).items.indexOf(NEW_MED) + 1, listAt(ed).items.indexOf(MEDS[2]));
  done(ed);
});

test('"at the end" (the AI aims at the last medicine) -> last item', () => {
  const ed = makeEditor([list('orderedList', MEDS)]);
  assert.equal(applyVoiceEdit(ed, { block_id: 'B6', operation: 'insert_after', new_value: NEW_MED }).ok, true);
  assert.deepEqual(listAt(ed).items, [...MEDS, NEW_MED]);
  done(ed);
});

// ---------------- the "top" flag comes from the PERSON'S words only ----------------



// ---------------- PART 3: wording ----------------




// ---------------- PART 4: "before X" - the medicine X comes from the PERSON'S words ----------------
const LAYOUT_BLOCKS = {
  'numbered list': { blocks: () => [list('orderedList', MEDS)], last: 'B6' },
  'one paragraph with line breaks': { blocks: () => [brPara(MEDS)], last: 'B3' },
  'separate paragraphs': { blocks: () => MEDS.map((m) => para(t(m))), last: 'B6' },
};

for (const [layout, { blocks, last }] of Object.entries(LAYOUT_BLOCKS)) {
  for (const [where, said, expected] of [
    ['first', 'add tab amoxicillin 500 mg to continue before ciplox', [NEW_MED, ...MEDS]],
    ['middle', 'add tab amoxicillin 500 mg to continue before pan-d', [MEDS[0], MEDS[1], NEW_MED, MEDS[2], MEDS[3]]],
    ['last', 'Add TAB. AMOXICILLIN 500 MG TO CONTINUE before Cremaffin.', [MEDS[0], MEDS[1], MEDS[2], NEW_MED, MEDS[3]]],
    ['"the first medicine"', 'add tab amoxicillin 500 mg to continue before the first medicine', [NEW_MED, ...MEDS]],
  ]) {
  }
}




