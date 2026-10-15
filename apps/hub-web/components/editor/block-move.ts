import { Fragment } from "@tiptap/pm/model";
import { Selection, type EditorState, type Transaction } from "@tiptap/pm/state";

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

/** Removes the block. When it was the only item of a list (or anything else that cannot be empty), the parent goes too. */
export function deleteBlock(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  const $pos = state.doc.resolve(pos);
  let from = pos;
  let to = pos + node.nodeSize;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const parent = $pos.node(depth);
    if (parent.childCount > 1 || parent.type.validContent(Fragment.empty)) break;
    from = $pos.before(depth);
    to = $pos.after(depth);
  }
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
