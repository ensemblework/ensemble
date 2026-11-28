/**
 * Page bodies saved as Markdown source in plain paragraphs, one per line (the page editor opened
 * plain-text notes that way before it read Markdown, and the next save kept them), back as real
 * blocks. Only a body that is clearly such Markdown qualifies; anything else stays as it is.
 */
import type { PageDocument, PageNode } from "./domain.js";
import { restoreMentionLinks } from "./mentions.js";
import { markdownToNodes } from "./page-markdown.js";

/** The most paragraphs, and characters, a body may have to be repaired. */
const MAX_PARAGRAPHS = 20_000;
const MAX_CHARS = 200_000;

const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^#{1,6}\s+\S/;
const LIST = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
/** A table's header rule, `| --- | :-: |`. */
const TABLE_RULE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;

type Kind = "fence" | "table" | "list" | "text";
const kindOf = (line: string): Kind => (FENCE.test(line) ? "fence" : TABLE_ROW.test(line) ? "table" : LIST.test(line) ? "list" : "text");

/** A paragraph's text when it is plain (text without marks, or empty); null for anything else. */
function plainLine(node: PageNode): string | null {
  if (node.type !== "paragraph") return null;
  let text = "";
  for (const child of node.content ?? []) {
    if (child.type !== "text" || child.marks?.length) return null;
    text += child.text ?? "";
  }
  return text.includes("\n") ? null : text;
}

/**
 * The repaired document, or null when `doc` does not qualify. It qualifies when every block is a
 * plain paragraph (no marks, no other nodes) and its lines are clearly Markdown: a table with its
 * header rule, a closed fence, or at least three lines of headings, list items, table rows or
 * fences, of two kinds or more. The lines are joined back into Markdown, one
 * newline within a run of table rows (empty paragraphs between rows skipped), list items or a
 * fence, a blank line elsewhere, and read with `markdownToNodes`; never as LaTeX. The result has
 * real blocks, so it never qualifies again.
 */
export function markdownParagraphsDocument(doc: PageDocument | null | undefined): PageDocument | null {
  const text = markdownParagraphsText(doc);
  if (text === null) return null;
  const content = markdownToNodes(text);
  // Nothing became a block or a mark: it was not Markdown after all.
  if (content.every((node) => node.type === "paragraph" && (node.content ?? []).every((child) => child.type === "text" && !child.marks?.length))) return null;
  return restoreMentionLinks({ type: "doc", content });
}

/**
 * The Markdown a qualifying body holds (see `markdownParagraphsDocument`), its lines joined back;
 * null when it does not qualify. For views that render Markdown text rather than blocks.
 */
export function markdownParagraphsText(doc: PageDocument | null | undefined): string | null {
  const blocks = doc?.content ?? [];
  if (blocks.length < 2 || blocks.length > MAX_PARAGRAPHS) return null;
  const lines: string[] = [];
  let chars = 0;
  let markdown = 0;
  let fences = 0;
  let rule = false;
  const kinds = new Set<string>();
  for (const block of blocks) {
    const line = plainLine(block);
    if (line === null) return null;
    chars += line.length + 1;
    if (chars > MAX_CHARS) return null;
    const kind = HEADING.test(line) ? "heading" : kindOf(line);
    if (kind !== "text") {
      markdown += 1;
      kinds.add(kind);
    }
    if (kind === "fence") fences += 1;
    if (TABLE_RULE.test(line)) rule = true;
    lines.push(line);
  }
  // Clearly Markdown: a table with its header rule, a closed fence, or three Markdown lines of two
  // kinds. A line or two typed with a leading "- " or "#" is not.
  if (!rule && fences < 2 && (markdown < 3 || kinds.size < 2)) return null;

  let text = "";
  let previous: Kind | null = null;
  let fence = false;
  for (const line of lines) {
    if (fence) {
      // Inside a fence every line is the code's, a blank one included.
      text += `\n${line}`;
      if (FENCE.test(line)) {
        fence = false;
        previous = "text";
      }
      continue;
    }
    if (!line.trim()) continue;
    const kind = kindOf(line);
    if (previous === null) text = line;
    else text += (kind === "table" || kind === "list") && kind === previous ? `\n${line}` : `\n\n${line}`;
    if (kind === "fence") fence = true;
    previous = kind;
  }
  return text;
}
