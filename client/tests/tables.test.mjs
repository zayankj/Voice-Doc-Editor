// Regression tests for table editing (Lab Investigations, header fields such as IP No).
// The edits below are the REAL edits the AI returned during the audit (voice clips, a lab image, a PDF),
// replayed on a dummy document (no patient data).
// Run:  cd client  &&  node --test tests/
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { EditorState } from '@tiptap/pm/state';
import { history, undo, undoDepth } from '@tiptap/pm/history';
import { asOneUndoStep } from '../src/lib/undoStep.js';
import { getBlocks } from '../src/lib/outline.js';
import { lockReason } from '../src/lib/guards.js';
import { keepValueFormat, cellAt, dataCellRole, isDataTable } from '../src/lib/tables.js';

// voiceEdit.js imports its neighbours without ".js": a temporary copy with the endings added
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-tables');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'medicineText', 'sections']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell]);
const BOLD = () => [schema.marks.bold.create()];
const p = (t) => schema.node('paragraph', null, t ? [schema.text(t)] : []);
const bold = (t) => schema.node('paragraph', null, t ? [schema.text(t, BOLD())] : []);
const th = (t) => schema.node('tableHeader', null, [typeof t === 'string' ? p(t) : t]);
const tr = (...c) => schema.node('tableRow', null, c);
const table = (...r) => schema.node('table', null, r);

const LAB = [['HB', '13.6 G/DL'], ['TLC', '26,560/CUMM'], ['PLATELET COUNT', '3,86,000/CUMM'], ['SERUM CREATININE', '1.9 MG/DL'],
  ['TOTAL BILIRUBIN', '1.2 MG/DL'], ['SGPT', '41 U/L'], ['SGOT', '39 U/L'], ['ALP', '248 U/L'], ['SODIUM', '140 MEQ/L'], ['POTASSIUM', '3.4 MEQ/L']];
// Same block numbers as in the audit: B11 "IP No", B12 its value, B16/B17 column titles, B18.. lab rows
function makeDoc(ipValue = 'IP00011111') {
  return schema.node('doc', null, [
    bold('DISCHARGE SUMMARY'),
    table(
      tr(th('Name'), th('MR. TEST PATIENT'), th('AGE'), th('40 Y')),
      tr(th('Address'), th('DUMMY STREET'), th('SEX'), th('MALE')),
      tr(th('Discharge Date'), th('30-10-2026'), th('IP No'), th(ipValue)),
    ),
    bold('DIAGNOSIS'), p('ENTERIC FEVER'),
    bold('LAB INVESTIGATIONS'),
    table(tr(th(bold('Investigation')), th(bold('Result'))), ...LAB.map(([a, b]) => tr(th(bold(a)), th(bold(b))))),
    bold('COURSE IN HOSPITAL'), p('Creatinine was 1.9 on admission. Patient is stable.'),
  ]);
}
class FakeView { constructor(o) { this.o = o; } dispatch(t) { this.o.state = this.o.state.apply(t); } }
function makeEditor(doc = makeDoc()) {
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), schema, isDestroyed: false };
  ed.view = new FakeView(ed);
  return ed;
}
const done = (ed) => { ed.isDestroyed = true; };
// every table row as "a | b | ..."
const rows = (doc) => {
  const out = [];
  doc.descendants((n) => {
    if (n.type.name !== 'tableRow') return true;
    const c = [];
    n.forEach((x) => c.push(x.textContent));
    out.push(c.join(' | '));
    return false;
  });
  return out;
};
const labRows = (doc) => rows(doc).slice(4); // after the 3 header rows and the column titles
const LAB_ROWS = LAB.map(([a, b]) => `${a} | ${b}`);
const withRow = (name, value) => LAB_ROWS.map((r) => (r.startsWith(`${name} |`) ? `${name} | ${value}` : r));
// apply AI edits the way App.jsx does: from the bottom of the document up
function applyAll(ed, edits, opts = {}) {
  const n = (e) => parseInt(e.block_id.slice(1), 10);
  return [...edits].sort((a, b) => n(b) - n(a)).map((e) => applyVoiceEdit(ed, e, opts));
}

