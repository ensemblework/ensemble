import type { PageDocument } from "./domain.js";
import { restoreMentionLinks } from "./mentions.js";
import { textToPageNodes } from "./page-markdown.js";

/**
 * Notes kept as plain text (a task, project or meeting before its page was first written) as the
 * page they open as. Markdown or equations become blocks (`textToPageNodes`, each line kept);
 * other text, LaTeX included, is one paragraph per line, as typed. Nothing is saved until the
 * page is edited, so the stored notes never change on their own.
 */
export function notesDocument(notes: string): PageDocument {
  const text = notes.replace(/\r\n?/g, "\n");
  // Never LaTeX: notes are converted every time they open, unseen, and the first edit saves the result.
  const nodes = text.trim() ? textToPageNodes(text, { latex: false }) : null;
  if (nodes?.length) return restoreMentionLinks({ type: "doc", content: nodes });
  return {
    type: "doc",
    content: text.split("\n").map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" })),
  };
}
