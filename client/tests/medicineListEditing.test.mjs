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
import { planEntryRemoval, applyRemovals, sectionEntries } from '../src/lib/medicineText.js';
import { getSections } from '../src/lib/sections.js';
import { checkMedicineEdits, withDuplicateChoice } from '../src/lib/verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-medlist');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables']) {
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
const advice = (ed) => getSections(ed.state.doc).find((s) => s.title === 'ADVICE');
const entries = (ed) => sectionEntries(ed.state.doc, advice(ed)).map((e) => e.text);
const removeByName = (ed, name) => applyRemovals(ed, planEntryRemoval(ed.state.doc, advice(ed), { names: [name] }));
const undoAll = (ed) => undo(ed.state, (tr) => { ed.state = ed.state.apply(tr); });

// ---------------- PART 1: removing ----------------
for (const type of ['orderedList', 'bulletList']) {
  for (const [where, name, k] of [['first', 'Ciplox', 0], ['middle', 'Dolo', 1], ['last', 'Cremaffin', 3]]) {
    test(`remove the ${where} medicine of a ${type} (confirm-removal path) -> the item goes, no empty entry`, () => {
      const ed = makeEditor([list(type, MEDS)]);
      const original = ed.state.doc;
      assert.equal(removeByName(ed, name).ok, true);
      const l = listAt(ed);
      assert.equal(l.type, type); // a numbered list stays numbered, a bulleted list never gets numbers
      assert.deepEqual(l.items, MEDS.filter((_, i) => i !== k)); // order and text of the others unchanged
      assert.ok(l.items.every((x) => x.trim()), 'no empty entry');
      assert.equal(child(ed, 3).attrs.start ?? 1, original.child(3).attrs.start ?? 1); // numbering still from 1
      assert.equal(undoDepth(ed.state), 1);
      undoAll(ed);
      assert.ok(ed.state.doc.eq(original), 'one Undo restores the exact original');
      done(ed);
    });
  }
}

test('remove two medicines of a numbered list at once (selected in the confirm window) -> both items go', () => {
  const ed = makeEditor([list('orderedList', MEDS)]);
  const p = planEntryRemoval(ed.state.doc, advice(ed), { names: ['Dolo', 'Pan-D'] });
  assert.equal(applyRemovals(ed, p).ok, true);
  assert.deepEqual(listAt(ed).items, [MEDS[0], MEDS[3]]);
  done(ed);
});

test('remove the ONLY medicine of a numbered list -> no empty list is left', () => {
  const ed = makeEditor([list('orderedList', [MEDS[1]]), para(t('Drink plenty of water'))]);
  assert.equal(removeByName(ed, 'Dolo').ok, true);
  assert.equal(child(ed, 3).type.name, 'paragraph');
  assert.equal(child(ed, 3).textContent, 'Drink plenty of water');
  assert.ok(!JSON.stringify(ed.state.doc.toJSON()).includes('orderedList'));
  done(ed);
});

test('remove a medicine from a list of plain lines (line breaks) -> unchanged behaviour, no numbering added', () => {
  const ed = makeEditor([brPara(MEDS)]);
  assert.equal(removeByName(ed, 'Dolo').ok, true);
  assert.deepEqual(linesOf(child(ed, 3)), MEDS.filter((_, i) => i !== 1));
  assert.equal(child(ed, 3).type.name, 'paragraph');
  done(ed);
});

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
// all medicine lines of the Advice section, in order
const medsNow = (ed) => entries(ed);

for (const [layout, blocks] of Object.entries(LAYOUTS)) {
  test(`"at the top" (${layout}) -> the new medicine is FIRST, nothing replaced`, () => {
    const ed = makeEditor(blocks());
    const r = applyVoiceEdit(ed, { block_id: 'B2', operation: 'insert_after', new_value: NEW_MED, at_start: true });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(medsNow(ed), [NEW_MED, ...MEDS]);
    if (layout.endsWith('list')) assert.equal(child(ed, 3).type.name, layout === 'numbered list' ? 'orderedList' : 'bulletList');
    assert.equal(undoDepth(ed.state), 1);
    done(ed);
  });

  test(`no position said (${layout}): the AI aims at the heading -> still at the END (unchanged)`, () => {
    const ed = makeEditor(blocks());
    assert.equal(applyVoiceEdit(ed, { block_id: 'B2', operation: 'insert_after', new_value: NEW_MED }).ok, true);
    assert.deepEqual(medsNow(ed), [...MEDS, NEW_MED]);
    done(ed);
  });
}

