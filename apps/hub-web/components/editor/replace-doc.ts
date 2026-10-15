import type { Editor } from "@tiptap/core";
import { Fragment, Mark, type Node as ProseNode } from "@tiptap/pm/model";
import { Selection, TextSelection } from "@tiptap/pm/state";
import type { PageDocument } from "@ensemble/shared-types";

/** What a page holds of its editor: read it, check a document fits, swap one in. */
export type EditorControl = {
  read(): PageDocument;
  accepts(doc: PageDocument): boolean;
  /** False when the document does not fit this editor; the editor is left as it was. */
  replace(doc: PageDocument): boolean;
};

/**
 * The editor loads a page without checking its marks, so a saved page can hold combinations the
 * schema refuses (an import's bold inline code; code excludes every other mark). Keeps the marks
 * the schema allows instead of refusing the whole page.
 */
function allowedMarks(node: ProseNode): ProseNode {
  if (node.isLeaf) return node;
  const children: ProseNode[] = [];
  node.forEach((child) => {
    let marks = Mark.none;
    for (const mark of child.marks) if (node.type.allowsMarkType(mark.type)) marks = mark.addToSet(marks);
    const kept = Mark.sameSet(marks, child.marks) ? child : child.mark(marks);
    children.push(allowedMarks(kept));
  });
  return node.copy(Fragment.from(children));
}

function parse(editor: Editor, doc: PageDocument): ProseNode | null {
  try {
    const node = allowedMarks(editor.schema.nodeFromJSON(doc));
    node.check();
    return node;
  } catch {
    return null;
  }
}

export function acceptsDocument(editor: Editor, doc: PageDocument): boolean {
  return parse(editor, doc) !== null;
}

/**
 * Puts someone else's (or a merged) version in the editor. Only the part that differs is
 * replaced, outside the undo history and without an update event, so Undo never takes their
 * text out and nothing is saved back. The selection keeps its place in the text around it;
 * text that arrives exactly at the caret goes after it.
 */
export function replaceDocument(editor: Editor, doc: PageDocument): boolean {
  const next = parse(editor, doc);
  if (!next) return false;
  const { state } = editor;
  const start = state.doc.content.findDiffStart(next.content);
  if (start === null) return true;
  const end = state.doc.content.findDiffEnd(next.content)!;
  let endOld = end.a;
  let endNew = end.b;
  const overlap = start - Math.min(endOld, endNew);
  if (overlap > 0) {
    endOld += overlap;
    endNew += overlap;
  }
  let tr;
  try {
    tr = state.tr.replace(start, endOld, next.slice(start, endNew));
    if (!tr.doc.eq(next)) tr = state.tr.replaceWith(0, state.doc.content.size, next.content);
  } catch {
    return false;
  }
  const size = tr.doc.content.size;
  const place = (pos: number) => Math.max(0, Math.min(size, pos <= start ? pos : pos >= endOld ? pos + endNew - endOld : Math.min(pos, endNew)));
  const { anchor, head } = state.selection;
  try {
    tr.setSelection(state.selection instanceof TextSelection ? TextSelection.between(tr.doc.resolve(place(anchor)), tr.doc.resolve(place(head))) : Selection.near(tr.doc.resolve(place(head))));
  } catch {
    tr.setSelection(Selection.atStart(tr.doc));
  }
  editor.view.dispatch(tr.setMeta("addToHistory", false).setMeta("preventUpdate", true));
  return true;
}
