import { notesDocument, type PageDocument } from "@ensemble/shared-types";

/**
 * Plain notes to a TipTap document: Markdown, a LaTeX document or equations become blocks, other
 * text one paragraph per line (`notesDocument`). Kept out of the editor chunk so task pages can
 * load it without ProseMirror.
 */
export function textToDoc(text: string): PageDocument {
  return notesDocument(text);
}
