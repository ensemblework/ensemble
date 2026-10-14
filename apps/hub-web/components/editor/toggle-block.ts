import { Node, mergeAttributes } from "@tiptap/core";

/** The first paragraph or heading is the summary; every subsequent block belongs to the disclosure. */
export const ToggleBlock = Node.create({
  name: "toggleBlock",
  group: "block",
  content: "(paragraph | heading) block+",
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