// ---------- the value keeps its unit, number style and capitals ----------
test('keepValueFormat: units, Indian commas and capitals are kept', () => {
  assert.equal(keepValueFormat('1.9 MG/DL', '2.9'), '2.9 MG/DL');
  assert.equal(keepValueFormat('3,86,000/CUMM', '586000'), '5,86,000/CUMM');
  assert.equal(keepValueFormat('3,86,000/CUMM', '5,86,000'), '5,86,000/CUMM');
  assert.equal(keepValueFormat('26,560/CUMM', '28000'), '28,000/CUMM');
  assert.equal(keepValueFormat('1.2 MG/DL', '2.2 mg/dl'), '2.2 MG/DL');
  assert.equal(keepValueFormat('26,560/CUMM', '26,560/cumm'), '26,560/CUMM'); // only capitals differ: unchanged
  assert.equal(keepValueFormat('26,560/CUMM', '26,560'), '26,560/CUMM'); // unit dropped by the AI: unchanged
  assert.equal(keepValueFormat('40 Y', '41'), '41 Y');
});

test('keepValueFormat: a different unit, a date or text is written as given', () => {
  assert.equal(keepValueFormat('1.9 MG/DL', '168 UMOL/L'), '168 UMOL/L');
  assert.equal(keepValueFormat('48.9', '50 MG/L'), '50 MG/L');
  assert.equal(keepValueFormat('30-10-2026', '31-10-2026'), '31-10-2026');
  assert.equal(keepValueFormat('17.9 seconds (control - 14 seconds)', '18.2 seconds (control - 14 seconds)'), '18.2 seconds (control - 14 seconds)');
  assert.equal(keepValueFormat('POSITIVE', 'NEGATIVE'), 'NEGATIVE');
});

// ---------- which cells are labels ----------
test('Lab table: column titles and investigation names are locked labels; results are editable', () => {
  const doc = makeDoc();
  const b = (t) => getBlocks(doc).find((x) => x.node.textContent === t);
  for (const label of ['Investigation', 'Result', 'HB', 'SGPT', 'SGOT', 'PLATELET COUNT', 'SERUM CREATININE']) {
    assert.ok(lockReason(doc, b(label), 'set', '2.9 MG/DL'), label);
  }
  for (const value of ['13.6 G/DL', '41 U/L', '1.9 MG/DL']) assert.equal(lockReason(doc, b(value), 'set', '2.9 MG/DL'), '', value);
  assert.equal(dataCellRole(cellAt(doc, b('HB').pos)), 'name');
  assert.equal(dataCellRole(cellAt(doc, b('Name').pos)), null); // the header table is not a lab table
});

test('a lab table WITHOUT a title row is still recognised ("HB | 13.6 G/DL" rows)', () => {
  const t = table(...LAB.slice(0, 4).map(([a, b]) => tr(th(a), th(b))));
  assert.equal(isDataTable(t), true);
  assert.equal(isDataTable(table(tr(th('Name'), th('X')), tr(th('Address'), th('Y')))), false);
});

// ---------- bug 1: the investigation name was overwritten ----------
test('VOICE (audit): AI set the label "SERUM CREATININE" to "2.9 MG/DL" -> the RESULT changes, the name stays', () => {
  const ed = makeEditor();
  const r = applyVoiceEdit(ed, { block_id: 'B24', operation: 'set', new_value: '2.9 MG/DL', field_label: 'Serum Creatinine' });
  assert.equal(r.ok, true);
  assert.deepEqual(labRows(ed.state.doc), withRow('SERUM CREATININE', '2.9 MG/DL'));
  done(ed);
});

test('IMAGE upload (audit, 3 of 3 runs): values written into PLATELET COUNT / SERUM CREATININE labels -> results change', () => {
  const ed = makeEditor();
  applyAll(ed, [
    { block_id: 'B24', operation: 'set', new_value: '2.4 MG/DL' },
    { block_id: 'B22', operation: 'set', new_value: '2,10,000/CUMM' },
  ], { allowGender: true });
  assert.deepEqual(labRows(ed.state.doc), withRow('PLATELET COUNT', '2,10,000/CUMM').map((r, i) => withRow('SERUM CREATININE', '2.4 MG/DL')[i] !== LAB_ROWS[i] ? withRow('SERUM CREATININE', '2.4 MG/DL')[i] : r));
  done(ed);
});

test('IMAGE upload (audit run 1): "clear ALP and TOTAL BILIRUBIN" aimed at the labels -> refused, table unchanged', () => {
  const ed = makeEditor();
  const before = ed.state.doc;
  const rs = applyAll(ed, [
    { block_id: 'B32', operation: 'set', new_value: '' },
    { block_id: 'B26', operation: 'set', new_value: '' },
    { block_id: 'B32', operation: 'clear' },
  ], { allowGender: true });
  assert.ok(rs.every((r) => r.ok === false && r.blocked));
  assert.ok(ed.state.doc.eq(before));
  done(ed);
});

