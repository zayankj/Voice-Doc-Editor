// Every text block (paragraph, heading, table cell paragraph...) gets an ordinal number B0, B1, B2...
// in document order. The model refers to blocks by that number.

// Flat list of text blocks in document order: [{ index, pos, node }]
export function getBlocks(doc) {
  const blocks = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      blocks.push({ index: blocks.length, pos, node });
      return false;
    }
    return true;
  });
  return blocks;
}

// Text outline the model reads. Table rows are kept on one line so it can see "label | value | label | value".
export function buildOutline(doc) {
  const lines = [];
  const counter = { n: 0 };

  const walk = (node, out) => {
    node.forEach((child) => {
      const type = child.type.name;
      if (type === 'table') {
        child.forEach((row) => {
          const cells = [];
          row.forEach((cell) => {
            const sub = [];
            walk(cell, sub);
            cells.push(sub.join(' / '));
          });
          out.push('TABLE ROW: ' + cells.join(' | '));
        });
      } else if (child.isTextblock) {
        const tag = type === 'heading' ? `H${child.attrs.level}` : 'P';
        out.push(`[B${counter.n++}] (${tag}) ${JSON.stringify(child.textContent)}`);
      } else {
        walk(child, out);
      }
    });
  };

  walk(doc, lines);
  return lines.join('\n');
}
