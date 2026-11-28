import type { PageDocument } from "./domain.js";
import { restoreMentionLinks } from "./mentions.js";
import { textToPageNodes } from "./page-markdown.js";

/**
 * Notes kept as plain text (a task, project or meeting before its page was first written) as the
 * page they open as. Markdown, a LaTeX document or equations become blocks (`textToPageNodes`,
 * each line kept); other text is one paragraph per line, as typed. Nothing is saved until the
 * page is edited, so the stored notes never change on their own.
 */
export function notesDocument(notes: string): PageDocument {
  const text = notes.replace(/\r\n?/g, "\n");
  const nodes = text.trim() ? textToPageNodes(text) : null;
  if (nodes?.length) return restoreMentionLinks({ type: "doc", content: nodes });
  return {
    type: "doc",
    content: text.split("\n").map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" })),
  };
}
