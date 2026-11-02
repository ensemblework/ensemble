import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { Selection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { canJoin, canSplit } from "@tiptap/pm/transform";
import { ITEM_TYPES, LIST_TYPES } from "./block-targets";

/** Move siblings in one transaction. List numbers belong to their positions, not to the moved text. */
export function moveBlock(state: EditorState, from: number, target: number, after: boolean): Transaction | null {
  const source = state.doc.nodeAt(from);
  const destination = state.doc.nodeAt(target);
  if (!source || !destination || from === target) return null;
  const a = state.doc.resolve(from);
  const b = state.doc.resolve(target);
  if (a.parent !== b.parent) return null;
  const children = Array.from({ length: a.parent.childCount }, (_, index) => a.parent.child(index));
  const sourceIndex = a.index();
  const targetIndex = b.index() + (after ? 1 : 0);
  const nextIndex = targetIndex > sourceIndex ? targetIndex - 1 : targetIndex;
  if (nextIndex === sourceIndex) return null;
  children.splice(sourceIndex, 1);
  children.splice(nextIndex, 0, source);
  const content = Fragment.fromArray(children);
  if (!a.parent.type.validContent(content)) return null;
  const tr = state.tr.replaceWith(a.start(), a.end(), content);
  const nextPos = a.start() + children.slice(0, nextIndex).reduce((size, child) => size + child.nodeSize, 0);
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(nextPos + 1, tr.doc.content.size))));
  return tr.scrollIntoView();
}

/** The range that removes a block: its parents too while they would be left empty and cannot be (the only item of a list). */
export function removalRange(doc: PMNode, pos: number, size: number): [number, number] {
  const $pos = doc.resolve(pos);
  let from = pos;
  let to = pos + size;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const parent = $pos.node(depth);
    if (parent.childCount > 1 || parent.type.validContent(Fragment.empty)) break;
    from = $pos.before(depth);
    to = $pos.after(depth);
  }
  return [from, to];
}

/** Two lists of one kind that end up next to each other become one, as they read. */
export function joinLists(tr: Transaction, pos: number): boolean {
  if (pos <= 0 || pos >= tr.doc.content.size) return false;
  const $pos = tr.doc.resolve(pos);
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  if (!before || !after || before.type !== after.type || !LIST_TYPES.has(before.type.name) || !canJoin(tr.doc, pos)) return false;
  tr.join(pos);
  return true;
}

/**
 * Moves a block before or after any other block, the way Notion does: an item can go into another list
 * (taking that list's kind of item) or out of lists (in a new list of its own kind, joined to one of the
 * same kind beside it), and another block dropped between two items splits their list around it. A
 * list's numbers stay with their places. The block takes its nested blocks with it; it cannot go inside
 * itself. One transaction; null when nothing would change or the block cannot go there.
 */
export function moveBlockTo(state: EditorState, from: number, target: number, after: boolean): { tr: Transaction; at: number } | null {
  const { doc } = state;
  const source = doc.nodeAt(from);
  const dest = doc.nodeAt(target);
  if (!source || !dest) return null;
  const end = from + source.nodeSize;
  if (target >= from && target < end) return null;
  const $from = doc.resolve(from);
  const $target = doc.resolve(target);
  const parent = $target.parent;
  const index = $target.index() + (after ? 1 : 0);
  let at = after ? target + dest.nodeSize : target;
  if ($from.parent === parent && (at === from || at === end)) return null;
  const item = ITEM_TYPES.has(source.type.name);
  let node: PMNode = source;
  let wrapped = false;
  let split = false;
  if (parent.canReplaceWith(index, index, source.type)) {
    // As it is.
  } else if (item && LIST_TYPES.has(parent.type.name)) {
    const itemType = parent.type.contentMatch.defaultType;
    if (!itemType || !itemType.validContent(source.content)) return null;
    node = itemType.create(null, source.content);
  } else if (item) {
    const listType = $from.parent.type;
    if (!parent.canReplaceWith(index, index, listType)) return null;
    node = listType.create(null, source);
    wrapped = true;
  } else if (LIST_TYPES.has(parent.type.name)) {
    const holder = $target.node($target.depth - 1);
    const place = $target.index($target.depth - 1);
    if (index === 0) at = $target.before();
    else if (index === parent.childCount) at = $target.after();
    else split = true;
    const slot = index === 0 ? place : place + 1;
    if (!holder.canReplaceWith(slot, slot, source.type)) return null;
    if (split && !canSplit(doc, at, 1)) return null;
  } else {
    return null;
  }
  const tr = state.tr;
  try {
    if (split) {
      tr.split(at, 1);
      at += 1;
    }
    tr.insert(at, node);
    const inserted = tr.steps.length;
    const start = tr.mapping.map(from, 1);
    const stop = tr.mapping.map(end, -1);
    const [gone, goneEnd] = removalRange(tr.doc, start, stop - start);
    tr.delete(gone, goneEnd);
    // Lists the block stood between close up behind it.
    joinLists(tr, gone);
    const later = () => tr.mapping.slice(inserted);
    if (wrapped) {
      const listEnd = later().map(at + node.nodeSize, -1);
      joinLists(tr, listEnd);
      joinLists(tr, later().map(at, 1));
    }
    const moved = later().map(wrapped ? at + 1 : at, 1);
    if (tr.doc.eq(doc)) return null;
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(moved + 1, tr.doc.content.size))));
    return { tr: tr.scrollIntoView(), at: moved };
  } catch {
    return null;
  }
}

/** Removes the block. When it was the only item of a list (or anything else that cannot be empty), the parent goes too. */
export function deleteBlock(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  const [from, to] = removalRange(state.doc, pos, node.nodeSize);
  const $from = state.doc.resolve(from);
  const tr = state.tr;
  // The page itself, or a summary followed by something that cannot be one, keeps an empty line in its place.
  if ($from.parent.canReplace($from.index(), $from.index() + 1)) tr.delete(from, to);
  else tr.replaceWith(from, to, state.schema.nodes.paragraph!.create());
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size))));
  return tr.scrollIntoView();
}

/** Inserts a copy right after the block. The copy has no comment highlights: those threads stay with the original. */
export function duplicateBlock(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  const $pos = state.doc.resolve(pos);
  const at = pos + node.nodeSize;
  if (!$pos.parent.canReplaceWith($pos.index() + 1, $pos.index() + 1, node.type)) return null;
  const tr = state.tr.insert(at, node);
  const comment = state.schema.marks.comment;
  if (comment) tr.removeMark(at, at + node.nodeSize, comment);
  tr.setSelection(Selection.near(tr.doc.resolve(at + 1)));
  return tr.scrollIntoView();
}
