import type { Prisma, PrismaClient } from "@prisma/client";
import {
  MAX_STORED_ROWS,
  MAX_UPLOAD_BYTES,
  PICKLE_REJECTION,
  defaultPlotConfig,
  parseTableText,
  plotConfigSchema,
  type PlotColumn,
  type PlotConfig,
} from "@ensemble/shared-types";
import { runtime } from "../lib/runtime.js";
import { readOriginal, readTable, removeDatasetFiles, writeTable, type StoredTable } from "./store.js";
import { fetchPublicTable } from "./ssrf.js";

const TEXT = new Set(["csv", "tsv", "txt", "json", "jsonl", "paste"]);
const BINARY = new Set(["xlsx", "xls", "xlsm", "ods", "numbers", "parquet", "feather"]);

export function formatFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pkl") || lower.endsWith(".pickle")) return "pickle";
  if (lower.endsWith(".numbers")) return "numbers";
  if (lower.endsWith(".parquet")) return "parquet";
  if (lower.endsWith(".feather") || lower.endsWith(".arrow")) return "feather";
  if (lower.endsWith(".xlsm")) return "xlsm";
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".xls")) return "xls";
  if (lower.endsWith(".ods")) return "ods";
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".tsv")) return "tsv";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".txt")) return "txt";
  return "csv";
}

type Parsed = {
  columns: PlotColumn[];
  rows: Array<Array<string | number | null>>;
  warnings: string[];
  sheets: string[];
  sheet: string;
};

async function parseBytes(filename: string, bytes: Uint8Array, sheet?: string): Promise<Parsed> {
  const format = formatFromName(filename);
  if (format === "pickle") throw Object.assign(new Error(PICKLE_REJECTION), { statusCode: 400 });
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw Object.assign(new Error("That file is larger than 32 MB."), { statusCode: 400 });
  if (TEXT.has(format) || format === "csv") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const parsed = parseTableText(text, format === "paste" ? "paste" : (format as "csv"), undefined);
    return { columns: parsed.columns, rows: parsed.rows, warnings: parsed.warnings, sheets: [], sheet: "" };
  }
  if (!BINARY.has(format)) throw Object.assign(new Error("That file type is not supported."), { statusCode: 400 });
  const result = await runtime<{
    columns: PlotColumn[];
    rows: Array<Array<string | number | null>>;
    warnings?: string[];
    sheets?: string[];
    sheet?: string;
  }>("/api/plots/parse", {
    method: "POST",
    timeoutMs: 60_000,
    json: { filename, contentBase64: Buffer.from(bytes).toString("base64"), sheet: sheet ?? "" },
  });
  return {
    columns: result.columns,
    rows: result.rows.slice(0, MAX_STORED_ROWS),
    warnings: result.warnings ?? [],
    sheets: result.sheets ?? [],
    sheet: result.sheet ?? "",
  };
}

