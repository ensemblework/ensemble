/**
 * Equations in pages: `inlineMath` inside a line and `blockMath` on a line of its own, each holding
 * its TeX in `latex` (the node names and attribute TipTap's own math extension uses). KaTeX draws
 * them (lib/math.ts). Markdown reads and writes them as `$…$` and `$$…$$` (shared-types page-math.ts).
 *
 * Click an equation, or press Enter on a selected one, to edit its TeX below it: the equation
 * redraws as you type, Enter saves, Shift+Enter starts a new line, Escape puts it back. An
 * equation saved with no TeX is removed.
 */
import { Extension, InputRule, Node, mergeAttributes, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Selection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView, NodeView } from "@tiptap/pm/view";
import { mathMarkdown } from "@ensemble/shared-types";
import { drawMath } from "@/lib/math";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    math: {
      /** `/equation`: an equation on its own line where the caret is, with its TeX open to type. */
      insertBlockMath: () => ReturnType;
      /** `/inline equation`: an equation inside the line at the caret, with its TeX open to type. */
      insertInlineMath: () => ReturnType;
    };
  }
}

const MATH_TYPES = new Set(["inlineMath", "blockMath"]);
/** Sent to an equation's element to open its TeX. */
const EDIT_EVENT = "page-math-edit";

const latexOf = (node: ProseMirrorNode) => String(node.attrs.latex ?? "");
/** The equation's Markdown (`$x$`, `$$x$$`): its text for copies and search. */
const sourceOf = (node: ProseMirrorNode) => mathMarkdown({ type: node.type.name, attrs: node.attrs }) ?? "";

/** Opens the TeX of the selected equation. False when no equation is selected. */
export function editSelectedMath(view: EditorView): boolean {
  const { selection } = view.state;
  if (!(selection instanceof NodeSelection) || !MATH_TYPES.has(selection.node.type.name) || !view.editable) return false;
  const dom = view.nodeDOM(selection.from);
  if (!(dom instanceof HTMLElement)) return false;
  dom.dispatchEvent(new Event(EDIT_EVENT));
  return true;
}

class MathView implements NodeView {
  dom: HTMLElement;
  private shown: HTMLElement;
  private box: HTMLElement | null = null;
  private field: HTMLTextAreaElement | null = null;
  private original = "";

  constructor(
    private node: ProseMirrorNode,
    private editor: Editor,
    private getPos: () => number | undefined,
  ) {
    const block = node.type.name === "blockMath";
    this.dom = document.createElement(block ? "div" : "span");
    this.dom.className = block ? "page-math page-math-block" : "page-math page-math-inline";
    this.dom.dataset.type = block ? "block-math" : "inline-math";
    this.shown = document.createElement(block ? "div" : "span");
    this.shown.className = "page-math-shown";
    this.dom.append(this.shown);
    this.draw();
    this.dom.addEventListener("click", this.onClick);
    this.dom.addEventListener(EDIT_EVENT, this.open);
  }

  private get display() {
    return this.node.type.name === "blockMath" || Boolean(this.node.attrs.display);
  }

  private draw(latex = latexOf(this.node)) {
    drawMath(this.shown, latex, this.display);
  }

  private onClick = (event: MouseEvent) => {
    if (!this.editor.isEditable || this.field || this.box?.contains(event.target as globalThis.Node)) return;
    this.open();
  };

  private open = () => {
    if (this.field || !this.editor.isEditable) return;
    this.original = latexOf(this.node);
    const block = this.node.type.name === "blockMath";
    const box = document.createElement(block ? "div" : "span");
    box.className = "page-math-edit";
    const field = document.createElement("textarea");
    field.className = "field page-math-source";
    field.value = this.original;
    field.rows = 1;
    field.spellcheck = false;
    field.placeholder = "TeX, like E = mc^2";
    field.setAttribute("aria-label", "Equation TeX");
    field.addEventListener("input", () => {
      this.draw(field.value);
      this.fit();
    });
    field.addEventListener("keydown", this.onKey);
    field.addEventListener("blur", this.onBlur);
    box.append(field);
    this.dom.append(box);
    this.dom.classList.add("is-editing");
    this.box = box;
    this.field = field;
    this.fit();
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  };

