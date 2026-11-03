import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType,
} from 'docx';

const HEADINGS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
];

function runs(node, prefix = '') {
  const out = prefix ? [new TextRun(prefix)] : [];
  (node.content || []).forEach((n) => {
    if (n.type === 'hardBreak') return out.push(new TextRun({ break: 1 }));
    const m = (n.marks || []).map((x) => x.type);
    out.push(new TextRun({
      text: n.text || '',
      bold: m.includes('bold'),
      italics: m.includes('italic'),
      underline: m.includes('underline') ? {} : undefined,
    }));
  });
  return out;
}

function toBlocks(node, extra = {}, prefix = '') {
  switch (node.type) {
    case 'paragraph':
      return [new Paragraph({ children: runs(node, prefix), ...extra })];
    case 'heading':
      return [new Paragraph({ children: runs(node), heading: HEADINGS[node.attrs.level - 1] })];
    case 'bulletList':
      return node.content.flatMap((li) => li.content.flatMap((c) => toBlocks(c, { bullet: { level: 0 } })));
    case 'orderedList':
      return node.content.flatMap((li, i) => li.content.flatMap((c) => toBlocks(c, {}, `${i + 1}. `)));
    case 'table':
      return [new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: node.content.map((row) => new TableRow({
          children: row.content.map((cell) => {
            const kids = (cell.content || []).flatMap((c) => toBlocks(c));
            return new TableCell({ children: kids.length ? kids : [new Paragraph('')] });
          }),
        })),
      }), new Paragraph('')];
    default:
      return [];
  }
}

export async function exportDocx(editor, filename = 'edited-document.docx') {
  const children = editor.getJSON().content.flatMap((n) => toBlocks(n));
  const file = new Document({ sections: [{ children: children.length ? children : [new Paragraph('')] }] });
  const blob = await Packer.toBlob(file);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
