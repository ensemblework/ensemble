/**
 * CSV and TSV exports. Papa Parse guesses the delimiter; this file finds the
 * header row, recognizes known exports by their headers, proposes a column
 * mapping, and turns rows into import items.
 */
import { createHash } from "node:crypto";
import Papa from "papaparse";
import { cleanTitle, normalizeDate, splitList, splitRange } from "../mapping.js";
import { ImportError, type ImportItem } from "../types.js";

export const MAX_ROWS = 20_000;

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

export const CSV_FIELDS = ["title", "due", "start", "labels", "status", "priority", "assignee", "description", "project", "url", "id", "done", "completedAt", "parent"] as const;
export type CsvField = (typeof CSV_FIELDS)[number];
/** Field → header names. Several headers can feed one field (Jira repeats "Labels"). */
export type CsvMapping = Partial<Record<CsvField, string[]>>;

export const CSV_PRESETS = ["notion", "asana", "todoist", "jira", "linear", "clickup", "generic"] as const;
export type CsvPreset = (typeof CSV_PRESETS)[number];

export const PRESET_LABEL: Record<CsvPreset, string> = {
  notion: "Notion database CSV",
  asana: "Asana CSV",
  todoist: "Todoist CSV",
  jira: "Jira CSV",
  linear: "Linear CSV",
  clickup: "ClickUp CSV",
  generic: "Spreadsheet",
};

export function parseCsv(text: string): CsvTable {
  const clean = text.replace(/^\uFEFF/, "");
  const parsed = Papa.parse<string[]>(clean, {
    skipEmptyLines: "greedy",
    delimitersToGuess: [",", "\t", ";", "|"],
  });
  const all = parsed.data.filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? "").trim()));
  if (!all.length) throw new ImportError("That file has no rows.");
  const headerIndex = findHeaderRow(all);
  const headers = all[headerIndex]!.map((cell, index) => String(cell ?? "").replace(/^\uFEFF/, "").trim() || `Column ${index + 1}`);
  const rows = all.slice(headerIndex + 1).map((row) => headers.map((_, index) => String(row[index] ?? "").trim()));
  if (rows.length > MAX_ROWS) throw new ImportError(`That file has ${rows.length} rows. Imports take up to ${MAX_ROWS} at a time; split the file and import each part.`);
  return { headers, rows };
}

