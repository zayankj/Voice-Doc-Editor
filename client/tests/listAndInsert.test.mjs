// Regression tests (MOCKED AI edits on real TipTap documents - no Gemini call here). Dummy data only: the Advice
// lines of the reported screenshot (medicine names, no patient details), in both layouts.
//   PART 1  to_list: "select" (the browser picks the lines), tolerant matching of "lines", joined entries refused
//   PART 2  a new medicine is ALWAYS its own line (", Tab. DOLO …" was glued onto the Ringworm line)
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
import { checkNamedSection, checkTableEdits } from '../src/lib/verify.js';
import { asOneUndoStep } from '../src/lib/undoStep.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-listinsert');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'previewEdits', 'medicineText', 'sections']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { medicinesLostByEdits } = await import(pathToFileURL(path.join(tmp, 'previewEdits.js')).href);
const { getBlocks } = await import(pathToFileURL(path.join(tmp, 'outline.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit]);
const t = (s, m) => schema.text(s, m);
const p = (...k) => schema.node('paragraph', null, k);
const B = () => [schema.marks.bold.create()];
const h = (s) => p(t(s, B()));
const br = () => schema.nodes.hardBreak.create();

const CIPLOX = 'Tab. CIPLOX 200 mg — (1-0-1) — 2 days';
const METRO = 'Tab. METRONIDAZOLE 500 mg — Three Times Daily (1-1-1) — 2 days';
const INSTA = 'Syp. INSTARAFT (Antacid) 10 ml — Three Times Daily (1-1-1) — 5 days — 10 mins after food';
const ZINC = 'Tab. ZINCOVIT (Multivitamin/Mineral) — Once Daily (1-0-0) — 14 days';
const BACT = 'Tab. BACTOGUT (Probiotic) — Once Daily (1-0-0) — 7 days';
const POWDER = 'AZIPROPROTEIN POWDER (Protein Supplement) 2 scoops — (1-0-1) — 1 week — In 1 glass of water';
const AZI = 'Tab. AZITHROMYCIN 500 mg — (1-0-1) — 5 days';
const BENA = 'Syp. BENADRYL — Daily Morning (1-0-0)';
const HYDRO = 'Tab. HYDROXYZINE — Daily Night (0-0-1),'; // the trailing comma as in the document
const RING = 'Ointment for Ringworm — Apply before going to sleep';
const LINES = [CIPLOX, METRO, INSTA, ZINC, BACT, POWDER, AZI, BENA, HYDRO, RING];
const GLUED_LAST = 'Ointment for Ringworm — Apply before going to sleep,Tab. DOLO (Paracetamol) — Daily Night (0-0-1)';
const TAIL = () => [p(t('Signed By: Dr. DUMMY ONE', B())), p(t('Summary Briefed by: Dr. DUMMY TWO', B()))];
const START = () => [h('DIAGNOSIS'), p(t('ACUTE GASTROENTERITIS')), h('ADVICE')];
const layout = {
  A: (lines = LINES) => [...START(), ...lines.map((l) => p(t(l))), ...TAIL()],
  B: (lines = LINES) => [...START(), p(...lines.flatMap((l, i) => (i ? [br(), t(l)] : [t(l)]))), ...TAIL()],
};
function makeEditor(kids) {
  const doc = schema.node('doc', null, kids);
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), schema, isDestroyed: false, dryRun: true };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
}
const id = (ed, s) => `B${getBlocks(ed.state.doc).find((x) => x.node.textContent.startsWith(s)).index}`;
// Advice as rows: "P text" / "OL<n> text" (line breaks ↵, bold **x**)
function adviceRows(doc) {
  const txt = (n) => { let s = ''; n.forEach((c) => { s += c.type.name === 'hardBreak' ? '↵' : c.marks.some((m) => m.type.name === 'bold') ? `**${c.text}**` : c.text; }); return s; };
  const rows = [];
  let inAdvice = false;
  doc.forEach((n) => {
    if (n.type.name === 'paragraph' && n.textContent === 'ADVICE') { inAdvice = true; return; }
    if (n.type.name === 'paragraph' && n.textContent.startsWith('Signed By')) inAdvice = false;
    if (!inAdvice) return;
    if (n.type.name === 'orderedList') { let k = n.attrs.start; n.forEach((li) => rows.push(`OL${k++} ${txt(li.firstChild)}`)); }
    else rows.push(`P ${txt(n)}`);
  });
  return rows;
}
const adviceLines = (doc) => adviceRows(doc).flatMap((r) => r.replace(/^\S+ /, '').split('↵')).map((x) => x.replace(/\*\*/g, ''));
const numbered = (doc) => adviceRows(doc).filter((r) => r.startsWith('OL'));
const outside = (doc) => { const o = []; doc.forEach((n) => o.push(n.textContent)); return o.filter((x) => !LINES.includes(x) && !x.includes('Tab.')); };
const toList = (ed, extra) => applyVoiceEdit(ed, { block_id: id(ed, 'Tab. CIPLOX'), operation: 'to_list', list_type: 'ordered', field_label: 'Advice', ...extra });

// ======================= PART 1: to_list =======================
for (const L of ['A', 'B']) {
  test(`to_list select all_medicines + the supplement named by the AI (layout ${L}): all 10 numbered 1-10, text and order unchanged`, () => {
    const ed = makeEditor(layout[L]());
    const before = ed.state.doc;
    const edit = { block_id: id(ed, 'Tab. CIPLOX'), operation: 'to_list', list_type: 'ordered', select: ['all_medicines'], lines: [POWDER], field_label: 'Advice' };
    assert.equal(medicinesLostByEdits(before, [edit]), 0);
    const r = applyVoiceEdit(ed, edit);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(numbered(ed.state.doc), LINES.map((l, i) => `OL${i + 1} ${l}`));
    assert.deepEqual(outside(ed.state.doc), outside(before), 'heading, diagnosis, signatures untouched');
  });

  test(`to_list select tablets (layout ${L}): only the 6 Tab. lines numbered 1-6 in order; syrups, powder, ointment untouched`, () => {
    const ed = makeEditor(layout[L]());
    const r = toList(ed, { select: ['tablets'] });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(numbered(ed.state.doc), [CIPLOX, METRO, ZINC, BACT, AZI, HYDRO].map((l, i) => `OL${i + 1} ${l}`));
    assert.deepEqual(adviceLines(ed.state.doc), LINES, 'every line, same text, same order');
    for (const x of [INSTA, POWDER, BENA, RING]) assert.ok(adviceRows(ed.state.doc).some((row) => row.startsWith('P ') && row.includes(x)), x);
  });

  test(`to_list select syrups / ointments (layout ${L}): only those, numbered 1..n`, () => {
    let ed = makeEditor(layout[L]());
    assert.equal(toList(ed, { select: ['syrups'] }).ok, true);
    assert.deepEqual(numbered(ed.state.doc), [`OL1 ${INSTA}`, `OL2 ${BENA}`]);
    assert.deepEqual(adviceLines(ed.state.doc), LINES);
    ed = makeEditor(layout[L]());
    assert.equal(toList(ed, { select: ['ointments'] }).ok, true);
    assert.deepEqual(numbered(ed.state.doc), [`OL1 ${RING}`]);
    ed = makeEditor(layout[L]());
    assert.equal(toList(ed, { select: ['tablets', 'syrups'] }).ok, true);
    assert.deepEqual(numbered(ed.state.doc).map((r) => r.replace(/^OL\d+ /, '')), [CIPLOX, METRO, INSTA, ZINC, BACT, AZI, BENA, HYDRO]);
    assert.deepEqual(numbered(ed.state.doc).map((r) => r.match(/^OL(\d+)/)[1]), ['1', '2', '3', '4', '5', '6', '7', '8']);
  });

  test(`all medicines WITHOUT the supplement named: the powder stays as it is, numbering continues (layout ${L})`, () => {
    const ed = makeEditor(layout[L]());
    assert.equal(toList(ed, { select: ['all_medicines'] }).ok, true);
    assert.deepEqual(numbered(ed.state.doc).map((r) => r.replace(/^OL\d+ /, '')), LINES.filter((l) => l !== POWDER));
    assert.deepEqual(numbered(ed.state.doc).map((r) => Number(r.match(/^OL(\d+)/)[1])), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(adviceRows(ed.state.doc).some((r) => r.startsWith('P ') && r.includes(POWDER)));
  });

  test(`THE REPORTED FAILURE (layout ${L}): a line holding two entries ("…sleep,Tab. DOLO …") is refused with a clear message; nothing changes`, () => {
    const glued = [...LINES.slice(0, 9), GLUED_LAST];
    for (const extra of [
      { select: ['all_medicines'], lines: [POWDER] },
      { select: ['tablets'] }, // DOLO (a tablet) is hidden in that line
      { lines: [...glued.slice(0, 9), RING, 'Tab. DOLO (Paracetamol) — Daily Night (0-0-1)'] }, // what the AI sent
      { lines: glued }, // the joined line copied as one line
    ]) {
      const ed = makeEditor(layout[L](glued));
      const before = ed.state.doc;
      const r = toList(ed, extra);
      assert.equal(r.ok, false, JSON.stringify(extra));
      assert.equal(r.blocked, true);
      assert.match(r.error, /two entries appear to be joined on one line: "Ointment for Ringworm — Apply before going to sleep,Tab\. DOLO \(Paracetamol\) — Daily Night \(0-0-1\)"\. Please put each entry on its own line and try again\. Nothing was changed/);
      assert.ok(ed.state.doc.eq(before), 'document unchanged');
    }
    // syrups only: the joined line holds no syrup, so the syrups are numbered (the joined line is not touched)
    const ed = makeEditor(layout[L](glued));
    assert.equal(toList(ed, { select: ['syrups'] }).ok, true);
    assert.deepEqual(numbered(ed.state.doc), [`OL1 ${INSTA}`, `OL2 ${BENA}`]);
    assert.ok(adviceLines(ed.state.doc).includes(GLUED_LAST));
  });

  test(`"lines" matching ignores dashes, spaces, non-breaking spaces, capitals and a trailing comma / full stop (layout ${L})`, () => {
    const ed = makeEditor(layout[L]());
    const fuzzy = [
      CIPLOX.replace(/—/g, '-'),
      METRO.replace(/—/g, '–').replace(/ /g, '  '),
      ZINC.toUpperCase(),
      BACT.replace(/ /g, ' '),
      'Tab. HYDROXYZINE — Daily Night (0-0-1)', // the document line ends with a comma
      `${AZI}.`,
    ];
    const r = toList(ed, { lines: fuzzy });
    assert.equal(r.ok, true, r.error);
    // the ORIGINAL document text is kept (the comparison text is never written)
    assert.deepEqual(numbered(ed.state.doc).map((x) => x.replace(/^OL\d+ /, '')), [CIPLOX, METRO, ZINC, BACT, AZI, HYDRO]);
  });

  test(`a missing line, an ambiguous line and an unknown kind are refused; nothing changes (layout ${L})`, () => {
    let ed = makeEditor(layout[L]());
    let before = ed.state.doc;
    let r = toList(ed, { lines: [CIPLOX, 'Tab. NOTHERE 5 mg'] });
    assert.equal(r.ok, false);
    assert.match(r.error, /the line "Tab\. NOTHERE 5 mg" was not found in that section\. Nothing was changed/);
    assert.ok(ed.state.doc.eq(before));
    // no partial matching: a part of a line is not a line
    r = toList(ed, { lines: ['Tab. CIPLOX 200 mg'] });
    assert.equal(r.ok, false);
    assert.ok(ed.state.doc.eq(before));
    // the same line twice in the section -> which one?
    ed = makeEditor(layout[L]([...LINES, BENA]));
    before = ed.state.doc;
    r = toList(ed, { lines: [BENA] });
    assert.match(r.error, /appears more than once in that section/);
    assert.ok(ed.state.doc.eq(before));
    r = toList(ed, { select: ['vitamins'] });
    assert.equal(r.ok, false);
    r = toList(ed, {});
    assert.match(r.error, /not clear which lines should be in the list/);
  });
}

test('to_list keeps bold inside the lines; one Undo restores the document exactly', () => {
  const ed = makeEditor([...START(), p(t('Tab. ', []), t('CIPLOX', B()), t(' 200 mg — (1-0-1) — 2 days')), p(t(INSTA)), p(t(AZI)), ...TAIL()]);
  const before = ed.state.doc;
  asOneUndoStep(ed.view, () => assert.equal(toList(ed, { select: ['tablets'] }).ok, true));
  assert.deepEqual(numbered(ed.state.doc), ['OL1 Tab. **CIPLOX** 200 mg — (1-0-1) — 2 days', `OL2 ${AZI}`]);
  undo(ed.state, (tr) => { ed.state = ed.state.apply(tr); });
  assert.ok(ed.state.doc.eq(before));
});

for (const L of ['A', 'B']) {
  test(`REAL-MODEL CASE (layout ${L}): one to_list per syrup (block ids of each syrup) -> ONE list numbered 1, 2 (not 1, 1)`, () => {
    const ed = makeEditor(layout[L]());
    // App.jsx applies the AI's edits from the bottom up: the BENADRYL one first
    for (const s of ['Syp. BENADRYL', 'Syp. INSTARAFT']) {
      const r = applyVoiceEdit(ed, { block_id: L === 'A' ? id(ed, s) : id(ed, 'Tab. CIPLOX'), operation: 'to_list', list_type: 'ordered', select: ['syrups'], field_label: 'Advice' });
      assert.equal(r.ok, true, r.error);
    }
    assert.deepEqual(numbered(ed.state.doc), [`OL1 ${INSTA}`, `OL2 ${BENA}`]);
    assert.deepEqual(adviceLines(ed.state.doc), LINES);
  });
}

test('REAL-MODEL CASE: list_type missing -> a plain question, nothing changes', () => {
  const ed = makeEditor(layout.A());
  const before = ed.state.doc;
  const r = applyVoiceEdit(ed, { block_id: id(ed, 'Tab. CIPLOX'), operation: 'to_list', select: ['all_medicines'], field_label: 'Advice' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not clear whether the list should be numbered or bulleted\. Please say "numbered list" or "bullet list"\. Nothing was changed/);
  assert.ok(ed.state.doc.eq(before));
});

test('REAL-MODEL CASE: "Add a Ringworm ointment" when "Ointment for Ringworm" is there -> the question names RINGWORM', () => {
  const ed = makeEditor(layout.A());
  const r = applyVoiceEdit(ed, { block_id: id(ed, 'Ointment'), operation: 'insert_after', new_value: 'Ointment for Ringworm', field_label: 'Advice' });
  assert.equal(r.ok, false);
  assert.match(r.error, /^RINGWORM is already in this section/);
});

test('select on an existing numbered list of all its medicines: unchanged (no error)', () => {
  const ed = makeEditor(layout.A());
  assert.equal(toList(ed, { select: ['syrups'] }).ok, true);
  const r = applyVoiceEdit(ed, { block_id: id(ed, 'Syp. INSTARAFT'), operation: 'to_list', list_type: 'ordered', select: ['syrups'], field_label: 'Advice' });
  assert.equal(r.ok, true, r.error);
});

// ======================= PART 2: a new medicine is always its own line =======================
const DOLO = 'Tab. DOLO — Daily Night (0-0-1)';
for (const L of ['A', 'B']) {
  test(`THE REPORTED FAILURE (layout ${L}): append ", Tab. DOLO …" after the Ringworm line -> its own line, no comma, Ringworm unchanged`, () => {
    for (const value of [`, ${DOLO}`, `,${DOLO}`, `; ${DOLO}`, ` — ${DOLO}`, DOLO, `\n${DOLO}`]) {
      const ed = makeEditor(layout[L]());
      const at = L === 'A' ? id(ed, 'Ointment for Ringworm') : id(ed, 'Tab. CIPLOX');
      const r = applyVoiceEdit(ed, { block_id: at, operation: 'append', new_value: value, field_label: 'Advice' });
      assert.equal(r.ok, true, `${value}: ${r.error}`);
      assert.deepEqual(adviceLines(ed.state.doc), [...LINES, DOLO], JSON.stringify(value));
      if (L === 'B') assert.equal(adviceRows(ed.state.doc).length, 1, 'still one paragraph with line breaks');
      else assert.ok(adviceRows(ed.state.doc).includes(`P ${DOLO}`), 'its own paragraph');
    }
  });

  test(`replace_text that adds a medicine after a line ("sleep" -> "sleep, Tab. DOLO …") -> its own line right after it (layout ${L})`, () => {
    const ed = makeEditor(layout[L]());
    const at = L === 'A' ? id(ed, 'Tab. HYDROXYZINE') : id(ed, 'Tab. CIPLOX');
    const r = applyVoiceEdit(ed, { block_id: at, operation: 'replace_text', find_text: 'Daily Night (0-0-1),', new_value: `Daily Night (0-0-1), ${DOLO}`, field_label: 'Advice' });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(adviceLines(ed.state.doc), [...LINES.slice(0, 9), DOLO, RING]);
    // text joined in the MIDDLE of a line is never allowed
    const e2 = makeEditor(layout[L]());
    const before = e2.state.doc;
    const r2 = applyVoiceEdit(e2, { block_id: L === 'A' ? id(e2, 'Ointment') : id(e2, 'Tab. CIPLOX'), operation: 'replace_text', find_text: 'Apply', new_value: 'Tab. DOLO 1 tab, Apply', field_label: 'Advice' });
    assert.equal(r2.ok, false);
    assert.equal(r2.blocked, true);
    assert.match(r2.error, /would join a new entry onto the line .* a new entry must be on its own line\. Nothing was changed/);
    assert.ok(e2.state.doc.eq(before));
  });

  test(`"Add DOLO after HYDROXYZINE" lands right after it as its own entry (layout ${L}); a leading comma is dropped`, () => {
    const ed = makeEditor(layout[L]());
    const edit = L === 'A'
      ? { block_id: id(ed, 'Tab. HYDROXYZINE'), operation: 'insert_after', new_value: `, ${DOLO}`, field_label: 'Advice' }
      : { block_id: id(ed, 'Tab. CIPLOX'), operation: 'insert_after', find_text: 'Tab. HYDROXYZINE', new_value: `, ${DOLO}`, field_label: 'Advice' };
    const r = applyVoiceEdit(ed, edit);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(adviceLines(ed.state.doc), [...LINES.slice(0, 9), DOLO, RING]);
    // a plain instruction with a stray comma in front: also its own line without the comma
    const e2 = makeEditor(layout.A());
    assert.equal(applyVoiceEdit(e2, { block_id: id(e2, 'Ointment'), operation: 'insert_after', new_value: ', Drink plenty of water.', field_label: 'Advice' }).ok, true);
    assert.deepEqual(adviceLines(e2.state.doc), [...LINES, 'Drink plenty of water.']);
  });

  test(`a medicine already there, joined with a comma (layout ${L}) -> the existing duplicate question; nothing changes`, () => {
    const ed = makeEditor(layout[L]());
    const before = ed.state.doc;
    const r = applyVoiceEdit(ed, { block_id: L === 'A' ? id(ed, 'Ointment') : id(ed, 'Tab. CIPLOX'), operation: 'append', new_value: ', Tab. BENADRYL', field_label: 'Advice' });
    assert.equal(r.ok, false);
    assert.match(r.error, /BENADRYL is already in this section/);
    assert.ok(ed.state.doc.eq(before));
  });
}

test('invented numbers behind a comma are still caught (", Tab. DOLO 650 mg" when 650 was not said)', () => {
  const doc = schema.node('doc', null, layout.A());
  const ed = makeEditor(layout.A());
  const at = id(ed, 'Ointment');
  for (const e of [
    { block_id: at, operation: 'append', new_value: ', Tab. DOLO 650 mg — Daily Night', field_label: 'Advice' },
    { block_id: at, operation: 'replace_text', find_text: 'sleep', new_value: 'sleep, Tab. DOLO 650 mg', field_label: 'Advice' },
  ]) {
    const c = checkTableEdits(doc, 'Add a DOLO tablet daily night', [e]);
    assert.equal(c.edits.length, 0, e.operation);
    assert.match(c.blocked[0], /contains 650, which was not in your command/);
  }
  // said -> allowed; the existing checks (named section) still run first
  assert.equal(checkTableEdits(doc, 'add dolo 650 mg daily night', [{ block_id: at, operation: 'append', new_value: ', Tab. DOLO 650 mg', field_label: 'Advice' }]).edits.length, 1);
  assert.ok(!checkNamedSection(doc, 'add dolo in the advice', [{ block_id: at, operation: 'append', new_value: `, ${DOLO}`, field_label: 'Advice' }]).reject);
});

test('normal appending is unchanged: a continuation of the same line, and text outside medicine sections', () => {
  let ed = makeEditor(layout.A());
  assert.equal(applyVoiceEdit(ed, { block_id: id(ed, 'Syp. BENADRYL'), operation: 'append', new_value: ', SOS', field_label: 'Advice' }).ok, true);
  assert.ok(adviceLines(ed.state.doc).includes(`${BENA}, SOS`));
  ed = makeEditor(layout.A());
  assert.equal(applyVoiceEdit(ed, { block_id: id(ed, 'ACUTE'), operation: 'append', new_value: ', DEHYDRATION', field_label: 'Diagnosis' }).ok, true);
  let d = ''; ed.state.doc.forEach((n) => { if (n.textContent.startsWith('ACUTE')) d = n.textContent; });
  assert.equal(d, 'ACUTE GASTROENTERITIS, DEHYDRATION');
  // a medicine dose change inside one line is still a normal replacement
  ed = makeEditor(layout.B());
  assert.equal(applyVoiceEdit(ed, { block_id: id(ed, 'Tab. CIPLOX'), operation: 'replace_text', find_text: '200 mg', new_value: '500 mg', field_label: 'Advice' }).ok, true);
  assert.ok(adviceLines(ed.state.doc).includes(CIPLOX.replace('200 mg', '500 mg')));
});

test('a department-template medicine section (MEDICATIONS): ", Tab. X" is its own line; one Undo restores the document', () => {
  const ed = makeEditor([h('NURSING NOTES'), p(t('Stable')), h('MEDICATIONS'), p(t('Inj. PANTOP 40 mg IV OD'), br(), t('Tab. DOLO 650 mg SOS')), h('REMARKS'), p(t('None'))]);
  const before = ed.state.doc;
  asOneUndoStep(ed.view, () => assert.equal(applyVoiceEdit(ed, { block_id: 'B3', operation: 'append', new_value: ', Tab. ZINCOVIT Once Daily', field_label: 'Medications' }).ok, true));
  let m = ''; ed.state.doc.forEach((n) => { if (n.textContent.startsWith('Inj.')) { n.forEach((c) => { m += c.isText ? c.text : '↵'; }); } });
  assert.equal(m, 'Inj. PANTOP 40 mg IV OD↵Tab. DOLO 650 mg SOS↵Tab. ZINCOVIT Once Daily');
  undo(ed.state, (tr) => { ed.state = ed.state.apply(tr); });
  assert.ok(ed.state.doc.eq(before));
});
