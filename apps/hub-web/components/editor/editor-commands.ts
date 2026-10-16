/**
 * Slash-command catalog and mention helpers for the block editor.
 * The mention helpers live in shared-types so hub-api's page store restores
 * `ensemble://` links with exactly the same rules the editor writes them with.
 */
import type { ChainedCommands, Editor, Range } from "@tiptap/core";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { liftTarget } from "@tiptap/pm/transform";
import {
  dateMention,
  isEntityKind,
  mentionHref,
  mentionQuery,
  restoreMentionLinks,
  type MentionKind,
  type PageMention,
} from "@ensemble/shared-types";
import { unwrapToggle, wrapInToggle } from "./toggle-block";

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
  | "divider"
  | "toggle"
  | "file";

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
  { id: "toggle", label: "Collapsible block", detail: "A summary with any blocks inside", aliases: "toggle collapse collapsible details disclosure", symbol: "▸" },
  { id: "quote", label: "Quote", detail: "Call out a passage", aliases: "blockquote citation", symbol: "❝" },
  { id: "divider", label: "Divider", detail: "Separate sections", aliases: "hr rule line separator", symbol: "—" },
  { id: "file", label: "File", detail: "Upload or attach a PDF, image, sheet or any file", aliases: "attach attachment upload pdf image photo picture document", symbol: "⎘" },
];

export function matchCommands(query: string): BlockCommand[] {
  const needle = query.toLowerCase().replace(/[\s_-]/g, "");
  return BLOCK_COMMANDS.filter((item) =>
    `${item.id} ${item.label} ${item.aliases}`.toLowerCase().replace(/[\s_-]/g, "").includes(needle),
  )
    .slice()
    .sort((a, b) => Number(b.id.replace(/-/g, "") === needle) - Number(a.id.replace(/-/g, "") === needle));
}

// Lists and quotes are styles a line can leave. A collapsible block or a table cell keeps its lines.
const STYLE_WRAPPERS = new Set(["bulletList", "orderedList", "taskList", "listItem", "taskItem", "blockquote"]);
const SUMMARY_KINDS = new Set<BlockCommandId>(["text", "h1", "h2", "h3"]);

function liftOutOfStyles(tr: Transaction): void {
  for (;;) {
    const range = tr.selection.$from.blockRange(tr.selection.$to);
    if (!range || !STYLE_WRAPPERS.has(range.parent.type.name)) return;
    const target = liftTarget(range);
    if (target === null) return;
    tr.lift(range, target);
  }
}

function setTextblocks(name: string, attrs?: Record<string, unknown>) {
  return ({ tr }: { tr: Transaction }) => {
    const type = tr.doc.type.schema.nodes[name];
    if (!type) return false;
    tr.setBlockType(tr.selection.from, tr.selection.to, type, attrs);
    return true;
  };
}

/** Changes the selected lines in place. A summary that cannot stay one (a list, a quote, code) leaves its collapsible block first. */
function convert(chain: ChainedCommands, command: BlockCommandId): boolean {
  const lifted = chain.command(({ tr }) => {
    const { $from } = tr.selection;
    if (!SUMMARY_KINDS.has(command) && $from.depth >= 2 && $from.node(-1).type.name === "toggleBlock" && $from.index(-1) === 0) unwrapToggle(tr, $from.before(-1));
    liftOutOfStyles(tr);
    return true;
  });
  switch (command) {
    case "text":
      return lifted.command(setTextblocks("paragraph")).run();
    case "h1":
      return lifted.command(setTextblocks("heading", { level: 1 })).run();
    case "h2":
      return lifted.command(setTextblocks("heading", { level: 2 })).run();
    case "h3":
      return lifted.command(setTextblocks("heading", { level: 3 })).run();
    case "code":
      return lifted.command(setTextblocks("codeBlock")).run();
    case "bullet-list":
      return lifted.toggleBulletList().run();
    case "list":
      return lifted.toggleOrderedList().run();
    case "check-list":
      return lifted.toggleTaskList().run();
    case "quote":
      return lifted.toggleBlockquote().run();
    default:
      return false;
  }
}

