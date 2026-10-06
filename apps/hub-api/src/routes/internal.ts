import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { hasModule, MODULE_DENIED } from "@ensemble/shared-types";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { prisma } from "../lib/prisma.js";
import { assertOwned } from "../services/records.js";

function assertInternal(request: FastifyRequest): void {
  const token = request.headers["x-ensemble-internal"];
  if (token !== env.ENSEMBLE_INTERNAL_TOKEN) {
    const error = new Error("Unauthorized internal call.");
    (error as Error & { statusCode: number }).statusCode = 401;
    throw error;
  }
}

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/internal/ledger", async (request, reply) => {
    assertInternal(request);
    const body = z
      .object({
        actor: z.enum(["agent", "me", "system"]).default("agent"),
        action: z.string(),
        taskId: z.string().optional(),
        runId: z.string().optional(),
        payload: z.unknown().optional(),
      })
      .parse(request.body);
    if (body.taskId) await assertOwned(prisma, request.userId, "task", body.taskId);
    if (body.runId) {
      const run = await prisma.run.findFirst({ where: { id: body.runId, userId: request.userId, deletedAt: null }, select: { id: true } });
      if (!run) return reply.code(404).send({ error: "Run not found." });
    }
    await appendLedger({
      userId: request.userId,
      actor: body.actor,
      action: body.action,
      taskId: body.taskId,
      runId: body.runId,
      payload: (body.payload ?? {}) as never,
    });
    return reply.code(204).send();
  });

  app.post("/api/internal/runs/:id/steps", async (request, reply) => {
    assertInternal(request);
    if (!hasModule(request.modules, "runs")) return reply.code(404).send({ error: MODULE_DENIED });
    const { id } = request.params as { id: string };
    const body = z
      .object({
        index: z.number().int().min(0).optional(),
        title: z.string().optional(),
        status: z.enum(["pending", "running", "done", "failed", "needs_approval", "skipped"]).optional(),
        output: z.string().optional(),
        error: z.string().optional(),
        toolCalls: z.unknown().optional(),
        model: z.string().optional(),
        tokensIn: z.number().optional(),
        tokensOut: z.number().optional(),
        credits: z.number().optional(),
      })
      .parse(request.body ?? {});
    const run = await prisma.run.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!run) return reply.code(404).send({ error: "Run not found." });
    const index = body.index ?? run.cursor;
    const step = await prisma.runStep.upsert({
      where: { runId_index: { runId: id, index } },
      create: {
        runId: id,
        index,
        title: body.title ?? `Step ${index + 1}`,
        status: (body.status as never) ?? "running",
        output: body.output,
        error: body.error,
        toolCalls: (body.toolCalls ?? []) as never,
        model: body.model,
        tokensIn: body.tokensIn,
        tokensOut: body.tokensOut,
        credits: body.credits,
        startedAt: new Date(),
      },
      update: {
        title: body.title,
        status: body.status as never,
        output: body.output,
        error: body.error,
        toolCalls: body.toolCalls as never,
        model: body.model,
        tokensIn: body.tokensIn,
        tokensOut: body.tokensOut,
        credits: body.credits,
        endedAt: body.status && body.status !== "running" ? new Date() : undefined,
      },
    });
    await prisma.run.update({ where: { id }, data: { cursor: index } });
    return { step };
  });
}