export async function ingestDataset(
  prisma: PrismaClient,
  userId: string,
  input: {
    name?: string;
    filename?: string;
    text?: string;
    url?: string;
    sheet?: string;
    fileBase64?: string;
    columns?: PlotColumn[];
    rows?: Array<Array<string | number | null>>;
    delimiter?: string;
  },
): Promise<{ id: string; name: string; columns: PlotColumn[]; rowCount: number; warnings: string[]; sheets: string[]; sheet: string; format: string }> {
  let bytes: Uint8Array | undefined;
  let filename = input.filename || "pasted.csv";
  let warnings: string[] = [];
  if (input.url) {
    const fetched = await fetchPublicTable(input.url);
    bytes = fetched.bytes;
    filename = fetched.filename;
  } else if (input.fileBase64) {
    bytes = Buffer.from(input.fileBase64, "base64");
  } else if (input.text !== undefined) {
    bytes = new TextEncoder().encode(input.text);
    if (!input.filename) filename = input.text.trim().startsWith("{") || input.text.trim().startsWith("[") ? "pasted.json" : "pasted.csv";
  }

  let table: StoredTable;
  let sheets: string[] = [];
  let sheet = input.sheet ?? "";
  let format = formatFromName(filename);
  if (input.columns && input.rows && !bytes) {
    table = { columns: input.columns, rows: input.rows.slice(0, MAX_STORED_ROWS) };
    format = "table";
    if (input.rows.length > MAX_STORED_ROWS) warnings.push(`Kept the first ${MAX_STORED_ROWS.toLocaleString()} rows.`);
  } else if (!bytes) {
    throw Object.assign(new Error("Add a file, a paste, or a link."), { statusCode: 400 });
  } else {
    const parsed = await parseBytes(filename, bytes, input.sheet);
    table = { columns: parsed.columns, rows: parsed.rows };
    warnings = parsed.warnings;
    sheets = parsed.sheets;
    sheet = parsed.sheet;
  }
  if (!table.columns.length) throw Object.assign(new Error(warnings[0] || "Nothing to plot in that file."), { statusCode: 400 });
  const name = (input.name || filename.replace(/\.[^.]+$/, "") || "Dataset").slice(0, 200);
  const row = await prisma.plotDataset.create({
    data: {
      userId,
      name,
      format,
      columns: table.columns as unknown as Prisma.InputJsonValue,
      rowCount: table.rows.length,
      byteSize: bytes?.byteLength ?? Buffer.byteLength(JSON.stringify(table.rows)),
      contentHash: "pending",
      sheet,
      sheets,
    },
  });
  const hash = writeTable(userId, row.id, table, bytes);
  await prisma.plotDataset.update({ where: { id: row.id }, data: { contentHash: hash } });
  return { id: row.id, name, columns: table.columns, rowCount: table.rows.length, warnings, sheets, sheet, format };
}

export async function ownedDataset(prisma: PrismaClient, userId: string, id: string) {
  const row = await prisma.plotDataset.findFirst({ where: { id, userId, deletedAt: null } });
  if (!row) throw Object.assign(new Error("That dataset is not on your account."), { statusCode: 404 });
  return row;
}

export async function ownedPlot(prisma: PrismaClient, userId: string, id: string) {
  const row = await prisma.plot.findFirst({ where: { id, userId, deletedAt: null } });
  if (!row) throw Object.assign(new Error("That plot is not on your account."), { statusCode: 404 });
  return row;
}

export function configOf(value: unknown): PlotConfig {
  const parsed = plotConfigSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : defaultPlotConfig();
}

export async function loadOwnedTable(prisma: PrismaClient, userId: string, datasetId: string): Promise<{ name: string; table: StoredTable; hash: string; sheet: string; sheets: string[] }> {
  const row = await ownedDataset(prisma, userId, datasetId);
  const table = readTable(userId, row.id, row.contentHash);
  return { name: row.name, table, hash: row.contentHash, sheet: row.sheet, sheets: Array.isArray(row.sheets) ? (row.sheets as string[]) : [] };
}

export async function reparseSheet(prisma: PrismaClient, userId: string, datasetId: string, sheet: string) {
  const row = await ownedDataset(prisma, userId, datasetId);
  const original = readOriginal(userId, datasetId);
  if (!original) throw Object.assign(new Error("The original file is not kept for this dataset, so the sheet cannot be changed."), { statusCode: 400 });
  const parsed = await parseBytes(`${row.name}.${row.format}`, original, sheet);
  const hash = writeTable(userId, row.id, { columns: parsed.columns, rows: parsed.rows }, original);
  await prisma.plotDataset.update({
    where: { id: row.id },
    data: { columns: parsed.columns as unknown as Prisma.InputJsonValue, rowCount: parsed.rows.length, contentHash: hash, sheet: parsed.sheet || sheet, sheets: parsed.sheets },
  });
  return { columns: parsed.columns, rowCount: parsed.rows.length, sheet: parsed.sheet || sheet, warnings: parsed.warnings };
}

export async function deleteDataset(prisma: PrismaClient, userId: string, id: string) {
  await ownedDataset(prisma, userId, id);
  await prisma.plotDataset.update({ where: { id }, data: { deletedAt: new Date() } });
  removeDatasetFiles(userId, id);
}