/** Whether a position is inside a table cell. */
export function inTable($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const name = $pos.node(depth).type.name;
    if (name === "tableCell" || name === "tableHeader") return true;
  }
  return false;
}

export function applyBlock(editor: Editor, range: Range, command: BlockCommandId): void {
  if (command === "table" && inTable(editor.state.doc.resolve(range.from))) return;
  const chain = editor.chain().focus().deleteRange(range);
  switch (command) {
    case "toggle":
      chain.insertContent({ type: "toggleBlock", content: [{ type: "paragraph" }] }).run();
      break;
    case "divider":
      chain.setHorizontalRule().run();
      break;
    case "table":
      // 2x2 including the header row, so what appears is a header and one
      // row of data — the smallest thing that still reads as a table.
      chain.clearNodes().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
      break;
    case "file":
      chain.run();
      editor.commands.chooseFile(range.from);
      break;
    default:
      convert(chain, command);
  }
}

/** The kinds a block's handle menu offers under Turn into, in menu order. */
const TURN_INTO: readonly BlockCommandId[] = ["text", "h1", "h2", "h3", "bullet-list", "list", "check-list", "quote", "code", "toggle"];

const TURNABLE = new Set(["paragraph", "heading", "codeBlock", "blockquote", "listItem", "taskItem", "toggleBlock"]);

/** What the block at `pos` is, in Turn into terms, or null when Turn into does not apply to it (tables, files, dividers). */
export function blockKind(doc: ProseMirrorNode, pos: number): BlockCommandId | null {
  const node = doc.nodeAt(pos);
  if (!node || !TURNABLE.has(node.type.name)) return null;
  switch (node.type.name) {
    case "heading":
      return `h${Math.min(Math.max(Number(node.attrs.level) || 1, 1), 3)}` as BlockCommandId;
    case "codeBlock":
      return "code";
    case "blockquote":
      return "quote";
    case "taskItem":
      return "check-list";
    case "listItem":
      return doc.resolve(pos).parent.type.name === "orderedList" ? "list" : "bullet-list";
    case "toggleBlock":
      return "toggle";
    default:
      return "text";
  }
}

/** Only a single line can become the summary of a collapsible block. */
export function turnIntoChoices(kind: BlockCommandId | null): BlockCommandId[] {
  if (!kind) return [];
  return TURN_INTO.filter((id) => id !== "toggle" || kind === "toggle" || SUMMARY_KINDS.has(kind));
}

/**
 * Turn into, from a block's handle menu: every line in the block changes. A collapsible block
 * becomes its summary, turned into the new kind, followed by its body.
 */
export function turnBlockInto(editor: Editor, pos: number, command: BlockCommandId): boolean {
  const kind = blockKind(editor.state.doc, pos);
  const node = editor.state.doc.nodeAt(pos);
  if (!node || !kind || kind === command || !turnIntoChoices(kind).includes(command)) return false;
  if (command === "toggle") return editor.chain().focus().command(({ tr }) => wrapInToggle(tr, pos)).run();
  if (kind === "toggle") {
    const size = node.firstChild?.content.size ?? 0;
    return convert(editor.chain().focus().command(({ tr }) => unwrapToggle(tr, pos)).setTextSelection({ from: pos + 1, to: pos + 1 + size }), command);
  }
  let from = -1;
  let to = -1;
  editor.state.doc.nodesBetween(pos, pos + node.nodeSize, (line, at) => {
    if (!line.isTextblock) return true;
    if (from < 0) from = at + 1;
    to = at + 1 + line.content.size;
    return false;
  });
  if (from < 0) return false;
  return convert(editor.chain().focus().setTextSelection({ from, to }), command);
}

export { dateMention, isEntityKind, mentionHref, mentionQuery, restoreMentionLinks };
export type { MentionKind, PageMention };
