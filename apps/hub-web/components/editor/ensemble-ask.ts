import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ensembleTokenAt } from "../comments/ensemble-prompt";

const TOKEN = "@ensemble".length;
export const ENSEMBLE_ASK_KEY = new PluginKey("ensembleAsk");

function hint(className: string, html: string) {
  return () => {
    const element = document.createElement("span");
    element.className = className;
    element.contentEditable = "false";
    element.setAttribute("aria-hidden", "true");
    element.innerHTML = html;
    return element;
  };
}
const PLACEHOLDER = hint("ensemble-ask-placeholder", "Ask about this page, or to make a diagram or plot");
const SEND = hint("ensemble-ask-send", "<kbd>↵</kbd> Ask Ensemble");

/**
 * While `@ensemble …` is typed in the caret's line, it looks like the request it is: `@ensemble` turns
 * into Ensemble's chip, the question is tinted, and the line says Enter asks. Only decorations: the
 * page text stays as typed until Enter sends it (comments/inline-ensemble.tsx).
 */
export function ensembleAskDecorations(state: EditorState): DecorationSet {
  const { selection } = state;
  if (!selection.empty) return DecorationSet.empty;
  const $head = selection.$head;
  const block = $head.parent;
  if (!block.isTextblock || block.type.name === "codeBlock") return DecorationSet.empty;
  const at = ensembleTokenAt(block, $head.parentOffset);
  if (at < 0) return DecorationSet.empty;
  const start = $head.start();
  const from = start + at;
  const prompt = from + TOKEN;
  const caret = $head.pos;
  const asked = state.doc.textBetween(prompt, caret, " ", " ").trim();
  const decorations = [Decoration.inline(from, prompt, { class: "ensemble-ask-token" })];
  if (asked) {
    decorations.push(Decoration.inline(prompt, caret, { class: "ensemble-ask-prompt" }));
    decorations.push(Decoration.widget($head.end(), SEND, { key: "ensemble-ask-send", side: 1, ignoreSelection: true }));
  } else if (caret === $head.end()) {
    decorations.push(Decoration.widget(caret, PLACEHOLDER, { key: "ensemble-ask-placeholder", side: 1, ignoreSelection: true }));
  }
  return DecorationSet.create(state.doc, decorations);
}

export const EnsembleAsk = Extension.create<{ active: () => boolean }>({
  name: "ensembleAsk",
  addOptions() {
    return { active: () => true };
  },
  addProseMirrorPlugins() {
    const { editor, options } = this;
    return [
      new Plugin({
        key: ENSEMBLE_ASK_KEY,
        props: {
          decorations: (state) => (editor.isEditable && options.active() ? ensembleAskDecorations(state) : DecorationSet.empty),
        },
      }),
    ];
  },
});
