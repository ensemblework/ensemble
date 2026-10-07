/**
 * Uploaded exports: CSV/TSV (with presets for Notion, Asana, Todoist, Jira,
 * Linear and ClickUp), Trello JSON, and Notion "Markdown & CSV" zips.
 */
import { createHash } from "node:crypto";
import { stripNotionId } from "../mapping.js";
import { ImportError, type ImportContainer, type ImportItem, type ImportSourceId } from "../types.js";
import { csvItems, detectPreset, parseCsv, PRESET_LABEL, proposeMapping, type CsvItemOptions, type CsvMapping, type CsvPreset, type CsvTable } from "./csv.js";
import { parseNotionExport, readNotionZip } from "./notion-zip.js";
import { parseTrelloExport, trelloContainer, trelloItems } from "./trello.js";
import { isZip } from "./zip.js";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface FileTable {
  container: ImportContainer;
  table: CsvTable;
  preset: CsvPreset;
  mapping: CsvMapping;
  options: Omit<CsvItemOptions, "containerId">;
}

export interface ParsedUpload {
  format: "csv" | "trello-json" | "notion-zip";
  formatLabel: string;
  /** external_source for written rows. */
  externalSource: string;
  source: ImportSourceId;
  containers: ImportContainer[];
  tables: FileTable[];
  /** Items that need no column mapping (Trello cards, Notion pages). */
  items: ImportItem[];
}

const PRESET_SOURCE: Record<CsvPreset, ImportSourceId> = {
  notion: "notion",
  asana: "asana",
  todoist: "todoist",
  jira: "jira",
  linear: "linear",
  clickup: "clickup",
  generic: "csv",
};

/** UTF-8 first; UTF-16 when there is a BOM (Excel "Unicode text"); Windows-1252 when UTF-8 clearly fails. */
export function decodeText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data.subarray(2));
  const text = new TextDecoder("utf-8").decode(data);
  const broken = (text.match(/\uFFFD/g) ?? []).length;
  if (broken > 3 && broken > text.length / 1000) return new TextDecoder("windows-1252").decode(data);
  return text;
}

const fileKey = (name: string) => `file-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;

/** "Q3 roadmap (1) 2026-10-07.csv" and "Q3 roadmap.csv" are the same sheet downloaded twice. */
export function sheetName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).replace(/\.(csv|tsv|txt)$/i, "");
  return stripNotionId(base)
    .replace(/_all$/i, "")
    .replace(/\d{4}[-_.]?\d{2}[-_.]?\d{2}(?:[T _-]?\d{1,2}[-_.:h]?\d{2}(?:[-_.:m]?\d{2})?(?:\.\d+)?z?)?/gi, " ")
    .replace(/\s*\(\d+\)\s*/g, " ")
    .replace(/^copy of\s+/i, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Namespace for a sheet's own ID column: the same export downloaded again maps
 * to the same key, a different sheet (other name or other columns) does not.
 */
export function sheetIdNamespace(name: string, headers: string[]): string {
  const columns = headers.map((header) => header.trim().toLowerCase()).join("\u0001");
  return `sheet-${createHash("sha256").update(`${sheetName(name)}\u0000${columns}`).digest("hex").slice(0, 16)}`;
}

function displayName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return stripNotionId(base.replace(/\.(csv|tsv|txt|json|zip)$/i, "")).replace(/_all$/, "") || "Imported file";
}

export function parseUpload(name: string, data: Uint8Array, hint: ImportSourceId): ParsedUpload {
  if (!data.length) throw new ImportError("That file is empty.");
  if (data.length > MAX_UPLOAD_BYTES) throw new ImportError("That file is larger than 50 MB. Export a smaller part and import each.", 413);
  if (isZip(data)) {
    const exported = parseNotionExport(readNotionZip(data));
    const containers = [...exported.databases.map((db) => db.container), ...(exported.pagesContainer ? [exported.pagesContainer] : [])];
    if (!containers.length) throw new ImportError("Nothing to import was found in that zip.");
    return {
      format: "notion-zip",
      formatLabel: "Notion export (Markdown & CSV)",
      externalSource: "notion",
      source: "notion",
      containers,
      tables: exported.databases.map((db) => ({ container: db.container, table: db.table, preset: "notion", mapping: db.mapping, options: db.options })),
      items: exported.pages,
    };
  }
  const text = decodeText(data);
  const trimmed = text.trimStart();
  if (/\.json$/i.test(name) || trimmed.startsWith("{")) {
    const board = parseTrelloExport(text);
    const container = trelloContainer(board);
    return {
      format: "trello-json",
      formatLabel: "Trello board export (JSON)",
      externalSource: "trello",
      source: "trello",
      containers: [container],
      tables: [],
      items: trelloItems(board),
    };
  }
  const table = parseCsv(text);
  const preset = detectPreset(table.headers, hint);
  const title = displayName(name);
  const container: ImportContainer = { id: fileKey(name), name: title, kind: "file", count: table.rows.length, importAs: "tasks" };
  const projectForFile = preset === "todoist" || preset === "notion";
  const localIds = preset === "generic" || preset === "notion";
  return {
    format: "csv",
    formatLabel: PRESET_LABEL[preset],
    externalSource: PRESET_SOURCE[preset],
    source: PRESET_SOURCE[preset],
    containers: [container],
    tables: [
      {
        container,
        table,
        preset,
        mapping: proposeMapping(table, preset),
        options: { ...(projectForFile ? { projectName: title } : {}), ...(localIds ? { idNamespace: sheetIdNamespace(name, table.headers) } : {}) },
      },
    ],
    items: [],
  };
}

/** What the review step needs from a parsed upload, without the rows themselves. */
export interface UploadSummary {
  format: ParsedUpload["format"];
  formatLabel: string;
  externalSource: string;
  source: ImportSourceId;
  tables: Array<{ containerId: string; headers: string[]; preset: CsvPreset; mapping: CsvMapping }>;
}

export function summarizeUpload(parsed: ParsedUpload): UploadSummary {
  return {
    format: parsed.format,
    formatLabel: parsed.formatLabel,
    externalSource: parsed.externalSource,
    source: parsed.source,
    tables: parsed.tables.map((table) => ({ containerId: table.container.id, headers: table.table.headers, preset: table.preset, mapping: table.mapping })),
  };
}

/** Items for the chosen containers, with the person's column mapping where they changed it. */
export function uploadItems(parsed: ParsedUpload, chosen: Set<string>, mappings: Record<string, CsvMapping> = {}): ImportItem[] {
  const items: ImportItem[] = [];
  for (const table of parsed.tables) {
    if (!chosen.has(table.container.id)) continue;
    items.push(...csvItems(table.table, mappings[table.container.id] ?? table.mapping, table.preset, { ...table.options, containerId: table.container.id }));
  }
  for (const item of parsed.items) if (item.containerId && chosen.has(item.containerId)) items.push(item);
  return items;
}
