import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const flashKey = new PluginKey('flash');

// Highlights the block that was just changed by voice. Purely visual, never saved or exported.
export const Flash = Extension.create({
  name: 'flash',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: flashKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(flashKey);
            if (meta !== undefined) {
              return meta
                ? DecorationSet.create(tr.doc, [Decoration.node(meta.from, meta.to, { class: 'flash' })])
                : DecorationSet.empty;
            }
            return set.map(tr.mapping, tr.doc);
          },
        },
        props: { decorations: (state) => flashKey.getState(state) },
      }),
    ];
  },
});
