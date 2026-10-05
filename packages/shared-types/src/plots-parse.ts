import { MAX_STORED_ROWS, type ColumnType, type PlotColumn } from "./plots.js";

export type ParsedTable = {
  columns: PlotColumn[];
  rows: Array<Array<string | number | null>>;
  delimiter: string;
  truncated: number;
  warnings: string[];
};

const DELIMITERS = [",", "\t", "|", ";", " "] as const;

function splitLine(line: string, delimiter: string): string[] {
  if (delimiter === " ") {
    return line.trim().split(/\s+/).filter((cell) => cell.length > 0);
  }
  const out: string[] = [];
  let cell = "";
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else quote = false;
      } else cell += char;
      continue;
    }
    if (char === '"' && cell.length === 0) {
      quote = true;
      continue;
    }
    if (char === delimiter) {
      out.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  out.push(cell.trim());
  return out;
}

function scoreDelimiter(sample: string[], delimiter: string): number {
  const widths = sample.map((line) => splitLine(line, delimiter).length).filter((n) => n > 1);
  if (widths.length < 2) return 0;
  const first = widths[0]!;
  const stable = widths.filter((n) => n === first).length;
  return stable * 10 + first;
}

export function sniffDelimiter(text: string): string {
  const sample = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, 20);
  let best: string = ",";
  let bestScore = -1;
  for (const delimiter of DELIMITERS) {
    const score = scoreDelimiter(sample, delimiter);
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

function looksNumber(raw: string, commaDecimal: boolean): number | null {
  let text = raw.trim();
  if (!text || text === "-" || text.toLowerCase() === "na" || text.toLowerCase() === "null") return null;
  text = text.replace(/[$£€%\s]/g, "");
  if (commaDecimal) {
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(text) || /^-?\d+,\d+$/.test(text)) {
      text = text.replace(/\./g, "").replace(",", ".");
    }
  } else {
    text = text.replace(/,/g, "");
  }
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function commaDecimalColumn(cells: string[]): boolean {
  let eu = 0;
  let us = 0;
  for (const cell of cells) {
    const text = cell.trim();
    if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(text) || /^-?\d+,\d+$/.test(text)) eu++;
    else if (/^-?\d{1,3}(,\d{3})+\.\d+$/.test(text) || /^-?\d+\.\d+$/.test(text)) us++;
  }
  return eu > us && eu >= 2;
}

