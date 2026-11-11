import type { PageDocument, PageNode } from "@ensemble/shared-types";

/**
 * A saved version of a page against the page as it is now, for the history preview. Pages are
 * compared as their readable blocks (a heading, a paragraph, a list item, a table row), then
 * word by word inside blocks that changed. This is for reading only: restoring writes the saved
 * document itself (`POST /api/page-versions/:id/restore`).
 */

export type BlockKind = "h1" | "h2" | "h3" | "p" | "bullet" | "ordered" | "task" | "quote" | "code" | "rule" | "image" | "table" | "toggle" | "embed";

export type PageBlock = { kind: BlockKind; text: string; depth: number; checked?: boolean; number?: number };

/** `added`: in the saved version only (restoring brings it back). `removed`: on the page now only. */
export type Change = "added" | "removed";

export type Segment = { text: string; change?: Change };

export type DiffBlock =
  | { change: "same"; block: PageBlock }
  | { change: Change; block: PageBlock }
  | { change: "edited"; block: PageBlock; segments: Segment[] };

const EMBEDS: Record<string, string> = { diagram: "Diagram", plot: "Plot", file: "File" };

function inline(nodes: readonly PageNode[] | undefined): string {
  return (nodes ?? [])
    .map((node) => {
      if (node.type === "text") return node.text ?? "";
      if (node.type === "hardBreak") return "\n";
      if (node.type === "mention") {
        const kind = String(node.attrs?.kind ?? "");
        const label = String(node.attrs?.label ?? "").replace(/^@+/, "");
        if (EMBEDS[kind]) return `${EMBEDS[kind]}: ${label || "Untitled"}`;
        return kind === "date" ? label : `@${label}`;
      }
      if (node.type === "image") return String(node.attrs?.alt ?? "") || "Image";
      return inline(node.content);
    })
    .join("");
}

function label(node: PageNode): string {
  const attrs = node.attrs ?? {};
  for (const key of ["label", "title", "filename", "alt"]) if (typeof attrs[key] === "string" && attrs[key]) return String(attrs[key]);
  return "";
}

function walk(node: PageNode, depth: number, out: PageBlock[], as?: BlockKind): void {
  const children = node.content ?? [];
  switch (node.type) {
    case "paragraph":
      out.push({ kind: as ?? "p", text: inline(children), depth });
      return;
    case "heading": {
      const level = Number(node.attrs?.level ?? 2);
      out.push({ kind: level <= 1 ? "h1" : level === 2 ? "h2" : "h3", text: inline(children), depth });
      return;
    }
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const kind: BlockKind = node.type === "bulletList" ? "bullet" : node.type === "orderedList" ? "ordered" : "task";
      const start = Number(node.attrs?.start ?? 1);
      children.forEach((item, index) => {
        const [head, ...rest] = item.content ?? [];
        const block: PageBlock = { kind, text: head && head.type === "paragraph" ? inline(head.content) : "", depth };
        if (kind === "task") block.checked = Boolean(item.attrs?.checked);
        if (kind === "ordered") block.number = start + index;
        out.push(block);
        for (const child of head && head.type === "paragraph" ? rest : item.content ?? []) walk(child, depth + 1, out);
      });
      return;
    }
    case "blockquote":
      for (const child of children) walk(child, depth, out, "quote");
      return;
    case "codeBlock":
      out.push({ kind: "code", text: children.map((child) => child.text ?? "").join(""), depth });
      return;
    case "horizontalRule":
      out.push({ kind: "rule", text: "", depth });
      return;
    case "image":
      out.push({ kind: "image", text: label(node) || "Image", depth });
      return;
    case "table":
      for (const row of children) out.push({ kind: "table", text: (row.content ?? []).map((cell) => (cell.content ?? []).map((part) => inline(part.content)).join(" ").trim()).join(" | "), depth });
      return;
    case "toggleBlock": {
      const [summary, ...body] = children;
      out.push({ kind: "toggle", text: inline(summary?.content), depth });
      for (const child of body) walk(child, depth + 1, out);
      return;
    }
    case "agentBlock":
      for (const child of children) walk(child, depth, out, as);
      return;
    default: {
      const name = label(node);
      if (name && !children.length) out.push({ kind: "embed", text: name, depth });
      else if (children.some((child) => child.type === "text" || child.type === "mention")) out.push({ kind: as ?? "p", text: inline(children), depth });
      else for (const child of children) walk(child, depth, out, as);
    }
  }
}

/** The page's readable blocks in order. Empty paragraphs are left out: they are spacing, not content. */
export function pageBlocks(doc: PageDocument | null | undefined): PageBlock[] {
  const out: PageBlock[] = [];
  for (const node of doc?.content ?? []) walk(node as PageNode, 0, out);
  return out.filter((block) => block.kind === "rule" || block.text.trim() !== "" || block.kind === "task");
}

const key = (block: PageBlock) => `${block.kind}\u0000${block.depth}\u0000${block.checked ? 1 : 0}\u0000${block.text}`;

/** Past this many cells, a changed stretch is shown as removed and added instead of compared. */
const MAX_CELLS = 200_000;

type Op = ["same" | "add" | "del", number, number];

