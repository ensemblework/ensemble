/** What the review step shows: sample rows, the status values found and where each will land. */
import type { TaskStatus } from "@prisma/client";
import { guessStatus, statusKey } from "./mapping.js";
import type { ImportItem } from "./types.js";

export interface StatusFound {
  value: string;
  count: number;
  proposed: TaskStatus;
}

export interface SampleRow {
  kind: "task" | "page" | "project";
  containerId: string | null;
  title: string;
  status: string | null;
  due: string | null;
  labels: string[];
  assignees: string[];
  project: string | null;
  priority: string | null;
}

export function statusesFound(items: ImportItem[]): StatusFound[] {
  const found = new Map<string, StatusFound & { category?: string | null; done: number }>();
  for (const item of items) {
    if (item.kind !== "task" || !item.status?.trim()) continue;
    const key = statusKey(item.status);
    const entry = found.get(key) ?? { value: item.status.trim(), count: 0, proposed: "todo" as TaskStatus, category: item.statusCategory, done: 0 };
    entry.count += 1;
    if (item.done) entry.done += 1;
    found.set(key, entry);
  }
  return [...found.values()]
    .map(({ value, count, category, done }) => {
      const guess = guessStatus(value, category);
      return { value, count, proposed: guess ?? (done === count ? "done" : "todo") };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 60);
}

export function sampleRows(items: ImportItem[], limit = 8): SampleRow[] {
  const perContainer = new Map<string, number>();
  const rows: SampleRow[] = [];
  for (const item of items) {
    const key = item.containerId ?? "";
    const used = perContainer.get(key) ?? 0;
    if (used >= Math.max(3, Math.ceil(limit / 2))) continue;
    perContainer.set(key, used + 1);
    rows.push({
      kind: item.kind,
      containerId: item.containerId ?? null,
      title: item.title,
      status: item.status ?? (item.done ? "Done" : null),
      due: item.dueDate ?? null,
      labels: (item.labels ?? []).slice(0, 6),
      assignees: (item.assignees ?? []).slice(0, 4),
      project: item.projectName ?? null,
      priority: item.priority ?? null,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}
