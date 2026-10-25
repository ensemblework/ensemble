/**
 * Markdown → page blocks. hub-api uses it for everything a model, an import or a file writes
 * into a page; the page editor uses it for pasted Markdown and for an Ensemble answer put on
 * the page, so all of them come out as the same blocks.
 */
import type { PageNode } from "./domain.js";
import { pageImageAlign, pageImageSide, pageImageWidth } from "./page-images.js";

type Mark = { type: string; attrs?: Record<string, unknown> };

// Underscores inside a word (snake_case) are not emphasis.
const INLINE =
  /(\*\*([^*]+)\*\*|(?<![\p{L}\p{N}])__([^_]+)__(?![\p{L}\p{N}])|~~([^~]+)~~|\*([^*\s][^*]*)\*|(?<![\p{L}\p{N}])_([^_\s][^_]*)_(?![\p{L}\p{N}])|`([^`]+)`|\[([^\]]+)\]\(((?:(?:https?|ensemble|notion-page):\/\/|\/pages\/)[^\s)]+)\)|(https?:\/\/[^\s)<>]+))/gu;

function inline(text: string): PageNode[] {
  const out: PageNode[] = [];
  // `ensemble://<kind>/<id>` links stay links here; restoreMentionLinks turns them into mentions.
  let last = 0;
  const push = (value: string, marks?: Mark[]) => {
    if (!value) return;
    out.push(marks?.length ? { type: "text", text: value, marks } : { type: "text", text: value });
  };
  for (const match of text.matchAll(INLINE)) {
    push(text.slice(last, match.index));
    if (match[2] ?? match[3]) push((match[2] ?? match[3])!, [{ type: "bold" }]);
    else if (match[4]) push(match[4], [{ type: "strike" }]);
    else if (match[5] ?? match[6]) push((match[5] ?? match[6])!, [{ type: "italic" }]);
    else if (match[7]) push(match[7], [{ type: "code" }]);
    else if (match[8]) push(match[8], [{ type: "link", attrs: { href: match[9] } }]);
    else if (match[10]) push(match[10], [{ type: "link", attrs: { href: match[10] } }]);
    last = match.index! + match[0].length;
  }
  push(text.slice(last));
  return out;
}

/**
 * An image on a line of its own: `![alt](https://…)` or a file in Files, `![alt](ensemble://file/<id>)`,
 * optionally followed by `{width=60% align=left natural=1200x800}` (`imageMarkdown` writes this form).
 */
const IMAGE_LINE = /^!\[((?:\\.|[^\]\\])*)\]\(((?:https?:\/\/|ensemble:\/\/file\/)[^\s)]+)\)(?:\{([^{}]*)\})?\s*$/;

function imageNode(line: string): PageNode | null {
  const match = IMAGE_LINE.exec(line);
  if (!match) return null;
  const alt = match[1]!.replace(/\\([\\[\]])/g, "$1");
  const target = match[2]!;
  const options = match[3] ?? "";
  const attrs: Record<string, unknown> = { alt };
  if (target.startsWith("ensemble://file/")) {
    let id: string;
    try {
      id = decodeURIComponent(target.slice("ensemble://file/".length));
    } catch {
      return null;
    }
    if (!id) return null;
    attrs.src = null;
    attrs.fileId = id;
  } else attrs.src = target;
  const width = pageImageWidth(/(?:^|\s)width=([\d.]+%?)(?=\s|$)/.exec(options)?.[1]);
  if (width !== null) attrs.width = width;
  const align = /(?:^|\s)align=(left|center|right)(?=\s|$)/.exec(options)?.[1];
  if (align) attrs.align = pageImageAlign(align);
  const natural = /(?:^|\s)natural=(\d+)x(\d+)(?=\s|$)/.exec(options);
  const naturalWidth = pageImageSide(natural?.[1]);
  const naturalHeight = pageImageSide(natural?.[2]);
  if (naturalWidth && naturalHeight) Object.assign(attrs, { naturalWidth, naturalHeight });
  return { type: "image", attrs };
}

