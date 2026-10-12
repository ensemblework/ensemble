/**
 * Spreadsheets in the browser: reading workbooks with SheetJS into a grid, editing
 * cells, and turning edits into what gets saved (a SheetPatch for .xlsx/.xlsm, or the
 * CSV/TSV text itself). The SheetJS module is passed in so it loads only in the viewer.
 */
import type { SheetPatch } from "@ensemble/shared-types";

export type CellValue = string | number | boolean | null;
export type SheetCell = { value: CellValue; text: string; formula?: string };
export type SheetData = {
  name: string;
  /** Row 0 is the sheet's row 1. Missing cells are null. */
  rows: Array<Array<SheetCell | null>>;
  columns: number;
  widths: number[];
  /** True when the sheet had more rows than are shown. */
  truncated: boolean;
};

export const MAX_ROWS = 50_000;
const MAX_COLUMNS = 400;

export function columnName(index: number): string {
  let name = "";
  let left = index + 1;
  while (left > 0) {
    const rest = (left - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    left = Math.floor((left - 1) / 26);
  }
  return name;
}

export function cellText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?([eE][-+]?\d+)?$|^[-+]?\.\d+$/;

/** What a typed value becomes: empty → nothing, TRUE/FALSE → yes/no, numbers (not ones with leading zeros) → numbers. */
export function parseCellInput(text: string): CellValue {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  if (NUMBER.test(trimmed) && !/^[-+]?0\d/.test(trimmed.replace(/,/g, ""))) {
    const value = Number(trimmed.replace(/,/g, ""));
    if (Number.isFinite(value)) return value;
  }
  return text;
}

const same = (a: CellValue, b: CellValue) => (a === "" ? null : a) === (b === "" ? null : b);

export type WorkingRow = { origin: number | null; values: CellValue[] };

/**
 * Edits as a SheetPatch. `original[r]` is the sheet's row r+1 as loaded. Kept rows keep
 * their original row numbers; added rows go after the last original row; deletions are
 * applied after the edits, so the coordinates all refer to the file as it was.
 */
export function buildSheetPatch(sheets: Array<{ name: string; original: CellValue[][]; rows: WorkingRow[] }>): SheetPatch {
  const out: SheetPatch = { sheets: [] };
  for (const sheet of sheets) {
    const set: NonNullable<SheetPatch["sheets"][number]["set"]> = [];
    const kept = new Set<number>();
    let added = 0;
    for (const row of sheet.rows) {
      if (row.origin === null) {
        added += 1;
        row.values.forEach((value, col) => {
          if (value !== null && value !== "") set.push({ row: sheet.original.length + added, col: col + 1, value });
        });
        continue;
      }
      kept.add(row.origin);
      const before = sheet.original[row.origin - 1] ?? [];
      const width = Math.max(before.length, row.values.length);
      for (let col = 0; col < width; col += 1) {
        const value = row.values[col] ?? null;
        if (!same(value, before[col] ?? null)) set.push({ row: row.origin, col: col + 1, value });
      }
    }
    const deleteRows: number[] = [];
    for (let origin = 1; origin <= sheet.original.length; origin += 1) if (!kept.has(origin)) deleteRows.push(origin);
    if (set.length || deleteRows.length) out.sheets.push({ name: sheet.name, ...(set.length ? { set } : {}), ...(deleteRows.length ? { deleteRows } : {}) });
  }
  return out;
}

/** RFC 4180 text: quoted fields may hold separators, quotes and line breaks. */
export function parseDelimited(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === separator) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function toDelimited(rows: CellValue[][], separator: string, newline = "\n"): string {
  const needsQuotes = new RegExp(`["\\r\\n${separator === "\t" ? "\\t" : separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]|^\\s|\\s$`);
  const trimmed = rows.map((row) => row.map((value) => cellText(value)));
  while (trimmed.length && trimmed.at(-1)!.every((value) => value === "")) trimmed.pop();
  return trimmed.map((row) => row.map((value) => (needsQuotes.test(value) ? `"${value.replace(/"/g, '""')}"` : value)).join(separator)).join(newline) + (trimmed.length ? newline : "");
}

/** CSV or TSV bytes as a grid of text cells, with what is needed to write them back the same way. */
export function readDelimited(bytes: Uint8Array, separator: string): { sheet: SheetData; bom: boolean; newline: string } {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const newline = /\r\n/.test(text.slice(0, 10_000)) ? "\r\n" : "\n";
  const parsed = parseDelimited(text, separator);
  const truncated = parsed.length > MAX_ROWS;
  const rows = parsed.slice(0, MAX_ROWS).map((row) => row.map((value) => (value === "" ? null : { value, text: value })));
  const columns = Math.min(MAX_COLUMNS, Math.max(0, ...rows.map((row) => row.length)));
  return { sheet: { name: "Sheet1", rows, columns, widths: estimateWidths(rows, columns), truncated }, bom, newline };
}

function estimateWidths(rows: Array<Array<SheetCell | null>>, columns: number, known: number[] = []): number[] {
  const widths: number[] = [];
  for (let col = 0; col < columns; col += 1) {
    if (known[col]) {
      widths.push(Math.min(360, Math.max(48, known[col]!)));
      continue;
    }
    let longest = 0;
    for (let row = 0; row < Math.min(rows.length, 200); row += 1) longest = Math.max(longest, rows[row]?.[col]?.text.length ?? 0);
    widths.push(Math.min(320, Math.max(64, longest * 7.5 + 18)));
  }
  return widths;
}

type XlsxCell = { v?: unknown; w?: string; t?: string; f?: string };
type XlsxSheet = Record<string, unknown> & { "!ref"?: string; "!fullref"?: string; "!cols"?: Array<{ wpx?: number; wch?: number } | undefined> };
type XlsxModule = {
  read: (data: Uint8Array, options: Record<string, unknown>) => { SheetNames: string[]; Sheets: Record<string, XlsxSheet> };
  utils: { decode_range: (ref: string) => { s: { r: number; c: number }; e: { r: number; c: number } }; encode_cell: (cell: { r: number; c: number }) => string };
};

/** Every sheet of a workbook (xlsx, xlsm, xls, ods, numbers) as grids of values and their displayed text. */
export function readWorkbook(XLSX: XlsxModule, bytes: Uint8Array): SheetData[] {
  const book = XLSX.read(bytes, { type: "array", cellFormula: true, cellNF: true, cellDates: false, sheetRows: MAX_ROWS + 1 });
  return book.SheetNames.map((name) => {
    const sheet = book.Sheets[name];
    const ref = sheet?.["!ref"];
    if (!sheet || !ref) return { name, rows: [], columns: 0, widths: [], truncated: false };
    const range = XLSX.utils.decode_range(ref);
    const lastRow = Math.min(range.e.r, MAX_ROWS - 1);
    const columns = Math.min(MAX_COLUMNS, range.e.c + 1);
    const rows: Array<Array<SheetCell | null>> = [];
    for (let r = 0; r <= lastRow; r += 1) {
      const row: Array<SheetCell | null> = [];
      for (let c = 0; c < columns; c += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XlsxCell | undefined;
        if (!cell || (cell.v === undefined && !cell.f)) {
          row.push(null);
          continue;
        }
        const value: CellValue = typeof cell.v === "number" || typeof cell.v === "boolean" ? cell.v : cell.v === undefined || cell.v === null ? null : String(cell.v);
        row.push({ value, text: cell.w ?? cellText(value), ...(cell.f ? { formula: cell.f } : {}) });
      }
      while (row.length && row.at(-1) === null) row.pop();
      rows.push(row);
    }
    const known = (sheet["!cols"] ?? []).map((col) => (col?.wpx ? col.wpx : col?.wch ? col.wch * 7 + 10 : 0));
    const full = sheet["!fullref"] ? XLSX.utils.decode_range(sheet["!fullref"]) : range;
    return { name, rows, columns, widths: estimateWidths(rows, columns, known), truncated: full.e.r > lastRow };
  });
}

/** A first row of short labels over rows of data reads as a header. */
export function looksLikeHeader(rows: Array<Array<SheetCell | null>>): boolean {
  const first = rows[0]?.filter(Boolean) ?? [];
  if (first.length < 2 || rows.length < 2) return false;
  return first.every((cell) => typeof cell!.value === "string" && cell!.text.length <= 60);
}
