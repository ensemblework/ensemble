"use client";

import type { FileStyleProfile } from "@ensemble/shared-types";
import type { Block, ExportDoc, Run } from "./document";
import { plainText, toHtml, toMarkdown, toText } from "./document";

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

/**
 * A PDF with real, selectable text: headings, paragraphs, lists, to-dos, quotes, code, tables.
 * With a style profile it uses the original file's page size, margins, fonts, sizes and colours.
 */
export async function toPdf(doc: ExportDoc, options: { style?: FileStyleProfile | null } = {}): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const layout = pdfLayout(options.style);
  const pdf = layout.format
    ? new jsPDF({ unit: "pt", format: layout.format, orientation: layout.format[0] > layout.format[1] ? "landscape" : "portrait" })
    : new jsPDF({ unit: "pt", format: "a4" });
  const width = pdf.internal.pageSize.getWidth();
  const height = pdf.internal.pageSize.getHeight();
  const { margins } = layout;
  const usable = width - margins.left - margins.right;
  let y = margins.top;
  const ensure = (space: number) => {
    if (y + space > height - margins.bottom) {
      pdf.addPage();
      y = margins.top;
    }
  };
  const write = (text: string, options: { size: number; style?: "normal" | "bold" | "italic"; font?: PdfFont; indent?: number; color?: Rgb; gap?: number; lineHeight?: number }) => {
    pdf.setFont(options.font ?? layout.body.font, options.style ?? "normal");
    pdf.setFontSize(options.size);
    pdf.setTextColor(...(options.color ?? layout.body.color));
    const indent = options.indent ?? 0;
    const lineHeight = options.size * (options.lineHeight ?? layout.body.lineHeight);
    for (const line of pdf.splitTextToSize(text || " ", usable - indent) as string[]) {
      ensure(lineHeight);
      pdf.text(line, margins.left + indent, y + options.size);
      y += lineHeight;
    }
    y += options.gap ?? 6;
  };
  const runs = (value: Run[]) => plainText(value);
  const body = layout.body;
  if (layout.title) {
    write(doc.title, { size: 22, style: "bold", gap: 10 });
    for (const [label, value] of doc.meta ?? []) write(`${label}: ${value}`, { size: 10, color: [107, 101, 92], gap: 0 });
    if (doc.meta?.length) y += 12;
  }
  const block = (item: Block) => {
    switch (item.type) {
      case "heading": {
        const heading = layout.headings[item.level];
        y += 6;
        write(runs(item.runs), { size: heading.size, style: heading.bold ? "bold" : "normal", font: heading.font, color: heading.color, lineHeight: Math.max(1.15, Math.min(body.lineHeight, 1.4)) });
        break;
      }
      case "paragraph":
        write(runs(item.runs), { size: body.size });
        break;
      case "list":
        item.items.forEach((entry, index) => write(`${item.ordered ? `${index + 1}.` : "•"}  ${runs(entry)}`, { size: body.size, indent: 12, gap: 2 }));
        y += 4;
        break;
      case "todo":
        for (const entry of item.items) write(`${entry.checked ? "[x]" : "[ ]"}  ${runs(entry.runs)}`, { size: body.size, indent: 12, gap: 2 });
        y += 4;
        break;
      case "quote":
        write(runs(item.runs), { size: body.size, style: "italic", indent: 14, color: layout.title ? [90, 85, 78] : body.color });
        break;
      case "code":
        write(item.text, { size: Math.max(7, body.size - 1.5), font: "courier", indent: 8, color: layout.title ? [60, 56, 50] : body.color });
        break;
      case "table":
        for (const row of item.rows) write(row.join("   |   "), { size: Math.max(7, body.size - 1), gap: 2 });
        y += 6;
        break;
      case "rule":
        ensure(16);
        pdf.setDrawColor(220, 214, 204);
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

/** A Word document. Apple Pages, Google Docs and LibreOffice all open it. */
export async function toDocx(doc: ExportDoc): Promise<Blob> {
  const docx = await import("docx");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType } = docx;
  const runs = (value: Run[]) =>
    value.map((run) => {
      const text = new TextRun({ text: run.text, bold: run.bold, italics: run.italic, strike: run.strike, font: run.code ? "Menlo" : undefined });
      return run.href ? new ExternalHyperlink({ link: run.href, children: [new TextRun({ text: run.text, style: "Hyperlink" })] }) : text;
    });
  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [new Paragraph({ text: doc.title, heading: HeadingLevel.TITLE })];
  for (const [label, value] of doc.meta ?? []) children.push(new Paragraph({ children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun(value)] }));
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
        children.push(new Paragraph({ children: runs(block.runs).map((run) => run), style: "IntenseQuote" }));
        break;
      case "code":
        for (const line of block.text.split("\n")) children.push(new Paragraph({ children: [new TextRun({ text: line || " ", font: "Menlo", size: 18 })] }));
        break;
      case "table":
        if (block.rows.length)
          children.push(
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: block.rows.map((row, index) => new TableRow({ children: row.map((cell) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: cell, bold: index === 0 })] })] })) })),
            }),
          );
        break;
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
