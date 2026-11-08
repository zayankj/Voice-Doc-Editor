import { EditorContent } from '@tiptap/react';

// The grey desk with a white A4-like page, like Word. zoom is a percentage.
// className: extra style for the page, e.g. "tpl-doc" for documents made from department templates
export default function DocEditor({ editor, zoom = 100, className = '' }) {
  return (
    <div className="desk">
      <div className={`page ${className}`} style={{ zoom: zoom / 100 }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}