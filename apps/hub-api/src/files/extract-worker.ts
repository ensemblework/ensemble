import { replaceOfficeText } from "./office-edit.js";
/**
 * Runs inside a worker thread with its own memory cap (files/extract.ts starts it):
 * text out of PDF and Office files, and cell edits saved into an .xlsx. A file
 * that is too large or too complex can only take this thread down, not the API.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { SheetPatch } from "@ensemble/shared-types";
import ExcelJS from "exceljs";
import { unzipSync } from "fflate";
import { docxText, pptxSlides } from "../lib/office/extract.js";
import { rowsToCsv } from "../lib/office/xlsx.js";
import { xlsxPreview } from "./xlsx-text.js";

export type WorkerJob =
  | { task: "text"; kind: "pdf" | "docx" | "pptx" | "xlsx"; bytes: Uint8Array; maxChars: number }
  | { task: "cells"; bytes: Uint8Array; patch: SheetPatch }
  | { task: "office-edit"; kind: "docx" | "pptx"; bytes: Uint8Array; find: string; replacement: string };

export type WorkerText = { text: string; pageCount: number | null; warnings: string[] };
export type WorkerReply =
  | { ok: true; text?: WorkerText; bytes?: Uint8Array }
  /** "exposed": a message meant for the person; the rest are summarized by the caller. */
  | { ok: false; reason: "exposed" | "timeout" | "memory" | "crash"; message: string };

export const PDF_MAX_PAGES = 300;
export const SHEET_MAX_ROWS = 2000;

export class ExposedError extends Error {}

async function pdfText(bytes: Uint8Array, maxChars: number): Promise<WorkerText> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes, disableFontFace: true, useSystemFonts: false, stopAtErrors: false, verbosity: 0 });
  try {
    const doc = await task.promise.catch((error: unknown) => {
      if (error instanceof Error && error.name === "PasswordException") throw new ExposedError("This PDF is password-protected, so agents cannot read it.");
      throw new ExposedError("This PDF could not be opened (it may be damaged), so agents cannot read it.");
    });
    const warnings: string[] = [];
    const pages = Math.min(doc.numPages, PDF_MAX_PAGES);
    if (doc.numPages > PDF_MAX_PAGES) warnings.push(`Agents can read the first ${PDF_MAX_PAGES} pages of this PDF.`);
    const parts: string[] = [];
    let length = 0;
    let readable = 0;
    for (let number = 1; number <= pages && length < maxChars; number += 1) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        if (item.hasEOL) text += "\n";
        else if (item.str && !/\s$/.test(item.str)) text += " ";
      }
      page.cleanup();
      text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      readable += text.replace(/\s/g, "").length;
      const part = `--- Page ${number} ---\n${text}`;
      parts.push(part);
      length += part.length + 2;
    }
    if (!readable) return { text: "", pageCount: doc.numPages, warnings: ["This PDF has no text layer (scanned?), so agents cannot read it."] };
    return { text: parts.join("\n\n"), pageCount: doc.numPages, warnings };
  } finally {
    await task.destroy();
  }
}

function sheetText(bytes: Uint8Array): WorkerText {
  const sheets = xlsxPreview(bytes, SHEET_MAX_ROWS);
  const warnings = sheets.some((sheet) => sheet.more) ? [`Agents can read the first ${SHEET_MAX_ROWS.toLocaleString("en-US")} rows of each sheet.`] : [];
  const parts = sheets.map((sheet, index) => {
    let rows = sheet.rows;
    while (rows.length && rows[rows.length - 1]!.every((cell) => cell === "")) rows = rows.slice(0, -1);
    return `--- Sheet ${index + 1}: ${sheet.name} ---\n${rowsToCsv(rows)}`;
  });
  return { text: parts.join("\n\n"), pageCount: sheets.length, warnings };
}

