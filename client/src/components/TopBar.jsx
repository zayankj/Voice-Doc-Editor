import Dropdown from './Dropdown';

export default function TopBar({
  editor, title, saved, userInitial, onBack, backLabel = '← Back',
  onOpen, onExportDocx, onPrint, onInsertImage, onZoom, onValidate, onFixConsistency,
}) {
  const cmd = (fn) => () => {
    if (editor) fn(editor.chain().focus()).run();
  };

  const menus = [
    ['File', [
      { label: 'Open .docx…', onClick: onOpen },
      { label: 'Export as .docx', onClick: onExportDocx },
      { label: 'Print / Save as PDF', hint: 'Ctrl+P', onClick: onPrint },
    ]],
    ['Edit', [
      { label: 'Undo', hint: 'Ctrl+Z', onClick: cmd((c) => c.undo()) },
      { label: 'Redo', hint: 'Ctrl+Y', onClick: cmd((c) => c.redo()) },
      { divider: true },
      { label: 'Select all', hint: 'Ctrl+A', onClick: cmd((c) => c.selectAll()) },
    ]],
    ['View', [
      { label: 'Zoom 75%', onClick: () => onZoom(75) },
      { label: 'Zoom 100%', onClick: () => onZoom(100) },
      { label: 'Zoom 125%', onClick: () => onZoom(125) },
    ]],
    ['Insert', [
      { label: 'Table (3 × 3)', onClick: cmd((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: false })) },
      { label: 'Image…', onClick: onInsertImage },
      { label: 'Horizontal line', onClick: cmd((c) => c.setHorizontalRule()) },
    ]],
    ['Format', [
      { label: 'Bold', hint: 'Ctrl+B', onClick: cmd((c) => c.toggleBold()) },
      { label: 'Italic', hint: 'Ctrl+I', onClick: cmd((c) => c.toggleItalic()) },
      { label: 'Underline', hint: 'Ctrl+U', onClick: cmd((c) => c.toggleUnderline()) },
      { divider: true },
      { label: 'Heading 1', onClick: cmd((c) => c.setHeading({ level: 1 })) },
      { label: 'Heading 2', onClick: cmd((c) => c.setHeading({ level: 2 })) },
      { label: 'Heading 3', onClick: cmd((c) => c.setHeading({ level: 3 })) },
      { label: 'Normal text', onClick: cmd((c) => c.setParagraph()) },
    ]],
    ['Validate', [
      { label: 'Find missing fields', onClick: onValidate },
      ...(onFixConsistency ? [{ label: 'Fix age / gender everywhere', onClick: onFixConsistency }] : []),
    ]],
    ['Help', [
      { info: 'Voice: tap the mic and say "change the discharge date to today\'s date".' },
      { info: 'Say "change the name from X to Y" to change only that part.' },
      { info: 'Attach a photo, scan or PDF, then click Apply Edit.' },
      { info: 'Or type an instruction and click Apply Edit.' },
    ]],
  ];

  return (
    <header className="topbar">
      {onBack ? (
        <button className="back-btn" onClick={onBack} title="Back to the list">{backLabel}</button>
      ) : (
        <span className="logo">▤</span>
      )}
      <div className="doc-title">
        <b>{title}</b>
        <span className={`saved ${saved ? '' : 'saving'}`}>{saved ? '✓ Saved' : 'Saving…'}</span>
      </div>
      <nav className="menus">
        {menus.map(([name, items]) => (
          <Dropdown key={name} className="menu" label={name} items={items} />
        ))}
      </nav>
      <div className="spacer" />
      <Dropdown
        className="export"
        label="⭳ Export ▾"
        align="right"
        items={[
          { label: 'Word (.docx)', onClick: onExportDocx },
          { label: 'PDF (print dialog)', onClick: onPrint },
        ]}
      />
      {userInitial && <div className="avatar">{userInitial}</div>}
    </header>
  );
}