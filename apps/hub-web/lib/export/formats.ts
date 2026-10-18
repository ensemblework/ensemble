"use client";

import type { FileStyleProfile } from "@ensemble/shared-types";
import type { Block, Cell, ExportDoc, Run } from "./document";
import { linkRuns, plainText, safeHref, toHtml, toMarkdown, toText } from "./document";

export type DocFormat = "md" | "pdf" | "docx" | "pages" | "html" | "txt";

export const DOC_FORMATS: Array<{ id: DocFormat; label: string; hint: string }> = [
  { id: "pdf", label: "PDF", hint: ".pdf" },
  { id: "docx", label: "Word", hint: ".docx" },
  { id: "pages", label: "Apple Pages", hint: "opens the .docx" },
  { id: "md", label: "Markdown", hint: ".md" },
  { id: "html", label: "Web page", hint: ".html" },
  { id: "txt", label: "Plain text", hint: ".txt" },
];

/**
 * A file name from a title. Letters and digits in any script, and emoji, stay; everything else
 * (including the characters file systems refuse, such as / \ : * ? " < > |) becomes a hyphen.
 */
export function fileSlug(title: string): string {
  const slug = title
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  // Cut by characters, not UTF-16 units, so an emoji is never split in half.
  return Array.from(slug).slice(0, 80).join("").replace(/[-\u200d]+$/, "") || "untitled";
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export type PdfFont = "helvetica" | "times" | "courier";
type Rgb = [number, number, number];

export type PdfLayout = {
  /** Points; null keeps jsPDF's A4. */
  format: [number, number] | null;
  margins: { top: number; right: number; bottom: number; left: number };
  body: { font: PdfFont; size: number; color: Rgb; lineHeight: number };
  headings: Record<1 | 2 | 3, { font: PdfFont; size: number; color: Rgb; bold: boolean }>;
  /** Write the page title and properties at the top. Off when exporting back to the original's layout. */
  title: boolean;
};

const INK: Rgb = [28, 25, 21];

/** The nearest of the standard PDF fonts every reader has, by the original font's name. */
export function pdfFontFor(name: string | undefined): PdfFont {
  const family = (name ?? "").toLowerCase();
  if (/mono|courier|consolas|menlo|monaco|code/.test(family)) return "courier";
  if (!/sans/.test(family) && /times|georgia|garamond|cambria|palatino|book|baskerville|minion|serif|caslon|century|constantia|didot|bodoni|charter|cmr|libertine|merriweather|playfair|lora|crimson/.test(family)) return "times";
  return "helvetica";
}

function rgb(hex: string | undefined, fallback: Rgb): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!match) return fallback;
  const value = match[1]!;
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

/** Page size, margins, fonts, sizes and colours for a PDF: Ensemble's own look, or the original file's when one is given. */
export function pdfLayout(style?: FileStyleProfile | null): PdfLayout {
  if (!style) {
    return {
      format: null,
      margins: { top: 56, right: 56, bottom: 56, left: 56 },
      body: { font: "helvetica", size: 11, color: INK, lineHeight: 1.4 },
      headings: {
        1: { font: "helvetica", size: 17, color: INK, bold: true },
        2: { font: "helvetica", size: 14.5, color: INK, bold: true },
        3: { font: "helvetica", size: 12.5, color: INK, bold: true },
      },
      title: true,
    };
  }
  const size = style.body?.size && style.body.size > 3 ? style.body.size : 11;
  const font = pdfFontFor(style.body?.font);
  const color = rgb(style.body?.color, [0, 0, 0]);
  const heading = (level: 1 | 2 | 3, scale: number) => {
    const own = style.headings?.[String(level) as "1" | "2" | "3"];
    return { font: own?.font ? pdfFontFor(own.font) : font, size: own?.size ?? Math.round(size * scale * 2) / 2, color: rgb(own?.color, color), bold: own?.bold ?? true };
  };
  return {
    format: style.page ? [style.page.width, style.page.height] : null,
    margins: style.page?.margins ?? { top: 72, right: 72, bottom: 72, left: 72 },
    body: { font, size, color, lineHeight: Math.min(2.5, Math.max(1, style.body?.lineHeight ?? 1.2)) },
    headings: { 1: heading(1, 1.6), 2: heading(2, 1.3), 3: heading(3, 1.1) },
    title: false,
  };
}

