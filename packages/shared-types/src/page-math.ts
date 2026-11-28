/**
 * TeX math in Markdown: `$…$` and `\(…\)` inline, `$$…$$` and `\[…\]` on lines of their own as a
 * display equation. Page Markdown (page-markdown.ts), hub-api's page Markdown and the Hub's chat
 * Markdown all read math with these rules, so an equation an agent writes, a person pastes or an
 * import brings in becomes the same `inlineMath` or `blockMath` node.
 *
 * A dollar sign only opens math when the next character is not a space, and only closes it after a
 * character that is not a space and before one that is not a digit, so prices such as "$5 and
 * $10" stay text. `\$` is a literal dollar sign.
 */

/** `$$x$$` inside a line of text: display math in a sentence. */
const DISPLAY = String.raw`\$\$(?![\s$])((?:\\[^\n]|[^$\\\n])+?)\$\$`;
/** `$x$`: no space just inside the dollars, no letter or digit before the first, no digit after the last. */
const DOLLAR = String.raw`(?<![\\$\p{L}\p{N}])\$(?![\s$])((?:\\[^\n]|[^$\\\n\x60])*?(?:\\[^\n]|[^\s$\\\x60]))\$(?![\p{N}$])`;
/** `\(x\)`, as many models write inline math. */
const PAREN = String.raw`\\\(([^\n]+?)\\\)`;

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

/** Whether a line of text holds inline math. */
export function hasInlineMath(text: string): boolean {
  return inlineMathPattern().test(text);
}

function dedent(lines: string[]): string {
  const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^[ \t]*/)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(cut).trimEnd()).join("\n").trim();
}

/**
 * A display equation starting at line `i`: `$$ … $$` on one line, or `$$` (or `\[`) with the TeX on
 * the following lines up to a line ending in `$$` (or `\]`). Null when the line does not open one,
 * or when it closes with text after it (that is inline math in a sentence) or never closes before
 * a blank line, since TeX math has no blank lines.
 */
export function mathBlockAt(lines: readonly string[], i: number): { latex: string; next: number } | null {
  const first = lines[i]?.trim() ?? "";
  const open = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\[" : null;
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
  for (let j = i + 1; j < lines.length; j += 1) {
    const line = lines[j]!.trimEnd();
    if (!line.trim()) return null;
    const at = line.indexOf(close);
    if (at >= 0) {
      if (at !== line.length - 2) return null;
      body.push(line.slice(0, at));
      const latex = dedent(body);
      return latex ? { latex, next: j + 1 } : null;
    }
    body.push(line);
  }
  return null;
}

/** Whether line `i` opens a display equation. */
export const startsMathBlock = (lines: readonly string[], i: number) => mathBlockAt(lines, i) !== null;

type MathNode = { type?: string; attrs?: Record<string, unknown> | null };

/**
 * The Markdown of an `inlineMath` or `blockMath` node, which reads back as the same node:
 * `$x$`, `$$x$$` for display math in a sentence, and a display equation on lines of its own.
 * Null for any other node.
 */
export function mathMarkdown(node: MathNode): string | null {
  const latex = String(node.attrs?.latex ?? "").trim();
  if (node.type === "blockMath") return `$$\n${latex}\n$$`;
  if (node.type !== "inlineMath") return null;
  return node.attrs?.display ? `$$${latex}$$` : `$${latex}$`;
}

/** Escapes the dollar signs of text that would read back as math (`\$`), so it stays text. */
export function escapeMathText(text: string): string {
  if (!text.includes("$")) return text;
  return text.replace(inlineMathPattern(), (match) => match.replace(/(?<!\\)\$/g, "\\$"));
}
