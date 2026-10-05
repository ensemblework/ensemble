/**
 * Slash-command catalog and mention helpers for the block editor.
 * The mention helpers live in shared-types so hub-api's page store restores
 * `ensemble://` links with exactly the same rules the editor writes them with.
 */
import type { Editor, Range } from "@tiptap/core";
import {
  dateMention,
  isEntityKind,
  mentionHref,
  mentionQuery,
  restoreMentionLinks,
  type MentionKind,
  type PageMention,
} from "@ensemble/shared-types";

export type BlockCommandId =
  | "text"
  | "h1"
  | "h2"
  | "h3"
  | "bullet-list"
  | "list"
  | "check-list"
  | "code"
  | "table"
  | "quote"
  | "divider";

export interface BlockCommand {
  id: BlockCommandId;
  label: string;
  detail: string;
  aliases: string;
  symbol: string;
}

export const BLOCK_COMMANDS: readonly BlockCommand[] = [
  { id: "text", label: "Text", detail: "A plain paragraph", aliases: "paragraph normal", symbol: "T" },
  { id: "h1", label: "Heading 1", detail: "Large section heading", aliases: "heading1 title", symbol: "H1" },
  { id: "h2", label: "Heading 2", detail: "Medium section heading", aliases: "heading2 subtitle", symbol: "H2" },
  { id: "h3", label: "Heading 3", detail: "Small section heading", aliases: "heading3", symbol: "H3" },
  { id: "bullet-list", label: "Bulleted list", detail: "A simple list", aliases: "bullet unordered ul", symbol: "•" },
  { id: "list", label: "Numbered list", detail: "An ordered list", aliases: "number ordered ol", symbol: "1." },
  { id: "check-list", label: "Checklist", detail: "Tick off individual items", aliases: "checklist todo checkbox task", symbol: "☑" },
  { id: "code", label: "Code", detail: "A fenced code block", aliases: "codeblock snippet", symbol: "</>" },
  { id: "table", label: "Table", detail: "A header plus one row of data", aliases: "grid", symbol: "▦" },
  { id: "quote", label: "Quote", detail: "Call out a passage", aliases: "blockquote citation", symbol: "❝" },
  { id: "divider", label: "Divider", detail: "Separate sections", aliases: "hr rule line separator", symbol: "—" },
];

export const MENTION_GROUPS: ReadonlyArray<{ kind: MentionKind; label: string; detail: string }> = [
  { kind: "people", label: "People", detail: "Mention someone in your workspace" },
  { kind: "project", label: "Projects", detail: "Link a project" },
  { kind: "repo", label: "Repositories", detail: "Link a repository" },
  { kind: "task", label: "Tasks / todos", detail: "Refer to another task" },
  { kind: "deliverable", label: "Deliverables", detail: "Link an outcome" },
  { kind: "skill", label: "Skills", detail: "Reference a personal skill" },
  { kind: "diagram", label: "Diagrams", detail: "Link a block diagram" },
  { kind: "plot", label: "Plots", detail: "Link a saved plot" },
  { kind: "date", label: "Date & time", detail: "Mention a date without changing the due date" },
];

export function matchCommands(query: string): BlockCommand[] {
  const needle = query.toLowerCase().replace(/[\s_-]/g, "");
  return BLOCK_COMMANDS.filter((item) =>
    `${item.id} ${item.label} ${item.aliases}`.toLowerCase().replace(/[\s_-]/g, "").includes(needle),
  )
    .slice()
    .sort((a, b) => Number(b.id.replace(/-/g, "") === needle) - Number(a.id.replace(/-/g, "") === needle));
}

export function applyBlock(editor: Editor, range: Range, command: BlockCommandId): void {
  const chain = editor.chain().focus().deleteRange(range);
  switch (command) {
    case "text":
      chain.clearNodes().setParagraph().run();
      break;
    case "h1":
      chain.clearNodes().setHeading({ level: 1 }).run();
      break;
    case "h2":
      chain.clearNodes().setHeading({ level: 2 }).run();
      break;
    case "h3":
      chain.clearNodes().setHeading({ level: 3 }).run();
      break;
    case "code":
      chain.clearNodes().setCodeBlock().run();
      break;
    case "bullet-list":
      chain.clearNodes().toggleBulletList().run();
      break;
    case "list":
      chain.clearNodes().toggleOrderedList().run();
      break;
    case "check-list":
      chain.clearNodes().toggleTaskList().run();
      break;
    case "quote":
      chain.clearNodes().toggleBlockquote().run();
      break;
    case "divider":
      chain.setHorizontalRule().run();
      break;
    case "table":
      // 2x2 including the header row, so what appears is a header and one
      // row of data — the smallest thing that still reads as a table.
      chain.clearNodes().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
      break;
  }
}

export { dateMention, isEntityKind, mentionHref, mentionQuery, restoreMentionLinks };
export type { MentionKind, PageMention };