  private fit() {
    const field = this.field;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }

  private onKey = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.close("cancel");
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this.close("done");
    }
  };

  private onBlur = () => this.close("blur");

  /** `done` puts the caret after the equation, `cancel` keeps it selected, `blur` leaves the selection where the click put it. */
  private close(how: "done" | "cancel" | "blur") {
    const field = this.field;
    if (!field) return;
    const value = how === "cancel" ? this.original : field.value.trim();
    this.field = null;
    field.removeEventListener("blur", this.onBlur);
    this.box?.remove();
    this.box = null;
    this.dom.classList.remove("is-editing");
    this.draw(value);
    const pos = this.getPos();
    const { view } = this.editor;
    const current = typeof pos === "number" ? view.state.doc.nodeAt(pos) : null;
    if (typeof pos !== "number" || !current || current.type !== this.node.type || this.editor.isDestroyed) return;
    const tr = view.state.tr;
    if (!value) {
      tr.delete(pos, pos + current.nodeSize);
      if (how !== "blur") tr.setSelection(Selection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size))));
    } else {
      if (value !== latexOf(current)) tr.setNodeMarkup(pos, undefined, { ...current.attrs, latex: value });
      if (how === "cancel") tr.setSelection(NodeSelection.create(tr.doc, pos));
      else if (how === "done") tr.setSelection(Selection.findFrom(tr.doc.resolve(pos + current.nodeSize), 1, true) ?? NodeSelection.create(tr.doc, pos));
    }
    if (tr.docChanged || tr.selectionSet) view.dispatch(tr);
    if (how !== "blur") view.focus();
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    // Someone else's change waits until this person is done typing the TeX.
    if (!this.field) this.draw();
    return true;
  }

  selectNode() {
    this.dom.classList.add("ProseMirror-selectednode");
  }

  deselectNode() {
    this.dom.classList.remove("ProseMirror-selectednode");
  }

  stopEvent(event: Event) {
    return Boolean(this.box && event.target instanceof globalThis.Node && this.box.contains(event.target));
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.dom.removeEventListener("click", this.onClick);
    this.dom.removeEventListener(EDIT_EVENT, this.open);
    this.field?.removeEventListener("blur", this.onBlur);
  }
}

/** Selects the equation just added, then opens its TeX once the editor has drawn it. */
function selectAndEdit(tr: Transaction, node: ProseMirrorNode, editor: Editor): void {
  let at = -1;
  tr.doc.descendants((child, pos) => {
    if (at >= 0) return false;
    if (child === node) at = pos;
    return at < 0;
  });
  if (at < 0) return;
  tr.setSelection(NodeSelection.create(tr.doc, at));
  setTimeout(() => {
    if (!editor.isDestroyed) editSelectedMath(editor.view);
  }, 0);
}

/** The text block holding the caret, when it is empty: a new equation on its own line takes its place. */
function emptyLine(state: EditorState): { from: number; to: number } | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.content.size || $from.depth < 1) return null;
  return { from: $from.before(), to: $from.after() };
}

// `$x$` typed: inline math. The rules match pasted Markdown (shared-types page-math.ts): no space just
// inside the dollars and no letter or digit before the first, so "$5 and $10" stays text.
const INLINE_RULE = /(?<![\\$\p{L}\p{N}])\$(?![\s$])((?:\\.|[^$\\])*?(?:\\.|[^\s$\\]))\$$/u;
// `$$x$$` typed: an equation on its own line, or display math inside a sentence.
const DISPLAY_RULE = /(?<![\\$])\$\$(?![\s$])((?:\\.|[^$\\])+?)\$\$$/;
// `$$` and a space on an empty line: a new equation on its own line.
const BLOCK_RULE = /^\$\$\s$/;