test('"at the top" with an instruction line before the medicines -> before the first MEDICINE, after the instruction', () => {
  const ed = makeEditor([para(t('Continue the following medicines:')), ...MEDS.map((m) => para(t(m)))]);
  assert.equal(applyVoiceEdit(ed, { block_id: 'B2', operation: 'insert_after', new_value: NEW_MED, at_start: true }).ok, true);
  assert.deepEqual([3, 4, 5].map((i) => child(ed, i).textContent), ['Continue the following medicines:', NEW_MED, MEDS[0]]);
  done(ed);
});

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
const flagFor = (said, edit = { block_id: 'B2', operation: 'insert_after', new_value: NEW_MED }) => {
  const ed = makeEditor([list('orderedList', MEDS)]);
  const med = checkMedicineEdits(ed.state.doc, { said, edits: [edit] });
  done(ed);
  assert.ok(!med.reject, med.reject);
  return withDuplicateChoice(med.edits, med.newEntries)[0].at_start === true;
};

test('top words -> the flag is set', () => {
  for (const said of [
    'add tab amoxicillin 500 mg to continue at the top',
    'add tab amoxicillin 500 mg to continue at the beginning of advice',
    'add tab amoxicillin 500 mg to continue as the first medicine',
    'put tab amoxicillin 500 mg to continue on top of the list',
  ]) assert.equal(flagFor(said), true, said);
});

test('no top words -> no flag (timings and durations are not positions); the AI cannot set it', () => {
  for (const said of [
    'add tab amoxicillin 500 mg to continue',
    'add tab amoxicillin 500 mg to continue at the end',
    'add tab amoxicillin 500 mg to continue at the bottom',
    'add tab amoxicillin 500 mg to continue after dolo',
  ]) assert.equal(flagFor(said), false, said);
  assert.equal(flagFor('add tab amoxicillin 500 mg to continue', { block_id: 'B2', operation: 'insert_after', new_value: NEW_MED, at_start: true }), false);
  const timing = 'Tab. AMOXICILLIN 500 mg — Before Food — first 3 days';
  assert.equal(flagFor('add tab amoxicillin 500 mg before food for the first 3 days', { block_id: 'B2', operation: 'insert_after', new_value: timing }), false);
  const start = 'Tab. AMOXICILLIN 500 mg — to start from tomorrow';
  assert.equal(flagFor('add tab amoxicillin 500 mg to start from tomorrow', { block_id: 'B2', operation: 'insert_after', new_value: start }), false);
  const week = 'Tab. AMOXICILLIN 500 mg — for the first one week';
  assert.equal(flagFor('add tab amoxicillin 500 mg for the first one week', { block_id: 'B2', operation: 'insert_after', new_value: week }), false);
});

test('end to end: checked "at the top" command -> the medicine becomes item 1 of the numbered list', () => {
  const ed = makeEditor([list('orderedList', MEDS)]);
  const med = checkMedicineEdits(ed.state.doc, { said: 'add tab amoxicillin 500 mg to continue at the top', edits: [{ block_id: 'B2', operation: 'insert_after', new_value: NEW_MED }] });
  for (const e of withDuplicateChoice(med.edits, med.newEntries)) assert.equal(applyVoiceEdit(ed, e).ok, true);
  assert.deepEqual(listAt(ed).items, [NEW_MED, ...MEDS]);
  done(ed);
});

// ---------------- PART 3: wording ----------------
const checked = (said, value) => {
  const ed = makeEditor([list('orderedList', MEDS)]);
  const med = checkMedicineEdits(ed.state.doc, { said, edits: [{ block_id: 'B6', operation: 'insert_after', new_value: value }] });
  done(ed);
  return med;
};

