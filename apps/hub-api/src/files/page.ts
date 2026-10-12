/**
 * Page content from a text, Markdown, code, CSV or TSV file. PDF and Word files are
 * converted in the browser instead (they send the content to POST /api/documents/:id/page).
 */
import { fileFormat, type PageDocument, type PageNode } from "@ensemble/shared-types";
import Papa from "papaparse";
import { markdownToNodes } from "../pages/markdown.js";
import { decodeStart } from "./extract.js";

/** Longest text a page made from a file keeps; the rest stays in the file. */
export const PAGE_TEXT_CHARS = 200_000;
export const PAGE_TABLE_ROWS = 200;
const CSV_PAGE_CHARS = 4_000_000;

/** True when the server can build a page from this format's text. */
export function serverPageFormat(filename: string): boolean {
  const format = fileFormat(filename);
  return format.toPage === "server" || format.ext === "csv" || format.ext === "tsv";
}

const text = (value: string): PageNode[] => (value ? [{ type: "text", text: value }] : []);

const para = (value: string): PageNode => {
  const content = text(value);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
};

function plainParagraphs(body: string): PageNode[] {
  const blocks = body.replace(/\r\n?/g, "\n").split(/\n\s*\n/).filter((block) => block.trim());
  return blocks.map((block) => {
    const lines = block.split("\n");
    const content: PageNode[] = [];
    lines.forEach((line, index) => {
      if (index) content.push({ type: "hardBreak" });
      content.push(...text(line));
    });
    return content.length ? { type: "paragraph", content } : { type: "paragraph" };
  });
}

function table(rows: string[][]): PageNode {
  const width = Math.max(1, ...rows.map((row) => row.length));
  return {
    type: "table",
    content: rows.map((row, index) => ({
      type: "tableRow",
      content: Array.from({ length: width }, (_, column) => ({
        type: index === 0 ? "tableHeader" : "tableCell",
        content: [para(row[column] ?? "")],
      })),
    })),
  };
}

/** The page a text-like file becomes, from its original bytes. */
export function pageFromFile(filename: string, bytes: Uint8Array): PageDocument {
  const format = fileFormat(filename);
  const nodes: PageNode[] = [];
  if (format.ext === "csv" || format.ext === "tsv") {
    const start = decodeStart(bytes, CSV_PAGE_CHARS);
    // The header row, the rows the page shows, and one more to know whether there are others.
    const parsed = Papa.parse<string[]>(start.text, { delimiter: format.ext === "tsv" ? "\t" : "", skipEmptyLines: "greedy", preview: PAGE_TABLE_ROWS + 2 });
    const rows = parsed.data.filter((row) => Array.isArray(row));
    // Reading stopped partway through the file, so its last row may be cut short.
    if (start.partial && rows.length <= PAGE_TABLE_ROWS + 1) rows.pop();
    const shown = rows.slice(0, PAGE_TABLE_ROWS + 1);
    if (shown.length) nodes.push(table(shown.map((row) => row.map((cell) => String(cell ?? "")))));
    if (rows.length > shown.length || start.partial) nodes.push(para(`This page shows the first ${Math.max(shown.length - 1, 0)} rows. The file has the rest.`));
    return { type: "doc", content: nodes.length ? nodes : [{ type: "paragraph" }] };
  }
  const start = decodeStart(bytes, PAGE_TEXT_CHARS);
  const cut = start.text.length > PAGE_TEXT_CHARS;
  const body = cut ? start.text.slice(0, PAGE_TEXT_CHARS) : start.text;
  if (format.kind === "code") {
    nodes.push({ type: "codeBlock", attrs: { language: format.language ?? null }, content: text(body) });
  } else if (format.ext === "md" || format.ext === "markdown") {
    nodes.push(...markdownToNodes(body));
  } else {
    nodes.push(...plainParagraphs(body));
  }
  if (cut) nodes.push(para(`This page shows the first ${PAGE_TEXT_CHARS.toLocaleString("en-US")} characters. The file has the rest.`));
  return { type: "doc", content: nodes.length ? nodes : [{ type: "paragraph" }] };
}

/** Page title from a file name: "Q3 field notes.md" → "Q3 field notes". */
export function pageTitle(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return (base.trim() || filename.trim() || "Untitled").slice(0, 200);
}