/** The first row in the first ten that looks like labels: mostly filled, mostly text, not a lone title line. */
function findHeaderRow(rows: string[][]): number {
  const width = Math.max(...rows.slice(0, 10).map((row) => row.filter((cell) => String(cell ?? "").trim()).length));
  for (let index = 0; index < Math.min(rows.length, 10); index += 1) {
    const cells = rows[index]!.map((cell) => String(cell ?? "").trim()).filter(Boolean);
    if (cells.length < Math.max(1, Math.ceil(width * 0.6))) continue;
    const texty = cells.filter((cell) => !/^[\d.,:/\s-]+$/.test(cell)).length;
    if (texty >= cells.length * 0.8) return index;
  }
  return 0;
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function has(headers: string[], ...names: string[]): boolean {
  const set = new Set(headers.map(norm));
  return names.every((name) => set.has(norm(name)));
}

export function detectPreset(headers: string[], hint?: string | null): CsvPreset {
  if (has(headers, "Issue key", "Summary") || has(headers, "Issue id", "Summary")) return "jira";
  if (has(headers, "TYPE", "CONTENT", "PRIORITY")) return "todoist";
  if (has(headers, "Task ID", "Task Name") && (has(headers, "List Name") || has(headers, "Space Name") || has(headers, "Task Content"))) return "clickup";
  if (has(headers, "Task ID", "Name") && (has(headers, "Section/Column") || has(headers, "Assignee Email") || has(headers, "Parent task"))) return "asana";
  if (has(headers, "ID", "Title", "Team") && (has(headers, "Cycle Name") || has(headers, "Triaged") || has(headers, "Project ID") || has(headers, "Creator"))) return "linear";
  if (hint === "notion") return "notion";
  return "generic";
}

const PRESET_MAPPING: Record<Exclude<CsvPreset, "generic" | "notion">, CsvMapping> = {
  jira: {
    title: ["Summary"], id: ["Issue id", "Issue key"], status: ["Status"], priority: ["Priority"], assignee: ["Assignee"],
    due: ["Due date", "Due Date"], labels: ["Labels", "Sprint"], description: ["Description"], project: ["Project name"],
    completedAt: ["Resolved"], parent: ["Parent", "Parent summary"],
  },
  todoist: { title: ["CONTENT"], description: ["DESCRIPTION"], priority: ["PRIORITY"], assignee: ["RESPONSIBLE"], due: ["DEADLINE", "DATE"] },
  clickup: {
    title: ["Task Name"], id: ["Task ID"], description: ["Task Content"], status: ["Status"], priority: ["Priority"],
    assignee: ["Assignees"], labels: ["Tags"], due: ["Due Date"], start: ["Start Date"], project: ["List Name"], parent: ["Parent ID"],
  },
  asana: {
    title: ["Name"], id: ["Task ID"], description: ["Notes"], status: ["Section/Column"], assignee: ["Assignee"],
    labels: ["Tags"], due: ["Due Date"], start: ["Start Date"], project: ["Projects"], completedAt: ["Completed At"], parent: ["Parent task"],
  },
  linear: {
    title: ["Title"], id: ["ID"], description: ["Description"], status: ["Status"], priority: ["Priority"], assignee: ["Assignee"],
    labels: ["Labels"], due: ["Due Date"], project: ["Project"], completedAt: ["Completed"], parent: ["Parent issue"],
  },
};

const SYNONYMS: Record<CsvField, string[]> = {
  title: ["title", "name", "task", "task name", "summary", "subject", "item", "issue", "card name", "to do", "todo", "content"],
  due: ["due", "due date", "deadline", "due on", "due at", "end date", "target date", "date", "when"],
  start: ["start", "start date", "starts", "begin", "start on"],
  labels: ["labels", "label", "tags", "tag", "categories", "category", "keywords", "type"],
  status: ["status", "state", "stage", "progress"],
  priority: ["priority", "importance", "urgency", "prio"],
  assignee: ["assignee", "assignees", "assigned to", "owner", "responsible", "people", "person", "members", "assign"],
  description: ["description", "notes", "note", "details", "body", "task content", "comments"],
  project: ["project", "projects", "project name", "list", "list name", "board", "folder", "area"],
  url: ["url", "link", "href", "issue url", "web link"],
  id: ["id", "task id", "issue id", "key", "issue key", "uid", "external id", "record id"],
  done: ["done", "completed", "complete", "is done", "checked", "finished", "check"],
  completedAt: ["completed at", "completed on", "date completed", "resolved", "done at", "closed at"],
  parent: ["parent", "parent task", "parent id", "parent issue"],
};

export function proposeMapping(table: CsvTable, preset: CsvPreset): CsvMapping {
  const { headers } = table;
  const byNorm = new Map<string, string>();
  for (const header of headers) if (!byNorm.has(norm(header))) byNorm.set(norm(header), header);
  const mapping: CsvMapping = {};
  if (preset !== "generic" && preset !== "notion") {
    for (const [field, names] of Object.entries(PRESET_MAPPING[preset]) as Array<[CsvField, string[]]>) {
      const found = names.map((name) => byNorm.get(norm(name))).filter((name): name is string => Boolean(name));
      if (found.length) mapping[field] = field === "labels" ? found : [found[0]!];
    }
    return mapping;
  }
  const used = new Set<string>();
  for (const field of CSV_FIELDS) {
    for (const synonym of SYNONYMS[field]) {
      const header = byNorm.get(synonym);
      if (header && !used.has(header) && fitsField(table, header, field)) {
        mapping[field] = [header];
        used.add(header);
        break;
      }
    }
  }
  // Notion puts the title property first, whatever its name.
  if (!mapping.title && headers[0]) mapping.title = [headers[0]];
  if (preset === "notion" && !mapping.due) {
    const dateColumn = headers.find((header) => !used.has(header) && looksLikeDates(table, header));
    if (dateColumn) mapping.due = [dateColumn];
  }
  return mapping;
}

function column(table: CsvTable, header: string): string[] {
  const index = table.headers.indexOf(header);
  return index < 0 ? [] : table.rows.slice(0, 50).map((row) => row[index] ?? "").filter(Boolean);
}

function looksLikeDates(table: CsvTable, header: string): boolean {
  const values = column(table, header);
  return values.length > 0 && values.filter((value) => splitRange(value)[1]).length >= values.length * 0.8;
}

function fitsField(table: CsvTable, header: string, field: CsvField): boolean {
  if (field === "due" || field === "start" || field === "completedAt") {
    const values = column(table, header);
    return !values.length || looksLikeDates(table, header);
  }
  if (field === "done") {
    const values = column(table, header);
    return values.every((value) => /^(yes|no|true|false|x|✓|✔|1|0|done|)$/i.test(value) || Boolean(normalizeDate(value)));
  }
  return true;
}

function cells(row: string[], headers: string[], names: string[] | undefined): string[] {
  if (!names?.length) return [];
  const out: string[] = [];
  for (const name of names) {
    headers.forEach((header, index) => {
      if (header === name && row[index]) out.push(row[index]!);
    });
  }
  return out;
}

const first = (row: string[], headers: string[], names: string[] | undefined) => cells(row, headers, names)[0] ?? "";

function truthy(value: string): boolean {
  return /^(yes|true|x|✓|✔|1|done|checked|complete|completed)$/i.test(value.trim()) || Boolean(normalizeDate(value));
}

/** "[Mira Chen, Theo Park]" (ClickUp) or "Mira Chen; Theo Park". */
function listCell(value: string): string[] {
  return splitList(value.replace(/^\[|\]$/g, ""));
}

function stableId(...parts: string[]): string {
  return `row-${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)}`;
}

const TODOIST_PRIORITY: Record<string, string> = { "1": "urgent", "2": "high", "3": "medium", "4": "none" };

export interface CsvItemOptions {
  containerId: string;
  /** Project for rows with no project column, e.g. the file or database name. */
  projectName?: string | null;
  projectRef?: string | null;
  /** Notion zip: page id per row title, to link rows to their exported page bodies. */
  rowIdFor?: (rowIndex: number) => string | null;
  /**
   * Prefix for ids from an ID column. Spreadsheet ids such as 1, 2, 3 are only
   * unique within one sheet; vendor exports (Jira, Asana, ClickUp, Linear) carry
   * ids unique across the app and leave this unset.
   */
  idNamespace?: string;
  rowPage?: (id: string) => string | null;
  sourceUrlFor?: (id: string) => string | null;
}

export function csvItems(table: CsvTable, mapping: CsvMapping, preset: CsvPreset, options: CsvItemOptions): ImportItem[] {
  const { headers } = table;
  const items: ImportItem[] = [];
  const occurrences = new Map<string, number>();
  let section: string | null = null;
  const mappedHeaders = new Set(Object.values(mapping).flat());
  for (const [rowIndex, row] of table.rows.entries()) {
    let title = first(row, headers, mapping.title);
    const labels: string[] = cells(row, headers, mapping.labels).flatMap(listCell);
    let priority = first(row, headers, mapping.priority) || null;
    if (preset === "todoist") {
      const type = (row[headers.findIndex((header) => norm(header) === "type")] ?? "").toLowerCase();
      if (type === "section") {
        section = title || null;
        continue;
      }
      if (type && type !== "task") continue;
      title = title.replace(/(^|\s)@([\p{L}\p{N}_-]+)/gu, (_match, lead: string, label: string) => {
        labels.push(label);
        return lead;
      });
      if (section) labels.push(section);
      priority = TODOIST_PRIORITY[priority ?? ""] ?? priority;
    }
    if (!title.trim()) continue;
    const [rangeStart, due] = splitRange(first(row, headers, mapping.due));
    const start = normalizeDate(first(row, headers, mapping.start)) ?? rangeStart;
    const project = first(row, headers, mapping.project);
    const explicitId = first(row, headers, mapping.id);
    const doneCell = first(row, headers, mapping.done);
    const completedAt = normalizeDate(first(row, headers, mapping.completedAt));
    const rawId = explicitId.trim();
    let externalId = options.rowIdFor?.(rowIndex) ?? (rawId ? (options.idNamespace ? `${options.idNamespace}:${rawId}` : rawId) : null);
    if (!externalId) {
      const base = `${project}\u0000${title.trim().toLowerCase()}`;
      const seen = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, seen);
      // Not the file name: a re-downloaded "tasks (1).csv" must match the same rows.
      externalId = stableId(options.projectRef ?? "", base, String(seen));
    }
    const extras = preset === "notion" ? notionExtras(headers, row, mappedHeaders) : "";
    const description = cells(row, headers, mapping.description).join("\n\n");
    const body = options.rowPage?.(externalId) ?? "";
    const pageMarkdown = [extras ? `**Properties**\n\n${extras}` : "", body].filter((part) => part.trim()).join("\n\n") || null;
    items.push({
      kind: "task",
      externalId,
      title: cleanTitle(title),
      description: description || null,
      dueDate: due,
      startDate: start,
      status: first(row, headers, mapping.status) || null,
      done: Boolean(doneCell && truthy(doneCell)) || Boolean(completedAt),
      priority,
      labels,
      assignees: cells(row, headers, mapping.assignee).flatMap(listCell),
      url: first(row, headers, mapping.url) || options.sourceUrlFor?.(externalId) || null,
      containerId: options.containerId,
      projectName: project ? listCell(project)[0] ?? project : options.projectName ?? null,
      projectRef: project ? null : options.projectRef ?? null,
      parentRef: first(row, headers, mapping.parent) || null,
      pageMarkdown,
      completedAt,
    });
  }
  return items;
}

/** Notion rows carry properties with no Ensemble field; keep them readable in the description. */
function notionExtras(headers: string[], row: string[], mapped: Set<string>): string {
  const lines: string[] = [];
  headers.forEach((header, index) => {
    const value = row[index];
    if (!value || mapped.has(header)) return;
    lines.push(`- **${header}:** ${value.replace(/\s+/g, " ").slice(0, 300)}`);
  });
  return lines.slice(0, 15).join("\n");
}
