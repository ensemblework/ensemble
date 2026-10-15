import type { DeskLive } from "@/lib/api";

export const CHART_COLORS = ["var(--chart-teal)", "var(--chart-blue)", "var(--chart-amber)", "var(--chart-rose)", "var(--chart-violet)"];
export type Segment = { label: string; value: number; color: string };
export const ratio = (value: number, total: number) => total > 0 ? Math.max(0, Math.min(100, value / total * 100)) : 0;
export const taskRows = (live: DeskLive) => live.tasks.filter((t) => !["logged", "dropped"].includes(t.status) && !["time", "mock"].includes(t.taskType || ""));

export function taskSegments(live: DeskLive): Segment[] {
  const tasks = taskRows(live);
  return [
    { label: "Done", value: tasks.filter((t) => t.status === "done").length, color: CHART_COLORS[0]! },
    { label: "In progress", value: tasks.filter((t) => t.status === "in_progress").length, color: CHART_COLORS[1]! },
    { label: "To do", value: tasks.filter((t) => ["todo", "proposed"].includes(t.status)).length, color: CHART_COLORS[2]! },
    { label: "Waiting", value: tasks.filter((t) => ["blocked", "waiting_approval"].includes(t.status)).length, color: CHART_COLORS[3]! },
  ];
}

export function timeSegments(live: DeskLive): Segment[] {
  const groups = new Map<string, number>();
  for (const task of live.tasks.filter((t) => t.taskType === "time" && (t.measure ?? 0) > 0)) {
    const label = task.subject || task.title;
    groups.set(label, (groups.get(label) ?? 0) + task.measure! / 60);
  }
  const sorted = [...groups].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, 4);
  if (sorted.length > 4) shown.push(["Other", sorted.slice(4).reduce((sum, [, value]) => sum + value, 0)]);
  return shown.map(([label, value], i) => ({ label, value, color: CHART_COLORS[i % CHART_COLORS.length]! }));
}

export type DatedItem = { id: string; title: string; day: string; kind: string };
export function datedItems(live: DeskLive): DatedItem[] {
  const rows = [
    ...live.tasks.filter((t) => t.due && !["done", "dropped", "logged"].includes(t.status)).map((t) => ({ id: t.id, title: t.title, day: t.due!.slice(0, 10), kind: t.taskType || "task" })),
    ...live.deliverables.filter((d) => d.due && !["done", "completed"].includes(d.status)).map((d) => ({ id: d.id, title: d.title, day: d.due!.slice(0, 10), kind: "deliverable" })),
    ...live.reminders.map((d) => ({ id: d.id, title: d.title, day: d.dueDate.slice(0, 10), kind: "reminder" })),
    ...live.countdowns.filter((d) => !live.tasks.some((t) => t.id === d.id && ["done", "dropped", "logged"].includes(t.status))).map((d) => ({ id: d.id, title: d.title, day: d.due.slice(0, 10), kind: "exam" })),
  ];
  return rows.filter((r, i) => rows.findIndex((o) => o.title === r.title && o.day === r.day) === i).sort((a, b) => a.day.localeCompare(b.day));
}

export function mockScores(live: DeskLive) {
  return live.tasks.filter((t) => t.taskType === "mock" && t.measure != null && (t.weight ?? 0) > 0)
    .map((t) => ({ id: t.id, label: t.title, subject: t.subject, value: ratio(t.measure!, t.weight!), day: t.due }));
}

const OPEN = new Set(["todo", "proposed", "in_progress", "blocked", "waiting_approval"]);

/** "16 Oct", or "1 Jan 2025" when the day is not in the year of `today` (both YYYY-MM-DD). */
export function dayLabel(day: string, today: string): string {
  const date = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

/** An open task whose due day is before `today`. */
export function isLate(task: { status: string; due: string | null }, today: string): boolean {
  return Boolean(task.due && OPEN.has(task.status) && task.due.slice(0, 10) < today);
}

/** Dated work before today, and per day for the seven days from today. */
export function weekAhead(live: DeskLive): { overdue: number; days: Array<{ day: string; value: number }> } {
  const dated = datedItems(live);
  const start = Date.parse(`${live.today}T00:00:00Z`);
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(start + i * 86400000).toISOString().slice(0, 10);
    return { day, value: dated.filter((r) => r.day === day).length };
  });
  return { overdue: dated.filter((r) => r.day < live.today).length, days };
}

/** Overdue and dated work first (oldest first), then the rest in their existing order. */
export function byUrgency<T extends { due: string | null }>(rows: T[]): T[] {
  const dated = rows.filter((r) => r.due).sort((a, b) => a.due!.localeCompare(b.due!));
  return [...dated, ...rows.filter((r) => !r.due)];
}