type FontStyle = "normal" | "bold" | "italic" | "bolditalic";
/** The look of a stretch of text before its runs' own bold, italic, code and links. */
export type PdfTextStyle = { font: PdfFont; size: number; color: Rgb; bold?: boolean; italic?: boolean };
/** Part of a laid-out line in one font, size and colour; `width` in points. */
export type PdfPiece = { text: string; font: PdfFont; style: FontStyle; size: number; color: Rgb; href?: string; strike?: boolean; width: number };
export type PdfLine = { pieces: PdfPiece[]; width: number };
export type PdfMeasure = (text: string, font: PdfFont, style: FontStyle, size: number) => number;

const LINK: Rgb = [37, 99, 235];

function pieceStyle(run: Run, base: PdfTextStyle): Omit<PdfPiece, "text" | "width"> {
  const bold = Boolean(run.bold || base.bold);
  const italic = Boolean(run.italic || base.italic);
  const href = safeHref(run.href);
  return {
    font: run.code ? "courier" : base.font,
    style: bold && italic ? "bolditalic" : bold ? "bold" : italic ? "italic" : "normal",
    size: run.code ? Math.round(base.size * 0.92 * 2) / 2 : base.size,
    color: href ? LINK : base.color,
    href,
    strike: run.strike || undefined,
  };
}

const sameLook = (a: Omit<PdfPiece, "text" | "width">, b: Omit<PdfPiece, "text" | "width">) =>
  a.font === b.font && a.style === b.style && a.size === b.size && a.color.join() === b.color.join() && a.href === b.href && a.strike === b.strike;

/**
 * Runs as lines no wider than `width`: wrapped at spaces, a word wider than a whole line (a long
 * URL) cut between characters, "\n" a line break. `keepIndent` keeps the spaces a line starts
 * with, for code.
 */
export function layoutRuns(runs: Run[], base: PdfTextStyle, width: number, measure: PdfMeasure, options: { keepIndent?: boolean } = {}): PdfLine[] {
  type Part = { text: string; look: Omit<PdfPiece, "text" | "width"> };
  type Token = { kind: "word" | "space" | "break"; parts: Part[] };
  const tokens: Token[] = [];
  for (const run of linkRuns(runs)) {
    const look = pieceStyle(run, base);
    const text = run.text.replace(/\r/g, "").replace(/\t/g, options.keepIndent ? "    " : " ");
    for (const piece of text.split(/(\n| +)/)) {
      if (!piece) continue;
      if (piece === "\n") tokens.push({ kind: "break", parts: [] });
      else if (piece.startsWith(" ")) tokens.push({ kind: "space", parts: [{ text: piece, look }] });
      else if (tokens.at(-1)?.kind === "word") tokens.at(-1)!.parts.push({ text: piece, look });
      else tokens.push({ kind: "word", parts: [{ text: piece, look }] });
    }
  }
  const widthOf = (part: Part) => measure(part.text, part.look.font, part.look.style, part.look.size);
  const lines: PdfLine[] = [];
  let current: PdfPiece[] = [];
  let used = 0;
  let lineStart = true;
  const push = (part: Part) => {
    if (!part.text) return;
    const size = widthOf(part);
    const last = current.at(-1);
    if (last && sameLook(last, part.look)) {
      last.text += part.text;
      last.width += size;
    } else current.push({ ...part.look, text: part.text, width: size });
    used += size;
  };
  const finish = () => {
    let last = current.at(-1);
    while (last && / $/.test(last.text)) {
      const trimmed = last.text.replace(/ +$/, "");
      if (trimmed) {
        last.text = trimmed;
        last.width = measure(trimmed, last.font, last.style, last.size);
        break;
      }
      current.pop();
      last = current.at(-1);
    }
    lines.push({ pieces: current, width: current.reduce((sum, piece) => sum + piece.width, 0) });
    current = [];
    used = 0;
  };
  const hasText = () => current.some((piece) => piece.text.trim());
  for (const token of tokens) {
    if (token.kind === "break") {
      finish();
      lineStart = true;
      continue;
    }
    if (token.kind === "space") {
      if (hasText() || (options.keepIndent && lineStart)) push(token.parts[0]!);
      continue;
    }
    lineStart = false;
    let parts = token.parts;
    const total = parts.reduce((sum, part) => sum + widthOf(part), 0);
    if (used + total <= width) {
      parts.forEach(push);
      continue;
    }
    if (hasText()) {
      finish();
      if (total <= width) {
        parts.forEach(push);
        continue;
      }
    }
    // Wider than a whole line: as many characters as fit, then the rest on the next lines.
    for (;;) {
      const chars = parts.flatMap((part) => Array.from(part.text).map((char) => ({ char, look: part.look })));
      const group = (list: typeof chars): Part[] => {
        const out: Part[] = [];
        for (const { char, look } of list) {
          if (out.at(-1)?.look === look) out.at(-1)!.text += char;
          else out.push({ text: char, look });
        }
        return out;
      };
      const fits = (count: number) => group(chars.slice(0, count)).reduce((sum, part) => sum + widthOf(part), 0) <= width - used;
      if (fits(chars.length)) {
        parts.forEach(push);
        break;
      }
      let low = 0;
      let high = chars.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(middle)) low = middle;
        else high = middle - 1;
      }
      let count = Math.max(low, used > 0 ? 0 : 1);
      // A URL reads better broken after a slash or other separator, when one is near the end.
      for (let at = low; at > 1 && at >= low * 0.6; at -= 1) {
        if (/[/?&#=_.-]/.test(chars[at - 1]!.char)) {
          count = at;
          break;
        }
      }
      group(chars.slice(0, count)).forEach(push);
      finish();
      if (count >= chars.length) break;
      parts = group(chars.slice(count));
    }
  }
  if (current.length || !lines.length || tokens.at(-1)?.kind === "break") finish();
  return lines;
}

