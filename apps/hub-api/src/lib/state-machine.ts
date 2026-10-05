import type { TaskStatus, TaskOwner } from "@prisma/client";

const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  proposed: ["todo", "dropped", "in_progress"],
  todo: ["in_progress", "dropped", "done", "proposed"],
  in_progress: ["waiting_approval", "blocked", "done", "todo", "dropped"],
  waiting_approval: ["in_progress", "done", "blocked", "dropped"],
  blocked: ["todo", "in_progress", "dropped"],
  done: ["todo"],
  dropped: ["proposed", "todo"],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw Object.assign(new Error(`Cannot move a task from ${from} to ${to}.`), { statusCode: 409 });
  }
}

export function ownerForColumn(column: "me" | "agent" | "needs-me"): { owner?: TaskOwner; status?: TaskStatus } {
  if (column === "me") return { owner: "me" };
  if (column === "agent") return { owner: "agent" };
  return { status: "waiting_approval" };
}
