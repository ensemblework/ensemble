import type { Priority, TaskStatus } from "./api";
import { safeDate } from "./safe-date";

export const PRIORITY: Record<Priority, { label: string; tone: Tone; key: string }> = {
  critical: { label: "Critical", tone: "red", key: "critical" },
  p0: { label: "High", tone: "orange", key: "high" },
  p1: { label: "Medium", tone: "blue", key: "medium" },
  p2: { label: "Low", tone: "gray", key: "low" },
};
/** Most urgent first. */
export const PRIORITY_ORDER: Priority[] = ["critical", "p0", "p1", "p2"];
export const PRIORITY_RANK: Record<Priority, number> = { critical: 0, p0: 1, p1: 2, p2: 3 };

export type Tone = "red" | "orange" | "yellow" | "green" | "blue" | "pink" | "purple" | "gray";

export const toneStyle = (tone: Tone) => ({
  background: `var(--tag-${tone}-bg)`,
  color: `var(--tag-${tone}-fg)`,
});

export const STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  proposed: { label: "Proposed", tone: "pink" },
  todo: { label: "To do", tone: "blue" },
  in_progress: { label: "In progress", tone: "yellow" },
  waiting_approval: { label: "Waiting for me", tone: "red" },
  blocked: { label: "Blocked", tone: "red" },
  done: { label: "Done", tone: "green" },
  dropped: { label: "Dropped", tone: "gray" },
};

export const OWNER_LABEL: Record<string, string> = { me: "Me", agent: "Agent", unassigned: "Unassigned" };

export const COMPLEXITY_LABEL: Record<string, string> = { easy: "Easy", medium: "Medium", high: "High", max: "Max" };

const DAY = 86_400_000;

export function startOfDay(date = new Date()): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function isoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "overdue by 5 days", "due today", "due in 2 days" — or null when there is no due date. */
export function dueLabel(due: string | null, done = false): { text: string; overdue: boolean } | null {
  if (!due || done) return null;
  const date = safeDate(due);
  if (!date) return { text: String(due), overdue: false };
  const days = Math.round((startOfDay(date).getTime() - startOfDay().getTime()) / DAY);
  if (days < 0) return { text: `overdue by ${-days} day${days === -1 ? "" : "s"}`, overdue: true };
  if (days === 0) return { text: "due today", overdue: false };
  if (days === 1) return { text: "due tomorrow", overdue: false };
  return { text: `due in ${days} days`, overdue: false };
}

const WHEN = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });
const WEEKDAY = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short" });

/** "Wed, 30 Sept" */
export function weekdayDate(value: string | Date | null | undefined = new Date()): string {
  const date = value instanceof Date ? value : safeDate(value);
  if (!date) return "—";
  return WEEKDAY.format(date);
}

export function shortDate(value: string | Date | null | undefined): string {
  if (!value) return "Empty";
  const date = safeDate(value);
  if (!date) return String(value);
  return WHEN.format(date);
}

/** Recent moments stay relative. Older dates are "28 Sept", in en-IN. */
export function whenLabel(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = safeDate(value);
  if (!date) return String(value);
  const days = Math.floor((Date.now() - date.getTime()) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 14) return `${days} days ago`;
  return WHEN.format(date);
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = safeDate(value);
  if (!date) return String(value);
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

/** Clock time as en-IN 12-hour, "4:00 pm", with no leading zero. */
export function clockLabel(value: string | null | undefined): string {
  if (!value) return "";
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return value;
  let hour = Number(match[1]);
  if (!Number.isFinite(hour)) return value;
  const suffix = hour >= 12 ? "pm" : "am";
  hour = hour % 12 || 12;
  return `${hour}:${match[2]} ${suffix}`;
}

export function clock(value: string | Date): string {
  const date = typeof value === "string" ? safeDate(value) : value;
  if (!date || Number.isNaN(date.getTime())) return typeof value === "string" ? value : "—";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

/** Time remaining, in a unit a person can read. Past an hour and a half this is hours, not raw minutes. */
export function untilLabel(seconds: number): string {
  const left = Math.max(0, Math.round(seconds));
  if (left >= 36 * 3600) return `about ${Math.round(left / 86400)} d`;
  if (left >= 90 * 60) return `about ${Math.round(left / 3600)} h`;
  if (left > 90) return `${Math.round(left / 60)} min`;
  return `${left}s`;
}

export function relative(value: string | null | undefined): string {
  if (!value) return "never";
  const parsed = safeDate(value);
  if (!parsed) return String(value);
  const diff = Date.now() - parsed.getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 14 ? (days === 1 ? "1 day ago" : `${days} days ago`) : shortDate(value);
}

/** "1 person", "2 people", "3 steps". `many` covers irregulars; otherwise the word gains an s. */
export function plural(count: number, one: string, many?: string): string {
  return `${count} ${count === 1 ? one : (many ?? `${one}s`)}`;
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

export function credits(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unknown credits";
  return `${Math.round(value * 10) / 10} credits`;
}

export function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript React",
    js: "JavaScript",
    jsx: "JavaScript React",
    py: "Python",
    md: "Markdown",
    json: "JSON",
    css: "CSS",
    html: "HTML",
    yml: "YAML",
    yaml: "YAML",
    sh: "Shell",
    cs: "C#",
    cpp: "C++",
    h: "C++",
    go: "Go",
    rs: "Rust",
    prisma: "Prisma",
  };
  return map[ext] ?? "Plain text";
}