/**
 * Column widths for a table `total` wide. Columns that all fit at their natural width share the
 * spare room by size; otherwise each keeps its floor (`least`) and the rest is shared by how much
 * more each one wants; when even the floors don't fit, they shrink together.
 */
export function columnWidths(natural: number[], least: number[], total: number): number[] {
  const sum = (values: number[]) => values.reduce((all, value) => all + value, 0);
  const even = () => natural.map(() => total / Math.max(1, natural.length));
  const wanted = sum(natural);
  if (wanted <= total) return wanted > 0 ? natural.map((value) => (value * total) / wanted) : even();
  const floors = natural.map((value, index) => Math.min(value, least[index] ?? 0));
  const floor = sum(floors);
  if (floor >= total) return floor > 0 ? floors.map((value) => (value * total) / floor) : even();
  return natural.map((value, index) => floors[index]! + ((value - floors[index]!) * (total - floor)) / (wanted - floor));
}

/**
 * A PDF with real, selectable text: headings, paragraphs, lists, to-dos, quotes, code and tables,
 * keeping bold, italic, code, strikethrough and clickable links. With a style profile it uses the
 * original file's page size, margins, fonts, sizes and colours.
 */
export async function toPdf(doc: ExportDoc, options: { style?: FileStyleProfile | null } = {}): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const layout = pdfLayout(options.style);
  const pdf = layout.format
    ? new jsPDF({ unit: "pt", format: layout.format, orientation: layout.format[0] > layout.format[1] ? "landscape" : "portrait" })
    : new jsPDF({ unit: "pt", format: "a4" });
  pdf.setProperties({ title: doc.title, creator: "Ensemble" });
  const width = pdf.internal.pageSize.getWidth();
  const height = pdf.internal.pageSize.getHeight();
  const { margins, body } = layout;
  const own = layout.title;
  const usable = width - margins.left - margins.right;
  const bottom = height - margins.bottom;
  let y = margins.top;
  const newPage = () => {
    pdf.addPage();
    y = margins.top;
  };
  const measured = new Map<string, number>();
  const measure: PdfMeasure = (text, font, style, size) => {
    const key = `${font} ${style} ${size} ${text}`;
    let value = measured.get(key);
    if (value === undefined) {
      pdf.setFont(font, style);
      pdf.setFontSize(size);
      value = pdf.getTextWidth(text);
      measured.set(key, value);
    }
    return value;
  };
  const drawLine = (line: PdfLine, x: number, baseline: number) => {
    let cursor = x;
    for (const piece of line.pieces) {
      pdf.setFont(piece.font, piece.style);
      pdf.setFontSize(piece.size);
      pdf.setTextColor(...piece.color);
      pdf.text(piece.text, cursor, baseline);
      if (piece.href || piece.strike) {
        pdf.setDrawColor(...piece.color);
        pdf.setLineWidth(Math.max(0.4, piece.size / 20));
        if (piece.href) {
          pdf.line(cursor, baseline + piece.size * 0.12, cursor + piece.width, baseline + piece.size * 0.12);
          pdf.link(cursor, baseline - piece.size * 0.85, piece.width, piece.size * 1.1, { url: piece.href });
        }
        if (piece.strike) pdf.line(cursor, baseline - piece.size * 0.3, cursor + piece.width, baseline - piece.size * 0.3);
      }
      cursor += piece.width;
    }
  };
  /** Lines down the page, starting a new page when the next one would not fit. */
  const flow = (lines: PdfLine[], at: { x: number; size: number; lineHeight: number; pad?: number; backdrop?: (top: number, height: number) => void; first?: (baseline: number) => void }) => {
    const pad = at.pad ?? 0;
    let index = 0;
    while (index < lines.length) {
      if (y + at.lineHeight + 2 * pad > bottom && y > margins.top) newPage();
      const room = Math.max(1, Math.floor((bottom - y - 2 * pad) / at.lineHeight));
      const count = Math.min(room, lines.length - index);
      at.backdrop?.(y, count * at.lineHeight + 2 * pad);
      y += pad;
      for (let offset = 0; offset < count; offset += 1) {
        if (index + offset === 0) at.first?.(y + at.size);
        drawLine(lines[index + offset]!, at.x, y + at.size);
        y += at.lineHeight;
      }
      y += pad;
      index += count;
    }
  };
  const text = (runs: Run[], style: PdfTextStyle, at: { indent?: number; gap?: number; lineHeight?: number; first?: (baseline: number) => void; bar?: Rgb } = {}) => {
    const indent = at.indent ?? 0;
    const bar = at.bar;
    flow(layoutRuns(runs, style, usable - indent, measure), {
      x: margins.left + indent,
      size: style.size,
      lineHeight: style.size * (at.lineHeight ?? body.lineHeight),
      first: at.first,
      backdrop: bar
        ? (top, tall) => {
            pdf.setFillColor(...bar);
            pdf.rect(margins.left + 1, top, 2.5, tall, "F");
          }
        : undefined,
    });
    y += at.gap ?? 6;
  };
  const plain: PdfTextStyle = { font: body.font, size: body.size, color: body.color };
  const muted: Rgb = own ? [107, 101, 92] : body.color;
  const border: Rgb = own ? [221, 214, 204] : [200, 200, 200];

  const table = (rows: Cell[][]) => {
    const columns = Math.max(1, ...rows.map((row) => row.length));
    const size = Math.max(7, body.size - 1.5);
    const lineHeight = size * Math.min(1.35, Math.max(1.15, body.lineHeight));
    const padX = 6;
    const padY = 4;
    const look = (row: number): PdfTextStyle => ({ ...plain, size, bold: row === 0 || undefined });
    const natural = Array.from({ length: columns }, () => 2 * padX);
    const least = Array.from({ length: columns }, () => 0);
    rows.forEach((row, rowIndex) => {
      for (let column = 0; column < columns; column += 1) {
        const runs = row[column] ?? [];
        const lines = layoutRuns(runs, look(rowIndex), Number.POSITIVE_INFINITY, measure);
        natural[column] = Math.max(natural[column]!, ...lines.map((line) => line.width + 2 * padX));
        for (const run of linkRuns(runs)) {
          const piece = pieceStyle(run, look(rowIndex));
          for (const word of run.text.split(/\s+/)) least[column] = Math.max(least[column]!, Math.min(110, measure(word, piece.font, piece.style, piece.size)) + 2 * padX);
        }
      }
    });
    const sizes = columnWidths(
      natural,
      least.map((value, index) => Math.min(natural[index]!, Math.max(36, value))),
      usable,
    );
    const cells = rows.map((row, rowIndex) => sizes.map((columnWidth, column) => layoutRuns(row[column] ?? [], look(rowIndex), columnWidth - 2 * padX, measure)));
    const lineCount = (row: number) => Math.max(1, ...cells[row]!.map((lines) => lines.length));
    const rowHeight = (row: number) => lineCount(row) * lineHeight + 2 * padY;
    const header = own ? ([241, 237, 229] as Rgb) : ([238, 238, 238] as Rgb);
    const zebra = own ? ([251, 249, 245] as Rgb) : ([248, 248, 248] as Rgb);
    const drawRow = (row: number, from = 0, to = lineCount(row)) => {
      const rowSize = (to - from) * lineHeight + 2 * padY;
      const fill = row === 0 ? header : row % 2 === 0 ? zebra : null;
      if (fill) {
        pdf.setFillColor(...fill);
        pdf.rect(margins.left, y, usable, rowSize, "F");
      }
      let x = margins.left;
      sizes.forEach((columnWidth, column) => {
        cells[row]![column]!.slice(from, to).forEach((line, index) => drawLine(line, x + padX, y + padY + index * lineHeight + size));
        x += columnWidth;
      });
      pdf.setDrawColor(...border);
      pdf.setLineWidth(0.6);
      x = margins.left;
      for (const columnWidth of sizes) {
        pdf.rect(x, y, columnWidth, rowSize, "S");
        x += columnWidth;
      }
      y += rowSize;
    };
    const repeatHeader = rows.length > 1 && rowHeight(0) < (bottom - margins.top) / 3;
    const freshPage = () => {
      newPage();
      if (repeatHeader) drawRow(0);
    };
    // The header stays with the first row under it.
    if (y + rowHeight(0) + (rows.length > 1 ? rowHeight(1) : 0) > bottom && y > margins.top) newPage();
    drawRow(0);
    for (let row = 1; row < rows.length; row += 1) {
      if (y + rowHeight(row) <= bottom) {
        drawRow(row);
        continue;
      }
      if (margins.top + (repeatHeader ? rowHeight(0) : 0) + rowHeight(row) <= bottom) {
        freshPage();
        drawRow(row);
        continue;
      }
      // Taller than a page: the row continues on the next one.
      let from = 0;
      while (from < lineCount(row)) {
        const room = Math.floor((bottom - y - 2 * padY) / lineHeight);
        if (room < 1) {
          freshPage();
          continue;
        }
        const to = Math.min(lineCount(row), from + room);
        drawRow(row, from, to);
        from = to;
        if (from < lineCount(row)) freshPage();
      }
    }
    y += 10;
  };

  if (own) {
    text([{ text: doc.title }], { ...plain, size: 22, bold: true }, { gap: 10, lineHeight: 1.25 });
    for (const [label, value] of doc.meta ?? []) text([{ text: `${label}: ${value}` }], { ...plain, size: 10, color: muted }, { gap: 0 });
    if (doc.meta?.length) y += 12;
  }
  const block = (item: Block) => {
    switch (item.type) {
      case "heading": {
        const heading = layout.headings[item.level];
        y += 6;
        // A heading is not left alone at the foot of a page.
        if (y + heading.size * 1.4 + body.size * body.lineHeight * 2 > bottom && y > margins.top) newPage();
        text(item.runs, { font: heading.font, size: heading.size, color: heading.color, bold: heading.bold }, { lineHeight: Math.max(1.15, Math.min(body.lineHeight, 1.4)) });
        break;
      }
      case "paragraph":
        text(item.runs, plain);
        break;
      case "list": {
        const markers = item.items.map((_, index) => (item.ordered ? `${index + 1}.` : "•"));
        const column = Math.max(...markers.map((marker) => measure(marker, body.font, "normal", body.size))) + 6;
        item.items.forEach((entry, index) =>
          text(entry, plain, {
            indent: 12 + column,
            gap: 2,
            first: (baseline) => {
              pdf.setFont(body.font, "normal");
              pdf.setFontSize(body.size);
              pdf.setTextColor(...body.color);
              pdf.text(markers[index]!, margins.left + 12, baseline);
            },
          }),
        );
        y += 4;
        break;
      }
      case "todo": {
        const box = Math.round(body.size * 0.72 * 2) / 2;
        for (const entry of item.items) {
          text(entry.runs, plain, {
            indent: 12 + box + 7,
            gap: 2,
            first: (baseline) => {
              const x = margins.left + 12;
              const top = baseline - body.size * 0.36 - box / 2;
              pdf.setLineWidth(0.8);
              if (entry.checked) {
                pdf.setFillColor(...(own ? INK : body.color));
                pdf.setDrawColor(...(own ? INK : body.color));
                pdf.roundedRect(x, top, box, box, 1.5, 1.5, "FD");
                pdf.setDrawColor(255, 255, 255);
                pdf.setLineWidth(1.1);
                pdf.lines(
                  [
                    [box * 0.2, box * 0.22],
                    [box * 0.38, -box * 0.48],
                  ],
                  x + box * 0.2,
                  top + box * 0.52,
                );
              } else {
                pdf.setDrawColor(...(own ? ([150, 143, 133] as Rgb) : body.color));
                pdf.roundedRect(x, top, box, box, 1.5, 1.5, "S");
              }
            },
          });
        }
        y += 4;
        break;
      }
      case "quote":
        text(item.runs, { ...plain, italic: true, color: own ? [90, 85, 78] : body.color }, { indent: 14, bar: border });
        break;
      case "code": {
        const size = Math.max(7, body.size - 1.5);
        flow(layoutRuns([{ text: item.text }], { font: "courier", size, color: own ? [60, 56, 50] : body.color }, usable - 16, measure, { keepIndent: true }), {
          x: margins.left + 8,
          size,
          lineHeight: size * 1.35,
          pad: own ? 6 : 0,
          backdrop: own
            ? (top, tall) => {
                pdf.setFillColor(244, 241, 234);
                pdf.rect(margins.left, top, usable, tall, "F");
              }
            : undefined,
        });
        y += 8;
        break;
      }
      case "table":
        if (item.rows.length) table(item.rows);
        break;
      case "rule":
        if (y + 16 > bottom) newPage();
        pdf.setDrawColor(220, 214, 204);
        pdf.setLineWidth(0.6);
        pdf.line(margins.left, y + 6, width - margins.right, y + 6);
        y += 16;
        break;
    }
  };
  for (const item of doc.blocks) block(item);
  return pdf.output("blob");
}

