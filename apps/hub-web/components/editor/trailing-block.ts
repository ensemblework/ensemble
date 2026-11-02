import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

export const TRAILING_BLOCK_KEY = new PluginKey("trailingBlock");

/** The page already ends on an empty line. */
export function endsOnEmptyLine(doc: PMNode): boolean {
  const last = doc.lastChild;
  return Boolean(last && last.type.name === "paragraph" && last.childCount === 0);
}

/** Puts the caret on the page's last empty line, adding that line first when the page ends on something else. */
export function writeAtEnd(view: EditorView): void {
  const tr = view.state.tr;
  const paragraph = view.state.schema.nodes.paragraph;
  if (paragraph && !endsOnEmptyLine(tr.doc)) tr.insert(tr.doc.content.size, paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1)).scrollIntoView();
  view.dispatch(tr);
  view.focus();
}

/**
 * The page always shows an empty line at its end, so there is somewhere to write after an image, a
 * table or a list. It is drawn, not saved: clicking it (or anywhere below the last block) makes it a
 * real line. Nothing changes in the document until then, so a shared page gets no stray lines from
 * people who only opened it.
 */
export const TrailingBlock = Extension.create({
  name: "trailingBlock",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: TRAILING_BLOCK_KEY,
        props: {
          decorations(state) {
            if (endsOnEmptyLine(state.doc)) return null;
            const line = Decoration.widget(
              state.doc.content.size,
              (view) => {
                const element = document.createElement("div");
                element.className = "trailing-line";
                element.contentEditable = "false";
                element.setAttribute("aria-hidden", "true");
                element.addEventListener("mousedown", (event) => {
                  if (event.button !== 0 || !view.editable) return;
                  event.preventDefault();
                  writeAtEnd(view);
                });
                return element;
              },
              { key: "trailing-line", side: 1, ignoreSelection: true, stopEvent: () => true },
            );
            return DecorationSet.create(state.doc, [line]);
          },
          handleDOMEvents: {
            mousedown(view, event) {
              if (!view.editable || event.button !== 0 || event.target !== view.dom) return false;
              const blocks = Array.from(view.dom.children).filter((child) => !child.classList.contains("trailing-line"));
              const last = blocks.at(-1);
              if (!last || event.clientY <= last.getBoundingClientRect().bottom) return false;
              event.preventDefault();
              writeAtEnd(view);
              return true;
            },
          },
        },
      }),
    ];
  },
});
