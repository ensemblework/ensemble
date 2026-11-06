/**
 * "Needs you" notifications (the bell's Needs me) last only while what they are about still waits:
 * a run's question or permission (`decision:<id>`), or a board task a run left blocked (`task:<id>`),
 * the same things the Needs me page lists.
 * Answered anywhere (here, Ensemble Node, the CLI, a phone), expired, cancelled, retried, done or
 * deleted, they leave the bell at once and are marked read. Notifications saved before they named their
 * subject are matched by their title (a decision) or their link (`/tasks/<id>`).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { isNodeTask } from "../lib/node-tasks.js";
import { NODE_TOOL_DECISION } from "../node/device-tool-decisions.js";
import { nodeNeedsInEnsemble, nodeRunJobs } from "../node/needs-me.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** The bell's Needs me kinds. */
export const NEEDS_KINDS = new Set(["decision", "agent"]);

export type NeedsRow = { id: string; kind: string; title: string; url: string | null; subject: string | null; createdAt: Date };

const subjectId = (subject: string | null, kind: string): string | null => (subject?.startsWith(`${kind}:`) ? subject.slice(kind.length + 1) : null);
const taskFromUrl = (url: string | null): string | null => /^\/tasks\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(url ?? "")?.[1] ?? null;

/** Which of these notifications no longer need the person. */
export async function staleNeeds(db: Db, userId: string, rows: NeedsRow[]): Promise<Set<string>> {
  const stale = new Set<string>();
  const needs = rows.filter((row) => NEEDS_KINDS.has(row.kind));
  if (!needs.length) return stale;
  const now = new Date();
  const decisionRows = needs.filter((row) => row.kind === "decision");
  const taskRows = needs.filter((row) => row.kind === "agent");

  if (decisionRows.length) {
    const select = { id: true, title: true, status: true, expiresAt: true, source: true, toolName: true, sessionId: true } as const;
    const ids = decisionRows.map((row) => subjectId(row.subject, "decision")).filter((id): id is string => Boolean(id));
    const named = ids.length ? await db.agentDecision.findMany({ where: { id: { in: ids }, userId }, select }) : [];
    // Older notifications name no subject: they still wait only while a pending request with their title does.
    const legacy = decisionRows.some((row) => !subjectId(row.subject, "decision"));
    const pending = legacy ? await db.agentDecision.findMany({ where: { userId, status: "pending", expiresAt: { gt: now } }, select, take: 200 }) : [];
    const all = [...named, ...pending];
    const hideNodeRuns = !(await nodeNeedsInEnsemble(db as PrismaClient, userId));
    const nodeJobs = hideNodeRuns ? await nodeRunJobs(db as PrismaClient, all.map((row) => row.sessionId)) : new Set<string>();
    const waits = (row: (typeof all)[number]) =>
      row.status === "pending" &&
      row.expiresAt > now &&
      // A node's own computer-tool question is answered in the Node chat only.
      !(row.source === "ensemble" && row.toolName === NODE_TOOL_DECISION) &&
      !(row.sessionId && nodeJobs.has(row.sessionId));
    const byId = new Map(named.map((row) => [row.id, row]));
    for (const row of decisionRows) {
      const id = subjectId(row.subject, "decision");
      if (id) {
        const decision = byId.get(id);
        if (!decision || !waits(decision)) stale.add(row.id);
        continue;
      }
      const open = pending.some((decision) => waits(decision) && decision.title.trim().length > 0 && row.title.includes(decision.title.trim().slice(0, 120)));
      if (!open) stale.add(row.id);
    }
  }

  if (taskRows.length) {
    const ids = [...new Set(taskRows.map((row) => subjectId(row.subject, "task") ?? taskFromUrl(row.url)).filter((id): id is string => Boolean(id)))];
    const tasks = ids.length ? await db.task.findMany({ where: { id: { in: ids }, userId }, select: { id: true, status: true, deletedAt: true, sourceRef: true } }) : [];
    const byId = new Map(tasks.map((task) => [task.id, task]));
    // A run started again after the notification (retried, reassigned) supersedes it.
    const jobs = ids.length ? await db.workspaceJob.findMany({ where: { taskId: { in: ids } }, select: { taskId: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 500 }) : [];
    const latestJob = new Map<string, number>();
    for (const job of jobs) if (!latestJob.has(job.taskId)) latestJob.set(job.taskId, job.createdAt.getTime());
    for (const row of taskRows) {
      const id = subjectId(row.subject, "task") ?? taskFromUrl(row.url);
      const task = id ? byId.get(id) : undefined;
      const retried = id ? (latestJob.get(id) ?? 0) > row.createdAt.getTime() : false;
      // The bell's Needs me matches the Needs me page: a task waits while it is blocked or waiting on the
      // board. Runs a node started report in its chat, where the node goes on: they never wait here.
      const waiting = task?.status === "blocked" || task?.status === "waiting_approval";
      if (!task || task.deletedAt || !waiting || isNodeTask(task) || retried) stale.add(row.id);
    }
  }
  return stale;
}
