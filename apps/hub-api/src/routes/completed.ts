/** Completed tasks and deliverables beyond the board's recent slice. */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { recordUndoInTransaction } from "../lib/undo.js";

export async function completedRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.get("/api/completed", async (request) => {
    const query = z
      .object({
        q: z.string().optional(),
        kind: z.enum(["task", "deliverable", "all"]).default("all"),
        projectId: z.string().optional(),
      })
      .parse(request.query);
    const userId = request.userId;
    const needle = query.q?.trim();
    const tasks =
      query.kind === "deliverable"
        ? []
        : await prisma.task.findMany({
            where: {
              userId,
              deletedAt: null,
              status: { in: ["done", "dropped"] },
              ...(query.projectId ? { projectId: query.projectId } : {}),
              ...(needle ? { title: { contains: needle, mode: "insensitive" } } : {}),
            },
            orderBy: { completedAt: "desc" },
            take: 200,
            select: {
              id: true,
              title: true,
              status: true,
              priority: true,
              projectId: true,
              completedAt: true,
              pinned: true,
              project: { select: { name: true } },
            },
          });
    const deliverables =
      query.kind === "task"
        ? []
        : await prisma.deliverable.findMany({
            where: {
              userId,
              deletedAt: null,
              status: "completed",
              ...(query.projectId ? { projectId: query.projectId } : {}),
              ...(needle ? { title: { contains: needle, mode: "insensitive" } } : {}),
            },
            orderBy: { completedAt: "desc" },
            take: 200,
            select: { id: true, title: true, status: true, projectId: true, completedAt: true, pinned: true, project: { select: { name: true } } },
          });
    const items = [
      ...tasks.map((row) => ({
        kind: "task" as const,
        id: row.id,
        title: row.title,
        status: row.status,
        priority: row.priority,
        projectId: row.projectId,
        projectName: row.project?.name ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        pinned: row.pinned,
      })),
      ...deliverables.map((row) => ({
        kind: "deliverable" as const,
        id: row.id,
        title: row.title,
        status: row.status,
        priority: null,
        projectId: row.projectId,
        projectName: row.project?.name ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        pinned: row.pinned,
      })),
    ].sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
    return { items };
  });

  app.post("/api/tasks/:id/reopen", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.task.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!existing) return reply.code(404).send({ error: "Task not found." });
    const task = await prisma.$transaction(async (tx) => {
      const updated = await tx.task.update({ where: { id }, data: { status: "todo", completedAt: null } });
      await tx.taskTransition.create({
        data: { userId: request.userId, taskId: id, fromStatus: existing.status, toStatus: "todo", actor: "me" },
      });
      await recordUndoInTransaction(tx, {
        userId: request.userId,
        label: `Reopened “${existing.title}”`,
        kind: "update",
        actor: "me",
        subject: "task",
        inverse: { op: "update", model: "task", id, before: existing as never, after: updated as never },
        forward: { op: "update", model: "task", id, before: existing as never, after: updated as never },
      });
      return updated;
    });
    sseHub.publish(request.userId, { event: "task", data: { id } });
    return { task };
  });

  app.post("/api/deliverables/:id/reopen", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.deliverable.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!existing) return reply.code(404).send({ error: "Deliverable not found." });
    const deliverable = await prisma.deliverable.update({ where: { id }, data: { status: "upcoming", completedAt: null } });
    sseHub.publish(request.userId, { event: "deliverable", data: { id } });
    await appendLedger({ userId: request.userId, actor: "me", action: "deliverable.reopen", payload: { id } });
    return { deliverable };
  });

  app.post("/api/tasks/:id/pin", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ pinned: z.boolean() }).parse(request.body);
    const updated = await prisma.task.updateMany({ where: { id, userId: request.userId, deletedAt: null }, data: { pinned: body.pinned } });
    if (!updated.count) return reply.code(404).send({ error: "Task not found." });
    return { ok: true, pinned: body.pinned };
  });

  app.post("/api/deliverables/:id/pin", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ pinned: z.boolean() }).parse(request.body);
    const updated = await prisma.deliverable.updateMany({ where: { id, userId: request.userId, deletedAt: null }, data: { pinned: body.pinned } });
    if (!updated.count) return reply.code(404).send({ error: "Deliverable not found." });
    return { ok: true, pinned: body.pinned };
  });
}
