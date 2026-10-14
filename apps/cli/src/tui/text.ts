/**
 * Text for the terminal: Markdown-ish rendering into styled lines, wrapped to a width, so views
 * can scroll by line and know exactly what is on screen (and where a click lands).
 */

export type Style = { color?: string; bold?: boolean; dim?: boolean; italic?: boolean; inverse?: boolean; backgroundColor?: string; underline?: boolean };
export type Segment = { text: string; brandWorking?: boolean } & Style;
export type Line = Segment[];

/** Display width of a string: wide East Asian characters and most emoji take two cells. */
export function cellWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0x300 && code <= 0x36f)) continue;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd)
        ? 2
        : 1;
  }
  return width;
}

/** Cut to at most `width` cells, with an ellipsis when cut. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (cellWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const w = cellWidth(char);
    if (used + w > width - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

export function pad(text: string, width: number): string {
  const cut = truncate(text, width);
  return cut + " ".repeat(Math.max(0, width - cellWidth(cut)));
}

/** Wraps one styled line to `width` cells, breaking at spaces where it can. */
export function wrapLine(line: Line, width: number, indent = ""): Line[] {
  if (width <= 4) return [line];
  const out: Line[] = [];
  let current: Line = [];
  let used = 0;
  const flush = () => {
    out.push(current);
    current = indent ? [{ text: indent }] : [];
    used = cellWidth(indent);
  };
  for (const segment of line) {
    const words = segment.text.split(/(\s+)/);
    for (const word of words) {
      if (!word) continue;
      let piece = word;
      while (cellWidth(piece) > 0) {
        const room = width - used;
        const w = cellWidth(piece);
        if (w <= room) {
          current.push({ ...segment, text: piece });
          used += w;
          break;
        }
        if (/^\s+$/.test(piece)) {
          flush();
          break;
        }
        if (w <= width - cellWidth(indent) && used > cellWidth(indent)) {
          flush();
          continue;
        }
        // A word longer than the line: hard break.
        let head = "";
        let headWidth = 0;
        for (const char of piece) {
          const cw = cellWidth(char);
          if (headWidth + cw > room) break;
          head += char;
          headWidth += cw;
        }
        if (!head) {
          flush();
          continue;
        }
        current.push({ ...segment, text: head });
        piece = piece.slice(head.length);
        flush();
      }
    }
  }
  out.push(current);
  return out;
}

/** `**bold**`, `` `code` `` and links inside one line of Markdown. */
export function inline(text: string, base: Style = {}): Line {
  const out: Line = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) out.push({ ...base, text: text.slice(last, match.index) });
    const token = match[0];
    if (token.startsWith("**")) out.push({ ...base, text: token.slice(2, -2), bold: true });
    else if (token.startsWith("`")) out.push({ ...base, text: token.slice(1, -1), color: "cyan" });
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      out.push({ ...base, text: link[1]!, underline: true }, { ...base, text: ` (${link[2]})`, dim: true });
    }
    last = match.index! + token.length;
  }
  if (last < text.length) out.push({ ...base, text: text.slice(last) });
  return out.length ? out : [{ ...base, text: "" }];
}

/** Markdown (the subset models write) to wrapped, styled lines. */
export function markdown(source: string, width: number, base: Style = {}): Line[] {
  const lines: Line[] = [];
  let fence: string | null = null;
  for (const raw of source.replace(/\r/g, "").split("\n")) {
    const fenceMatch = /^\s*```(\S*)/.exec(raw);
    if (fenceMatch) {
      if (fence === null) {
        fence = fenceMatch[1] ?? "";
        lines.push([{ text: `╭─ ${fence || "code"}`, dim: true }]);
      } else {
        fence = null;
        lines.push([{ text: "╰─", dim: true }]);
      }
      continue;
    }
    if (fence !== null) {
      for (const wrapped of wrapLine([{ text: "│ ", dim: true }, { text: raw, color: "cyan" }], width, "│ ")) lines.push(wrapped);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      lines.push(...wrapLine(inline(heading[2]!, { ...base, bold: true }), width));
      continue;
    }
    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (bullet) {
      const depth = Math.min(4, Math.floor(bullet[1]!.length / 2));
      const marker = /\d/.test(bullet[2]!) ? `${bullet[2]} ` : "• ";
      const lead = `${"  ".repeat(depth)}${marker}`;
      lines.push(...wrapLine([{ ...base, text: lead }, ...inline(bullet[3]!, base)], width, " ".repeat(cellWidth(lead))));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(raw);
    if (quote) {
      lines.push(...wrapLine([{ text: "▎ ", dim: true }, ...inline(quote[1]!, { ...base, italic: true })], width, "▎ "));
      continue;
    }
    lines.push(...wrapLine(inline(raw, base), width));
  }
  return lines;
}

/** Plain text (a log) to wrapped lines, one style. */
export function plain(text: string, width: number, style: Style = {}): Line[] {
  return text
    .replace(/\r/g, "")
    // Colour codes a tool printed are not ours to interpret.
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split("\n")
    .flatMap((line) => wrapLine([{ ...style, text: line }], width));
}

export function lineText(line: Line): string {
  return line.map((segment) => segment.text).join("");
}