function slideText(bytes: Uint8Array): WorkerText {
  const slides = pptxSlides(bytes);
  const text = slides
    .map((slide) =>
      [
        `--- Slide ${slide.index}${slide.title ? `: ${slide.title}` : ""} ---`,
        ...slide.body.map((line) => `${/^\s*/.exec(line)![0]}- ${line.trim()}`),
        slide.notes ? `Notes: ${slide.notes}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return { text, pageCount: slides.length, warnings: [] };
}

export async function extractInThread(kind: "pdf" | "docx" | "pptx" | "xlsx", bytes: Uint8Array, maxChars: number): Promise<WorkerText> {
  if (kind === "pdf") return pdfText(bytes, maxChars);
  if (kind === "docx") return { text: docxText(bytes), pageCount: null, warnings: [] };
  if (kind === "pptx") return slideText(bytes);
  return sheetText(bytes);
}

function cellValue(value: string | number | boolean | null): ExcelJS.CellValue {
  if (typeof value === "string" && value.startsWith("=") && value.length > 1) return { formula: value.slice(1) };
  return value;
}

/** Parts of a workbook exceljs does not write back. Saving cells would silently drop them. */
const LOST_PARTS: Array<[RegExp, string]> = [
  [/^xl\/(charts|chartsheets)\//, "charts"],
  [/^xl\/(pivotTables|pivotCache)\//, "pivot tables"],
  [/^xl\/(slicers|slicerCaches|timelines)\//, "slicers"],
  [/^xl\/vbaProject\.bin$/, "macros"],
  [/^xl\/(activeX|ctrlProps)\//, "form controls"],
  [/^xl\/(comments\d*\.xml|threadedComments\/)/, "comments"],
  [/^xl\/externalLinks\//, "links to other workbooks"],
];

export function partsCellEditsWouldLose(bytes: Uint8Array): string[] {
  const found = new Set<string>();
  unzipSync(bytes, {
    filter(file) {
      for (const [pattern, label] of LOST_PARTS) if (pattern.test(file.name)) found.add(label);
      return false;
    },
  });
  return [...found];
}

const list = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

const REF =
  /"(?:[^"]|"")*"|(?<![\w.$'!])((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?(\$?[A-Z]{1,3}\$?)(\d+)(?::(\$?[A-Z]{1,3}\$?)(\d+))?(?![\w(!])/g;

/**
 * A formula after rows are removed from `sheet`, the way Excel rewrites it: references below a
 * removed row move up, ranges shrink, and a reference to a removed cell becomes #REF!.
 * `removed` is sorted ascending, in the numbering before the removal.
 */
export function shiftFormula(formula: string, sheet: string, onSheet: boolean, removed: readonly number[]): string {
  const before = (row: number, inclusive: boolean) => {
    let low = 0;
    let high = removed.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (inclusive ? removed[mid]! <= row : removed[mid]! < row) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  return formula.replace(REF, (match, prefix: string | undefined, column: string, rowText: string, column2: string | undefined, row2Text: string | undefined) => {
    if (match.startsWith('"') || column === undefined) return match;
    const named = prefix ? prefix.slice(0, -1).replace(/^'|'$/g, "").replace(/''/g, "'") : null;
    if (named ? named.toLowerCase() !== sheet.toLowerCase() : !onSheet) return match;
    const row = Number(rowText);
    if (row2Text === undefined) {
      if (before(row, true) !== before(row, false)) return "#REF!";
      return `${prefix ?? ""}${column}${row - before(row, false)}`;
    }
    const [low, high] = row <= Number(row2Text) ? [row, Number(row2Text)] : [Number(row2Text), row];
    const start = low - before(low, false);
    const end = high - before(high, true);
    if (end < start) return "#REF!";
    return `${prefix ?? ""}${column}${start}:${column2}${end}`;
  });
}

type Formula = { formula: string; result?: unknown };

/** Sets cells and removes rows in the workbook itself, so formatting and every other cell stay as they were. */
export async function patchInThread(bytes: Uint8Array, patch: SheetPatch): Promise<Uint8Array> {
  const lost = partsCellEditsWouldLose(bytes);
  if (lost.length) {
    throw new ExposedError(`Saving cells here would drop this workbook's ${list(lost)}. Edit it in Excel, or make a copy without them to edit it here.`);
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  } catch {
    throw new ExposedError("This workbook could not be opened. It may be damaged.");
  }
  for (const edit of patch.sheets) {
    const sheet = workbook.getWorksheet(edit.name);
    if (!sheet) throw new ExposedError(`This workbook has no sheet named “${edit.name}”.`);
    for (const cell of edit.set ?? []) sheet.getCell(cell.row, cell.col).value = cellValue(cell.value);
  }
  const removals = patch.sheets.filter((edit) => edit.deleteRows?.length);
  if (removals.length) {
    const formulas: Array<{ cell: ExcelJS.Cell; sheet: string; value: Formula }> = [];
    workbook.eachSheet((worksheet) =>
      worksheet.eachRow((row) =>
        row.eachCell((cell) => {
          const value = cell.value;
          if (!value || typeof value !== "object" || !("formula" in value || "sharedFormula" in value)) return;
          // A shared formula is stored once and read relative to each cell; keep each cell's own copy so rows can move.
          formulas.push({ cell, sheet: worksheet.name, value: { formula: cell.formula, result: (value as { result?: unknown }).result } });
        }),
      ),
    );
    for (const edit of removals) {
      const removed = [...new Set(edit.deleteRows)].sort((a, b) => a - b);
      for (const item of formulas) item.value.formula = shiftFormula(item.value.formula, edit.name, item.sheet === edit.name, removed);
    }
    for (const item of formulas) item.cell.value = item.value as ExcelJS.CellValue;
    for (const edit of removals) {
      const sheet = workbook.getWorksheet(edit.name)!;
      for (const row of [...new Set(edit.deleteRows)].sort((a, b) => b - a)) sheet.spliceRows(row, 1);
    }
  }
  // Cached results of formulas that read the edited cells are stale; Excel recalculates on open.
  workbook.calcProperties.fullCalcOnLoad = true;
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

async function run(job: WorkerJob): Promise<WorkerReply> {
  try {
    if (job.task === "office-edit") { try { return { ok: true, bytes: replaceOfficeText(job.bytes, job.kind, job.find, job.replacement) }; } catch (error) { throw new ExposedError(error instanceof Error ? error.message : "The edit failed."); } }
    if (job.task === "cells") return { ok: true, bytes: await patchInThread(job.bytes, job.patch) };
    return { ok: true, text: await extractInThread(job.kind, job.bytes, job.maxChars) };
  } catch (error) {
    return { ok: false, reason: error instanceof ExposedError ? "exposed" : "crash", message: error instanceof Error ? error.message : String(error) };
  }
}

if (parentPort && workerData) {
  const port = parentPort;
  void run(workerData as WorkerJob).then((reply) => {
    port.postMessage(reply, reply.ok && reply.bytes ? [reply.bytes.buffer as ArrayBuffer] : []);
  });
}
