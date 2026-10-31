import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CreateTask, PatchTask } from "@ensemble/shared-types";
import { prisma } from "../lib/prisma.js";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { lastUndoId } from "../lib/undo.js";
import { isGuestIn } from "../sharing/context.js";
import { hidesSignupStarters } from "../marketplace/starters.js";
import { answerRequestedMove, createTask, updateTask } from "../services/tasks.js";
import { accountIdOf } from "../lib/auth.js";
import { getTaskPage, saveTaskPage, TaskPageError } from "../pages/store.js";
import { NODE_TASK } from "../lib/node-tasks.js";

export function serializeTask(task: {
  due: Date | null;
  snoozedUntil: Date | null;
  nudgePausedUntil?: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
}) {
  return {
    ...task,
    due: task.due?.toISOString() ?? null,
    snoozedUntil: task.snoozedUntil?.toISOString() ?? null,
    nudgePausedUntil: task.nudgePausedUntil?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

type NodeAssignee = { kind: "node" | "crew"; id: string; name: string; handle: string | null; accountId: string };

/**
 * The node or crew each task with one is with (owner "node"), by its public fields, so everyone who sees the
 * task sees who has it: a node's name and handle, a crew's title for its own person only.
 */
async function nodeAssignees(viewer: string, tasks: ReadonlyArray<{ owner: string; assigneeNodeId?: string | null; assigneeRoomId?: string | null }>): Promise<Map<string, NodeAssignee>> {
  const held = tasks.filter((task) => task.owner === "node");
  const nodeIds = [...new Set(held.map((task) => task.assigneeNodeId).filter((id): id is string => Boolean(id)))];
  const roomIds = [...new Set(held.map((task) => task.assigneeRoomId).filter((id): id is string => Boolean(id)))];
  const [nodes, rooms] = await Promise.all([
    nodeIds.length ? prisma.nodeAgent.findMany({ where: { id: { in: nodeIds } }, select: { id: true, name: true, slug: true, userId: true } }) : [],
    roomIds.length ? prisma.nodeRoom.findMany({ where: { id: { in: roomIds }, kind: "crew" }, select: { id: true, title: true, userId: true } }) : [],
  ]);
  const found = new Map<string, NodeAssignee>();
  for (const node of nodes) found.set(node.id, { kind: "node", id: node.id, name: node.name, handle: node.slug, accountId: node.userId });
  for (const room of rooms) found.set(room.id, { kind: "crew", id: room.id, name: room.userId === viewer ? room.title : "Crew", handle: null, accountId: room.userId });
  return found;
}

type Held = Parameters<typeof serializeTask>[0] & { owner: string; assigneeNodeId?: string | null; assigneeRoomId?: string | null };

function withNodeAssignee(task: Held, found: Map<string, NodeAssignee>) {
  return { ...serializeTask(task), ...(task.owner === "node" ? { nodeAssignee: found.get(task.assigneeNodeId ?? task.assigneeRoomId ?? "") ?? null } : {}) };
}

async function presentTask(viewer: string, task: Held) {
  return withNodeAssignee(task, await nodeAssignees(viewer, [task]));
}

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/tasks", async (request) => {
    const { board } = z.object({ board: z.enum(["default"]).optional() }).parse(request.query ?? {});
    const userId = request.userId;
    const hideStarters = await hidesSignupStarters(prisma, userId);
    const tasks = await prisma.task.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(board ? { OR: [{ page: null }, { page: { boardId: null } }] } : {}),
        NOT: [NODE_TASK, ...(hideStarters ? [{ sourceRef: { startsWith: "template:" } }] : [])],
      },
      orderBy: [{ boardOrder: "asc" }, { createdAt: "desc" }],
    });
    const found = await nodeAssignees(accountIdOf(request), tasks);
    return { tasks: tasks.map((task) => withNodeAssignee(task, found)) };
  });

  app.get("/api/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = await prisma.task.findFirst({
      where: { id, userId: request.userId, deletedAt: null },
    });
    if (!task) {
      // The owner is told a task is in Trash, so the Hub can offer Restore instead of "not found".
      const binned = isGuestIn(request.userId) ? null : await prisma.task.findFirst({ where: { id, userId: request.userId, deletedAt: { not: null } }, select: { id: true } });
      return reply.code(404).send(binned ? { error: "This task is in Trash.", code: "TASK_IN_TRASH" } : { error: "Task not found." });
    }
    return { task: await presentTask(accountIdOf(request), task) };
  });

  app.post("/api/tasks", async (request, reply) => {
    const body = CreateTask.parse(request.body);
    const userId = request.userId;
    const created = await prisma.$transaction(async (tx) => {
      const task = await createTask(tx, userId, body, "me");
      return { task, undoEntryId: lastUndoId(tx) ?? null };
    });
    await appendLedger({ userId, actor: "me", action: "task.create", taskId: created.task.id });
    sseHub.publish(userId, { event: "task", data: { id: created.task.id, action: "create" } });
    return reply.code(201).send({ task: await presentTask(accountIdOf(request), created.task), undoEntryId: created.undoEntryId });
  });

  app.patch("/api/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = PatchTask.parse(request.body);
    const userId = request.userId;
    let task;
    try {
      // Out of `proposed`, a task someone asked for in a room answers its request (services/tasks.ts).
      const existing = body.status ? await prisma.task.findFirst({ where: { id, userId, deletedAt: null } }) : null;
      const answered = existing ? await answerRequestedMove({ accountId: accountIdOf(request), task: existing, status: body.status! }) : null;
      if (answered) {
        sseHub.publish(userId, { event: "task", data: { id, action: "update" } });
        return { task: serializeTask(answered.task), undoEntryId: null, answered: answered.message };
      }
      task = await prisma.$transaction(async (tx) => {
        const updated = await updateTask(tx, userId, id, body, "me");
        return { updated, undoEntryId: lastUndoId(tx) ?? null };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Task not found.";
      const status = (error as { statusCode?: number }).statusCode ?? (message.includes("not on your board") ? 404 : 400);
      return reply.code(status).send({ error: message });
    }
    await appendLedger({ userId, actor: "me", action: "task.update", taskId: id });
    sseHub.publish(userId, { event: "task", data: { id, action: "update" } });
    return { task: await presentTask(accountIdOf(request), task.updated), undoEntryId: task.undoEntryId };
  });

  app.get("/api/tasks/:id/page", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await getTaskPage(prisma, request.userId, id);
    } catch (error) {
      if (error instanceof TaskPageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.put("/api/tasks/:id/page", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const page = await saveTaskPage(prisma, request.userId, id, request.body);
      sseHub.publish(request.userId, { event: "page", data: { taskId: id, action: "save", revision: page.revision } });
      return page;
    } catch (error) {
      if (error instanceof TaskPageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
