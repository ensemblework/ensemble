import type { NodeViewRenderer } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";

/** A checklist item's checkbox is named by the item's own line, never by the items nested under it. */
export function checkboxLabel(node: ProseMirrorNode): string {
  const text = (node.firstChild?.textContent ?? "").replace(/\s+/g, " ").trim();
  return text || "Empty checklist item";
}

/** TipTap's checklist item, with a checkbox label that follows the text as it changes. */
export const ChecklistItem = TaskItem.extend({
  addNodeView() {
    const parent = this.parent?.() as NodeViewRenderer;
    return (props) => {
      const view = parent(props) as NodeView;
      const checkbox = view.dom instanceof HTMLElement ? view.dom.querySelector<HTMLInputElement>("input[type='checkbox']") : null;
      const label = (node: ProseMirrorNode) => checkbox?.setAttribute("aria-label", checkboxLabel(node));
      label(props.node);
      const update = view.update?.bind(view);
      return {
        ...view,
        update: (node, decorations, inner) => {
          const kept = update ? update(node, decorations, inner) : false;
          if (kept) label(node);
          return kept;
        },
      };
    };
  },
});
