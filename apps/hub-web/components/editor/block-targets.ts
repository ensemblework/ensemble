import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

/**
 * The blocks a handle can stand for, the way Notion counts them: every block of the page, every item of
 * a list at any depth (not the list as a whole), every block inside an item after its first line, and
 * every block inside a collapsible block after its summary. A list or a collapsible block is only the
 * container its blocks sit in. `parent` is where the block's siblings start, so two blocks are siblings
 * when it is the same.
 */
export type BlockTarget = {
  pos: number;
  node: PMNode;
  element: HTMLElement;
  /** The block's own first line (an item's first paragraph, a collapsible block's summary), or the block. */
  head: HTMLElement;
  parent: number;
  depth: number;
  /** A bullet or numbered item: its marker hangs outside its box, to the left. */
  marker: boolean;
};

/** The block measured against the editor: top, bottom, the middle of its own line and its left edge. */
export type MeasuredTarget = BlockTarget & { top: number; bottom: number; middle: number; left: number };

export const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);
export const ITEM_TYPES = new Set(["listItem", "taskItem"]);
const NESTING = new Set([...ITEM_TYPES, "toggleBlock"]);

export function blockTargets(view: EditorView): BlockTarget[] {
  const out: BlockTarget[] = [];
  const element = (pos: number): HTMLElement | null => {
    const dom = view.nodeDOM(pos);
    return dom instanceof HTMLElement ? dom : null;
  };
  const visit = (parent: PMNode, start: number, depth: number, skipFirst: boolean) => {
    parent.forEach((child, offset, index) => {
      const pos = start + offset;
      if (LIST_TYPES.has(child.type.name)) {
        visit(child, pos + 1, depth, false);
        return;
      }
      if (skipFirst && index === 0) return;
      const dom = element(pos);
      if (dom) {
        const first = NESTING.has(child.type.name) && child.firstChild?.isBlock ? element(pos + 1) : null;
        out.push({ pos, node: child, element: dom, head: first ?? dom, parent: start, depth, marker: child.type.name === "listItem" });
      }
      if (NESTING.has(child.type.name)) visit(child, pos + 1, depth + 1, true);
    });
  };
  visit(view.state.doc, 0, 0, false);
  return out;
}

/** Measures the blocks against the editor's top left, leaving out the ones not drawn (inside a closed collapsible block). */
export function measureTargets(root: HTMLElement, targets: readonly BlockTarget[]): MeasuredTarget[] {
  const box = root.getBoundingClientRect();
  const out: MeasuredTarget[] = [];
  for (const target of targets) {
    if (!target.element.isConnected) continue;
    const rect = target.element.getBoundingClientRect();
    if (rect.height <= 0 && rect.width <= 0) continue;
    const head = target.head === target.element ? rect : target.head.getBoundingClientRect();
    out.push({
      ...target,
      top: rect.top - box.top,
      bottom: rect.bottom - box.top,
      middle: (head.top + head.bottom) / 2 - box.top,
      left: rect.left - box.left,
    });
  }
  return out;
}

/**
 * The block at a height (measured from the editor's top): the deepest one that spans it, so a nested
 * item wins over the item it is in. In a gap between blocks, the nearest one.
 */
export function targetAt(measured: readonly MeasuredTarget[], y: number): MeasuredTarget | null {
  let best: MeasuredTarget | null = null;
  for (const target of measured) {
    if (y < target.top || y > target.bottom) continue;
    if (!best || target.depth >= best.depth) best = target;
  }
  if (best) return best;
  let distance = Infinity;
  for (const target of measured) {
    const gap = y < target.top ? target.top - y : y - target.bottom;
    if (gap < distance || (gap === distance && best && target.depth > best.depth)) {
      distance = gap;
      best = target;
    }
  }
  return best;
}

/** How far a block's handle sits in from the page's edge: a list item's handle stays clear of its bullet. */
export function targetIndent(target: Pick<MeasuredTarget, "left" | "marker">): number {
  return Math.max(0, Math.round(target.left - (target.marker ? 22 : 0)));
}
