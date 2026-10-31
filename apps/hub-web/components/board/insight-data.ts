import type { TaskRecord } from "@/lib/api";
import type { Role } from "../onboarding/roles";

export const INSIGHT_IDS = ["flow", "ideas", "ownership", "agent", "my-work", "attention", "stale", "deadlines", "done", "capacity"] as const;
export type InsightId = (typeof INSIGHT_IDS)[number];
export const INSIGHTS_KEY = "desk.board.insights";
export const MAX_INSIGHTS = 4;
export type InsightLayout = { v: 1; tiles: InsightId[]; collapsed: boolean; wipCap?: number };
export type OwnerContext = { me: string | null; ownerId: string | null };
export type OwnerBucket = "me" | "agent" | "team" | "unassigned";
export type BoardFocus = { kind: "status"; value: string } | { kind: "owner"; value: OwnerBucket } | { kind: "ideas" | "attention" | "stale" | "deadlines" | "done" };
export const DAY = 86_400_000;
export const ACTIVE = new Set(["proposed", "todo", "in_progress", "waiting_approval", "blocked"]);
export const IN_PROGRESS_STATUSES: TaskRecord["status"][] = ["in_progress", "waiting_approval", "blocked"];
export const boardTasks = (tasks: TaskRecord[]) => tasks.filter((t) => ACTIVE.has(t.status) || t.status === "done");
export const openTasks = (tasks: TaskRecord[]) => tasks.filter((t) => ACTIVE.has(t.status));
export const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export const idleDays = (t: TaskRecord, now: number) => Math.max(0, Math.floor((now - Date.parse(t.updatedAt)) / DAY));
export const daysOld = (t: TaskRecord, now: number) => Math.max(0, Math.floor((now - Date.parse(t.createdAt)) / DAY));

export function ownerBucket(task: TaskRecord, who: OwnerContext): OwnerBucket {
  if (task.owner === "agent" || task.owner === "unassigned") return task.owner;
  // A node or a crew is an AI teammate doing it, as the agent is.
  if (task.owner === "node") return "agent";
  return who.me && (task.assigneeAccountId ?? who.ownerId) === who.me ? "me" : "team";
}

export function matchesFocus(task: TaskRecord, focus: BoardFocus | null, who: OwnerContext, now: number): boolean {
  if (!focus) return true;
  if (focus.kind === "status") return focus.value === "planned" ? ["proposed", "todo"].includes(task.status) : focus.value === "in_progress" ? IN_PROGRESS_STATUSES.includes(task.status) : focus.value === "waiting" ? ["blocked", "waiting_approval"].includes(task.status) : task.status === focus.value;
  if (focus.kind === "owner") return ownerBucket(task, who) === focus.value && ACTIVE.has(task.status);
  if (focus.kind === "ideas") return task.status === "proposed";
  if (focus.kind === "attention") return ["blocked", "waiting_approval"].includes(task.status);
  if (focus.kind === "stale") return ACTIVE.has(task.status) && idleDays(task, now) >= 7;
  if (focus.kind === "done") {
    const start = new Date(now); start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0);
    return task.status === "done" && Boolean(task.completedAt) && Date.parse(task.completedAt!) >= start.getTime() && Date.parse(task.completedAt!) <= now;
  }
  const end = new Date(now); end.setDate(end.getDate() + 6);
  return ACTIVE.has(task.status) && Boolean(task.due) && task.due!.slice(0, 10) <= dayKey(end);
}

export function focusLabel(focus: BoardFocus): string {
  if (focus.kind === "status") return ({ planned: "Planned work", waiting: "Waiting tasks", proposed: "Proposed", todo: "To do", in_progress: "In progress", blocked: "Blocked", waiting_approval: "Awaiting approval", done: "Done" } as Record<string, string>)[focus.value] ?? focus.value;
  if (focus.kind === "owner") return ({ me: "My open work", agent: "Agent-owned work", team: "Teammates' work", unassigned: "Unassigned work" })[focus.value];
  return { ideas: "Proposed ideas", attention: "Waiting tasks", stale: "No updates for 7+ days", deadlines: "Overdue or due within 7 days", done: "Completed in the last 7 days" }[focus.kind];
}

export const DEFAULT_INSIGHTS: Record<Role, InsightId[]> = {
  student: ["flow", "deadlines", "ideas"], teacher: ["flow", "deadlines", "stale"],
  lawyer: ["deadlines", "attention", "ownership"], engineer: ["flow", "agent", "stale"],
  vibe: ["ideas", "flow", "agent"], manager: ["ownership", "flow", "attention"],
};

export function readInsightLayout(value: unknown, fallback: InsightId[]): InsightLayout {
  const raw = value as Partial<InsightLayout> | null;
  if (!raw || raw.v !== 1 || !Array.isArray(raw.tiles)) return { v: 1, tiles: fallback.slice(0, MAX_INSIGHTS), collapsed: false };
  return { v: 1, tiles: [...new Set(raw.tiles)].filter((id): id is InsightId => (INSIGHT_IDS as readonly unknown[]).includes(id)).slice(0, MAX_INSIGHTS), collapsed: raw.collapsed === true, ...(typeof raw.wipCap === "number" && Number.isFinite(raw.wipCap) ? { wipCap: Math.max(1, Math.min(50, Math.round(raw.wipCap))) } : {}) };
}

export function completedDays(tasks: TaskRecord[], now: number) {
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(now); date.setDate(date.getDate() - 6 + i);
    const day = dayKey(date);
    return { day, label: date.toLocaleDateString("en-GB", { weekday: "short" }), count: tasks.filter((t) => t.status === "done" && t.completedAt && dayKey(new Date(t.completedAt)) === day && Date.parse(t.completedAt) <= now).length };
  });
}