test('the name cell keeps its bold formatting, and the result keeps bold after the change', () => {
  const ed = makeEditor();
  applyVoiceEdit(ed, { block_id: 'B30', operation: 'set', new_value: '50' }); // the SGOT label
  const cells = [];
  ed.state.doc.descendants((n) => { if (n.isText && /SGOT|50 U\/L/.test(n.text)) cells.push([n.text, n.marks.map((m) => m.type.name)]); });
  assert.deepEqual(cells, [['SGOT', ['bold']], ['50 U/L', ['bold']]]);
  done(ed);
});

// ---------- bugs 2 + 3: unit lost, capitals changed ----------
test('VOICE (audit): "26,560" and "2.2" without unit -> units kept (TLC unchanged, bilirubin 2.2 MG/DL)', () => {
  const ed = makeEditor();
  const rs = applyAll(ed, [
    { block_id: 'B27', operation: 'set', new_value: '2.2' },
    { block_id: 'B21', operation: 'set', new_value: '26,560' },
  ]);
  assert.deepEqual(labRows(ed.state.doc), withRow('TOTAL BILIRUBIN', '2.2 MG/DL'));
  assert.equal(rs.find((r) => r.unchanged)?.ok, true); // TLC: nothing really changed
  done(ed);
});

test('VOICE (audit): lower-case "26,560/cumm" / "2.2 mg/dl" -> original capitals kept', () => {
  const ed = makeEditor();
  applyAll(ed, [
    { block_id: 'B27', operation: 'set', new_value: '2.2 mg/dl' },
    { block_id: 'B21', operation: 'set', new_value: '26,560/cumm' },
  ]);
  assert.deepEqual(labRows(ed.state.doc), withRow('TOTAL BILIRUBIN', '2.2 MG/DL'));
  done(ed);
});

test('"Change platelet count to 586000" -> 5,86,000/CUMM; the name stays PLATELET COUNT', () => {
  const ed = makeEditor();
  applyVoiceEdit(ed, { block_id: 'B23', operation: 'set', new_value: '586000' });
  assert.deepEqual(labRows(ed.state.doc), withRow('PLATELET COUNT', '5,86,000/CUMM'));
  done(ed);
});

test('replace_text of only the number keeps the unit; aimed at the label it is moved to the value', () => {
  const ed = makeEditor();
  applyVoiceEdit(ed, { block_id: 'B25', operation: 'replace_text', find_text: '1.9', new_value: '2.9' });
  applyVoiceEdit(ed, { block_id: 'B28', operation: 'replace_text', find_text: '41', new_value: '45' }); // the SGPT label
  assert.deepEqual(labRows(ed.state.doc), withRow('SERUM CREATININE', '2.9 MG/DL').map((r) => (r.startsWith('SGPT') ? 'SGPT | 45 U/L' : r)));
  done(ed);
});

test('numbers in ordinary text (not a table) are not touched by the unit rule', () => {
  const ed = makeEditor();
  applyVoiceEdit(ed, { block_id: 'B39', operation: 'replace_text', find_text: '1.9', new_value: '2.9 mg/dl' });
  assert.equal(getBlocks(ed.state.doc)[39].node.textContent, 'Creatinine was 2.9 mg/dl on admission. Patient is stable.');
  done(ed);
});

// ---------- bug 6: a new row pasted inside a cell ----------
test('IMAGE/PDF upload (audit): insert_after "CRP | 48.9 MG/L" -> a REAL new row; POTASSIUM cell untouched', () => {
  for (const block_id of ['B37', 'B36']) { // after the value cell, or after the name cell
    const ed = makeEditor();
    const r = applyVoiceEdit(ed, { block_id, operation: 'insert_after', new_value: 'CRP | 48.9 MG/L' });
    assert.equal(r.ok, true, block_id);
    assert.deepEqual(labRows(ed.state.doc), [...LAB_ROWS, 'CRP | 48.9 MG/L'], block_id);
    // same look as the other rows: header cells, bold text
    const last = rows(ed.state.doc).length;
    let crp;
    ed.state.doc.descendants((n) => { if (n.isText && n.text === 'CRP') crp = n; });
    assert.deepEqual(crp.marks.map((m) => m.type.name), ['bold']);
    assert.equal(last, 15);
    done(ed);
  }
});