// What jsPDF's built-in fonts can draw (Windows-1252). Other scripts and emoji come out garbled.
const PDF_FONT_TEXT = /^[\t\n\r\x20-\x7e\xa0-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]*$/;

/** Whether every character of the document can be drawn in a PDF made here (Latin text only). */
export function pdfCanDraw(doc: ExportDoc): boolean {
  return PDF_FONT_TEXT.test(toMarkdown(doc));
}

/**
 * The browser's print dialog on the document as a web page, for Save as PDF. Used for PDFs with
 * Hindi, Arabic, Chinese, emoji and other text the built-in fonts can't draw: the browser shapes
 * and draws them with the computer's own fonts, so nothing large ships with the app.
 */
export async function printDocument(doc: ExportDoc): Promise<void> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(frame);
  try {
    await new Promise<void>((resolve, reject) => {
      frame.onload = () => resolve();
      frame.onerror = () => reject(new Error("The page could not be prepared for printing."));
      frame.srcdoc = toHtml(doc);
    });
    const view = frame.contentWindow;
    if (!view) throw new Error("Printing is not available here.");
    view.focus();
    view.print();
  } finally {
    // Some browsers return from print() before the dialog closes; the frame must outlive it.
    window.setTimeout(() => frame.remove(), 60_000);
  }
}

