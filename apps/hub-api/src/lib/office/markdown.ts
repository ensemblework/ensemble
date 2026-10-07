/**
 * A small Markdown reader for the office writers (Word, Google Docs, slides).
 *
 * Covers what an assistant writes: headings, paragraphs, bullet and numbered
 * lists (nested by indent), tables, fenced code, quotes, rules, and inline
 * bold, italic, strike, code and links. Anything else stays as plain text.
 */

export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
}

export interface ListItem {
  inlines: Inline[];
  depth: number;
  ordered: boolean;
}

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; items: ListItem[] }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "code"; text: string }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "rule" };

type Style = Omit<Inline, "text">;

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~|>]/;
const BARE_URL = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/;

/** Links that may become clickable. Everything else is shown as text. */
export function safeLink(url: string): string | undefined {
  const trimmed = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : undefined;
}

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char === "\\" && body[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function findClosing(source: string, marker: string, from: number): number {
  let index = from;
  while (index < source.length) {
    const found = source.indexOf(marker, index);
    if (found < 0) return -1;
    if (source[found - 1] === "\\") {
      index = found + 1;
      continue;
    }
    // A single * must not be the start of a ** pair.
    if (marker.length === 1 && source[found + 1] === marker) {
      index = found + 2;
      continue;
    }
    return found;
  }
  return -1;
}

export function parseInline(source: string, style: Style = {}): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ text: buffer, ...style });
    buffer = "";
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const rest = source.slice(index);
    if (char === "\\" && index + 1 < source.length && ESCAPABLE.test(source[index + 1]!)) {
      buffer += source[index + 1];
      index += 2;
      continue;
    }
    if (char === "`") {
      const end = source.indexOf("`", index + 1);
      if (end > index + 1) {
        flush();
        out.push({ text: source.slice(index + 1, end), ...style, code: true });
        index = end + 1;
        continue;
      }
    }
    if (char === "[") {
      const match = /^\[((?:[^\]\\]|\\.)+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
      if (match) {
        flush();
        const link = safeLink(match[2]!);
        out.push(...parseInline(match[1]!, link ? { ...style, link } : style));
        index += match[0].length;
        continue;
      }
    }
    if (char === "<") {
      const match = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/i.exec(rest);
      if (match) {
        flush();
        out.push({ text: match[1]!.replace(/^mailto:/i, ""), ...style, link: match[1]! });
        index += match[0].length;
        continue;
      }
    }
    if ((char === "h" || char === "H") && !style.link && (index === 0 || /\s|\(/.test(source[index - 1]!))) {
      const match = BARE_URL.exec(rest);
      if (match) {
        flush();
        out.push({ text: match[0], ...style, link: match[0] });
        index += match[0].length;
        continue;
      }
    }
    if (rest.startsWith("**") || rest.startsWith("__")) {
      const marker = rest.slice(0, 2);
      const end = findClosing(source, marker, index + 2);
      if (end > index + 2) {
        flush();
        out.push(...parseInline(source.slice(index + 2, end), { ...style, bold: true }));
        index = end + 2;
        continue;
      }
    }
    if (rest.startsWith("~~")) {
      const end = findClosing(source, "~~", index + 2);
      if (end > index + 2) {
        flush();
        out.push(...parseInline(source.slice(index + 2, end), { ...style, strike: true }));
        index = end + 2;
        continue;
      }
    }
    if ((char === "*" || char === "_") && source[index + 1] !== " " && !(char === "_" && /\w/.test(source[index - 1] ?? ""))) {
      const end = findClosing(source, char, index + 1);
      if (end > index + 1 && source[end - 1] !== " " && !(char === "_" && /\w/.test(source[end + 1] ?? ""))) {
        flush();
        out.push(...parseInline(source.slice(index + 1, end), { ...style, italic: true }));
        index = end + 1;
        continue;
      }
    }
    buffer += char;
    index += 1;
  }
  flush();
  return merge(out);
}