/** ISO and year-first dates only. Ambiguous day/month strings stay text. */
export function parseDate(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?/.test(text)) return null;
  const iso = text.includes("T") ? text : text.replace(" ", "T").replace(/\//g, "-");
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

function inferType(values: Array<string | number | null>): ColumnType {
  let number = 0;
  let date = 0;
  let text = 0;
  let seen = 0;
  const unique = new Set<string>();
  for (const value of values) {
    if (value === null || value === "") continue;
    seen++;
    if (typeof value === "number") {
      number++;
      continue;
    }
    unique.add(value);
    if (parseDate(value) !== null) date++;
    else text++;
  }
  if (seen === 0) return "text";
  if (number / seen >= 0.8) return "number";
  if (date / seen >= 0.8) return "date";
  if (unique.size <= Math.max(12, seen * 0.2) && text > 0) return "category";
  return "text";
}

function uniqueNames(header: string[], width: number): string[] {
  const used = new Set<string>();
  const names: string[] = [];
  for (let i = 0; i < width; i++) {
    let name = (header[i] ?? "").trim() || `column_${i + 1}`;
    name = name.slice(0, 200);
    const base = name;
    let n = 2;
    while (used.has(name)) name = `${base}_${n++}`;
    used.add(name);
    names.push(name);
  }
  return names;
}

export function parseDelimited(text: string, delimiter?: string): ParsedTable {
  const warnings: string[] = [];
  const chosen = delimiter && DELIMITERS.includes(delimiter as (typeof DELIMITERS)[number]) ? delimiter : sniffDelimiter(text);
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#"));
  if (!lines.length) return { columns: [], rows: [], delimiter: chosen, truncated: 0, warnings: ["That file has no rows."] };
  const matrix = lines.map((line) => splitLine(line, chosen));
  const width = Math.max(...matrix.map((row) => row.length));
  const first = matrix[0] ?? [];
  const headerIsText = first.some((cell) => cell && looksNumber(cell, false) === null && parseDate(cell) === null);
  const header = headerIsText ? first : uniqueNames([], width);
  const body = headerIsText ? matrix.slice(1) : matrix;
  const names = uniqueNames(header, width);
  const samples = body.slice(0, 200).map((row) => row.map((cell) => cell ?? ""));
  const comma = names.map((_, index) => commaDecimalColumn(samples.map((row) => row[index] ?? "")));
  const rows: Array<Array<string | number | null>> = [];
  let truncated = 0;
  for (const raw of body) {
    if (rows.length >= MAX_STORED_ROWS) {
      truncated++;
      continue;
    }
    rows.push(
      names.map((_, index) => {
        const cell = (raw[index] ?? "").trim();
        if (!cell) return null;
        const numeric = looksNumber(cell, comma[index] ?? false);
        if (numeric !== null) return numeric;
        return cell;
      }),
    );
  }
  if (truncated) warnings.push(`Kept the first ${MAX_STORED_ROWS.toLocaleString()} rows and left ${truncated.toLocaleString()} out.`);
  const columns: PlotColumn[] = names.map((name, index) => ({
    name,
    type: inferType(rows.map((row) => row[index] ?? null)),
  }));
  return { columns, rows, delimiter: chosen, truncated, warnings };
}

export function parseJsonTable(text: string): ParsedTable {
  const trimmed = text.trim();
  if (!trimmed) return { columns: [], rows: [], delimiter: ",", truncated: 0, warnings: ["That file has no rows."] };
  const warnings: string[] = [];
  let records: unknown[] = [];
  const asRecords = (parsed: unknown): unknown[] => {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      const bag = parsed as Record<string, unknown>;
      const nested = bag.rows ?? bag.data ?? bag.records ?? bag.items;
      if (Array.isArray(nested)) return nested;
      return [parsed];
    }
    return [];
  };
  try {
    records = asRecords(JSON.parse(trimmed) as unknown);
  } catch {
    records = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }
  const objects = records.filter((row) => row && typeof row === "object" && !Array.isArray(row)) as Array<Record<string, unknown>>;
  if (!objects.length) return { columns: [], rows: [], delimiter: ",", truncated: 0, warnings: ["JSON has no objects to plot."] };
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of objects.slice(0, 40)) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(key.slice(0, 200));
    }
  }
  let truncated = 0;
  const taken = objects.slice(0, MAX_STORED_ROWS);
  truncated = objects.length - taken.length;
  const rows = taken.map((row) =>
    names.map((name) => {
      const value = row[name];
      if (value === null || value === undefined || value === "") return null;
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "boolean") return value ? 1 : 0;
      if (typeof value === "string") {
        const numeric = looksNumber(value, commaDecimalColumn([value]));
        if (numeric !== null) return numeric;
        return value;
      }
      return JSON.stringify(value);
    }),
  );
  if (truncated) warnings.push(`Kept the first ${MAX_STORED_ROWS.toLocaleString()} rows and left ${truncated.toLocaleString()} out.`);
  const columns: PlotColumn[] = names.map((name, index) => ({ name, type: inferType(rows.map((row) => row[index] ?? null)) }));
  return { columns, rows, delimiter: ",", truncated, warnings };
}

export function decodeTableText(bytes: Uint8Array): string {
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const slice = bytes.subarray(start);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    return new TextDecoder("windows-1252").decode(slice);
  }
}

export function parseTableText(text: string, format: "csv" | "tsv" | "txt" | "json" | "jsonl" | "paste", delimiter?: string): ParsedTable {
  if (format === "json" || format === "jsonl") return parseJsonTable(text);
  const forced = format === "tsv" ? "\t" : format === "csv" ? "," : delimiter;
  return parseDelimited(text, forced);
}
