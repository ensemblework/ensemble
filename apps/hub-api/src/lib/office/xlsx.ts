/** Rows ↔ .xlsx (npm `exceljs`, MIT). */
import ExcelJS from "exceljs";

export type CellInput = string | number | boolean | null;

export interface SheetInput {
  name?: string;
  headers?: readonly string[];
  rows: ReadonlyArray<ReadonlyArray<CellInput>>;
}

export interface SheetRows {
  name: string;
  rows: CellInput[][];
}

/** Excel refuses names over 31 characters and these seven characters. */
export function safeSheetName(name: string | undefined, index: number, taken: Set<string>): string {
  const base = (name ?? "").replace(/[\\/?*[\]:]/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31) || `Sheet${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate.toLowerCase())) {
    const tail = ` (${suffix})`;
    candidate = `${base.slice(0, 31 - tail.length)}${tail}`;
    suffix += 1;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

function cellValue(value: CellInput): ExcelJS.CellValue {
  if (typeof value === "string" && value.startsWith("=") && value.length > 1) return { formula: value.slice(1) };
  return value;
}

export async function rowsToXlsx(sheets: readonly SheetInput[], title = ""): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Ensemble";
  if (title) workbook.title = title;
  const taken = new Set<string>();
  sheets.forEach((sheet, index) => {
    const worksheet = workbook.addWorksheet(safeSheetName(sheet.name, index, taken));
    const widths: number[] = [];
    const measure = (row: ReadonlyArray<CellInput>) =>
      row.forEach((value, column) => {
        widths[column] = Math.max(widths[column] ?? 0, String(value ?? "").length);
      });
    if (sheet.headers?.length) {
      const header = worksheet.addRow([...sheet.headers]);
      header.font = { bold: true };
      worksheet.views = [{ state: "frozen", ySplit: 1 }];
      measure(sheet.headers);
    }
    for (const row of sheet.rows) {
      worksheet.addRow(row.map(cellValue));
      measure(row);
    }
    widths.forEach((width, column) => {
      worksheet.getColumn(column + 1).width = Math.min(Math.max(width + 2, 8), 60);
    });
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

function plainCell(value: ExcelJS.CellValue): CellInput {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString().replace(/T00:00:00\.000Z$/, "");
  if ("richText" in value) return value.richText.map((piece) => piece.text).join("");
  if ("hyperlink" in value) return value.text;
  if ("error" in value) return value.error;
  if ("result" in value && value.result !== undefined) {
    const result = value.result;
    if (result instanceof Date) return result.toISOString();
    if (typeof result === "object") return result.error;
    return result;
  }
  if ("formula" in value && value.formula) return `=${value.formula}`;
  return null;
}

export async function xlsxToRows(data: Buffer | Uint8Array, maxRows = 500): Promise<SheetRows[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(data) as unknown as ExcelJS.Buffer);
  const sheets: SheetRows[] = [];
  workbook.eachSheet((worksheet) => {
    const rows: CellInput[][] = [];
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (rowNumber > maxRows) return;
      const values: CellInput[] = [];
      row.eachCell({ includeEmpty: true }, (cell, column) => {
        values[column - 1] = plainCell(cell.value);
      });
      for (let index = 0; index < values.length; index += 1) if (values[index] === undefined) values[index] = null;
      rows[rowNumber - 1] = values;
    });
    for (let index = 0; index < rows.length; index += 1) if (!rows[index]) rows[index] = [];
    sheets.push({ name: worksheet.name, rows });
  });
  return sheets;
}

const csvCell = (value: CellInput): string => {
  const text = value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const rowsToCsv = (rows: ReadonlyArray<ReadonlyArray<CellInput>>): string => rows.map((row) => row.map(csvCell).join(",")).join("\n");