function sameStyle(a: Inline, b: Inline): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code && a.link === b.link;
}

function merge(inlines: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const piece of inlines) {
    if (!piece.text) continue;
    const last = out[out.length - 1];
    if (last && sameStyle(last, piece)) last.text += piece.text;
    else out.push({ ...piece });
  }
  return out;
}

export const inlineText = (inlines: readonly Inline[]): string => inlines.map((piece) => piece.text).join("");

function taskMarker(text: string): string {
  return text.replace(/^\[( |x|X)\]\s+/, (_all, mark: string) => (mark === " " ? "☐ " : "☑ "));
}

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", inlines: parseInline(paragraph.join(" ").trim()) });
    paragraph = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      endParagraph();
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      endParagraph();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trim().startsWith(fence[1]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      blocks.push({ kind: "heading", level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, inlines: parseInline(heading[2]!) });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      endParagraph();
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]!)) {
      endParagraph();
      const header = splitRow(line).map((cell) => parseInline(cell));
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim()) {
        const cells = splitRow(lines[index]!).map((cell) => parseInline(cell));
        while (cells.length < header.length) cells.push([]);
        rows.push(cells.slice(0, header.length));
        index += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (LIST.test(line)) {
      endParagraph();
      const items: ListItem[] = [];
      const indents: number[] = [];
      while (index < lines.length) {
        const current = lines[index]!;
        const match = LIST.exec(current);
        if (match) {
          const indent = match[1]!.length;
          while (indents.length && indents[indents.length - 1]! > indent) indents.pop();
          if (!indents.length || indents[indents.length - 1]! < indent) indents.push(indent);
          items.push({
            inlines: parseInline(taskMarker(match[3]!)),
            depth: Math.min(indents.length - 1, 5),
            ordered: /\d/.test(match[2]!),
          });
          index += 1;
          continue;
        }
        // An indented line continues the item above it.
        if (current.trim() && /^\s{2,}/.test(current) && items.length && !HEADING.test(current.trim())) {
          const last = items[items.length - 1]!;
          last.inlines = merge([...last.inlines, { text: " " }, ...parseInline(current.trim())]);
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      endParagraph();
      const body: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index]!);
        if (!match) break;
        body.push(match[1]!);
        index += 1;
      }
      blocks.push({ kind: "quote", inlines: parseInline(body.join(" ").trim()) });
      continue;
    }
    paragraph.push(line.trim());
    index += 1;
  }
  endParagraph();
  return blocks;
}

/** Plain text with light markers, for previews, slide bullets and word counts. */
export function markdownToPlain(markdown: string): string {
  const out: string[] = [];
  for (const block of parseMarkdown(markdown)) {
    switch (block.kind) {
      case "heading":
      case "paragraph":
      case "quote":
        out.push(inlineText(block.inlines));
        break;
      case "list":
        for (const item of block.items) out.push(`${"  ".repeat(item.depth)}${item.ordered ? "1." : "-"} ${inlineText(item.inlines)}`);
        break;
      case "table":
        out.push([block.header, ...block.rows].map((row) => row.map(inlineText).join(" | ")).join("\n"));
        break;
      case "code":
        out.push(block.text);
        break;
      case "rule":
        break;
    }
  }
  return out.join("\n");
}

export function wordCount(markdown: string): number {
  return markdownToPlain(markdown).split(/\s+/).filter(Boolean).length;
}

/** The outline of a document for a preview: headings, then the first lines. */
export function outline(markdown: string, max = 6): string[] {
  const blocks = parseMarkdown(markdown);
  const headings = blocks.filter((block): block is Extract<Block, { kind: "heading" }> => block.kind === "heading");
  if (headings.length) return headings.slice(0, max).map((block) => `${"  ".repeat(Math.max(0, block.level - 1))}${inlineText(block.inlines)}`);
  return markdownToPlain(markdown).split("\n").filter((line) => line.trim()).slice(0, max);
}
