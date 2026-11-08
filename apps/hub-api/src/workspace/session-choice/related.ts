/**
 * What a task is tied to, for choosing a session (docs/30, Choosing a session): its project, deliverable,
 * meeting and parent page, its labels, and the tasks it names (an @mention on its page, a link to one in
 * its text or the run's instructions, a dependency). Ensemble on the web sends them with the claim of a
 * run (`related`), as the computer has none of the account's records; a computer keeps them on each run
 * it makes (`context.taskFacts`), so later runs can be matched against them.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { LinkReason } from "./score.js";

const id = z.string().min(1).max(100);

export const TaskFacts = z.object({
  /** The task's id where links to it point: the web's for a run claimed from there. */
  key: id,
  projectId: id.nullable().default(null),
  deliverableId: id.nullable().default(null),
  meetingId: id.nullable().default(null),
  parentPageId: id.nullable().default(null),
  labels: z.array(z.string().max(80)).max(50).default([]),
  named: z.array(z.object({ id, reason: z.enum(["mention", "link", "depends"]) })).max(100).default([]),
});
export type TaskFacts = z.infer<typeof TaskFacts>;

export function parseFacts(value: unknown): TaskFacts | null {
  const parsed = TaskFacts.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** `ensemble://task/<id>`, an app link (`/tasks/<id>`, `?task=<id>`), or a page mention's link form. */
const TASK_LINK = new RegExp(`(?:ensemble://task/|/tasks/|[?&]task=)(${UUID})`, "gi");

/** The tasks a task names, each once, with why: page mentions first, then links in its text, then dependencies. */
export async function namedTasks(prisma: PrismaClient, userId: string, task: { id: string; dependsOn: string[]; description: string; notes: string }, instructions = ""): Promise<Array<{ id: string; reason: LinkReason }>> {
  const page = await prisma.taskPage.findFirst({ where: { taskId: task.id }, select: { mentions: { where: { kind: "task" }, select: { entityId: true } } } });
  const found = new Map<string, LinkReason>();
  const add = (value: string, reason: LinkReason) => {
    const key = value.toLowerCase();
    if (key !== task.id && !found.has(key)) found.set(key, reason);
  };
  for (const mention of page?.mentions ?? []) add(mention.entityId, "mention");
  for (const text of [instructions, task.description, task.notes]) for (const match of text.matchAll(TASK_LINK)) add(match[1]!, "link");
  for (const value of task.dependsOn) add(value, "depends");
  if (!found.size) return [];
  const real = await prisma.task.findMany({ where: { userId, id: { in: [...found.keys()] } }, select: { id: true } });
  const ids = new Set(real.map((row) => row.id));
  return [...found.entries()].filter(([value]) => ids.has(value)).map(([value, reason]) => ({ id: value, reason })).slice(0, 100);
}

/** A task's facts from this database (the web's for a claim, or this computer's own task). */
export async function factsOf(prisma: PrismaClient, userId: string, taskId: string, instructions = ""): Promise<TaskFacts | null> {
  const task = await prisma.task.findFirst({
    where: { id: taskId, userId },
    select: { id: true, projectId: true, deliverableId: true, meetingNoteId: true, labels: true, dependsOn: true, description: true, notes: true, page: { select: { parentId: true } } },
  });
  if (!task) return null;
  return {
    key: task.id,
    projectId: task.projectId,
    deliverableId: task.deliverableId,
    meetingId: task.meetingNoteId,
    parentPageId: task.page?.parentId ?? null,
    labels: task.labels.slice(0, 50).map((label) => label.slice(0, 80)),
    named: await namedTasks(prisma, userId, task, instructions),
  };
}