test('"TO CONTINUE" is kept in every form the AI writes it', () => {
  const said = 'add TAB. AMOXICILLIN 500 MG TO CONTINUE';
  for (const value of ['TAB. AMOXICILLIN 500 MG TO CONTINUE', 'Tab. AMOXICILLIN 500 mg — To continue']) {
    const med = checked(said, value);
    assert.ok(!med.reject, med.reject);
    assert.equal(med.edits[0].new_value, value);
  }
});

test('an unsaid route is still removed, "To continue" stays', () => {
  const med = checked('add TAB. AMOXICILLIN 500 MG TO CONTINUE', 'Tab. AMOXICILLIN 500 mg — Oral — To continue');
  assert.ok(!med.reject, med.reject);
  assert.equal(med.edits[0].new_value, 'Tab. AMOXICILLIN 500 mg — To continue');
});

test('unsaid numbers / units are still refused; a placeholder name is still refused', () => {
  assert.ok(checked('add TAB. AMOXICILLIN 500 MG TO CONTINUE', 'Tab. AMOXICILLIN 500 mg — To continue — 5 days').reject);
  assert.ok(checked('add TAB. AMOXICILLIN 500 TO CONTINUE', 'Tab. AMOXICILLIN 500 mg — To continue').reject);
  assert.ok(checked('add a new medicine', 'Tab. NEW MEDICINE').reject);
});

// ---------------- PART 4: "before X" - the medicine X comes from the PERSON'S words ----------------
// check + apply, as App.jsx does; the AI's own place (aimAt) is deliberately wrong to show the words decide
const runCommand = (ed, said, value, aimAt = 'B2') => {
  const med = checkMedicineEdits(ed.state.doc, { said, edits: [{ block_id: aimAt, operation: 'insert_after', new_value: value }] });
  if (med.reject) return med;
  const results = withDuplicateChoice(med.edits, med.newEntries).map((e) => applyVoiceEdit(ed, e));
  return { med, results };
};
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
    test(`"before X" (${where}, ${layout}) -> directly before X; existing lines unchanged; one Undo step`, () => {
      for (const aimAt of ['B2', last]) { // the AI aimed at the heading, or at the LAST medicine
        const ed = makeEditor(blocks());
        const original = ed.state.doc;
        const r = runCommand(ed, said, NEW_MED, aimAt);
        assert.ok(!r.reject, r.reject);
        assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
        assert.deepEqual(medsNow(ed), expected, `${aimAt}`);
        if (layout === 'numbered list') assert.equal(child(ed, 3).type.name, 'orderedList');
        assert.equal(undoDepth(ed.state), 1);
        undoAll(ed);
        assert.ok(ed.state.doc.eq(original), 'one Undo restores the exact original');
        done(ed);
      }
    });
  }
}

test('"before X" with a medicine said WITHOUT a form (Cetirizine 10 mg before Dolo) -> still directly before DOLO', () => {
  const ed = makeEditor([list('orderedList', MEDS)]);
  const r = runCommand(ed, 'Add Cetirizine 10 mg before Dolo.', 'Tab. CETIRIZINE 10 mg', 'B6');
  assert.ok(!r.reject, r.reject);
  assert.deepEqual(listAt(ed).items, [MEDS[0], 'CETIRIZINE 10 mg', MEDS[1], MEDS[2], MEDS[3]]);
  done(ed);
});

test('"before X": the name in brackets (generic) also counts', () => {
  const meds = ['Tab. PANTOCID (Pantoprazole) 40 mg — Once Daily', 'Tab. DOLO (Paracetamol) 650 mg — SOS'];
  const ed = makeEditor([list('orderedList', meds)]);
  const r = runCommand(ed, 'insert tab amoxicillin 500 mg to continue before paracetamol', NEW_MED);
  assert.ok(!r.reject, r.reject);
  assert.deepEqual(listAt(ed).items, [meds[0], NEW_MED, meds[1]]);
  done(ed);
});

test('"before X" - X not in the section -> asks, nothing changed (never appended)', () => {
  const ed = makeEditor([list('orderedList', MEDS)]);
  const original = ed.state.doc;
  const r = runCommand(ed, 'add tab amoxicillin 500 mg to continue before azithral', NEW_MED);
  assert.match(r.reject, /could not find the medicine "azithral"/);
  assert.match(r.reject, /Nothing was changed/);
  assert.ok(ed.state.doc.eq(original));
  done(ed);
});

