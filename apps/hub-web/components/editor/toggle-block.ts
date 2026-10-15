import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Puts the collapsible block at `pos` back as plain blocks: its summary, then its body. A body of
 * only empty lines goes with it. The cursor lands at the start of the summary.
 */
export function unwrapToggle(tr: Transaction, pos: number): boolean {
  const toggle = tr.doc.nodeAt(pos);
  if (!toggle || toggle.type.name !== "toggleBlock" || !toggle.firstChild) return false;
  const body: ProseMirrorNode[] = [];
  toggle.forEach((child, _offset, index) => {
    if (index > 0) body.push(child);
  });
  const blank = body.every((child) => child.type.name === "paragraph" && child.content.size === 0);
  const content = Fragment.from([toggle.firstChild, ...(blank ? [] : body)]);
  const $pos = tr.doc.resolve(pos);
  if (!$pos.parent.canReplace($pos.index(), $pos.index() + 1, content)) return false;
  tr.replaceWith(pos, pos + toggle.nodeSize, content);
  tr.setSelection(TextSelection.create(tr.doc, pos + 1));
  return true;
}

/** Makes the paragraph or heading at `pos` the summary of a new collapsible block. */
export function wrapInToggle(tr: Transaction, pos: number): boolean {
  const node = tr.doc.nodeAt(pos);
  const toggle = tr.doc.type.schema.nodes.toggleBlock;
  if (!node || !toggle || (node.type.name !== "paragraph" && node.type.name !== "heading")) return false;
  const $pos = tr.doc.resolve(pos);
  if (!$pos.parent.canReplaceWith($pos.index(), $pos.index() + 1, toggle)) return false;
  tr.replaceWith(pos, pos + node.nodeSize, toggle.create(null, node));
  tr.setSelection(TextSelection.create(tr.doc, pos + 2 + node.content.size));
  return true;
}

const summaryPlaceholderKey = new PluginKey("toggleSummaryPlaceholder");

/** The first paragraph or heading is the summary; any blocks after it belong to the disclosure. */
export const ToggleBlock = Node.create({
  name: "toggleBlock",
  group: "block",
  content: "(paragraph | heading) block*",
  defining: true,
  addAttributes() {
    return { collapsed: { default: false } };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="toggleBlock"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "toggleBlock" }), 0];
  },
  addKeyboardShortcuts() {
    // A cursor in the summary of a collapsible block: $from.node(-1) is the block, index 0 is the summary.
    const inSummary = (editor: Editor) => {
      const { $from, empty } = editor.state.selection;
      if (!empty || $from.depth < 2 || !$from.parent.isTextblock) return null;
      const toggle = $from.node(-1);
      return toggle.type === this.type && $from.index(-1) === 0 ? { $from, toggle } : null;
    };
    return {
      // Without this, Backspace at the start of the summary selects and then deletes the block above.
      Backspace: ({ editor }) => {
        const found = inSummary(editor);
        // Right after "# " turned the summary into a heading, Backspace undoes that instead.
        if (!found || found.$from.parentOffset > 0 || editor.can().undoInputRule()) return false;
        const pos = found.$from.before(-1);
        editor.commands.command(({ tr }) => unwrapToggle(tr, pos));
        return true;
      },
      // The body of a collapsed block is hidden, so the text after the cursor starts a block after it.
      Enter: ({ editor }) => {
        const found = inSummary(editor);
        if (!found || !found.toggle.attrs.collapsed) return false;
        const { $from } = found;
        const paragraph = editor.schema.nodes.paragraph!;
        if (!$from.node(-2).canReplaceWith($from.index(-2) + 1, $from.index(-2) + 1, paragraph)) return false;
        return editor.commands.command(({ tr }) => {
          const tail = $from.parent.content.cut($from.parentOffset);
          tr.delete($from.pos, $from.end());
          const at = tr.mapping.map($from.after(-1));
          tr.insert(at, paragraph.create(null, tail));
          tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView();
          return true;
        });
      },
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    let doc: ProseMirrorNode | null = null;
    let set = DecorationSet.empty;
    const build = (next: ProseMirrorNode) => {
      const decorations: Decoration[] = [];
      next.descendants((node, pos) => {
        if (node.isTextblock) return false;
        const summary = node.type.name === "toggleBlock" ? node.firstChild : null;
        if (summary && summary.content.size === 0) {
          decorations.push(Decoration.node(pos + 1, pos + 1 + summary.nodeSize, {
            class: "is-empty",
            "data-placeholder": summary.type.name === "heading" ? "Toggle heading" : "Toggle",
          }));
        }
        return true;
      });
      return DecorationSet.create(next, decorations);
    };
    return [
      new Plugin({
        key: summaryPlaceholderKey,
        props: {
          decorations: (state) => {
            if (!editor.isEditable) return null;
            if (state.doc !== doc) {
              doc = state.doc;
              set = build(doc);
            }
            return set;
          },
        },
      }),
    ];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("div");
      dom.className = "toggle-block";
      const button = document.createElement("button");
      button.type = "button";
      button.contentEditable = "false";
      button.className = "toggle-block-trigger";
      const contentDOM = document.createElement("div");
      contentDOM.className = "toggle-block-content";
      const sync = (collapsed: boolean) => {
        dom.classList.toggle("is-collapsed", collapsed);
        button.textContent = collapsed ? "▸" : "▾";
        button.setAttribute("aria-expanded", String(!collapsed));
        button.setAttribute("aria-label", collapsed ? "Expand blocks" : "Collapse blocks");
      };
      sync(Boolean(node.attrs.collapsed));
      button.addEventListener("click", () => {
        const pos = getPos();
        if (typeof pos !== "number") return;
        const current = editor.state.doc.nodeAt(pos);
        if (!current) return;
        if (editor.isEditable) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, collapsed: !current.attrs.collapsed }));
        else sync(!dom.classList.contains("is-collapsed"));
      });
      dom.append(button, contentDOM);
      return {
        dom,
        contentDOM,
        update(next) {
          if (next.type !== node.type) return false;
          sync(Boolean(next.attrs.collapsed));
          return true;
        },
        stopEvent: (event) => button.contains(event.target as globalThis.Node),
        ignoreMutation: (mutation) => mutation.type !== "selection" && (mutation.target === dom || button.contains(mutation.target)),
      };
    };
  },
});
