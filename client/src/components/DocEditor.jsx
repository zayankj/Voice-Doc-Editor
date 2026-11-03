import { EditorContent } from '@tiptap/react';

// The grey desk with a white A4-like page, like Word.
export default function DocEditor({ editor }) {
  return (
    <div className="desk">
      <div className="page">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
