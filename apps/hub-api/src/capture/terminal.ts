/**
 * A terminal as evidence: its transcript (text is better evidence than a picture of text), turned
 * into a self-contained HTML page with the terminal's colours, which Chromium can also render to an
 * image. Saved secret values and key shapes are hidden before anything is written, so a transcript
 * capture is checked and need not be held.
 */
import { findSecrets, hideSecrets, type PrivacyRules } from "../browser/privacy.js";

const ESC = "\u001b";

/** CSI sequences (colours, cursor moves), OSC titles and links, and lone escapes. */
const ANSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^\\u0007\\u001b]*(?:\\u0007|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

const BASE = ["#1e1e1e", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5"];
const BRIGHT = ["#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];

/** One of the 256 xterm colours. */
export function xtermColour(index: number): string {
  if (index < 8) return BASE[index]!;
  if (index < 16) return BRIGHT[index - 8]!;
  if (index < 232) {
    const n = index - 16;
    const level = (value: number) => (value === 0 ? 0 : 55 + value * 40);
    const hex = (value: number) => level(value).toString(16).padStart(2, "0");
    return `#${hex(Math.floor(n / 36))}${hex(Math.floor(n / 6) % 6)}${hex(n % 6)}`;
  }
  const grey = (8 + (index - 232) * 10).toString(16).padStart(2, "0");
  return `#${grey}${grey}${grey}`;
}

type Style = { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean };

function applySgr(style: Style, codes: number[]): Style {
  let next: Style = { ...style };
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i]!;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) next.bold = next.dim = false;
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code >= 30 && code <= 37) next.fg = BASE[code - 30];
    else if (code >= 90 && code <= 97) next.fg = BRIGHT[code - 90];
    else if (code >= 40 && code <= 47) next.bg = BASE[code - 40];
    else if (code >= 100 && code <= 107) next.bg = BRIGHT[code - 100];
    else if (code === 39) next.fg = undefined;
    else if (code === 49) next.bg = undefined;
    else if ((code === 38 || code === 48) && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
      next[code === 38 ? "fg" : "bg"] = xtermColour(Math.min(255, codes[i + 2]!));
      i += 2;
    } else if ((code === 38 || code === 48) && codes[i + 1] === 2 && codes[i + 4] !== undefined) {
      const [r, g, b] = [codes[i + 2]!, codes[i + 3]!, codes[i + 4]!].map((value) => Math.min(255, value).toString(16).padStart(2, "0"));
      next[code === 38 ? "fg" : "bg"] = `#${r}${g}${b}`;
      i += 4;
    }
  }
  return next;
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function css(style: Style): string {
  const fg = style.inverse ? (style.bg ?? "#1e1e1e") : style.fg;
  const bg = style.inverse ? (style.fg ?? "#e5e5e5") : style.bg;
  return [fg && `color:${fg}`, bg && `background:${bg}`, style.bold && "font-weight:bold", style.dim && "opacity:.7", style.italic && "font-style:italic", style.underline && "text-decoration:underline"].filter(Boolean).join(";");
}

/** Carriage returns redraw a line (progress bars): keep what the line finally showed. Backspaces erase. */
export function settleLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const parts = line.replace(/\r$/, "").split("\r");
      let shown = "";
      for (const part of parts) shown = part + shown.slice(part.length);
      let out = "";
      for (const char of shown) out = char === "\b" ? out.slice(0, -1) : out + char;
      return out;
    })
    .join("\n");
}

/** ANSI-coloured text as HTML spans. */
export function ansiToHtml(text: string): string {
  let style: Style = {};
  let html = "";
  let last = 0;
  const sgr = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");
  const flush = (chunk: string) => {
    const plain = stripAnsi(chunk);
    if (!plain) return;
    const rule = css(style);
    html += rule ? `<span style="${rule}">${escapeHtml(plain)}</span>` : escapeHtml(plain);
  };
  for (let match = sgr.exec(text); match; match = sgr.exec(text)) {
    flush(text.slice(last, match.index));
    style = applySgr(style, (match[1] || "0").split(";").map((part) => Number(part || 0)));
    last = match.index + match[0].length;
  }
  flush(text.slice(last));
  return html;
}

/** The transcript as a standalone HTML page, with secrets hidden. Scripts are blocked by its policy. */
export function transcriptHtml(input: { transcript: string; title?: string; columns?: number; rules: PrivacyRules }): { html: string; hidden: boolean } {
  const settled = settleLines(input.transcript.replace(/\r\n/g, "\n").slice(0, 2_000_000));
  let body: string;
  const coloured = hideSecrets(settled, input.rules);
  const hidden = coloured !== settled;
  const plain = stripAnsi(coloured);
  // A secret split by colour codes is only visible once they are removed: then drop the colours.
  const findings = findSecrets(plain, input.rules);
  if (findings.savedSecrets || findings.keyLike) body = escapeHtml(hideSecrets(stripAnsi(settled), input.rules));
  else body = ansiToHtml(coloured);
  const columns = Math.min(Math.max(input.columns ?? 100, 40), 300);
  const title = escapeHtml(input.title ?? "Terminal");
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${title}</title>
<style>body{margin:0;background:#1e1e1e;color:#e5e5e5}header{font:600 13px system-ui,sans-serif;padding:10px 16px;background:#2d2d2d;color:#ccc}pre{margin:0;padding:12px 16px;font:13px/1.45 ui-monospace,"DejaVu Sans Mono",Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-all;max-width:${columns}ch}</style>
</head><body><header>${title}</header><pre>${body}</pre></body></html>
`;
  return { html, hidden: hidden || Boolean(findings.savedSecrets || findings.keyLike) };
}
