import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// Shows every {{placeholder}} (a value that is not filled in yet) in a soft grey box.
// Purely visual: the text itself is not changed, saved or exported differently.
const KEY = new PluginKey('placeholders');
const RE = /\{\{\s*[a-z0-9_]+\s*\}\}/gi;

function find(doc) {
  const decos = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const m of node.text.matchAll(RE)) {
      decos.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, { class: 'ph' }));
    }
  });
  return DecorationSet.create(doc, decos);
}

export const Placeholders = Extension.create({
  name: 'placeholders',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: KEY,
        state: {
          init: (_, { doc }) => find(doc),
          apply: (tr, set) => (tr.docChanged ? find(tr.doc) : set),
        },
        props: { decorations: (state) => KEY.getState(state) },
      }),
    ];
  },
});
