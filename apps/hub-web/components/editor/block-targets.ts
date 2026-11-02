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
export type MeasuredTarget = BlockTarget & { top: number; bottom: number; middle: number; left: number; headTop: number; headBottom: number };

export const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);
export const ITEM_TYPES = new Set(["listItem", "taskItem"]);
const NESTING = new Set([...ITEM_TYPES, "toggleBlock"]);

/** A block in the document alone (no DOM): where it starts, where its siblings start, and how deep it is. */
export type BlockPosition = { pos: number; node: PMNode; parent: number; depth: number };

/** The page's blocks in document order, a block before the blocks nested in it (see `BlockTarget`). */
export function blockPositions(doc: PMNode): BlockPosition[] {
  const out: BlockPosition[] = [];
  const visit = (parent: PMNode, start: number, depth: number, skipFirst: boolean) => {
    parent.forEach((child, offset, index) => {
      const pos = start + offset;
      if (LIST_TYPES.has(child.type.name)) {
        visit(child, pos + 1, depth, false);
        return;
      }
      if (skipFirst && index === 0) return;
      out.push({ pos, node: child, parent: start, depth });
      if (NESTING.has(child.type.name)) visit(child, pos + 1, depth + 1, true);
    });
  };
  visit(doc, 0, 0, false);
  return out;
}

/** The innermost block a position is in, or null between top-level blocks. */
export function blockAround(blocks: readonly BlockPosition[], pos: number): BlockPosition | null {
  let found: BlockPosition | null = null;
  for (const block of blocks) {
    if (block.pos >= pos) break;
    if (pos < block.pos + block.node.nodeSize) found = block;
  }
  return found;
}

export function blockTargets(view: EditorView): BlockTarget[] {
  const out: BlockTarget[] = [];
  const element = (pos: number): HTMLElement | null => {
    const dom = view.nodeDOM(pos);
    return dom instanceof HTMLElement ? dom : null;
  };
  for (const block of blockPositions(view.state.doc)) {
    const dom = element(block.pos);
    if (!dom) continue;
    const first = NESTING.has(block.node.type.name) && block.node.firstChild?.isBlock ? element(block.pos + 1) : null;
    out.push({ ...block, element: dom, head: first ?? dom, marker: block.node.type.name === "listItem" });
  }
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
      headTop: head.top - box.top,
      headBottom: head.bottom - box.top,
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