/** The Markdown `markdownToNodes` reads back as the same image node. Null for an image with nothing to show. */
export function imageMarkdown(attrs: Record<string, unknown> | undefined): string | null {
  const fileId = typeof attrs?.fileId === "string" && attrs.fileId ? attrs.fileId : null;
  const src = typeof attrs?.src === "string" && /^https?:\/\//i.test(attrs.src) ? attrs.src : null;
  if (!fileId && !src) return null;
  const alt = String(attrs?.alt ?? "").replace(/\s+/g, " ").trim().replace(/[\\[\]]/g, (char) => `\\${char}`);
  const target = fileId ? `ensemble://file/${encodeURIComponent(fileId)}` : src!.replace(/[\s)]/g, encodeURIComponent);
  const width = pageImageWidth(attrs?.width);
  const align = pageImageAlign(attrs?.align);
  const naturalWidth = pageImageSide(attrs?.naturalWidth);
  const naturalHeight = pageImageSide(attrs?.naturalHeight);
  const options = [width !== null ? `width=${width}%` : "", align !== "center" ? `align=${align}` : "", naturalWidth && naturalHeight ? `natural=${naturalWidth}x${naturalHeight}` : ""].filter(Boolean);
  return `![${alt}](${target})${options.length ? `{${options.join(" ")}}` : ""}`;
}

const paragraph = (text: string): PageNode => {
  const content = inline(text);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
};

/** A paragraph whose lines are kept apart by hard breaks. */
function brokenParagraph(lines: string[]): PageNode {
  const content = lines.flatMap((line, index): PageNode[] => [...(index ? [{ type: "hardBreak" }] : []), ...inline(line)]);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
}

function tableNode(rows: string[][]): PageNode {
  const width = Math.max(...rows.map((row) => row.length));
  return {
    type: "table",
    content: rows.map((row, index) => ({
      type: "tableRow",
      content: Array.from({ length: width }, (_, column) => ({
        type: index === 0 ? "tableHeader" : "tableCell",
        content: [brokenParagraph((row[column] ?? "").split(/<br\s*\/?>/i).map((line) => line.trim()))],
      })),
    })),
  };
}

/** A table's header rule: `| --- | :-: |`, or `--- | ---` without the outer pipes. */
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A header row followed by its rule starts a table, with or without pipes at the ends. */
const startsTable = (lines: string[], i: number) => Boolean(lines[i]?.includes("|") && lines[i + 1]?.includes("|") && TABLE_RULE.test(lines[i + 1]!));

