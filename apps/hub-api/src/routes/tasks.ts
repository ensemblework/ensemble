import type { FastifyInstance } from "fastify";
import { CreateTask, PatchTask } from "@ensemble/shared-types";
import { prisma } from "../lib/prisma.js";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { lastUndoId } from "../lib/undo.js";
import { hidesSignupStarters } from "../marketplace/starters.js";
import { createTask, updateTask } from "../services/tasks.js";
import { getTaskPage, saveTaskPage, TaskPageError } from "../pages/store.js";

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

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/tasks", async (request) => {
    const userId = request.userId;
    const hideStarters = await hidesSignupStarters(prisma, userId);
    const tasks = await prisma.task.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(hideStarters ? { NOT: { sourceRef: { startsWith: "template:" } } } : {}),
      },
      orderBy: [{ boardOrder: "asc" }, { createdAt: "desc" }],
    });
    return { tasks: tasks.map(serializeTask) };
  });

  app.get("/api/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = await prisma.task.findFirst({
      where: { id, userId: request.userId, deletedAt: null },
    });
    if (!task) return reply.code(404).send({ error: "Task not found." });
    return { task: serializeTask(task) };
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
    return reply.code(201).send({ task: serializeTask(created.task), undoEntryId: created.undoEntryId });
  });

  app.patch("/api/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = PatchTask.parse(request.body);
    const userId = request.userId;
    let task;
    try {
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
    return { task: serializeTask(task.updated), undoEntryId: task.undoEntryId };
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
      sseHub.publish(request.userId, { event: "page", data: { taskId: id } });
      return page;
    } catch (error) {
      if (error instanceof TaskPageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
