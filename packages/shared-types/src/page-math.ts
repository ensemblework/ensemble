/**
 * TeX math in Markdown: `$…$` and `\(…\)` inline, `$$…$$` and `\[…\]` on lines of their own as a
 * display equation. Page Markdown (page-markdown.ts), hub-api's page Markdown and the Hub's chat
 * Markdown all read math with these rules, so an equation an agent writes, a person pastes or an
 * import brings in becomes the same `inlineMath` or `blockMath` node.
 *
 * A dollar sign opens math only before a character that is not a space, and closes it only after a
 * character that is not a space and before one that is not a letter, digit, `_` or `{`. So prices
 * ("$5 and $10") and shell variables ("$PATH:$HOME", "${A}${B}") stay text.
 *
 * Every pattern is bounded (TeX up to `MAX_TEX` characters, a display equation up to
 * `MAX_BLOCK_LINES` lines) and stops at the next opener, so hostile text parses in linear time.
 */

/** The longest inline TeX read as one equation. */
const MAX_TEX = 2000;
/** The most lines a display equation spans. */
export const MAX_BLOCK_LINES = 200;

/** `$$x$$` inside a line of text: display math in a sentence. */
const DISPLAY = String.raw`(?<![\\$])\$\$(?![\s$])((?:\\[^\n]|[^$\\\n]){1,${MAX_TEX}}?)\$\$`;
/** `$x$`: no space just inside the dollars, no letter or digit before the first, nothing word-like after the last. */
const DOLLAR = String.raw`(?<![\\$\p{L}\p{N}])\$(?![\s$])((?:\\[^\n]|[^$\\\n\x60]){0,${MAX_TEX}}?(?:\\[^\n]|[^\s$\\\x60]))\$(?![\p{L}\p{N}_{$])`;
/** `\(x\)`, as many models write inline math. The TeX holds no other `\(` or `\)`. */
const PAREN = String.raw`(?<!\\)\\\(((?:[^\\\n]|\\[^()\n]){1,${MAX_TEX}}?)\\\)`;

/**
 * Inline math in a line of Markdown text. Group 1: `$$…$$` (display), group 2: `$…$`, group 3: `\(…\)`.
 * One alternation, so it can join another inline pattern; use `inlineMathMatch` to read a match.
 */
export const INLINE_MATH_SOURCE = `${DISPLAY}|${DOLLAR}|${PAREN}`;

export function inlineMathPattern(): RegExp {
  return new RegExp(INLINE_MATH_SOURCE, "gu");
}

/** The TeX and whether it is display math, from the three groups of `INLINE_MATH_SOURCE`. */
export function inlineMathMatch(display: string | undefined, dollar: string | undefined, paren: string | undefined): { latex: string; display: boolean } | null {
  if (display !== undefined) return { latex: display.trim(), display: true };
  const latex = (dollar ?? paren)?.trim();
  return latex ? { latex, display: false } : null;
}

const DOLLAR_AT = new RegExp(`${DISPLAY}|${DOLLAR}`, "uy");
const PAREN_AT = new RegExp(PAREN, "uy");

/** How far past a backslash the reader looks to see whether the escaped `$` or `\(` would be math. */
const ESCAPE_WINDOW = 256;

/**
 * Whether `pattern` would match at the backslash at `at` once that backslash is removed. Only a
 * short window is tried, so a run of escapes stays linear.
 */
function opensWithout(pattern: RegExp, text: string, at: number): boolean {
  const from = Math.max(0, at - 1);
  const window = text.slice(from, at) + text.slice(at + 1, at + 1 + ESCAPE_WINDOW);
  pattern.lastIndex = at - from;
  return pattern.test(window);
}

function dedent(lines: string[]): string {
  const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^[ \t]*/)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(cut).trimEnd()).join("\n").trim();
}

const opener = (line: string) => (line.startsWith("$$") ? "$$" : line.startsWith("\\[") ? "\\[" : null);

/**
 * A display equation starting at line `i`: `$$ … $$` on one line, or `$$` (or `\[`) with the TeX on
 * the following lines up to a line ending in `$$` (or `\]`). Null when the line does not open one,
 * when it closes with text after it (that is inline math in a sentence), or when no close comes
 * before a blank line (TeX math has none), another opener or `MAX_BLOCK_LINES` lines.
 */
