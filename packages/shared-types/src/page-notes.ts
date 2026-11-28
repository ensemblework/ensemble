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
  const text = joinTableRows(notes.replace(/\r\n?/g, "\n"));
  // Never LaTeX: notes are converted every time they open, unseen, and the first edit saves the result.
  const nodes = text.trim() ? textToPageNodes(text, { latex: false }) : null;
  if (nodes?.length) return restoreMentionLinks({ type: "doc", content: nodes });
  return {
    type: "doc",
    content: text.split("\n").map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" })),
  };
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;

/**
 * Text with the blank lines between table rows removed, outside fences: notes written back from a
 * page saved as one paragraph per line hold a blank line between every two rows, and a Markdown
 * table needs them together.
 */
function joinTableRows(text: string): string {
  if (!text.includes("|")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*(?:```|~~~)/.test(line)) fence = !fence;
    if (!fence && !line.trim() && out.length && TABLE_ROW.test(out[out.length - 1]!)) {
      let next = i + 1;
      while (next < lines.length && !lines[next]!.trim()) next += 1;
      if (next < lines.length && TABLE_ROW.test(lines[next]!)) {
        i = next - 1;
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}
