/**
 * Markdown → page blocks. hub-api uses it for everything a model, an import or a file writes
 * into a page; the page editor uses it for pasted Markdown and for an Ensemble answer put on
 * the page, so all of them come out as the same blocks.
 */
import type { PageNode } from "./domain.js";
import { pageImageAlign, pageImageSide, pageImageWidth } from "./page-images.js";
import { latexToMarkdown, looksLikeLatex } from "./page-latex.js";
import { INLINE_MATH_SOURCE, hasInlineMath, inlineMathMatch, inlineMathPattern, mathBlockAt, startsMathBlock, unescapeMathText } from "./page-math.js";

type Mark = { type: string; attrs?: Record<string, unknown> };

// Underscores inside a word (snake_case) are not emphasis; `<u>…</u>` is underline. A link's text stops at the next `[`, so
// a run of brackets cannot make the scan quadratic. Math (page-math.ts) comes last: it only starts
// at a dollar sign or `\(`, and starting there it wins over the emphasis inside the TeX.
const INLINE = new RegExp(
  String.raw`(\*\*([^*]+)\*\*|(?<![\p{L}\p{N}])__([^_]+)__(?![\p{L}\p{N}])|~~([^~]+)~~|\*([^*\s][^*]*)\*|(?<![\p{L}\p{N}])_([^_\s][^_]*)_(?![\p{L}\p{N}])|\x60([^\x60]+)\x60|\[([^\[\]]+)\]\(((?:(?:https?|ensemble|notion-page):\/\/|\/pages\/)[^\s)]+)\)|(https?:\/\/[^\s)<>]+)|<u>([^<>\n]{1,1000})<\/u>)|${INLINE_MATH_SOURCE}`,
  "gu",
);

const mathNode = (math: { latex: string; display: boolean }): PageNode => ({ type: "inlineMath", attrs: math.display ? { latex: math.latex, display: true } : { latex: math.latex } });

function inline(text: string): PageNode[] {
  const out: PageNode[] = [];
  // `ensemble://<kind>/<id>` links stay links here; restoreMentionLinks turns them into mentions.
  let last = 0;
  const push = (value: string, marks?: Mark[]) => {
    if (!value) return;
    out.push(marks?.length ? { type: "text", text: value, marks } : { type: "text", text: value });
  };
  // Escaped dollar signs (`\$5`) are text; `atStart`: the paragraph's first text.
  const plain = (value: string, marks?: Mark[], atStart = false) => push(unescapeMathText(value, atStart), marks);
  /** Bold, italic, struck or linked text keeps its mark; equations inside it are equations. */
  const marked = (value: string, marks: Mark[]) => {
    let at = 0;
    for (const found of value.matchAll(inlineMathPattern())) {
      const math = inlineMathMatch(found[1], found[2], found[3]);
      if (!math) continue;
      plain(value.slice(at, found.index), marks);
      out.push(mathNode(math));
      at = found.index! + found[0].length;
    }
    plain(value.slice(at), marks);
  };
  for (const match of text.matchAll(INLINE)) {
    plain(text.slice(last, match.index), undefined, last === 0);
    const math = match[1] === undefined ? inlineMathMatch(match[12], match[13], match[14]) : null;
    if (math) {
      out.push(mathNode(math));
      last = match.index! + match[0].length;
      continue;
    }
    if (match[2] ?? match[3]) marked((match[2] ?? match[3])!, [{ type: "bold" }]);
    else if (match[4]) marked(match[4], [{ type: "strike" }]);
    else if (match[5] ?? match[6]) marked((match[5] ?? match[6])!, [{ type: "italic" }]);
    else if (match[7]) push(match[7], [{ type: "code" }]);
    else if (match[8]) marked(match[8], [{ type: "link", attrs: { href: match[9] } }]);
    else if (match[10]) push(match[10], [{ type: "link", attrs: { href: match[10] } }]);
    else if (match[11]) marked(match[11], [{ type: "underline" }]);
    else if (match[1] === undefined) push(match[0]);
    last = match.index! + match[0].length;
  }
  plain(text.slice(last), undefined, last === 0);
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
    const math = mathBlockAt(lines, i);
    if (math) {
      nodes.push({ type: "blockMath", attrs: { latex: math.latex } });
      i = math.next;
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
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|\|)/.test(lines[i]!) && !startsTable(lines, i) && !startsMathBlock(lines, i)) body.push(keep(lines[i++]!));
    nodes.push(options.lineBreaks ? brokenParagraph(body) : paragraph(body.join(" ")));
  }
  return nodes.length ? nodes : [{ type: "paragraph" }];
}