export const InlineMath = Node.create({
  name: "inlineMath",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      latex: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-latex") ?? "",
        renderHTML: (attributes) => ({ "data-latex": String(attributes.latex ?? "") }),
      },
      display: {
        default: false,
        parseHTML: (element) => element.getAttribute("data-display") === "true",
        renderHTML: (attributes) => (attributes.display ? { "data-display": "true" } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-type="inline-math"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes({ "data-type": "inline-math" }, HTMLAttributes), sourceOf(node)];
  },
  renderText({ node }) {
    return sourceOf(node);
  },
  // The Markdown source is the equation's text: plain-text copies, agent block fingerprints.
  extendNodeSchema(extension) {
    return MATH_TYPES.has(extension.name) ? { leafText: (node: ProseMirrorNode) => sourceOf(node) } : {};
  },
  addNodeView() {
    return ({ node, editor, getPos }) => new MathView(node, editor, getPos as () => number | undefined);
  },
  addCommands() {
    return {
      insertInlineMath:
        () =>
        ({ tr, dispatch, editor }) => {
          const node = this.type.create({ latex: "" });
          if (dispatch) {
            tr.replaceSelectionWith(node, false);
            selectAndEdit(tr, node, editor);
          }
          return true;
        },
    };
  },
  addInputRules() {
    const inline = this.type;
    return [
      new InputRule({
        find: DISPLAY_RULE,
        handler: ({ state, range, match }) => {
          const latex = match[1]!.trim();
          const block = state.schema.nodes.blockMath;
          const $from = state.doc.resolve(range.from);
          const whole = $from.parent.isTextblock && $from.parent.type.name === "paragraph" && range.from === $from.start() && range.to === $from.end();
          if (block && whole && $from.depth >= 1) state.tr.replaceWith($from.before(), $from.after(), block.create({ latex }));
          else state.tr.replaceWith(range.from, range.to, inline.create({ latex, display: true }));
        },
      }),
      new InputRule({
        find: INLINE_RULE,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, inline.create({ latex: match[1]!.trim() }));
        },
      }),
    ];
  },
});

export const BlockMath = Node.create({
  name: "blockMath",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      latex: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-latex") ?? "",
        renderHTML: (attributes) => ({ "data-latex": String(attributes.latex ?? "") }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="block-math"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "block-math" }, HTMLAttributes), sourceOf(node)];
  },
  renderText({ node }) {
    return sourceOf(node);
  },
  addNodeView() {
    return ({ node, editor, getPos }) => new MathView(node, editor, getPos as () => number | undefined);
  },
  addCommands() {
    return {
      insertBlockMath:
        () =>
        ({ tr, state, dispatch, editor }) => {
          const node = this.type.create({ latex: "" });
          if (dispatch) {
            const line = emptyLine(state);
            if (line) tr.replaceWith(line.from, line.to, node);
            else tr.replaceSelectionWith(node, false);
            selectAndEdit(tr, node, editor);
          }
          return true;
        },
    };
  },
  addInputRules() {
    const type = this.type;
    const editor = this.editor;
    return [
      new InputRule({
        find: BLOCK_RULE,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== "paragraph" || $from.parent.textContent !== "$$" || $from.depth < 1) return null;
          const node = type.create({ latex: "" });
          state.tr.replaceWith($from.before(), $from.after(), node);
          selectAndEdit(state.tr, node, editor);
        },
      }),
    ];
  },
});

/**
 * Enter on a selected equation opens its TeX. Ahead of TipTap's own Enter, which would add a line
 * after it; a separate extension, since a higher priority on the nodes would reorder the schema.
 */
export const MathKeys = Extension.create({
  name: "mathKeys",
  priority: 1000,
  addKeyboardShortcuts() {
    return { Enter: ({ editor }) => editSelectedMath(editor.view) };
  },
});

