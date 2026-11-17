// "Make all the medicines a bullet / numbered list" (src/lib/voiceEdit.js applyToList, MOCKED AI edits on real TipTap
// documents - no Gemini call). Every medicine entry of the section is found dynamically (any number of entries), also
// one that does not start with Tab. / Syp. / Inj. ("AZIPROTEIN POWDER …", a supplement), with the medicine checks' own
// rule (isMedicineEntry). Non-medicine lines, headings and signatures stay where they are; words and order never
// change; a partly named existing list is still never changed. Dummy data only.
// Run:  cd client  &&  node --test tests/
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState } from '@tiptap/pm/state';
import { history, undo } from '@tiptap/pm/history';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-listformat');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'medicineText', 'sections']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { getBlocks } = await import(pathToFileURL(path.join(tmp, 'outline.js')).href);
const { flashKey } = await import(pathToFileURL(path.join(tmp, 'flash.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit]);
const t = (s, m) => schema.text(s, m);
const p = (s, bold) => schema.node('paragraph', null, [t(s, bold ? [schema.marks.bold.create()] : undefined)]);
const list = (kind, lines) => schema.node(kind, kind === 'orderedList' ? { start: 1 } : null, lines.map((l) => schema.node('listItem', null, [p(l)])));

// every kind of dummy medicine entry, including ones WITHOUT a form at the start
const POOL = [
  'Tab. METRONIDAZOLE 500 mg — Three Times Daily (1-1-1) — 2 days', 'Cap. OMEPRAZOLE 20 mg — Once Daily (1-0-0) — 14 days',
  'Syp. INSTARAFT (Antacid) 10 ml — Three Times Daily (1-1-1) — 5 days', 'INJ. Kcl 40 mEq in 500 ml NS — IV — STAT',
  'AZIPROTEIN POWDER (Protein Supplement) 2 scoops — (1-0-1) — 1 week — In 1 glass of water',
  'Ointment for Ringworm — Apply before going to sleep', 'Eye Drops MOXIFLOXACIN 1 drop — Four Times Daily',
  'VITAMIN D3 60000 IU — Once Weekly — 8 weeks', 'Tab. ZINCOVIT (Multivitamin/Mineral) — Once Daily (1-0-0) — 14 days',
  'Syp. BENADRYL — Daily Morning (1-0-0)', 'Tab. HYDROXYZINE 10 mg — Daily Night (0-0-1)', 'Sachet ORS 1 sachet — after every loose stool',
  'Tab. AZITHROMYCIN 500 mg — (1-0-1) — 5 days', 'PROTEIN POWDER 2 scoops daily', 'Inhaler BUDECORT 200 mcg 2 puffs — Twice Daily',
  'Tab. PANTOP 40 mg — Once Daily before food', 'Cap. BECOSULES 1 cap — Once Daily', 'Tab. DOLO 650 mg — At Night (0-0-1) — 3 days',
  'Syp. ASCORIL 5 ml — Twice Daily', 'Tab. CETIRIZINE 10 mg — At Night (0-0-1)',
];
const ADVICE_LINES = ['Drink plenty of water.', 'Avoid oily and spicy food.'];
const meds = (n) => Array.from({ length: n }, (_, i) => POOL[i % POOL.length] + (i >= POOL.length ? ` — repeat ${i}` : ''));
const START = () => [p('DISCHARGE SUMMARY', true), p('DIAGNOSIS', true), p('ACUTE GASTROENTERITIS'), p('ADVICE', true)];
const TAIL = () => [p('Signed By: Dr. DUMMY ONE', true), p('FOLLOW UP', true), p('Review in OPD after 1 week.')];
// layouts of the Advice section
const asParagraphs = (lines) => [...START(), ...lines.map((l) => p(l)), ...TAIL()];
const asList = (kind, lines) => [...START(), list(kind, lines), ...TAIL()];

function makeEditor(kids) {
  const doc = schema.node('doc', null, kids);
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), schema, isDestroyed: false, dryRun: true, flashes: [] };
  ed.view = { dispatch: (tr) => { const f = tr.getMeta(flashKey); if (f) ed.flashes.push(f); ed.state = ed.state.apply(tr); } };
  return ed;
}
const blockId = (ed, start) => `B${getBlocks(ed.state.doc).find((x) => x.node.textContent.startsWith(start)).index}`;
const toList = (ed, kind, extra = {}, at = 'ADVICE') => applyVoiceEdit(ed, { block_id: blockId(ed, at), operation: 'to_list', list_type: kind, select: ['all_medicines'], field_label: 'Advice', ...extra });
// the Advice section as rows: "P text", "OL<n> text", "UL text"
function adviceRows(doc) {
  const rows = [];
  let inAdvice = false;
  doc.forEach((n) => {
    if (n.type.name === 'paragraph' && n.textContent === 'ADVICE') { inAdvice = true; return; }
    if (n.type.name === 'paragraph' && n.textContent.startsWith('Signed By')) inAdvice = false;
    if (!inAdvice) return;
    if (n.type.name === 'orderedList') { let k = n.attrs.start; n.forEach((li) => rows.push(`OL${k++} ${li.textContent}`)); }
    else if (n.type.name === 'bulletList') n.forEach((li) => rows.push(`UL ${li.textContent}`));
    else rows.push(`P ${n.textContent}`);
  });
  return rows;
}
const texts = (doc) => adviceRows(doc).map((r) => r.replace(/^\S+ /, ''));
const outsideAdvice = (doc) => { const o = []; doc.forEach((n) => o.push(n.textContent)); return o.filter((x) => !x.startsWith('Tab.')); };

for (const n of [8, 13, 20]) {
  test(`${n} entries as paragraphs -> bullet list: every medicine found (no fixed number), words / order / other lines unchanged`, () => {
    const lines = meds(n);
    const ed = makeEditor(asParagraphs(lines));
    const r = toList(ed, 'bullet');
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(adviceRows(ed.state.doc), lines.map((l) => `UL ${l}`));
    assert.equal(ed.state.doc.child(4).type.name, 'bulletList', 'ONE list');
    assert.deepEqual(outsideAdvice(ed.state.doc).slice(0, 4), ['DISCHARGE SUMMARY', 'DIAGNOSIS', 'ACUTE GASTROENTERITIS', 'ADVICE']);
    assert.ok(outsideAdvice(ed.state.doc).includes('Signed By: Dr. DUMMY ONE') && outsideAdvice(ed.state.doc).includes('Review in OPD after 1 week.'));
  });
  test(`${n} entries as paragraphs -> numbered list 1..${n}`, () => {
    const lines = meds(n);
    const ed = makeEditor(asParagraphs(lines));
    assert.equal(toList(ed, 'ordered').ok, true);
    assert.deepEqual(adviceRows(ed.state.doc), lines.map((l, i) => `OL${i + 1} ${l}`));
  });
}

test('the powder / supplement entries without a form at the start are included; every form is included', () => {
  const lines = meds(20);
  const ed = makeEditor(asParagraphs(lines));
  assert.equal(toList(ed, 'ordered').ok, true);
  const rows = adviceRows(ed.state.doc);
  for (const x of ['AZIPROTEIN POWDER', 'PROTEIN POWDER', 'VITAMIN D3', 'Ointment for Ringworm', 'INJ. Kcl', 'Syp. INSTARAFT', 'Cap. OMEPRAZOLE', 'Eye Drops', 'Inhaler BUDECORT', 'Sachet ORS'])
    assert.ok(rows.some((r) => r.startsWith('OL') && r.includes(x)), x);
  // the AI often sends the kinds instead of all_medicines: a powder written name-first counts as a powder
  const ed2 = makeEditor(asParagraphs(['Tab. PANTOP 40 mg — Once Daily', 'AZIPROTEIN POWDER (Protein Supplement) 2 scoops — (1-0-1) — 1 week']));
  assert.equal(toList(ed2, 'bullet', { select: ['tablets', 'powders'] }).ok, true);
  assert.deepEqual(adviceRows(ed2.state.doc), ['UL Tab. PANTOP 40 mg — Once Daily', 'UL AZIPROTEIN POWDER (Protein Supplement) 2 scoops — (1-0-1) — 1 week']);
});

test('non-medicine advice between the medicines stays a paragraph, in its place; numbering continues around it', () => {
  const lines = meds(8);
  const mixed = [...lines.slice(0, 3), ADVICE_LINES[0], ...lines.slice(3, 6), ADVICE_LINES[1], ...lines.slice(6)];
  const ed = makeEditor(asParagraphs(mixed));
  assert.equal(toList(ed, 'ordered').ok, true);
  assert.deepEqual(adviceRows(ed.state.doc), [
    ...lines.slice(0, 3).map((l, i) => `OL${i + 1} ${l}`), `P ${ADVICE_LINES[0]}`,
    ...lines.slice(3, 6).map((l, i) => `OL${i + 4} ${l}`), `P ${ADVICE_LINES[1]}`,
    ...lines.slice(6).map((l, i) => `OL${i + 7} ${l}`),
  ]);
  assert.deepEqual(texts(ed.state.doc), mixed, 'same text, same order');
});

test('duplicate / similar medicine names stay two separate entries', () => {
  const dup = 'Tab. DOLO 650 mg — At Night (0-0-1) — 3 days';
  const lines = ['Tab. PANTOP 40 mg — Once Daily', dup, 'Tab. DOLO 650 mg — Twice Daily', dup];
  const ed = makeEditor(asParagraphs(lines));
  assert.equal(toList(ed, 'bullet').ok, true);
  assert.deepEqual(adviceRows(ed.state.doc), lines.map((l) => `UL ${l}`));
  // the AI naming the duplicate line as often as it appears also takes both
  const ed2 = makeEditor(asParagraphs(lines));
  assert.equal(toList(ed2, 'bullet', { select: [], lines }).ok, true);
  assert.deepEqual(adviceRows(ed2.state.doc), lines.map((l) => `UL ${l}`));
});

test('already the kind asked for: numbered -> numbered and bullet -> bullet are "already done" (no change, no refusal)', () => {
  for (const [kind, asked] of [['orderedList', 'ordered'], ['bulletList', 'bullet']]) {
    for (const n of [8, 13]) {
      const ed = makeEditor(asList(kind, meds(n)));
      const before = ed.state.doc;
      const r = toList(ed, asked);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.unchanged, true);
      assert.ok(ed.state.doc.eq(before));
    }
  }
  // the screenshot list: 12 entries with the powder supplement in the middle, numbered, asked numbered again
  const shot = meds(13).filter((l) => !l.startsWith('PROTEIN'));
  const ed = makeEditor(asList('orderedList', shot));
  assert.equal(toList(ed, 'ordered', {}, 'Tab. METRONIDAZOLE').unchanged, true);
});