const BLOCK_SYNTAX = /^(#{1,6}\s+\S|\s*([-*+]|\d+[.)])\s+\S|>\s?|```|\|.*\|\s*$|(-{3,}|\*{3,}|_{3,})\s*$|!\[[^\]]*\]\((?:https?:\/\/|ensemble:\/\/file\/))/;
const INLINE_SYNTAX = /\*\*[^*\s][^*]*\*\*|(?<![\p{L}\p{N}])__[^_\s][^_]*__|~~[^~\s][^~]*~~|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/|\/pages\/)[^\s)]+\)|(?:^|\s)\*[^*\s][^*\n]*\*(?=\s|[.,;:!?]|$)/mu;

/**
 * Whether plain text reads as Markdown: a heading, list, checklist, quote, fence, table, rule or
 * display equation at the start of a line, or bold, code, strikethrough or a link inside one. A lone URL or
 * ordinary prose is not, so it pastes as it always did.
 */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // A display equation counts; `$` math alone does not, since logs and shell lines are full of dollar signs.
  if (lines.some((line, index) => BLOCK_SYNTAX.test(line) || startsTable(lines, index) || startsMathBlock(lines, index))) return true;
  return INLINE_SYNTAX.test(text);
}

/**
 * Plain text with equations as page blocks, and nothing else read as Markdown: each line a
 * paragraph (as a plain paste makes them), display equations (`$$…$$`, `\[…\]` on lines of their
 * own) as blocks and inline `$…$` as equations under the strict rules (page-math.ts). Null when the
 * text holds no math.
 */
export function mathTextNodes(text: string): PageNode[] | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (!lines.some((line, index) => startsMathBlock(lines, index) || hasInlineMath(line))) return null;
  const nodes: PageNode[] = [];
  for (let i = 0; i < lines.length; ) {
    const block = mathBlockAt(lines, i);
    if (block) {
      nodes.push({ type: "blockMath", attrs: { latex: block.latex } });
      i = block.next;
      continue;
    }
    const line = lines[i++]!;
    if (!line.trim()) continue;
    const content: PageNode[] = [];
    let at = 0;
    for (const found of line.matchAll(inlineMathPattern())) {
      const math = inlineMathMatch(found[1], found[2], found[3]);
      if (!math) continue;
      if (found.index! > at) content.push({ type: "text", text: line.slice(at, found.index) });
      content.push(mathNode(math));
      at = found.index! + found[0].length;
    }
    if (at < line.length) content.push({ type: "text", text: line.slice(at) });
    nodes.push({ type: "paragraph", content });
  }
  return nodes.length ? nodes : null;
}

/**
 * Pasted or imported plain text as page blocks, the way Notion reads it: a LaTeX document by its
 * structure (page-latex.ts; `latex: false` skips it), Markdown (each line kept), or plain text with
 * its equations. Null for ordinary text, which stays as typed.
 */
export function textToPageNodes(text: string, options: { latex?: boolean } = {}): PageNode[] | null {
  if (options.latex !== false && looksLikeLatex(text)) return markdownToNodes(latexToMarkdown(text), { lineBreaks: true });
  if (looksLikeMarkdown(text)) return markdownToNodes(text, { lineBreaks: true });
  return mathTextNodes(text);
}

/** How much of a text a preview reads. */
const PREVIEW_CHARS = 4000;
/**
 * Lines a preview leaves out, tested trimmed: fences, rules, a table's header rule, and the
 * `$$` / `\[` lines around a display equation. Each part has one way to match, so long lines
 * stay linear.
 */
const SKIPPED_LINE = /^(?:```|~~~|-{3,}$|\*{3,}$|_{3,}$|(?:\|\s*)?:?-+:?(?:\s*\|\s*:?-+:?)*\s*\|?$|\$\$$|\\[[\]]$)/;

/**
 * Markdown as one line of plain text, for previews that show a line or two (cards, snippets,
 * search results, notifications): headings, list and quote markers, emphasis, code ticks, links,
 * images, rules, table pipes and `<details>` tags go; the words, link text and TeX stay.
 */
export function markdownPlainText(text: string): string {
  // Previews show a line or two: the first few thousand characters are plenty.
  const head = text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) : text;
  if (!/[#*_~`[\]<>|$-]|^\s*\d+[.)]\s/m.test(head)) return head.replace(/\s+/g, " ").trim();
  return head
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !SKIPPED_LINE.test(line))
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
        .replace(/<\/?(?:details|summary|u)(?:\s[^<>]{0,200})?>/gi, "")
        .replace(/!\[([^\[\]]*)\]\([^()\s]*\)/g, "$1")
        .replace(/\[([^\[\]]+)\]\([^()\s]*\)/g, "$1")
        .replace(/(\*\*|__|~~)(?=\S)([^*_~]{1,500}?)(?<=\S)\1/g, "$2")
        .replace(/(?<![\p{L}\p{N}*_])([*_])(?=[^\s*_])([^*_\n]{1,500}?)(?<=[^\s*_])\1(?![\p{L}\p{N}*_])/gu, "$2")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\s*\|\s*/g, " · ")
        .replace(/^ · | · $/g, ""),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
