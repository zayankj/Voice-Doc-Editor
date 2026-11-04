import Dropdown from './Dropdown';

const ALIGNS = [['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['justify', 'Justify']];
const SPACINGS = ['1', '1.15', '1.5', '2'];
const ZOOMS = [50, 75, 100, 125, 150];

export default function FormatBar({ editor, zoom, onZoom, onPrint, onInsertImage, collapsed, onToggle }) {
  if (!editor) return null;

  if (collapsed) {
    return (
      <div className="fmtbar collapsed">
        <div className="fmt-spacer" />
        <button className="ib" title="Show toolbar" onClick={onToggle}>⌄</button>
      </div>
    );
  }

  const textStyle = editor.getAttributes('textStyle');
  const size = parseInt(textStyle.fontSize, 10) || 14;
  const color = /^#[0-9a-f]{6}$/i.test(textStyle.color || '') ? textStyle.color : '#1b1f24';
  const headingValue = [1, 2, 3].find((l) => editor.isActive('heading', { level: l })) || 0;
  const inTable = editor.isActive('table');

  const setHeading = (v) => {
    const level = Number(v);
    (level ? editor.chain().focus().setHeading({ level }) : editor.chain().focus().setParagraph()).run();
  };
  const setSize = (n) => editor.chain().focus().setFontSize(`${Math.max(8, Math.min(48, n))}px`).run();

  const btn = (label, action, active = false, title) => (
    <button
      className={`ib ${active ? 'on' : ''}`}
      title={title}
      onMouseDown={(e) => { e.preventDefault(); action(); }}
    >
      {label}
    </button>
  );

  const moreItems = [
    { label: 'Strikethrough', onClick: () => editor.chain().focus().toggleStrike().run() },
    { label: 'Remove highlight', onClick: () => editor.chain().focus().unsetHighlight().run() },
    { label: 'Clear text formatting', onClick: () => editor.chain().focus().unsetAllMarks().run() },
    { divider: true },
    { label: 'Insert table (3 × 3)', onClick: () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run() },
    { label: 'Add row below', disabled: !inTable, onClick: () => editor.chain().focus().addRowAfter().run() },
    { label: 'Add column right', disabled: !inTable, onClick: () => editor.chain().focus().addColumnAfter().run() },
    { label: 'Delete row', disabled: !inTable, onClick: () => editor.chain().focus().deleteRow().run() },
    { label: 'Delete column', disabled: !inTable, onClick: () => editor.chain().focus().deleteColumn().run() },
    { label: 'Delete table', disabled: !inTable, onClick: () => editor.chain().focus().deleteTable().run() },
  ];

  return (
    <div className="fmtbar">
      {btn('↶', () => editor.chain().focus().undo().run(), false, 'Undo')}
      {btn('↷', () => editor.chain().focus().redo().run(), false, 'Redo')}
      {btn('🖨', onPrint, false, 'Print')}
      <select title="Zoom" value={zoom} onChange={(e) => onZoom(Number(e.target.value))}>
        {ZOOMS.map((z) => <option key={z} value={z}>{z}%</option>)}
      </select>
      <span className="sep" />

      <select title="Text style" value={headingValue} onChange={(e) => setHeading(e.target.value)}>
        <option value={0}>Normal text</option>
        <option value={1}>Heading 1</option>
        <option value={2}>Heading 2</option>
        <option value={3}>Heading 3</option>
      </select>
      {btn('−', () => setSize(size - 1), false, 'Smaller text')}
      <span className="size">{size}</span>
      {btn('+', () => setSize(size + 1), false, 'Bigger text')}
      <span className="sep" />

      {btn(<b>B</b>, () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'), 'Bold')}
      {btn(<i>I</i>, () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'), 'Italic')}
      {btn(<u>U</u>, () => editor.chain().focus().toggleUnderline().run(), editor.isActive('underline'), 'Underline')}

      <label className="ib colorbtn" title="Text color">
        <span style={{ borderBottom: `3px solid ${color}` }}>A</span>
        <input
          type="color"
          value={color}
          onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
        />
      </label>
      <label className="ib colorbtn" title="Highlight color">
        <span style={{ borderBottom: '3px solid #fff176' }}>🖍</span>
        <input
          type="color"
          defaultValue="#fff176"
          onChange={(e) => editor.chain().focus().setHighlight({ color: e.target.value }).run()}
        />
      </label>
      <span className="sep" />

      <Dropdown
        className="ib-dd"
        title="Alignment"
        label="☰"
        items={ALIGNS.map(([v, l]) => ({
          label: `${editor.isActive({ textAlign: v }) ? '✓ ' : ''}${l}`,
          onClick: () => editor.chain().focus().setTextAlign(v).run(),
        }))}
      />
      <Dropdown
        className="ib-dd"
        title="Line spacing"
        label="↕"
        items={SPACINGS.map((s) => ({
          label: `Line spacing ${s}`,
          onClick: () => editor.chain().focus().setLineHeight(s).run(),
        }))}
      />
      {btn('• List', () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'), 'Bullet list')}
      {btn('1. List', () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'), 'Numbered list')}
      <Dropdown className="ib-dd" title="More" label="⋮" items={moreItems} />

      <div className="fmt-spacer" />
      {btn('🖼', onInsertImage, false, 'Insert image')}
      <button className="ib" title="Hide toolbar" onClick={onToggle}>⌃</button>
    </div>
  );
}