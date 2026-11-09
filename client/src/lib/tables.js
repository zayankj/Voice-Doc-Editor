// Tables: where a text block sits in a table, and what that cell is (a column title, a row name or a value).
//
// A DATA TABLE is a table of results, e.g.
//     Investigation | Result          <- column titles (row 0)
//     HB            | 13.6 G/DL       <- row name | value
// In a data table the column titles and the row names (first column) are labels: they never change by AI.
// Only the value cells may change, and only the value cell of the row that was asked for.

const isCellNode = (n) => n.type.name === 'tableCell' || n.type.name === 'tableHeader';

// Column titles that mark a data table (compared in lower case, without punctuation)
const COLUMN_TITLES = new Set([
  'investigation', 'investigations', 'test', 'tests', 'test name', 'lab test', 'lab tests', 'parameter', 'parameters',
  'result', 'results', 'value', 'values', 'observed value', 'unit', 'units', 'reference range', 'ref range',
  'normal range', 'normal value', 'normal values', 'biological reference interval', 'findings', 'observation',
]);

const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const cellsOf = (row) => {
  const out = [];
  row.forEach((c) => out.push(c));
  return out;
};

// Where is the block at `pos` (the position just before a paragraph)? null when it is not directly in a table cell.
// { cell, row, table, col, rowIndex, cellPos, rowPos, tablePos }
export function cellAt(doc, pos) {
  const $p = doc.resolve(pos);
  const d = $p.depth;
  if (d < 3 || !isCellNode($p.parent)) return null;
  return {
    cell: $p.parent,
    row: $p.node(d - 1),
    table: $p.node(d - 2),
    col: $p.index(d - 1),
    rowIndex: $p.index(d - 2),
    cellPos: $p.before(d),
    rowPos: $p.before(d - 1),
    tablePos: $p.before(d - 2),
  };
}

// Does the first row hold column titles ("Investigation | Result")?
export const hasTitleRow = (table) => table.childCount > 0 && cellsOf(table.child(0)).some((c) => COLUMN_TITLES.has(norm(c.textContent)));

// A table of results: it has a title row, or every row is "name | value" and most values are numbers
export function isDataTable(table) {
  if (table.childCount < 2) return false;
  if (hasTitleRow(table)) return true;
  let numbers = 0;
  let twoCells = 0;
  table.forEach((r) => {
    if (r.childCount !== 2) return;
    twoCells++;
    if (/^\s*[<>]?\s*\d/.test(r.child(1).textContent)) numbers++;
  });
  return twoCells === table.childCount && numbers >= Math.max(2, Math.ceil(twoCells / 2));
}

// 'title' | 'name' | 'value' for a cell of a data table, null otherwise
export function dataCellRole(info) {
  if (!info || !isDataTable(info.table)) return null;
  if (info.rowIndex === 0 && hasTitleRow(info.table)) return 'title';
  return info.col === 0 ? 'name' : 'value';
}

// The name of the row a cell is in ("SERUM CREATININE")
export const rowName = (info) => info.row.child(0).textContent.trim();

// All row names of a data table (title row left out)
export function rowNames(table) {
  const out = [];
  table.forEach((r, _o, i) => {
    if (i === 0 && hasTitleRow(table)) return;
    out.push(r.child(0).textContent.trim());
  });
  return out;
}

// The value cell next to a label cell, in the SAME row: { pos, node } of its first text block, or null
export function valueCellAfter(info) {
  if (info.col + 1 >= info.row.childCount) return null;
  const next = info.row.child(info.col + 1);
  const first = next.firstChild;
  if (!first || !first.isTextblock) return null;
  return { pos: info.cellPos + info.cell.nodeSize + 1, node: first };
}

// ---------- values: keep the unit and the number style ----------
// "1.9 MG/DL" -> number "1.9", gap " ", unit "MG/DL". The unit has no digits ("17.9 seconds (control - 14 s)" is not split).
const VALUE = /^\s*(\d[\d,]*(?:\.\d+)?)(\s*)([^\d\s][^\d]*?)?\s*$/;
const digitsOf = (n) => n.replace(/,/g, '');
const sameText = (a, b) => a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase();

// 586000 -> "5,86,000" (Indian) or "586,000"
function group(num, indian) {
  const [int, dec] = num.split('.');
  let out;
  if (indian && int.length > 3) {
    const last3 = int.slice(-3);
    out = `${int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  } else {
    out = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  return dec != null ? `${out}.${dec}` : out;
}

// The new text for a value cell, written the way the old value was written:
//   "1.9 MG/DL" + "2.9"           -> "2.9 MG/DL"     (unit kept)
//   "3,86,000/CUMM" + "586000"    -> "5,86,000/CUMM" (unit and comma style kept)
//   "1.2 MG/DL" + "2.2 mg/dl"     -> "2.2 MG/DL"     (same unit: original capitals kept)
//   "26,560/CUMM" + "26,560/cumm" -> "26,560/CUMM"   (only capitals differ: no change)
// A different unit, or a value that is not "number + unit", is returned as given.
export function keepValueFormat(oldText, newText) {
  if (sameText(oldText, newText)) return oldText;
  const o = String(oldText).match(VALUE);
  const n = String(newText).match(VALUE);
  if (!o || !n) return newText;
  const [, oNum, oGap, oUnit = ''] = o;
  const [, nNum, , nUnit = ''] = n;
  if (nUnit && !sameText(nUnit, oUnit)) return newText; // a really different unit: as given
  const indian = /\d,\d\d,\d{3}/.test(oNum);
  const num = oNum.includes(',') ? group(digitsOf(nNum), indian) : digitsOf(nNum);
  return oUnit ? `${num}${oGap}${oUnit}` : num;
}