// A4 less docx's default 1-inch margins, in twentieths of a point.
const DOCX_TEXT_WIDTH = 9026;

/** A Word document. Apple Pages, Google Docs and LibreOffice all open it. */
export async function toDocx(doc: ExportDoc): Promise<Blob> {
  const docx = await import("docx");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType, TableLayoutType, BorderStyle, ShadingType } = docx;
  const runs = (value: Run[], extra: { bold?: boolean } = {}) =>
    linkRuns(value).flatMap((run): Array<InstanceType<typeof TextRun> | InstanceType<typeof ExternalHyperlink>> => {
      const href = safeHref(run.href);
      const parts = run.text.split("\n").map(
        (text, index) =>
          new TextRun({ text, break: index ? 1 : undefined, bold: run.bold || extra.bold, italics: run.italic, strike: run.strike, font: run.code ? "Menlo" : undefined, style: href ? "Hyperlink" : undefined }),
      );
      return href ? [new ExternalHyperlink({ link: href, children: parts })] : parts;
    });
  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [new Paragraph({ text: doc.title, heading: HeadingLevel.TITLE })];
  for (const [label, value] of doc.meta ?? []) children.push(new Paragraph({ children: [new TextRun({ text: `${label}: `, bold: true }), ...runs([{ text: value }])] }));
  for (const block of doc.blocks) {
    switch (block.type) {
      case "heading":
        children.push(new Paragraph({ children: runs(block.runs), heading: block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3 }));
        break;
      case "paragraph":
        children.push(new Paragraph({ children: runs(block.runs) }));
        break;
      case "list":
        block.items.forEach((item, index) =>
          children.push(new Paragraph({ children: block.ordered ? [new TextRun(`${index + 1}. `), ...runs(item)] : runs(item), bullet: block.ordered ? undefined : { level: 0 } })),
        );
        break;
      case "todo":
        for (const item of block.items) children.push(new Paragraph({ children: [new TextRun(item.checked ? "☑ " : "☐ "), ...runs(item.runs)] }));
        break;
      case "quote":
        children.push(new Paragraph({ children: runs(block.runs), style: "IntenseQuote" }));
        break;
      case "code":
        for (const line of block.text.split("\n")) children.push(new Paragraph({ children: [new TextRun({ text: line || " ", font: "Menlo", size: 18 })] }));
        break;
      case "table": {
        if (!block.rows.length) break;
        const columns = Math.max(1, ...block.rows.map((row) => row.length));
        // No font metrics here: columns are sized by characters, about 120 twips each at 11 pt,
        // plus the cell margins.
        const twips = (chars: number) => chars * 120 + 240;
        const lines = (cell: Cell | undefined) => plainText(cell ?? []).split("\n");
        const natural = Array.from({ length: columns }, (_, column) => twips(Math.max(3, ...block.rows.map((row) => Math.max(...lines(row[column]).map((line) => line.length))))));
        const longest = (column: number) => Math.max(0, ...block.rows.flatMap((row) => plainText(row[column] ?? []).split(/\s+/).map((word) => word.length)));
        const least = natural.map((value, column) => Math.min(value, twips(Math.max(4, Math.min(18, longest(column))))));
        const sizes = columnWidths(natural, least, DOCX_TEXT_WIDTH).map(Math.floor);
        const line = { style: BorderStyle.SINGLE, size: 4, color: "DDD6CC" };
        children.push(
          new Table({
            width: { size: sizes.reduce((sum, size) => sum + size, 0), type: WidthType.DXA },
            columnWidths: sizes,
            layout: TableLayoutType.FIXED,
            borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
            margins: { top: 60, bottom: 60, left: 110, right: 110 },
            rows: block.rows.map(
              (row, rowIndex) =>
                new TableRow({
                  tableHeader: (rowIndex === 0 && block.rows.length > 1) || undefined,
                  cantSplit: true,
                  children: sizes.map(
                    (size, column) =>
                      new TableCell({
                        width: { size, type: WidthType.DXA },
                        shading: rowIndex === 0 ? { fill: "F1EDE5", type: ShadingType.CLEAR, color: "auto" } : rowIndex % 2 === 0 ? { fill: "FBF9F5", type: ShadingType.CLEAR, color: "auto" } : undefined,
                        children: [new Paragraph({ children: runs(row[column] ?? [], rowIndex === 0 ? { bold: true } : {}) })],
                      }),
                  ),
                }),
            ),
          }),
        );
        break;
      }
      case "rule":
        children.push(new Paragraph({ text: "", border: { bottom: { color: "DDDDDD", space: 1, style: "single", size: 6 } } }));
        break;
    }
  }
  return Packer.toBlob(new Document({ creator: "Ensemble", title: doc.title, sections: [{ children }] }));
}