test('numbered -> bullet and bullet -> numbered: the whole list changes kind, words unchanged (also when the AI points at an item)', () => {
  const lines = meds(13);
  let ed = makeEditor(asList('orderedList', lines));
  let r = toList(ed, 'bullet', {}, 'Tab. METRONIDAZOLE');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(adviceRows(ed.state.doc), lines.map((l) => `UL ${l}`));
  ed = makeEditor(asList('bulletList', lines));
  r = toList(ed, 'ordered');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(adviceRows(ed.state.doc), lines.map((l, i) => `OL${i + 1} ${l}`));
});

test('medicines spread over two lists and a paragraph (left by the old behaviour) become ONE list, in order', () => {
  const lines = meds(12);
  const kids = [...START(), list('orderedList', lines.slice(0, 7)), p(lines[7]), list('orderedList', lines.slice(8)), ...TAIL()];
  const ed = makeEditor(kids);
  const r = toList(ed, 'bullet', {}, lines[0].slice(0, 12));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(adviceRows(ed.state.doc), lines.map((l) => `UL ${l}`));
});

test('PARTIAL-LIST PROTECTION: a list with a non-medicine line in it, or only some kinds named, is never changed or split', () => {
  const lines = meds(8);
  const withAdvice = [...lines.slice(0, 4), ADVICE_LINES[0], ...lines.slice(4)];
  let ed = makeEditor(asList('orderedList', withAdvice));
  let before = ed.state.doc;
  let r = toList(ed, 'bullet');
  assert.equal(r.ok, false);
  assert.match(r.error, /only part of an existing list was named; to change a list, name all of its lines\. Nothing was changed/);
  assert.ok(ed.state.doc.eq(before));
  // only the tablets of a mixed list
  ed = makeEditor(asList('orderedList', lines));
  before = ed.state.doc;
  r = toList(ed, 'bullet', { select: ['tablets'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /only part of an existing list was named/);
  assert.ok(ed.state.doc.eq(before));
  // a partly named list next to medicine paragraphs is refused too (never half converted)
  ed = makeEditor([...START(), list('orderedList', withAdvice), p('Tab. PAN 40 mg — Once Daily'), ...TAIL()]);
  before = ed.state.doc;
  r = toList(ed, 'bullet', {}, 'Tab. PAN');
  assert.equal(r.ok, false);
  assert.ok(ed.state.doc.eq(before));
  // ordinary advice / review / signature lines are never taken as medicines
  ed = makeEditor(asParagraphs([...ADVICE_LINES, 'Continue medication as directed by the treating physician']));
  r = toList(ed, 'bullet', {}, 'Drink');
  assert.equal(r.ok, false);
  assert.match(r.error, /no all medicines were found/);
});

test('Undo restores the document exactly; History text lists the entries; the new list is highlighted', () => {
  for (const [layout, kids] of [['paragraphs', asParagraphs(meds(13))], ['numbered list', asList('orderedList', meds(13))]]) {
    const ed = makeEditor(kids);
    const before = ed.state.doc;
    const r = toList(ed, 'bullet');
    assert.equal(r.ok, true, `${layout}: ${r.error}`);
    // History (App.jsx records before / after): every entry, in order
    assert.equal(r.before.split('\n').length, 13, layout);
    assert.equal(r.after.split('\n').length, 13, layout);
    assert.ok(r.after.split('\n').every((x) => x.startsWith('• ')), layout);
    // highlight: one range covering the new list
    assert.equal(ed.flashes.length, 1, layout);
    const { from, to } = ed.flashes[0].add;
    let listAt = -1;
    ed.state.doc.forEach((n, off) => { if (n.type.name === 'bulletList') listAt = off; });
    assert.ok(from <= listAt && to >= listAt + ed.state.doc.nodeAt(listAt).nodeSize, layout);
    // Undo: one step back to the original
    undo(ed.state, ed.view.dispatch);
    assert.ok(ed.state.doc.eq(before), `${layout}: undo`);
  }
});
