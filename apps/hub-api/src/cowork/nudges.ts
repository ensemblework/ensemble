/** Quiet "still relevant?" checks. Untouched work, and due work that never started. */

export const OPEN_STATUSES = ["proposed", "todo", "in_progress", "waiting_approval", "blocked"] as const;
const NO_PROGRESS = new Set(["proposed", "todo", "waiting_approval", "blocked"]);

export type NudgeReason = "untouched" | "due_no_progress";

export interface NudgeTask {
  id: string;
  title: string;
  status: string;
  due: Date | null;
  updatedAt: Date;
  snoozedUntil: Date | null;
  nudgePausedUntil: Date | null;
  deletedAt?: Date | null;
}

export function nudgeReasons(task: NudgeTask, now: Date, untouchedDays: number): NudgeReason[] {
  if (task.deletedAt) return [];
  if (!OPEN_STATUSES.includes(task.status as (typeof OPEN_STATUSES)[number])) return [];
  if (task.snoozedUntil && task.snoozedUntil > now) return [];
  if (task.nudgePausedUntil && task.nudgePausedUntil > now) return [];
  const reasons: NudgeReason[] = [];
  const cutoff = now.getTime() - untouchedDays * 86_400_000;
  if (task.updatedAt.getTime() < cutoff) reasons.push("untouched");
  if (task.due && task.due.getTime() <= now.getTime() && NO_PROGRESS.has(task.status)) reasons.push("due_no_progress");
  return reasons;
}

export function nudgeQuestion(reasons: NudgeReason[], untouchedDays: number): string {
  const quiet = reasons.includes("untouched");
  const due = reasons.includes("due_no_progress");
  if (quiet && due) return `This has been quiet for over ${untouchedDays} days, and it is due with no progress. Still relevant?`;
  if (due) return "This is due and has not been started. Still relevant?";
  return `Nothing has changed this for over ${untouchedDays} days. Still relevant?`;
}

/** Legal status hops so "Done" can finish a proposed or blocked task. */
export function pathToDone(status: string): string[] {
  if (status === "done") return [];
  if (status === "proposed" || status === "blocked") return ["in_progress", "done"];
  if (status === "dropped") return ["todo", "done"];
  return ["done"];
}