/** The file for one format, with its name. */
export async function renderDocument(doc: ExportDoc, format: DocFormat): Promise<{ blob: Blob; name: string }> {
  const base = fileSlug(doc.title);
  switch (format) {
    case "md":
      return { blob: new Blob([toMarkdown(doc)], { type: "text/markdown;charset=utf-8" }), name: `${base}.md` };
    case "txt":
      return { blob: new Blob([toText(doc)], { type: "text/plain;charset=utf-8" }), name: `${base}.txt` };
    case "html":
      return { blob: new Blob([toHtml(doc)], { type: "text/html;charset=utf-8" }), name: `${base}.html` };
    case "pdf":
      return { blob: await toPdf(doc), name: `${base}.pdf` };
    case "docx":
    case "pages":
      return { blob: await toDocx(doc), name: `${base}.docx` };
  }
}

/** Saves the file, or for a PDF the built-in fonts can't draw, opens the print dialog instead ("printed"). */
export async function downloadDocument(doc: ExportDoc, format: DocFormat): Promise<"saved" | "printed"> {
  if (format === "pdf" && !pdfCanDraw(doc)) {
    await printDocument(doc);
    return "printed";
  }
  const { blob, name } = await renderDocument(doc, format);
  saveBlob(blob, name);
  return "saved";
}
