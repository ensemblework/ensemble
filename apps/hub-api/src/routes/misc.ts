import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { env } from "../config.js";
import { schedulerSnapshot } from "../jobs/scheduler-clock.js";
import { deployedCommit, healthTimeoutMs, probeAgent, probeRedis, readDeepHealth, schedulerStaleMs } from "../lib/health.js";
import { useInProcessRuntime } from "../runtime/mode.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { sseHandler } from "../lib/sse.js";
import { redoLast, undoLast } from "../lib/undo.js";

const HistoryBody = z.object({ entryId: z.string().min(1).optional() });


async function ready(reply: FastifyReply) {
  const timeoutMs = healthTimeoutMs();
  const body = await readDeepHealth({
    postgres: () => prisma.$queryRaw`SELECT 1`,
    redis: () => probeRedis(redis),
    agent: () => (useInProcessRuntime() ? Promise.resolve() : probeAgent(env.AGENT_RUNTIME_URL, timeoutMs)),
    scheduler: schedulerSnapshot(),
    timeoutMs,
    staleMs: schedulerStaleMs(),
  });
  return reply.code(body.ok ? 200 : 503).send(body);
}

export async function miscRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (request, reply) => {
    const deep = (request.query as { deep?: string }).deep;
    if (deep === "1" || deep === "true") return ready(reply);
    const commit = deployedCommit();
    return { ok: true, service: "hub-api", ...(commit ? { commit } : {}) };
  });

  app.get("/health/ready", async (_request, reply) => ready(reply));

  /**
   * The stream connects to 127.0.0.1 so it never competes with API calls for
   * localhost's six connections, and the session cookie does not travel there.
   * A one-use ticket fetched over localhost carries the identity across.
   */
  const tickets = new Map<string, { userId: string; expires: number }>();

  app.post("/api/events/ticket", async (request) => {
    for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key);
    while (tickets.size > 200) {
      const oldest = tickets.keys().next().value;
      if (oldest === undefined) break;
      tickets.delete(oldest);
    }
    const ticket = randomBytes(18).toString("base64url");
    tickets.set(ticket, { userId: request.userId, expires: Date.now() + 60_000 });
    return { ticket };
  });

  app.get("/api/events", async (request, reply) => {
    const { ticket } = request.query as { ticket?: string };
    const entry = ticket ? tickets.get(ticket) : undefined;
    if (ticket) tickets.delete(ticket);
    const userId = entry && entry.expires > Date.now() ? entry.userId : request.userId;
    if (!userId) return reply.code(401).send({ error: "Sign in to Ensemble first." });
    await sseHandler(request, reply, userId);
  });

  app.get("/api/approvals", async (request) => {
    const approvals = await prisma.approval.findMany({
      where: { userId: request.userId, decision: null },
      orderBy: { requestedAt: "asc" },
    });
    return {
      approvals: approvals.map((a) => ({
        id: a.id,
        runId: a.runId,
        taskId: a.taskId,
        kind: a.kind,
        title: a.title,
        preview: a.preview,
        decision: a.decision,
        requestedAt: a.requestedAt.toISOString(),
      })),
    };
  });

  app.post("/api/undo", async (request, reply) => {
    const body = HistoryBody.parse(request.body ?? {});
    try {
      return await undoLast(prisma, request.userId, body.entryId);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 204) return reply.code(204).send();
      throw error;
    }
  });

  app.post("/api/redo", async (request, reply) => {
    const body = HistoryBody.parse(request.body ?? {});
    try {
      return await redoLast(prisma, request.userId, body.entryId);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 204) return reply.code(204).send();
      throw error;
    }
  });
}
