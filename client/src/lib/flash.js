import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const flashKey = new PluginKey('flash');

const toDeco = ({ from, to }) => Decoration.node(from, to, { class: 'flash' });

// Highlights blocks that were just changed (or are being read aloud).
// Purely visual: never saved and never exported.
//
// Meta values:
//   null                  -> clear every highlight
//   { from, to }          -> highlight only this block
//   { add: { from, to } } -> add this block to the highlights that are already showing
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
            if (meta === undefined) return set.map(tr.mapping, tr.doc); // keep highlights in the right place
            if (meta === null) return DecorationSet.empty;
            if (meta.add) return set.map(tr.mapping, tr.doc).add(tr.doc, [toDeco(meta.add)]);
            return DecorationSet.create(tr.doc, [toDeco(meta)]);
          },
        },
        props: { decorations: (state) => flashKey.getState(state) },
      }),
    ];
  },
});

// All blocks that are highlighted right now: [{ from, to }]
export function getFlashRanges(state) {
  const set = flashKey.getState(state);
  return set ? set.find().map((d) => ({ from: d.from, to: d.to })) : [];
}