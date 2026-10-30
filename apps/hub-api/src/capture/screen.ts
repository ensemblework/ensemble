/**
 * A terminal's screen as evidence (a node's `terminal` tool, nodeTools 2): what a program drew in a
 * pseudo-terminal, replayed in a headless xterm (`@xterm/headless`), as plain text and as a
 * self-contained HTML page with the screen's colours (16, 256 and true colour), bold, dim, italic,
 * underline, strike-through and inverse, which Chromium renders to an image
 * (capture/service.ts `htmlScreenshot`). Saved secret values and key shapes are hidden before
 * anything is written: a line that shows one is drawn as plain text, the secret replaced.
 */
import type { IBufferCell, IBufferLine, Terminal } from "@xterm/headless";
import { hideSecrets, type PrivacyRules } from "../browser/privacy.js";
import { escapeHtml, TERMINAL_BACKGROUND, TERMINAL_FOREGROUND, xtermColour } from "./terminal.js";

/** A headless terminal of this size, without scrollback. The library loads only when a screen is captured. */
export async function headlessTerminal(columns: number, rows: number): Promise<Terminal> {
  const loaded = (await import("@xterm/headless")) as unknown as { default?: { Terminal: typeof Terminal }; Terminal?: typeof Terminal };
  const Xterm = loaded.Terminal ?? loaded.default!.Terminal;
  return new Xterm({ cols: columns, rows, allowProposedApi: true, scrollback: 0 });
}

/** Resolves once everything written so far has been drawn. */
export function drawn(term: Terminal): Promise<void> {
  return new Promise((resolve) => term.write("", resolve));
}

const hex = (rgb: number) => `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`;

/** A cell's look as CSS; empty for the default look. Bold makes the eight basic colours bright, as most terminals draw it. */
export function cellCss(cell: IBufferCell): string {
  const bold = cell.isBold() !== 0;
  let fg: string | null = cell.isFgRGB() ? hex(cell.getFgColor()) : cell.isFgPalette() ? xtermColour(bold && cell.getFgColor() < 8 ? cell.getFgColor() + 8 : cell.getFgColor()) : null;
  let bg: string | null = cell.isBgRGB() ? hex(cell.getBgColor()) : cell.isBgPalette() ? xtermColour(cell.getBgColor()) : null;
  if (cell.isInverse()) [fg, bg] = [bg ?? TERMINAL_BACKGROUND, fg ?? TERMINAL_FOREGROUND];
  if (cell.isInvisible()) fg = bg ?? TERMINAL_BACKGROUND;
  const decoration = [cell.isUnderline() ? "underline" : "", cell.isStrikethrough() ? "line-through" : "", cell.isOverline() ? "overline" : ""].filter(Boolean).join(" ");
  return [fg && fg !== TERMINAL_FOREGROUND && `color:${fg}`, bg && bg !== TERMINAL_BACKGROUND && `background:${bg}`, bold && "font-weight:bold", cell.isDim() && "opacity:.6", cell.isItalic() && "font-style:italic", decoration && `text-decoration:${decoration}`].filter(Boolean).join(";");
}

/** One row of the screen as HTML: runs of cells that look the same, a wide character kept two cells wide. */
export function rowHtml(line: IBufferLine, columns: number, cell: IBufferCell): string {
  let html = "";
  let run = "";
  let css = "";
  const flush = () => {
    if (run) html += css ? `<span style="${css}">${run}</span>` : run;
    run = "";
  };
  for (let x = 0; x < columns; x += 1) {
    const got = line.getCell(x, cell);
    if (!got) break;
    const width = got.getWidth();
    if (width === 0) continue;
    const look = cellCss(got);
    if (look !== css) {
      flush();
      css = look;
    }
    const chars = escapeHtml(got.getChars() || " ");
    run += width === 2 ? `<span class="w">${chars}</span>` : chars;
  }
  flush();
  return html;
}

export type Screen = {
  /** What the screen shows as text, one line per row (right-trimmed, trailing empty rows dropped), secrets hidden. */
  text: string;
  /** The screen as a self-contained page; the screen itself is `#term`. */
  html: string;
  /** A saved secret or a key-shaped string was on the screen, and was hidden. */
  hidden: boolean;
  columns: number;
  rows: number;
};

/** The terminal's visible screen as text and HTML, with secrets hidden. */
export function renderScreen(term: Terminal, input: { title?: string; rules: PrivacyRules }): Screen {
  const buffer = term.buffer.active;
  const columns = term.cols;
  const rows = term.rows;
  const cell = buffer.getNullCell();
  const lines = Array.from({ length: rows }, (_, y) => buffer.getLine(buffer.viewportY + y));
  const texts: string[] = new Array(rows).fill("");
  const htmls: string[] = new Array(rows).fill("");
  let hidden = false;
  // A long line wrapped onto the next rows is checked for secrets as one line.
  for (let start = 0; start < rows; ) {
    let end = start + 1;
    while (end < rows && lines[end]?.isWrapped) end += 1;
    const group = lines.slice(start, end);
    const full = group.map((line, index) => line?.translateToString(index === group.length - 1) ?? "").join("");
    const shown = hideSecrets(full, input.rules);
    if (shown !== full) {
      hidden = true;
      for (let index = 0; index < group.length; index += 1) {
        const part = index === group.length - 1 ? shown.slice(index * columns) : shown.slice(index * columns, (index + 1) * columns);
        texts[start + index] = part.trimEnd();
        htmls[start + index] = escapeHtml(part);
      }
    } else {
      group.forEach((line, index) => {
        texts[start + index] = line?.translateToString(true) ?? "";
        htmls[start + index] = line ? rowHtml(line, columns, cell) : "";
      });
    }
    start = end;
  }
  const lastShown = texts.reduce((last, text, index) => (text.trim() ? index : last), -1);
  const title = escapeHtml(input.title ?? "Terminal");
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${title}</title>
<style>body{margin:0;background:${TERMINAL_BACKGROUND}}#term{display:inline-block;background:${TERMINAL_BACKGROUND};color:${TERMINAL_FOREGROUND}}header{font:600 12px system-ui,sans-serif;padding:7px 12px;background:#2d2d2d;color:#ccc}#screen{padding:8px 10px;font:14px/1.3 "DejaVu Sans Mono","Liberation Mono",ui-monospace,Menlo,Consolas,monospace;white-space:pre}.r{height:1.3em;width:${columns}ch;overflow:hidden}.w{display:inline-block;width:2ch}</style>
</head><body><div id="term"><header>${title}</header><div id="screen">${htmls.map((row) => `<div class="r">${row}</div>`).join("")}</div></div></body></html>
`;
  return { text: texts.slice(0, lastShown + 1).join("\n"), html, hidden, columns, rows };
}

/** The page's size in pixels with room to spare, for the tab that renders it (the screenshot is cropped to `#term`). */
export function screenViewport(columns: number, rows: number): { width: number; height: number } {
  return { width: Math.min(4000, Math.ceil(columns * 9.5) + 60), height: Math.min(4000, Math.ceil(rows * 19.5) + 80) };
}
