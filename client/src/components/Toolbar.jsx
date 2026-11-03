export default function Toolbar({ editor, onOpen, onExport, fileName }) {
  if (!editor) return null;
  const btn = (label, action, active = false, title) => (
    <button
      title={title}
      className={active ? 'tb on' : 'tb'}
      onMouseDown={(e) => { e.preventDefault(); action(); }}
    >
      {label}
    </button>
  );

  const headingValue = [1, 2, 3].find((l) => editor.isActive('heading', { level: l })) || 0;
  const setHeading = (v) => {
    const level = Number(v);
    level ? editor.chain().focus().setHeading({ level }).run() : editor.chain().focus().setParagraph().run();
  };

  return (
    <div className="toolbar-bar">
      <button className="tb solid" onClick={onOpen}>Open .docx</button>
      <span className="muted file">{fileName}</span>
      <span className="sep" />
      {btn('↶', () => editor.chain().focus().undo().run(), false, 'Undo')}
      {btn('↷', () => editor.chain().focus().redo().run(), false, 'Redo')}
      <select value={headingValue} onChange={(e) => setHeading(e.target.value)}>
        <option value={0}>Normal text</option>
        <option value={1}>Heading 1</option>
        <option value={2}>Heading 2</option>
        <option value={3}>Heading 3</option>
      </select>
      {btn(<b>B</b>, () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
      {btn(<i>I</i>, () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
      {btn(<u>U</u>, () => editor.chain().focus().toggleUnderline().run(), editor.isActive('underline'))}
      {btn('• List', () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}
      <span className="sep" />
      <button className="tb solid" onClick={onExport}>Export .docx</button>
    </div>
  );
}