/** Longest-common-subsequence edit script after trimming the common ends. `add` takes from `b`, `del` from `a`. */
function script(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i += 1) ops.push(["same", i, i]);
  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_CELLS) {
    for (let i = start; i < endA; i += 1) ops.push(["del", i, -1]);
    for (let j = start; j < endB; j += 1) ops.push(["add", -1, j]);
  } else {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        ops.push(["same", start + i, start + j]);
        i += 1;
        j += 1;
      } else if (i < n && (j >= m || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) {
        ops.push(["del", start + i, -1]);
        i += 1;
      } else {
        ops.push(["add", -1, start + j]);
        j += 1;
      }
    }
  }
  for (let k = 0; k < a.length - endA; k += 1) ops.push(["same", endA + k, endB + k]);
  return ops;
}

const WORDS = /\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_]/gu;

/**
 * `current` turned into `version`, word by word. Within a changed stretch the page's words come
 * first, then the version's; a space between two changed words joins the change, so "the old
 * plan" against "a new plan" reads as one swap, not three.
 */
export function wordDiff(current: string, version: string): Segment[] {
  const a = current.match(WORDS) ?? [];
  const b = version.match(WORDS) ?? [];
  const ops = script(a, b).map(([op, i, j]) => ({ op, text: op === "add" ? b[j]! : a[i]! }));
  for (let k = 1; k < ops.length - 1; k += 1) {
    const op = ops[k]!;
    if (op.op === "same" && !op.text.trim() && ops[k - 1]!.op !== "same" && ops[k + 1]!.op !== "same") {
      ops.splice(k, 1, { op: "del", text: op.text }, { op: "add", text: op.text });
      k += 1;
    }
  }
  const out: Segment[] = [];
  const push = (text: string, change?: Change) => {
    const last = out.at(-1);
    if (last && last.change === change) last.text += text;
    else out.push(change ? { text, change } : { text });
  };
  for (let k = 0; k < ops.length; ) {
    if (ops[k]!.op === "same") {
      push(ops[k]!.text);
      k += 1;
      continue;
    }
    let end = k;
    while (end < ops.length && ops[end]!.op !== "same") end += 1;
    const stretch = ops.slice(k, end);
    const removed = stretch.filter((op) => op.op === "del").map((op) => op.text).join("");
    const added = stretch.filter((op) => op.op === "add").map((op) => op.text).join("");
    if (removed) push(removed, "removed");
    if (added) push(added, "added");
    k = end;
  }
  return out;
}

/** How alike two blocks of one kind are, 0 to 1, by the words they share. */
function likeness(a: PageBlock, b: PageBlock): number {
  if (a.kind !== b.kind) return 0;
  const words = (text: string) => text.toLowerCase().match(WORDS)?.filter((word) => word.trim()) ?? [];
  const left = words(a.text);
  const right = words(b.text);
  if (!left.length && !right.length) return 1;
  const pool = new Map<string, number>();
  for (const word of left) pool.set(word, (pool.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of right) {
    const count = pool.get(word) ?? 0;
    if (count) {
      shared += 1;
      pool.set(word, count - 1);
    }
  }
  return (2 * shared) / (left.length + right.length);
}

/**
 * The saved version's blocks in order, each marked against the page now: the same, only in the
 * version, edited (with its words marked), and the page's blocks the version does not have, where
 * they would sit.
 */
export function diffPage(version: readonly PageBlock[], current: readonly PageBlock[]): DiffBlock[] {
  const ops = script(current.map(key), version.map(key));
  const out: DiffBlock[] = [];
  for (let k = 0; k < ops.length; ) {
    const [op, i, j] = ops[k]!;
    if (op === "same") {
      out.push({ change: "same", block: version[j]! });
      k += 1;
      continue;
    }
    let end = k;
    while (end < ops.length && ops[end]![0] !== "same") end += 1;
    const removed = ops.slice(k, end).filter(([kind]) => kind === "del").map(([, at]) => current[at]!);
    const added = ops.slice(k, end).filter(([kind]) => kind === "add").map(([, , at]) => version[at]!);
    // Pair a page block with the version block it most likely became, in order. Between pairs, the
    // page's blocks come first, then the version's, as words do inside a block.
    let r = 0;
    let waiting: PageBlock[] = [];
    const flush = () => {
      for (const block of waiting) out.push({ change: "added", block });
      waiting = [];
    };
    for (const block of added) {
      let match = -1;
      for (let x = r; x < removed.length; x += 1) {
        if (likeness(removed[x]!, block) >= 0.4) {
          match = x;
          break;
        }
      }
      if (match < 0) {
        waiting.push(block);
        continue;
      }
      for (; r < match; r += 1) out.push({ change: "removed", block: removed[r]! });
      flush();
      const before = removed[r]!;
      r += 1;
      out.push(before.text === block.text ? { change: "edited", block, segments: [{ text: block.text }] } : { change: "edited", block, segments: wordDiff(before.text, block.text) });
    }
    for (; r < removed.length; r += 1) out.push({ change: "removed", block: removed[r]! });
    flush();
    k = end;
  }
  return out;
}

/** How many places differ: each run of changed blocks counts once. */
export function changeCount(diff: readonly DiffBlock[]): number {
  let count = 0;
  let inside = false;
  for (const row of diff) {
    const changed = row.change !== "same";
    if (changed && !inside) count += 1;
    inside = changed;
  }
  return count;
}
