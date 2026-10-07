/**
 * Text out of Office files, server-side and without running anything in them.
 *
 * .docx and .pptx are zip files of XML; fflate (MIT) unzips them and the XML is
 * read with a small tag scanner. .xlsx goes through exceljs. Each extractor
 * returns Markdown-like text so a model can quote headings, bullets and tables.
 */
import { strFromU8, unzipSync, type Unzipped } from "fflate";
import { rowsToCsv, xlsxToRows } from "./xlsx.js";

const MAX_UNZIPPED_BYTES = 40 * 1024 * 1024;

export type OfficeKind = "docx" | "xlsx" | "pptx";

export function officeKind(name: string, mimeType?: string | null): OfficeKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".docx") || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (lower.endsWith(".xlsx") || mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (lower.endsWith(".pptx") || mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  return null;
}

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_all, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

function unzip(data: Uint8Array, wanted: (name: string) => boolean): Unzipped {
  let total = 0;
  return unzipSync(data, {
    filter(file) {
      if (!wanted(file.name)) return false;
      total += file.originalSize;
      if (total > MAX_UNZIPPED_BYTES) throw new Error("That file is too large to read.");
      return true;
    },
  });
}

const attribute = (attrs: string, name: string): string | undefined => {
  const match = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return match ? decodeXml(match[1]!) : undefined;
};

const TAG = /<(\/?)([A-Za-z0-9_:]+)([^>]*?)(\/?)>|([^<]+)/g;

/** Paragraphs from WordprocessingML, with headings, list items and table rows marked. */
export function docxXmlToText(xml: string): string {
  const lines: string[] = [];
  let paragraph: string | null = null;
  let prefix = "";
  let inText = false;
  let tableDepth = 0;
  let cell: string[] = [];
  let row: string[] = [];
  for (const match of xml.matchAll(TAG)) {
    const [, closing, name, attrs = "", selfClosing, text] = match;
    if (text !== undefined) {
      if (inText && paragraph !== null) paragraph += decodeXml(text);
      continue;
    }
    if (name === "w:t") {
      inText = !closing && !selfClosing;
    } else if (name === "w:p") {
      if (!closing && !selfClosing) {
        paragraph = "";
        prefix = "";
      } else if (closing && paragraph !== null) {
        const line = `${prefix}${paragraph}`.trimEnd();
        if (tableDepth > 0) cell.push(paragraph.trim());
        else lines.push(line);
        paragraph = null;
      }
    } else if (name === "w:pStyle" && paragraph !== null) {
      const style = attribute(attrs, "w:val") ?? "";
      const heading = /^(?:Heading|heading)\s?([1-6])$/.exec(style);
      if (heading) prefix = `${"#".repeat(Number(heading[1]))} `;
      else if (/^Title$/i.test(style)) prefix = "# ";
      else if (/List/i.test(style) && !prefix) prefix = "- ";
    } else if (name === "w:numPr" && paragraph !== null && !closing) {
      if (!prefix.startsWith("#")) prefix = "- ";
    } else if (name === "w:ilvl" && paragraph !== null && !prefix.startsWith("#")) {
      prefix = `${"  ".repeat(Math.min(Number(attribute(attrs, "w:val") ?? 0) || 0, 5))}- `;
    } else if ((name === "w:tab" || name === "w:ptab") && paragraph !== null) {
      paragraph += "\t";
    } else if ((name === "w:br" || name === "w:cr") && paragraph !== null) {
      paragraph += "\n";
    } else if (name === "w:tbl") {
      tableDepth += closing ? -1 : 1;
      if (closing && tableDepth === 0) lines.push("");
    } else if (name === "w:tc" && closing && tableDepth === 1) {
      row.push(cell.filter(Boolean).join(" ").replace(/\|/g, "\\|"));
      cell = [];
    } else if (name === "w:tr" && closing && tableDepth === 1) {
      lines.push(`| ${row.join(" | ")} |`);
      row = [];
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function docxText(data: Uint8Array): string {
  const files = unzip(data, (name) => name === "word/document.xml");
  const document = files["word/document.xml"];
  if (!document) throw new Error("That does not look like a Word document.");
  return docxXmlToText(strFromU8(document));
}

/** Text of one DrawingML shape tree, by shape, with the placeholder type of each shape. */
function shapes(xml: string): Array<{ placeholder: string | null; paragraphs: string[] }> {
  const out: Array<{ placeholder: string | null; paragraphs: string[] }> = [];
  for (const shape of xml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g) ?? []) {
    const ph = /<p:ph\b([^>]*)\/?>/.exec(shape);
    const placeholder = ph ? attribute(ph[1] ?? "", "type") ?? "body" : null;
    const paragraphs: string[] = [];
    for (const paragraph of shape.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? []) {
      const level = Number(attribute(/<a:pPr\b([^>]*)/.exec(paragraph)?.[1] ?? "", "lvl") ?? 0);
      const text = [...paragraph.matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:br\s*\/>/g)]
        .map((part) => (part[1] === undefined ? "\n" : decodeXml(part[1])))
        .join("");
      if (text.trim()) paragraphs.push(`${"  ".repeat(Math.min(level, 4))}${text}`);
    }
    out.push({ placeholder, paragraphs });
  }
  return out;
}

function relationships(xml: string | undefined): Map<string, { type: string; target: string }> {
  const map = new Map<string, { type: string; target: string }>();
  for (const match of (xml ?? "").matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attribute(match[1] ?? "", "Id");
    const target = attribute(match[1] ?? "", "Target");
    if (id && target) map.set(id, { type: attribute(match[1] ?? "", "Type") ?? "", target });
  }
  return map;
}

const resolvePart = (base: string, target: string): string => {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const piece of target.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece !== ".") parts.push(piece);
  }
  return parts.join("/");
};