function tableCells(row: string): string[] {
  let line = row.trim();
  if (line.startsWith("|")) line = line.slice(1);
  if (line.endsWith("|") && !line.endsWith("\\|")) line = line.slice(0, -1);
  return line.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/**
 * `lineBreaks`: each line of a paragraph keeps its own line (a hard break), as pasted text such
 * as a log or a list of commands expects, instead of Markdown's joining them with spaces.
 */
export function markdownToNodes(markdown: string, options: { lineBreaks?: boolean } = {}): PageNode[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const nodes: PageNode[] = [];
  let i = 0;
  const isList = (line: string) => /^\s*([-*+]|\d+[.)])\s+/.test(line);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (/^<details(?:\s|>)/i.test(line.trim())) {
      const body: string[] = [];
      let depth = 0;
      do {
        const current = lines[i++]!;
        depth += (current.match(/<details(?:\s[^>]*)?>/gi) ?? []).length;
        depth -= (current.match(/<\/details>/gi) ?? []).length;
        body.push(current);
      } while (depth > 0 && i < lines.length);
      const html = body.join("\n");
      const summary = /<summary>([\s\S]*?)<\/summary>/i.exec(html)?.[1] ?? "Details";
      const inner = html.replace(/^\s*<details[^>]*>\s*/i, "").replace(/<summary>[\s\S]*?<\/summary>/i, "").replace(/<\/details>\s*$/i, "");
      nodes.push({ type: "toggleBlock", attrs: { collapsed: !/^\s*<details[^>]*\bopen\b/i.test(html) }, content: [paragraph(summary), ...markdownToNodes(inner, options)] });
      continue;
    }
    const image = imageNode(line.trim());
    if (image) { nodes.push(image); i++; continue; }
    const fence = line.match(/^```([^\s`]*)/);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i += 1;
      nodes.push({ type: "codeBlock", attrs: { language: fence[1] || null }, content: body.length ? [{ type: "text", text: body.join("\n") }] : [] });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      nodes.push({ type: "heading", attrs: { level: Math.min(heading[1]!.length, 3) }, content: inline(heading[2]!.trim()) });
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      nodes.push({ type: "horizontalRule" });
      i += 1;
      continue;
    }
    if (startsTable(lines, i)) {
      const rows: string[][] = [tableCells(line)];
      i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) rows.push(tableCells(lines[i++]!));
      nodes.push(tableNode(rows));
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) body.push(lines[i++]!.replace(/^>\s?/, ""));
      nodes.push({ type: "blockquote", content: markdownToNodes(body.join("\n"), options) });
      continue;
    }
    if (isList(line)) {
      const first = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)!;
      const base = first[1]!.length;
      const ordered = /^\d/.test(first[2]!);
      const checklist = /^\[[ xX]\]/.test(first[3]!);
      const items: PageNode[] = [];
      while (i < lines.length) {
        const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (!match || match[1]!.length !== base || /^\d/.test(match[2]!) !== ordered || (!ordered && /^\[[ xX]\]/.test(match[3]!) !== checklist)) break;
        const check = match[3]!.match(/^\[([ xX])\]\s*(.*)$/);
        const body = check ? check[2]! : match[3]!;
        const extra: string[] = [];
        i += 1;
        while (i < lines.length) {
          const next = lines[i]!;
          if (!next.trim() && lines[i + 1] && (lines[i + 1]!.match(/^\s*/)?.[0].length ?? 0) > base) { extra.push(""); i++; continue; }
          const indent = next.match(/^\s*/)?.[0].length ?? 0;
          if (!next.trim() || indent <= base) break;
          extra.push(next.slice(Math.min(base + 2, indent)));
          i++;
        }
        items.push({ type: checklist ? "taskItem" : "listItem", ...(checklist ? { attrs: { checked: Boolean(check && check[1] !== " ") } } : {}), content: [paragraph(body), ...(extra.length ? markdownToNodes(extra.join("\n"), options) : [])] });
      }
      nodes.push({ type: checklist ? "taskList" : ordered ? "orderedList" : "bulletList", ...(ordered ? { attrs: { start: Number.parseInt(first[2]!, 10) || 1 } } : {}), content: items });
      continue;
    }
    const keep = (text: string) => (options.lineBreaks ? text.trimEnd() : text.trim());
    const body: string[] = [keep(line.trimStart())];
    i += 1;
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|\|)/.test(lines[i]!) && !startsTable(lines, i)) body.push(keep(lines[i++]!));
    nodes.push(options.lineBreaks ? brokenParagraph(body) : paragraph(body.join(" ")));
  }
  return nodes.length ? nodes : [{ type: "paragraph" }];
}

const BLOCK_SYNTAX = /^(#{1,6}\s+\S|\s*([-*+]|\d+[.)])\s+\S|>\s?|```|\|.*\|\s*$|(-{3,}|\*{3,}|_{3,})\s*$|!\[[^\]]*\]\((?:https?:\/\/|ensemble:\/\/file\/))/;
const INLINE_SYNTAX = /\*\*[^*\s][^*]*\*\*|(?<![\p{L}\p{N}])__[^_\s][^_]*__|~~[^~\s][^~]*~~|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/|\/pages\/)[^\s)]+\)|(?:^|\s)\*[^*\s][^*\n]*\*(?=\s|[.,;:!?]|$)/mu;

/**
 * Whether plain text reads as Markdown: a heading, list, checklist, quote, fence, table or rule
 * at the start of a line, or bold, code, strikethrough or a link inside one. A lone URL or
 * ordinary prose is not, so it pastes as it always did.
 */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.some((line, index) => BLOCK_SYNTAX.test(line) || startsTable(lines, index))) return true;
  return INLINE_SYNTAX.test(text);
}
