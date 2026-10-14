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