export interface SlideText {
  index: number;
  title: string;
  body: string[];
  notes: string;
}

export function pptxSlides(data: Uint8Array): SlideText[] {
  const files = unzip(data, (name) => name.startsWith("ppt/") && name.endsWith(".xml") || name.endsWith(".rels"));
  const read = (name: string) => (files[name] ? strFromU8(files[name]!) : undefined);
  const presentation = read("ppt/presentation.xml");
  if (!presentation) throw new Error("That does not look like a PowerPoint file.");
  const rels = relationships(read("ppt/_rels/presentation.xml.rels"));
  let order = [...presentation.matchAll(/<p:sldId\b([^>]*)\/?>/g)]
    .map((match) => rels.get(attribute(match[1] ?? "", "r:id") ?? "")?.target)
    .filter((target): target is string => Boolean(target))
    .map((target) => resolvePart("ppt/presentation.xml", target));
  if (!order.length) {
    order = Object.keys(files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  }
  return order.map((part, index) => {
    const slide = shapes(read(part) ?? "").filter((shape) => shape.paragraphs.length);
    // Decks without placeholders (most generated ones) put the title in the first text box.
    const titleShape = slide.find((shape) => shape.placeholder === "title" || shape.placeholder === "ctrTitle") ?? slide[0];
    const body = slide.filter((shape) => shape !== titleShape).flatMap((shape) => shape.paragraphs);
    const slideRels = relationships(read(part.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels")));
    const notesTarget = [...slideRels.values()].find((rel) => rel.type.endsWith("/notesSlide"))?.target;
    const notesXml = notesTarget ? read(resolvePart(part, notesTarget)) : undefined;
    const notes = notesXml
      ? shapes(notesXml)
          .filter((shape) => shape.placeholder === "body")
          .flatMap((shape) => shape.paragraphs)
          .join("\n")
      : "";
    return {
      index: index + 1,
      title: titleShape?.paragraphs.join(" ").trim() ?? "",
      body,
      notes: notes.trim(),
    };
  });
}

export function slidesToText(slides: readonly SlideText[]): string {
  return slides
    .map((slide) =>
      [
        `## Slide ${slide.index}${slide.title ? `: ${slide.title}` : ""}`,
        ...slide.body.map((line) => `${/^\s*/.exec(line)![0]}- ${line.trim()}`),
        slide.notes ? `Notes: ${slide.notes}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

export async function xlsxText(data: Uint8Array, maxRows = 200): Promise<string> {
  const sheets = await xlsxToRows(data, maxRows);
  return sheets.map((sheet) => `## ${sheet.name}\n${rowsToCsv(sheet.rows)}`).join("\n\n");
}

/** Text of a .docx, .xlsx or .pptx file. */
export async function officeText(kind: OfficeKind, data: Uint8Array): Promise<string> {
  if (kind === "docx") return docxText(data);
  if (kind === "pptx") return slidesToText(pptxSlides(data));
  return xlsxText(data);
}
