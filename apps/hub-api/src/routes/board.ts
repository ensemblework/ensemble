import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { TaskStatus } from "@ensemble/shared-types";
import { hasModule } from "@ensemble/shared-types";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { lastUndoId, recordUndoInTransaction } from "../lib/undo.js";
import { loadSettings } from "../lib/settings.js";
import { assertOwned, createReminder, softDelete } from "../services/records.js";

const MoveBody = z.object({
  status: TaskStatus,
  /** Neighbours after the drop. The new order sits between them. */
  beforeId: z.string().uuid().nullish(),
  afterId: z.string().uuid().nullish(),
});
const DateInput = z.string().refine((value) => !Number.isNaN(new Date(value).getTime()), "Use a valid date.");

export async function boardRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  /**
   * Drag and drop on the board. The engineer is authoritative here: the
   * state machine guards the agent, not a person moving their own card, so a
   * board move may cross any column. It is still journaled and undoable.
   */
  app.post("/api/tasks/:id/move", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = MoveBody.parse(request.body);
    const userId = request.userId;
    const existing = await prisma.task.findFirst({ where: { id, userId, deletedAt: null } });
    if (!existing) return reply.code(404).send({ error: "Task not found." });

    const [before, after] = await Promise.all([
      body.beforeId ? prisma.task.findFirst({ where: { id: body.beforeId, userId, deletedAt: null }, select: { boardOrder: true } }) : null,
      body.afterId ? prisma.task.findFirst({ where: { id: body.afterId, userId, deletedAt: null }, select: { boardOrder: true } }) : null,
    ]);
    if ((body.beforeId && !before) || (body.afterId && !after)) return reply.code(404).send({ error: "Neighbour task not found." });
    let boardOrder: number;
    if (before && after) boardOrder = (before.boardOrder + after.boardOrder) / 2;
    else if (before) boardOrder = before.boardOrder + 1;
    else if (after) boardOrder = after.boardOrder - 1;
    else boardOrder = existing.boardOrder;

    const task = await prisma.$transaction(async (tx) => {
      const updated = await tx.task.update({
        where: { id },
        data: {
          status: body.status,
          boardOrder,
          completedAt: body.status === "done" ? existing.completedAt ?? new Date() : null,
        },
      });
      if (existing.status !== body.status) {
        await tx.taskTransition.create({
          data: {
            userId,
            taskId: id,
            fromStatus: existing.status,
            toStatus: body.status,
            fromOwner: existing.owner,
            toOwner: existing.owner,
            actor: "me",
            reason: "board",
          },
        });
      }
      await recordUndoInTransaction(tx, {
        userId,
        label: existing.status === body.status ? `Reordered “${existing.title}”` : `Moved “${existing.title}”`,
        kind: "update",
        subject: "task",
        href: `/tasks/${id}`,
        inverse: {
          op: "update",
          model: "task",
          id,
          before: existing as unknown as Record<string, unknown>,
          after: updated as unknown as Record<string, unknown>,
        },
        forward: {
          op: "update",
          model: "task",
          id,
          before: existing as unknown as Record<string, unknown>,
          after: updated as unknown as Record<string, unknown>,
        },
      });
      return { updated, undoEntryId: lastUndoId(tx) ?? null };
    });
    sseHub.publish(userId, { event: "task", data: { id, action: "move" } });
    return {
      task: { id: task.updated.id, status: task.updated.status, boardOrder: task.updated.boardOrder },
      undoEntryId: task.undoEntryId,
    };
  });

  app.delete("/api/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.task.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!existing) return reply.code(404).send({ error: "Task not found." });
    const removed = await prisma.$transaction(async (tx) => {
      const result = await softDelete(tx, request.userId, "task", id, "me");
      return { ...result, undoEntryId: lastUndoId(tx) ?? null };
    });
    await appendLedger({ userId: request.userId, actor: "me", action: "task.delete", taskId: id });
    sseHub.publish(request.userId, { event: "task", data: { id, action: "delete" } });
    return { undoEntryId: removed.undoEntryId, label: removed.label };
  });

  app.get("/api/tasks/:id/transitions", async (request) => {
    const { id } = request.params as { id: string };
    await assertOwned(prisma, request.userId, "task", id);
    const transitions = await prisma.taskTransition.findMany({
      where: { taskId: id, userId: request.userId },
      orderBy: { at: "desc" },
      take: 50,
    });
    return { transitions };
  });

  app.get("/api/tasks/:id/runs", async (request) => {
    const { id } = request.params as { id: string };
    await assertOwned(prisma, request.userId, "task", id);
    if (!hasModule(request.modules, "runs")) return { runs: [] };
    const runs = await prisma.run.findMany({
      where: { taskId: id, userId: request.userId, deletedAt: null },
      orderBy: { startedAt: "desc" },
      take: 5,
      include: { steps: { orderBy: { index: "asc" }, select: { model: true, credits: true } } },
    });
    return { runs };
  });

  // ── deliverables ────────────────────────────────────────────────────────

  app.get("/api/deliverables", async (request) => {
    const { includeCompleted } = request.query as { includeCompleted?: string };
    const deliverables = await prisma.deliverable.findMany({
      where: {
        userId: request.userId,
        deletedAt: null,
        ...(includeCompleted === "true" ? {} : { status: "upcoming" }),
      },
      orderBy: [{ status: "asc" }, { due: "asc" }, { createdAt: "asc" }],
      include: { project: { select: { id: true, name: true } } },
    });
    return { deliverables };
  });

  app.post("/api/deliverables", async (request, reply) => {
    const body = z
      .object({ title: z.string().min(1), projectId: z.string().uuid(), due: DateInput.nullish() })
      .parse(request.body);
    await assertOwned(prisma, request.userId, "project", body.projectId);
    const deliverable = await prisma.deliverable.create({
      data: {
        userId: request.userId,
        projectId: body.projectId,
        title: body.title,
        due: body.due ? new Date(body.due) : null,
        createdBy: "me",
      },
    });
    sseHub.publish(request.userId, { event: "deliverable", data: { id: deliverable.id } });
    return reply.code(201).send({ deliverable });
  });

  app.patch("/api/deliverables/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        title: z.string().min(1).optional(),
        status: z.enum(["upcoming", "completed"]).optional(),
        due: DateInput.nullish(),
        notes: z.string().optional(),
      })
      .parse(request.body);
    const existing = await prisma.deliverable.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!existing) return reply.code(404).send({ error: "Deliverable not found." });
    const deliverable = await prisma.deliverable.update({
      where: { id },
      data: {
        title: body.title,
        notes: body.notes,
        status: body.status,
        due: body.due === undefined ? undefined : body.due ? new Date(body.due) : null,
        completedAt: body.status === "completed" ? new Date() : body.status === "upcoming" ? null : undefined,
      },
    });
    sseHub.publish(request.userId, { event: "deliverable", data: { id } });
    return { deliverable };
  });

  // ── reminders (private; never graph or retrieval nodes) ─────────────────

  app.post("/api/reminders", async (request, reply) => {
    const body = z
      .object({
        title: z.string().min(1),
        dueDate: z.string(),
        dueTime: z.string().nullish(),
        timeZone: z.string().optional(),
      })
      .parse(request.body);
    const settings = await loadSettings(prisma, request.userId);
    try {
      const reminder = await prisma.$transaction((tx) =>
        createReminder(tx, request.userId, { ...body, timeZone: body.timeZone || settings.timezone }, "me"),
      );
      return reply.code(201).send({ reminder });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Could not save that reminder." });
    }
  });

  app.delete("/api/deliverables/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = await prisma.$transaction((tx) => softDelete(tx, request.userId, "deliverable", id, "me"));
      sseHub.publish(request.userId, { event: "deliverable", data: { id, action: "delete" } });
      return { ok: true, label: result.label };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "Deliverable not found." });
    }
  });

  app.delete("/api/reminders/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = await prisma.$transaction((tx) => softDelete(tx, request.userId, "reminder", id, "me"));
      return { ok: true, label: result.label };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "Reminder not found." });
    }
  });

  app.post("/api/reminders/:id/dismiss", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await prisma.reminder.updateMany({ where: { id, userId: request.userId, deletedAt: null }, data: { dismissedAt: new Date() } });
    if (!result.count) return reply.code(404).send({ error: "Reminder not found." });
    return reply.code(204).send();
  });

  // ── calendar ────────────────────────────────────────────────────────────

  app.get("/api/calendar", async (request) => {
    const query = z.object({
      from: DateInput,
      to: DateInput,
    }).refine((value) => new Date(value.from) < new Date(value.to), { message: "from must be before to." }).parse(request.query);
    const events = await prisma.artifact.findMany({
      where: {
        userId: request.userId,
        kind: "event",
        deletedAt: null,
        ts: { gte: new Date(query.from), lt: new Date(query.to) },
      },
      orderBy: { ts: "asc" },
      select: { id: true, title: true, ts: true, url: true, metadata: true, participants: true },
    });
    const sync = await prisma.syncState.findMany({
      where: { userId: request.userId, connector: { in: ["google_calendar", "outlook_calendar"] } },
    });
    return {
      events: events.map((event) => {
        const meta = (event.metadata ?? {}) as { end?: string; allDay?: boolean; joinUrl?: string; location?: string };
        return {
          id: event.id,
          title: event.title,
          start: event.ts.toISOString(),
          end: meta.end ?? null,
          allDay: Boolean(meta.allDay),
          joinUrl: meta.joinUrl ?? event.url ?? null,
          location: meta.location ?? null,
        };
      }),
      sync: sync.map((row) => ({
        connector: row.connector,
        lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
        lastError: row.lastError,
      })),
    };
  });

  // ── needs me ────────────────────────────────────────────────────────────

  app.post("/api/approvals/:id/decide", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        decision: z.enum(["approved", "edited", "rejected"]),
        editedPayload: z.unknown().optional(),
        reason: z.string().optional(),
      })
      .parse(request.body);
    const approval = await prisma.approval.findFirst({ where: { id, userId: request.userId } });
    if (!approval) return reply.code(404).send({ error: "Approval not found." });
    if (approval.decision) return reply.code(409).send({ error: "This was already decided." });
    const decided = await prisma.approval.update({
      where: { id },
      data: {
        decision: body.decision,
        editedPayload: body.editedPayload === undefined ? undefined : (body.editedPayload as never),
        reason: body.reason,
        decidedAt: new Date(),
      },
    });
    await appendLedger({
      userId: request.userId,
      actor: "me",
      action: `approval.${body.decision}`,
      runId: approval.runId,
      taskId: approval.taskId ?? undefined,
      approvalId: id,
    });
    sseHub.publish(request.userId, { event: "approval", data: { id, decision: body.decision } });
    return { approval: decided };
  });
}
