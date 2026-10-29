/**
 * `node_overview` (docs/35 §6): what a node's owner is working on across every space they can open,
 * read-only. Tasks that are theirs, what is due, and agent runs they have going, each with its space.
 * It answers only where just the owner reads and the owner asked: the list spans spaces other people
 * in a room cannot see.
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool } from "../assistant/types.js";
import { zonedParts } from "../lib/clock.js";
import { ON_BOARD } from "../lib/node-tasks.js";
import { nodeSpaces, type NodeSpace } from "./spaces.js";
import type { NodeScope } from "./tools.js";

const ENDED_TASK = ["done", "dropped"] as const;
const ENDED_RUN = ["succeeded", "failed", "cancelled", "interrupted"] as const;
const MAX_TASKS = 40;
const MAX_DUE = 30;
const MAX_RUNS = 20;

const day = (date: Date | null | undefined): string | null => (date ? date.toISOString().slice(0, 10) : null);

/** Tasks that are the owner's in a space: theirs by default in their own spaces, assigned to them by name in others. */
function mine(space: NodeSpace, accountId: string): Prisma.TaskWhereInput {
  return space.role === "owner"
    ? { owner: "me", OR: [{ assigneeAccountId: null }, { assigneeAccountId: accountId }] }
    : { owner: "me", assigneeAccountId: accountId };
}

/** Runs the owner started: theirs in their own spaces, on their computer in spaces shared with them. */
function theirRuns(space: NodeSpace, accountId: string): Prisma.WorkspaceJobWhereInput {
  return space.role === "owner" ? { OR: [{ runnerAccountId: null }, { runnerAccountId: accountId }] } : { runnerAccountId: accountId };
}

export function overviewTool(scope: Pick<NodeScope, "prisma" | "node" | "ownerOnly" | "lineage">): AnyHubTool {
  const { prisma, node } = scope;
  return defineTool({
    name: "node_overview",
    area: "tasks",
    description:
      "What your owner is working on across every space they can open: open tasks that are theirs, what is due (overdue and the next days), and agent runs they have going, each with its space. Read-only. Use it for “what am I working on?”, “what's due?” and before planning their day; change a task with the Ensemble tools and its space.",
    input: z.object({ days: z.number().int().min(1).max(60).optional().describe("How many days ahead count as due. Default 7.") }).strict(),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      if (!scope.ownerOnly || scope.lineage.fromNonOwner) throw new ToolBlockedError("Your owner's work across their spaces is listed only in a chat with just your owner.");
      const owner = node.userId;
      const spaces = await nodeSpaces(prisma, owner);
      const byId = new Map(spaces.map((space) => [space.id, space]));
      const where = (id: string) => byId.get(id)?.name ?? "a space";
      const today = zonedParts(ctx.settings.timezone).date;
      const until = new Date(`${today}T23:59:59.999Z`);
      until.setUTCDate(until.getUTCDate() + (input.days ?? 7));
      const open = { deletedAt: null, status: { notIn: [...ENDED_TASK] }, ...ON_BOARD } satisfies Prisma.TaskWhereInput;
      const taskWhere: Prisma.TaskWhereInput = { ...open, OR: spaces.map((space) => ({ userId: space.id, ...mine(space, owner) })) };
      const own = spaces.filter((space) => space.role === "owner").map((space) => space.id);
      const [tasks, dueTasks, deliverables, reminders, runs] = await Promise.all([
        prisma.task.findMany({
          where: taskWhere,
          orderBy: [{ due: { sort: "asc", nulls: "last" } }, { updatedAt: "desc" }],
          take: MAX_TASKS,
          select: { id: true, userId: true, title: true, status: true, priority: true, due: true },
        }),
        prisma.task.findMany({ where: { AND: [taskWhere, { due: { not: null, lte: until } }] }, orderBy: { due: "asc" }, take: MAX_DUE, select: { id: true, userId: true, title: true, status: true, due: true } }),
        // Deliverables and reminders are the space owner's: only the owner's own spaces bring theirs.
        prisma.deliverable.findMany({ where: { userId: { in: own }, deletedAt: null, status: "upcoming", due: { not: null, lte: until } }, orderBy: { due: "asc" }, take: MAX_DUE, select: { id: true, userId: true, title: true, due: true } }),
        prisma.reminder.findMany({ where: { userId: { in: own }, deletedAt: null, dismissedAt: null, dueDate: { lte: day(until)! } }, orderBy: { dueDate: "asc" }, take: MAX_DUE, select: { id: true, userId: true, title: true, dueDate: true, dueTime: true } }),
        prisma.workspaceJob.findMany({
          where: { status: { notIn: [...ENDED_RUN] }, OR: spaces.map((space) => ({ userId: space.id, ...theirRuns(space, owner) })) },
          orderBy: { createdAt: "desc" },
          take: MAX_RUNS,
          select: { id: true, userId: true, status: true, provider: true, progress: true, createdAt: true, startedAt: true, task: { select: { title: true } }, device: { select: { name: true } } },
        }),
      ]);
      const due = [
        ...dueTasks.map((row) => ({ kind: "task", id: row.id, title: row.title, due: day(row.due), status: row.status, space: where(row.userId), spaceId: row.userId })),
        ...deliverables.map((row) => ({ kind: "deliverable", id: row.id, title: row.title, due: day(row.due), space: where(row.userId), spaceId: row.userId })),
        ...reminders.map((row) => ({ kind: "reminder", id: row.id, title: row.title, due: row.dueTime ? `${row.dueDate} ${row.dueTime}` : row.dueDate, space: where(row.userId), spaceId: row.userId })),
      ]
        .sort((a, b) => String(a.due).localeCompare(String(b.due)))
        .slice(0, MAX_DUE)
        .map((row) => ({ ...row, ...(row.due && row.due.slice(0, 10) < today ? { overdue: true } : {}) }));
      const data = {
        today,
        dueUntil: day(until),
        spaces: spaces.map((space) => ({ id: space.id, name: space.name, role: space.role, ...(space.ownerName ? { sharedBy: space.ownerName } : {}) })),
        tasks: tasks.map((row) => ({ id: row.id, title: row.title, status: row.status, priority: row.priority, ...(row.due ? { due: day(row.due) } : {}), space: where(row.userId), spaceId: row.userId })),
        due,
        runs: runs.map((row) => ({
          jobId: row.id,
          task: row.task.title,
          status: row.status,
          agent: row.provider,
          computer: row.device?.name ?? null,
          progress: row.progress,
          since: (row.startedAt ?? row.createdAt).toISOString(),
          space: where(row.userId),
          spaceId: row.userId,
        })),
      };
      const reached = new Set([...data.tasks, ...data.due, ...data.runs].map((row) => row.spaceId));
      return toolOk(
        `${data.tasks.length} open task${data.tasks.length === 1 ? "" : "s"}, ${due.length} due by ${data.dueUntil} and ${data.runs.length} run${data.runs.length === 1 ? "" : "s"} going, in ${reached.size} of ${spaces.length} space${spaces.length === 1 ? "" : "s"}.`,
        data,
      );
    },
  });
}
