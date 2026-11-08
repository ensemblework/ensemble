/**
 * Linked sessions (docs/30, Linked sessions). A task that names another task (an @mention on its page, a link to it
 * in its text or the assign instructions, or a dependency) continues the agent session that other task
 * was done in, when the same agent would do this one: the agent keeps what it learned there, and its
 * provider can reuse the cached conversation. Only within one project (both tasks in the same Ensemble
 * project, or both in none), only on the computer the run goes to, only a session that is idle,
 * resumable, not a chat and still kept by the agent (30 days, as Claude Code keeps its own).
 *
 * The person sees which session a task would continue when they assign it and can start a new one
 * instead (`newSession`), or turn this off (Settings → Orchestration → linkedSessions).
 */
import type { PrismaClient } from "@prisma/client";
import type { CodeEngine } from "@ensemble/shared-types";
import { resolveSession, runsOfSession, type AgentSession, type SessionScope } from "./sessions.js";

export type LinkReason = "mention" | "link" | "depends";
export type LinkedSession = { session: AgentSession; taskId: string; title: string; reason: LinkReason };

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** `ensemble://task/<id>`, an app link (`/tasks/<id>`, `?task=<id>`), or a page mention's link form. */
const TASK_LINK = new RegExp(`(?:ensemble://task/|/tasks/|[?&]task=)(${ID})`, "gi");
/** How long an agent keeps a session it can resume (Claude Code's own clean-up is 30 days by default). */
export const LINKED_SESSION_MAX_AGE_MS = 30 * 86_400_000;
const ORDER: Record<LinkReason, number> = { mention: 0, link: 1, depends: 2 };

/** The tasks this one names, each once, with why: page mentions first, then links in its text, then dependencies. */
export async function namedTasks(prisma: PrismaClient, userId: string, task: { id: string; dependsOn: string[]; description: string; notes: string }, instructions = ""): Promise<Array<{ id: string; reason: LinkReason }>> {
  const page = await prisma.taskPage.findFirst({ where: { taskId: task.id }, select: { mentions: { where: { kind: "task" }, select: { entityId: true } } } });
  const found = new Map<string, LinkReason>();
  const add = (id: string, reason: LinkReason) => {
    const key = id.toLowerCase();
    if (key !== task.id && !found.has(key)) found.set(key, reason);
  };
  for (const mention of page?.mentions ?? []) add(mention.entityId, "mention");
  for (const text of [instructions, task.description, task.notes]) for (const match of text.matchAll(TASK_LINK)) add(match[1]!, "link");
  for (const id of task.dependsOn) add(id, "depends");
  if (!found.size) return [];
  const real = await prisma.task.findMany({ where: { userId, id: { in: [...found.keys()] } }, select: { id: true } });
  const ids = new Set(real.map((row) => row.id));
  return [...found.entries()].filter(([id]) => ids.has(id)).map(([id, reason]) => ({ id, reason }));
}

/**
 * The session a new run of `task` by `engine` continues, or null for a new session. `deviceId`: the
 * computer the run goes to (null: this computer, or any when the request named none).
 */
export async function linkedSessionFor(
  prisma: PrismaClient,
  scope: SessionScope,
  input: { task: { id: string; projectId: string | null; dependsOn: string[]; description: string; notes: string }; engine: CodeEngine; deviceId: string | null; anyDevice?: boolean; instructions?: string; now?: Date },
): Promise<LinkedSession | null> {
  const named = await namedTasks(prisma, scope.space, input.task, input.instructions ?? "");
  if (!named.length) return null;
  const reasonOf = new Map(named.map((row) => [row.id, row.reason]));
  const runs = await prisma.workspaceJob.findMany({
    where: { userId: scope.space, runnerAccountId: scope.runner, taskId: { in: named.map((row) => row.id) }, kind: "code", provider: input.engine, OR: [{ startedAt: { not: null } }, { claimedAt: { not: null } }] },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, taskId: true },
  });
  const now = (input.now ?? new Date()).getTime();
  const seen = new Set<string>();
  const usable: LinkedSession[] = [];
  for (const run of runs) {
    const session = await resolveSession(prisma, scope, run.id);
    if (!session || seen.has(session.id)) continue;
    seen.add(session.id);
    if (session.agent !== input.engine || !session.resumable || session.chat || session.status !== "idle") continue;
    if (now - new Date(session.lastActiveAt).getTime() > LINKED_SESSION_MAX_AGE_MS) continue;
    if (!input.anyDevice && session.deviceId !== input.deviceId) continue;
    // Never across projects: every task the session worked on is in this task's project (or none is, as here).
    const taskIds = [...new Set((await runsOfSession(prisma, scope, session.id)).map((row) => row.taskId))];
    const projects = await prisma.task.findMany({ where: { id: { in: taskIds } }, select: { projectId: true } });
    if (projects.length !== taskIds.length || projects.some((row) => row.projectId !== input.task.projectId)) continue;
    const title = (await prisma.task.findUnique({ where: { id: run.taskId }, select: { title: true } }))?.title ?? "";
    usable.push({ session, taskId: run.taskId, title, reason: reasonOf.get(run.taskId) ?? "link" });
  }
  usable.sort((a, b) => ORDER[a.reason] - ORDER[b.reason] || b.session.lastActiveAt.localeCompare(a.session.lastActiveAt));
  return usable[0] ?? null;
}

/** Why, in words for the assign dialog and the run's record. */
export function linkWords(link: Pick<LinkedSession, "reason" | "title">): string {
  const title = `“${link.title.slice(0, 80)}”`;
  return link.reason === "mention" ? `This task mentions ${title}` : link.reason === "depends" ? `This task depends on ${title}` : `This task links to ${title}`;
}
