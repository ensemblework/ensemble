/**
 * Turning other apps' words into Ensemble's: status, priority, dates, labels.
 * Forgiving on purpose: an unknown value falls back to a sensible default
 * instead of failing the row.
 */
import type { Priority, TaskStatus } from "@prisma/client";

export const ENSEMBLE_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "blocked", "done", "dropped", "proposed", "waiting_approval"];

export const MAX_LABELS = 20;
export const MAX_LABEL_LENGTH = 40;
const MAX_TITLE = 500;

function words(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const STATUS_RULES: Array<[RegExp, TaskStatus]> = [
  [/^(cancell?ed|canceled|wont do|wont fix|wontfix|duplicate|rejected|declined|abandoned|obsolete|not planned|archived)$/, "dropped"],
  [/^(done|complete|completed|closed|resolved|shipped|released|finished|fixed|merged|deployed|live|approved)$/, "done"],
  [/^(blocked|on hold|waiting|stuck|paused|hold)$/, "blocked"],
  [/^(in progress|doing|started|in review|review|in development|development|active|working on it|testing|qa|in qa|code review|ready for review|ongoing|wip)$/, "in_progress"],
  [/^(backlog|todo|to do|open|unstarted|new|not started|planned|triage|ready|selected for development|next|up next|later|someday|inbox|icebox|reopened)$/, "todo"],
];

const CATEGORY_RULES: Record<string, TaskStatus> = {
  // Linear state types
  backlog: "todo",
  unstarted: "todo",
  triage: "todo",
  started: "in_progress",
  completed: "done",
  canceled: "dropped",
  // Jira status categories
  new: "todo",
  indeterminate: "in_progress",
  done: "done",
  // ClickUp status types
  open: "todo",
  custom: "in_progress",
  closed: "done",
  // GitHub
  not_planned: "dropped",
};

/** Best guess for a status name; null when nothing matches. */
export function guessStatus(raw: string | null | undefined, category?: string | null): TaskStatus | null {
  if (raw) {
    const text = words(raw);
    for (const [pattern, status] of STATUS_RULES) if (pattern.test(text)) return status;
    if (/\b(cancel|duplicate|wont)\b/.test(text)) return "dropped";
    if (/\b(done|complete|closed|resolved)\b/.test(text)) return "done";
    if (/\bblock/.test(text)) return "blocked";
    if (/\b(progress|review|doing|testing)\b/.test(text)) return "in_progress";
    if (/\b(todo|backlog|open)\b/.test(text)) return "todo";
  }
  if (category) return CATEGORY_RULES[category.toLowerCase()] ?? null;
  return null;
}

export function statusKey(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

export function resolveStatus(
  item: { status?: string | null; statusCategory?: string | null; done?: boolean },
  statusMap: Record<string, TaskStatus>,
): TaskStatus {
  const chosen = item.status ? statusMap[statusKey(item.status)] : undefined;
  const status = chosen ?? guessStatus(item.status, item.statusCategory) ?? "todo";
  if (item.done && status !== "done" && status !== "dropped") return "done";
  return status;
}

/** Ensemble has three priorities: p0 High, p1 Normal, p2 Low. Urgent and high both land on High. */
export function mapPriority(raw: string | number | null | undefined): Priority {
  if (raw === null || raw === undefined) return "p1";
  const text = words(String(raw));
  if (!text) return "p1";
  if (/^(urgent|highest|critical|blocker|asap|p0|0|1|p1|high|important|major)$/.test(text)) return "p0";
  if (/^(low|lowest|minor|trivial|p3|p4|3|4|5)$/.test(text)) return "p2";
  if (/\b(urgent|highest|critical|high)\b/.test(text)) return "p0";
  if (/\b(low|lowest|minor)\b/.test(text)) return "p2";
  return "p1";
}

/** Trimmed, de-duplicated (case-insensitive), at most 20 labels of 40 characters. */
export function cleanLabels(values: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const label = value.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH).trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

/** Splits "a, b; c" into labels. */
export function splitList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(/[,;\n]/).map((part) => part.trim()).filter(Boolean);
}

export function cleanTitle(value: string | null | undefined): string {
  const title = (value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  return title || "Untitled";
}

export function cleanPeople(values: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const name = (value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length >= 20) break;
  }
  return out;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function ymd(year: number, month: number, day: number): string | null {
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2200) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * A due date as Ensemble stores it: "YYYY-MM-DD" when the other app has no time,
 * otherwise an ISO datetime. Returns null for anything it cannot read.
 */
export function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? epoch(value) : null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{12,14}$/.test(text)) return epoch(Number(text));
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (isoDay) return ymd(Number(isoDay[1]), Number(isoDay[2]), Number(isoDay[3]));
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    // A floating time ("2026-10-07T09:00:00" with no zone) stays on its day.
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) return ymd(Number(text.slice(0, 4)), Number(text.slice(5, 7)), Number(text.slice(8, 10)));
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const slashYmd = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})\b/.exec(text);
  if (slashYmd) return ymd(Number(slashYmd[1]), Number(slashYmd[2]), Number(slashYmd[3]));
  const jira = /^(\d{1,2})\/([A-Za-z]{3,4})\/(\d{2,4})\b/.exec(text);
  if (jira) {
    const month = MONTHS[jira[2]!.toLowerCase()];
    return month ? ymd(Number(jira[3]), month, Number(jira[1])) : null;
  }
  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(text);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    // US order unless the first part cannot be a month.
    return a > 12 ? ymd(Number(numeric[3]), b, a) : ymd(Number(numeric[3]), a, b);
  }
  const named = /^(?:[A-Za-z]+,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(text);
  if (named) {
    const month = MONTHS[named[1]!.slice(0, named[1]!.toLowerCase().startsWith("sept") ? 4 : 3).toLowerCase()];
    if (month) return ymd(Number(named[3]), month, Number(named[2]));
  }
  const dayFirst = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/.exec(text);
  if (dayFirst) {
    const month = MONTHS[dayFirst[2]!.slice(0, 3).toLowerCase()];
    if (month) return ymd(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }
  return null;
}

function epoch(ms: number): string | null {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Notion and others write ranges as "start → end". Returns [start, end]. */
export function splitRange(value: string | null | undefined): [string | null, string | null] {
  if (!value) return [null, null];
  const parts = value.split(/\s+(?:→|->|–|to)\s+/);
  if (parts.length === 2) return [normalizeDate(parts[0]), normalizeDate(parts[1])];
  return [null, normalizeDate(value)];
}

/** Stored the way parseDue stores it: date-only means midnight UTC on that day. */
export function dueToDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00.000Z`);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const SHORT_DESCRIPTION = 500;

/**
 * Short single-paragraph descriptions stay on the task. Anything longer, or
 * with structure, moves to the task page and the task keeps a one-line summary.
 */
export function splitDescription(markdown: string | null | undefined, pageMarkdown: string | null | undefined): { description: string; page: string | null } {
  const text = (markdown ?? "").replace(/\r\n/g, "\n").trim();
  const body = (pageMarkdown ?? "").trim();
  const simple = text.length <= SHORT_DESCRIPTION && !/\n\s*\n|^\s*([-*+]|\d+[.)]|#{1,6}|>|```|\|)/m.test(text);
  if (simple) return { description: text, page: body || null };
  const first = text.split(/\n\s*\n/)[0]!.replace(/^#{1,6}\s+/, "").replace(/\s+/g, " ").trim();
  const summary = first.length > 280 ? `${first.slice(0, 279).trimEnd()}…` : first;
  return { description: summary, page: body ? `${text}\n\n${body}` : text };
}

/** Removes Notion's " 1a2b…(32 hex)" suffix from exported file and folder names. */
export function stripNotionId(name: string): string {
  return name.replace(/\s+[0-9a-f]{32}(?=(\.[a-z0-9]+)?$)/i, "").replace(/\s+[0-9a-f]{32}$/i, "").trim();
}

export function notionIdFrom(name: string): string | null {
  const match = /([0-9a-f]{32})(?:\.[a-z0-9]+)?$/i.exec(name.trim());
  return match ? match[1]!.toLowerCase() : null;
}

/** Notion ids with or without dashes compare equal. */
export function normalizeNotionId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}