export function mathBlockAt(lines: readonly string[], i: number): { latex: string; next: number } | null {
  const first = lines[i]?.trim() ?? "";
  const open = opener(first);
  if (!open) return null;
  const close = open === "$$" ? "$$" : "\\]";
  const rest = first.slice(2);
  const end = rest.indexOf(close);
  if (end >= 0) {
    if (rest.slice(end + 2).trim()) return null;
    const latex = rest.slice(0, end).trim();
    return latex ? { latex, next: i + 1 } : null;
  }
  const body = [rest];
  for (let j = i + 1; j < lines.length && j <= i + MAX_BLOCK_LINES; j += 1) {
    const line = lines[j]!.trimEnd();
    if (!line.trim()) return null;
    const at = line.indexOf(close);
    if (at >= 0) {
      if (at !== line.length - 2) return null;
      body.push(line.slice(0, at));
      const latex = dedent(body);
      return latex ? { latex, next: j + 1 } : null;
    }
    if (opener(line.trim())) return null;
    body.push(line);
  }
  return null;
}

/** Whether line `i` opens a display equation. */
export const startsMathBlock = (lines: readonly string[], i: number) => mathBlockAt(lines, i) !== null;

type MathNode = { type?: string; attrs?: Record<string, unknown> | null };

/** TeX as it is saved: trimmed, without blank lines (a blank line would end the equation in Markdown). */
export function cleanLatex(latex: string): string {
  return latex.split("\n").filter((line) => line.trim()).join("\n").trim();
}

/**
 * The Markdown of an `inlineMath` or `blockMath` node, which reads back as the same node:
 * `$x$`, `$$x$$` for display math in a sentence, and a display equation on lines of its own.
 * Null for any other node.
 */
export function mathMarkdown(node: MathNode): string | null {
  const latex = cleanLatex(String(node.attrs?.latex ?? ""));
  if (node.type === "blockMath") return `$$\n${latex}\n$$`;
  if (node.type !== "inlineMath") return null;
  const line = latex.replace(/\s*\n\s*/g, " ");
  return node.attrs?.display ? `$$${line}$$` : `$${line}$`;
}

/**
 * Whether the `\$` at `at` (the backslash) is an escape, read as a dollar sign: before a digit (a
 * price) or another `$`, when the dollar would otherwise open math, and anywhere but inside a word
 * or path such as `C:\$Recycle.Bin`, where the backslash is text.
 */
function dollarEscape(text: string, at: number): boolean {
  const before = text[at - 1] ?? "";
  const after = text[at + 2] ?? "";
  if (/[\p{N}$]/u.test(after)) return true;
  if (!(/[\p{L}\p{N}:\\/.]/u.test(before) && /[\p{L}_{]/u.test(after))) return true;
  return opensWithout(DOLLAR_AT, text, at);
}

/**
 * Plain Markdown text as page text: `\$` that is an escape becomes `$`, `\\$` a backslash and a
 * dollar sign, and `\\(` that would otherwise be math `\(`. `atStart` (the start of a paragraph):
 * `\\[` there becomes `\[`. Other backslashes are text.
 */
export function unescapeMathText(text: string, atStart = false): string {
  if (!text.includes("\\")) return text;
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "\\") {
      if (text[i + 1] === "\\" && text[i + 2] === "$") {
        out += "\\$";
        i += 2;
        continue;
      }
      if (text[i + 1] === "$" && dollarEscape(text, i)) {
        out += "$";
        i += 1;
        continue;
      }
      if (text[i + 1] === "\\" && text[i + 2] === "(" && opensWithout(PAREN_AT, text, i)) {
        out += "\\(";
        i += 2;
        continue;
      }
      if (atStart && i === 0 && text.startsWith("\\\\[") && mathBlockAt([text.slice(1)], 0)) {
        out += "\\[";
        i += 2;
        continue;
      }
    }
    out += char;
  }
  return out;
}

/**
 * Page text as Markdown that reads back as the same text (`unescapeMathText`): a backslash the
 * reader would take as an escape is doubled, and anything that would read as math gets a
 * backslash before it (`\$x$`, `\\(a\)`).
 */
export function escapeMathText(text: string): string {
  if (!text.includes("$") && !text.includes("\\")) return text;
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "\\" && text[i + 1] === "$" && (dollarEscape(text, i) || text[i - 1] === "\\")) out += "\\\\";
    else out += char;
  }
  for (let round = 0; round < 4; round += 1) {
    let changed = false;
    out = out.replace(inlineMathPattern(), (match) => {
      changed = true;
      return `\\${match}`;
    });
    if (!changed) break;
  }
  return out;
}

/** A paragraph's Markdown with every line that would open a display equation escaped (`\$$`, `\\[`). */
export function escapeMathBlockStarts(markdown: string): string {
  if (!markdown.includes("$$") && !markdown.includes("\\[")) return markdown;
  const lines = markdown.split("\n");
  return lines.map((line, index) => (startsMathBlock(lines, index) ? line.replace(/^(\s*)/, "$1\\") : line)).join("\n");
}
