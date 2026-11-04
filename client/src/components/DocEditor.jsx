import { EditorContent } from '@tiptap/react';

// The grey desk with a white A4-like page, like Word. zoom is a percentage.
export default function DocEditor({ editor, zoom = 100 }) {
  return (
    <div className="desk">
      <div className="page" style={{ zoom: zoom / 100 }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}