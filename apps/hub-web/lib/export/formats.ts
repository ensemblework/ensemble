"use client";

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

export function fileSlug(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "untitled";
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

/** A PDF with real, selectable text: headings, paragraphs, lists, to-dos, quotes, code, tables. */
export async function toPdf(doc: ExportDoc): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  const width = pdf.internal.pageSize.getWidth();
  const height = pdf.internal.pageSize.getHeight();
  const margin = 56;
  const usable = width - margin * 2;
  let y = margin;
  const ensure = (space: number) => {
    if (y + space > height - margin) {
      pdf.addPage();
      y = margin;
    }
  };
  const write = (text: string, options: { size: number; style?: "normal" | "bold" | "italic"; font?: "helvetica" | "courier"; indent?: number; color?: [number, number, number]; gap?: number }) => {
    pdf.setFont(options.font ?? "helvetica", options.style ?? "normal");
    pdf.setFontSize(options.size);
    pdf.setTextColor(...(options.color ?? [28, 25, 21]));
    const indent = options.indent ?? 0;
    const lineHeight = options.size * 1.4;
    for (const line of pdf.splitTextToSize(text || " ", usable - indent) as string[]) {
      ensure(lineHeight);
      pdf.text(line, margin + indent, y + options.size);
      y += lineHeight;
    }
    y += options.gap ?? 6;
  };
  const runs = (value: Run[]) => plainText(value);
  write(doc.title, { size: 22, style: "bold", gap: 10 });
  for (const [label, value] of doc.meta ?? []) write(`${label}: ${value}`, { size: 10, color: [107, 101, 92], gap: 0 });
  if (doc.meta?.length) y += 12;
  const block = (item: Block) => {
    switch (item.type) {
      case "heading":
        y += 6;
        write(runs(item.runs), { size: item.level === 1 ? 17 : item.level === 2 ? 14.5 : 12.5, style: "bold" });
        break;
      case "paragraph":
        write(runs(item.runs), { size: 11 });
        break;
      case "list":
        item.items.forEach((entry, index) => write(`${item.ordered ? `${index + 1}.` : "•"}  ${runs(entry)}`, { size: 11, indent: 12, gap: 2 }));
        y += 4;
        break;
      case "todo":
        for (const entry of item.items) write(`${entry.checked ? "[x]" : "[ ]"}  ${runs(entry.runs)}`, { size: 11, indent: 12, gap: 2 });
        y += 4;
        break;
      case "quote":
        write(runs(item.runs), { size: 11, style: "italic", indent: 14, color: [90, 85, 78] });
        break;
      case "code":
        write(item.text, { size: 9.5, font: "courier", indent: 8, color: [60, 56, 50] });
        break;
      case "table":
        for (const row of item.rows) write(row.join("   |   "), { size: 10, gap: 2 });
        y += 6;
        break;
      case "rule":
        ensure(16);
        pdf.setDrawColor(220, 214, 204);
        pdf.line(margin, y + 6, width - margin, y + 6);
        y += 16;
        break;
    }
  };
  for (const item of doc.blocks) block(item);
  return pdf.output("blob");
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

export async function downloadDocument(doc: ExportDoc, format: DocFormat): Promise<void> {
  const { blob, name } = await renderDocument(doc, format);
  saveBlob(blob, name);
}
