import type { PageDocument } from "@ensemble/shared-types";

/** Plain text to a TipTap document. Kept out of the editor chunk so task pages can load it without ProseMirror. */
export function textToDoc(text: string): PageDocument {
  const lines = text.split("\n");
  return {
    type: "doc",
    content: lines.length
      ? lines.map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" }))
      : [{ type: "paragraph" }],
  };
}
