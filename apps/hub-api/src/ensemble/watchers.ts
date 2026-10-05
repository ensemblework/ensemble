import type { Prisma, PrismaClient } from "@prisma/client";
import { recordUndoInTransaction } from "../lib/undo.js";

const DAY_MS = 86_400_000;

export interface WatcherScope {
  kind: "deliverable" | "task";
  id: string;
  title: string;
}

export interface WatcherDraft {
  scopeKind: "deliverable" | "task";
  scopeId: string;
  condition: "all_tasks_done" | "days_before_due";
  daysBefore: number | null;
  message: string;
}

const ALL_DONE = /all tasks under this deliverable are done/i;
const DAYS_BEFORE = /remind (?:the )?owner (\d+) days? before due/i;

/** The two example phrases become a proposal even when the model never calls the tool. */
export function parseWatcher(prompt: string, scopes: readonly WatcherScope[]): WatcherDraft | null {
  const deliverable = scopes.find((scope) => scope.kind === "deliverable");
  const any = deliverable ?? scopes[0];
  if (ALL_DONE.test(prompt)) {
    if (!deliverable) return null;
    return {
      scopeKind: "deliverable",
      scopeId: deliverable.id,
      condition: "all_tasks_done",
      daysBefore: null,
      message: `All tasks under “${deliverable.title}” are done`,
    };
  }
  const days = DAYS_BEFORE.exec(prompt);
  if (days && any) {
    const daysBefore = Number(days[1]);
    if (!Number.isInteger(daysBefore) || daysBefore < 0 || daysBefore > 60) return null;
    return {
      scopeKind: any.kind,
      scopeId: any.id,
      condition: "days_before_due",
      daysBefore,
      message: `Reminder ${daysBefore} day${daysBefore === 1 ? "" : "s"} before “${any.title}” is due`,
    };
  }
  return null;
}

/** True only inside the window: due within N days, and not more than a day past. */
export function watcherDue(due: Date | null, daysBefore: number, now: Date): boolean {
  if (!due || !Number.isFinite(daysBefore) || daysBefore < 0) return false;
  const delta = due.getTime() - now.getTime();
  return delta <= daysBefore * DAY_MS && delta >= -DAY_MS;
}

type Tx = Prisma.TransactionClient;

export async function createWatcher(
  tx: Tx,
  userId: string,
  input: WatcherDraft & { surface?: string; prompt?: string; actor?: "agent" | "me" },
) {
  if (input.scopeKind === "deliverable") {
    const row = await tx.deliverable.findFirst({ where: { id: input.scopeId, userId, deletedAt: null }, select: { id: true } });
    if (!row) throw new Error("That deliverable is not visible to you.");
  } else {
    const row = await tx.task.findFirst({ where: { id: input.scopeId, userId, deletedAt: null }, select: { id: true } });
    if (!row) throw new Error("That task is not visible to you.");
  }
  const watcher = await tx.watcher.create({
    data: {
      userId,
      surface: input.surface ?? input.scopeKind,
      prompt: input.prompt ?? "",
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      condition: input.condition,
      daysBefore: input.daysBefore,
      action: "notify",
      message: input.message,
      status: "active",
    },
  });
  const data = { ...watcher } as unknown as Record<string, unknown>;
  await recordUndoInTransaction(tx, {
    userId,
    label: `Watch: ${watcher.message}`,
    kind: "create",
    actor: input.actor ?? "agent",
    subject: "watcher",
    href: "/settings",
    inverse: { op: "create", model: "watcher", id: watcher.id, data },
    forward: { op: "create", model: "watcher", id: watcher.id, data },
  });
  return watcher;
}

async function scopeDue(prisma: PrismaClient, userId: string, kind: string, id: string): Promise<Date | null> {
  if (kind === "deliverable") {
    const row = await prisma.deliverable.findFirst({ where: { id, userId, deletedAt: null }, select: { due: true } });
    return row?.due ?? null;
  }
  const row = await prisma.task.findFirst({ where: { id, userId, deletedAt: null }, select: { due: true } });
  return row?.due ?? null;
}

/** One pass of the reminder scheduler. Returns how many watchers fired. */
export async function evaluateWatchers(prisma: PrismaClient, userId: string, now = new Date()): Promise<number> {
  const rows = await prisma.watcher.findMany({ where: { userId, status: "active" } });
  let fired = 0;
  for (const watcher of rows) {
    let ready = false;
    if (watcher.condition === "all_tasks_done" && watcher.scopeKind === "deliverable") {
      const tasks = await prisma.task.findMany({
        where: { userId, deliverableId: watcher.scopeId, deletedAt: null },
        select: { status: true },
      });
      ready = tasks.length > 0 && tasks.every((task) => task.status === "done" || task.status === "dropped");
    } else if (watcher.condition === "days_before_due") {
      const due = await scopeDue(prisma, userId, watcher.scopeKind, watcher.scopeId);
      ready = watcherDue(due, watcher.daysBefore ?? 0, now);
    }
    if (!ready) continue;
    const won = await prisma.$transaction(async (tx) => {
      const updated = await tx.watcher.updateMany({
        where: { id: watcher.id, status: "active" },
        data: { status: "fired", firedAt: now },
      });
      if (updated.count !== 1) return false;
      await tx.notification.create({
        data: {
          userId,
          kind: "watcher",
          title: watcher.message || "Watcher",
          body: watcher.prompt,
          url: watcher.scopeKind === "task" ? `/tasks/${watcher.scopeId}` : "/today",
        },
      });
      return true;
    });
    if (won) fired += 1;
  }
  return fired;
}