test('insert_after ALP (audit run 2) -> the new row goes right after ALP, the ALP cell is not changed', () => {
  const ed = makeEditor();
  applyVoiceEdit(ed, { block_id: 'B32', operation: 'insert_after', new_value: 'CRP | 48.9 MG/L' });
  const r = labRows(ed.state.doc);
  assert.equal(r[7], 'ALP | 248 U/L');
  assert.equal(r[8], 'CRP | 48.9 MG/L');
  done(ed);
});

test('a lab-table line that is not one value per column, or an investigation already there -> refused', () => {
  const ed = makeEditor();
  const before = ed.state.doc;
  assert.equal(applyVoiceEdit(ed, { block_id: 'B37', operation: 'insert_after', new_value: 'CRP 48.9' }).blocked, true);
  assert.equal(applyVoiceEdit(ed, { block_id: 'B37', operation: 'insert_after', new_value: 'CRP | 48.9 | mg/l' }).blocked, true);
  assert.match(applyVoiceEdit(ed, { block_id: 'B37', operation: 'insert_after', new_value: 'sgpt | 50 U/L' }).error, /already in the table/);
  assert.ok(ed.state.doc.eq(before));
  done(ed);
});

// ---------- bug 10: IP No ----------
test('IP No: an edit aimed at the "IP No" label updates the VALUE; the label stays', () => {
  for (const new_value of ['IP00019515', 'IP No: IP00019515', 'IP No IP00019515']) {
    const ed = makeEditor();
    const r = applyVoiceEdit(ed, { block_id: 'B11', operation: 'set', new_value, field_label: 'IP Number' });
    assert.equal(r.ok, true, new_value);
    assert.equal(rows(ed.state.doc)[2], 'Discharge Date | 30-10-2026 | IP No | IP00019515', new_value);
    done(ed);
  }
});

test('IP No: replace_text on the label, or append to the label when the value is empty -> value updated', () => {
  let ed = makeEditor();
  applyVoiceEdit(ed, { block_id: 'B11', operation: 'replace_text', find_text: 'IP00011111', new_value: 'IP00019515' });
  assert.equal(rows(ed.state.doc)[2], 'Discharge Date | 30-10-2026 | IP No | IP00019515');
  done(ed);
  ed = makeEditor(makeDoc(''));
  applyVoiceEdit(ed, { block_id: 'B11', operation: 'append', new_value: ': IP00019515' });
  assert.equal(rows(ed.state.doc)[2], 'Discharge Date | 30-10-2026 | IP No | IP00019515');
  done(ed);
});

test('IP No: the label itself can still never be changed or cleared', () => {
  const ed = makeEditor();
  const before = ed.state.doc;
  assert.equal(applyVoiceEdit(ed, { block_id: 'B11', operation: 'clear' }).blocked, true);
  assert.equal(applyVoiceEdit(ed, { block_id: 'B11', operation: 'set', new_value: 'IP No' }).blocked, true); // nothing for the value
  assert.equal(applyVoiceEdit(ed, { block_id: 'B11', operation: 'append', new_value: 'IP00019515' }).blocked, true); // value already there: unclear
  assert.ok(ed.state.doc.eq(before));
  done(ed);
});

test('other header fields work the same way (AGE label -> age value keeps "Y")', () => {
  const ed = makeEditor();
  applyVoiceEdit(ed, { block_id: 'B3', operation: 'set', new_value: '41' });
  assert.equal(rows(ed.state.doc)[0], 'Name | MR. TEST PATIENT | AGE | 41 Y');
  done(ed);
});

// ---------- one Undo ----------
test('all edits of one upload are ONE undo step, and Undo restores the exact original table', () => {
  const ed = makeEditor();
  const original = ed.state.doc;
  asOneUndoStep(ed.view, () => {
    applyAll(ed, [
      { block_id: 'B37', operation: 'insert_after', new_value: 'CRP | 48.9 MG/L' },
      { block_id: 'B24', operation: 'set', new_value: '2.4 MG/DL' },
      { block_id: 'B22', operation: 'set', new_value: '2,10,000/CUMM' },
    ], { allowGender: true });
  });
  assert.equal(undoDepth(ed.state), 1);
  undo(ed.state, ed.view.dispatch.bind(ed.view));
  assert.ok(ed.state.doc.eq(original));
  done(ed);
});

// ---------- the row and number check for typed / spoken commands ----------
const DOC = makeDoc();