test('"before X" - X matches two entries -> asks; the strength said picks one', () => {
  const meds = ['Tab. DOLO 650 mg — SOS', 'Tab. CIPLOX 500 mg — Twice Daily', 'Tab. DOLO 500 mg — Once Daily'];
  let ed = makeEditor([list('orderedList', meds)]);
  const r = runCommand(ed, 'add tab amoxicillin 500 mg to continue before dolo', NEW_MED);
  assert.match(r.reject, /more than one medicine matches "dolo"/);
  assert.equal(listAt(ed).items.length, 3);
  done(ed);
  ed = makeEditor([list('orderedList', meds)]);
  const r2 = runCommand(ed, 'add tab amoxicillin 500 mg to continue before dolo 650', NEW_MED);
  assert.ok(!r2.reject, r2.reject);
  assert.deepEqual(listAt(ed).items, [NEW_MED, ...meds]);
  done(ed);
});

test('"before X" - two different places named -> asks', () => {
  const ed = makeEditor([list('orderedList', MEDS)]);
  const r = runCommand(ed, 'add tab amoxicillin 500 mg to continue before dolo before cremaffin', NEW_MED);
  assert.match(r.reject, /more than one place/);
  done(ed);
});

test('"before food / breakfast / bed / starting tomorrow" is wording, never a place (no question, default place)', () => {
  for (const [said, value] of [
    ['add tab amoxicillin 500 mg before food', 'Tab. AMOXICILLIN 500 mg — Before Food'],
    ['add tab amoxicillin 500 mg before breakfast', 'Tab. AMOXICILLIN 500 mg — Before Breakfast'],
    ['add tab amoxicillin 500 mg before bed', 'Tab. AMOXICILLIN 500 mg — Before bed'],
    ['add tab amoxicillin 500 mg before starting tomorrow', 'Tab. AMOXICILLIN 500 mg — before starting tomorrow'],
    ['add tab amoxicillin 500 mg before meals', 'Tab. AMOXICILLIN 500 mg — Before Meals'],
  ]) {
    const ed = makeEditor([list('orderedList', MEDS)]);
    const r = runCommand(ed, said, value, 'B6');
    assert.ok(!r.reject, `${said}: ${r.reject}`);
    assert.equal(r.med.edits[0].before_entry, undefined, said);
    assert.deepEqual(listAt(ed).items, [...MEDS, value], said); // the default place: after the last medicine
    done(ed);
  }
});

test('a before_entry sent by the AI is never used; the safety checks still refuse invented details', () => {
  const ed = makeEditor([list('orderedList', MEDS)]);
  const med = checkMedicineEdits(ed.state.doc, { said: 'add tab amoxicillin 500 mg to continue', edits: [{ block_id: 'B6', operation: 'insert_after', new_value: NEW_MED, before_entry: MEDS[0] }] });
  assert.equal(med.edits[0].before_entry, undefined);
  assert.ok(runCommand(ed, 'add tab amoxicillin before dolo', 'Tab. AMOXICILLIN 500 mg').reject); // 500 mg not said
  assert.ok(runCommand(ed, 'add a new medicine before dolo', 'Tab. NEW MEDICINE').reject); // placeholder
  assert.deepEqual(listAt(ed).items, MEDS);
  done(ed);
});

test('a duplicate add before X still adds a NEW line (duplicate-add behaviour unchanged)', () => {
  const ed = makeEditor([list('orderedList', MEDS)]);
  const r = runCommand(ed, 'add tab dolo 650 mg before ciplox', 'Tab. DOLO 650 mg');
  assert.ok(!r.reject, r.reject);
  assert.deepEqual(listAt(ed).items, ['Tab. DOLO 650 mg', ...MEDS]);
  done(ed);
});

test('X gone at apply time (the document changed) -> nothing changed (never appended)', () => {
  const ed = makeEditor([list('orderedList', MEDS)]);
  const r = applyVoiceEdit(ed, { block_id: 'B2', operation: 'insert_after', new_value: NEW_MED, before_entry: 'Tab. ZZZ 1 mg' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
  assert.deepEqual(listAt(ed).items, MEDS);
  done(ed);
});
