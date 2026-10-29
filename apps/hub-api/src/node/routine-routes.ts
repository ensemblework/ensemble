/**
 * Routines over HTTP (docs/35 §6.5): the owner's routines for their nodes, run now, the webhook token,
 * runs, and the webhook itself, which authenticates with the routine's own token.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nodeAccount } from "./routes.js";
import { acceptHook, createRoutine, rotateHookToken, RoutineError, routineView, runNow, runView, updateRoutine } from "./routines.js";

const Id = z.object({ id: z.string().uuid() });

function sendError(error: unknown): never {
  if (error instanceof RoutineError) throw Object.assign(new Error(error.message), { statusCode: error.status });
  if (error instanceof z.ZodError) throw Object.assign(new Error(error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")), { statusCode: 400 });
  throw error;
}

export function registerRoutineRoutes(app: FastifyInstance): void {
  const prisma = app.prisma;

  app.get("/api/node/routines", async (request) => {
    const accountId = nodeAccount(request);
    const routines = await prisma.nodeRoutine.findMany({ where: { userId: accountId }, orderBy: { createdAt: "asc" } });
    return { routines: await Promise.all(routines.map((row) => routineView(prisma, row))) };
  });

  app.post("/api/node/routines", async (request, reply) => {
    const accountId = nodeAccount(request);
    try {
      const { routine, token } = await createRoutine(app, accountId, request.body);
      return reply.code(201).send({ routine: await routineView(prisma, routine), ...(token ? { token } : {}) });
    } catch (error) {
      sendError(error);
    }
  });

  app.patch("/api/node/routines/:id", async (request) => {
    const accountId = nodeAccount(request);
    const { id } = Id.parse(request.params);
    try {
      return { routine: await routineView(prisma, await updateRoutine(app, accountId, id, request.body)) };
    } catch (error) {
      sendError(error);
    }
  });

  app.delete("/api/node/routines/:id", async (request, reply) => {
    const accountId = nodeAccount(request);
    const { id } = Id.parse(request.params);
    const removed = await prisma.nodeRoutine.deleteMany({ where: { id, userId: accountId } });
    if (!removed.count) throw Object.assign(new Error("That routine is not yours."), { statusCode: 404 });
    return reply.code(204).send();
  });

  app.post("/api/node/routines/:id/run", async (request, reply) => {
    const accountId = nodeAccount(request);
    const { id } = Id.parse(request.params);
    try {
      const run = await runNow(app, accountId, id);
      return reply.code(202).send({ run: runView(run, null) });
    } catch (error) {
      sendError(error);
    }
  });

  app.post("/api/node/routines/:id/token", async (request) => {
    const accountId = nodeAccount(request);
    const { id } = Id.parse(request.params);
    try {
      return { token: await rotateHookToken(app, accountId, id) };
    } catch (error) {
      sendError(error);
    }
  });

  app.get("/api/node/routines/:id/runs", async (request) => {
    const accountId = nodeAccount(request);
    const { id } = Id.parse(request.params);
    const routine = await prisma.nodeRoutine.findFirst({ where: { id, userId: accountId }, select: { id: true } });
    if (!routine) throw Object.assign(new Error("That routine is not yours."), { statusCode: 404 });
    const runs = await prisma.nodeRoutineRun.findMany({ where: { routineId: id }, orderBy: { createdAt: "desc" }, take: 50 });
    const missions = await prisma.nodeMission.findMany({ where: { id: { in: runs.map((row) => row.missionId).filter((value): value is string => Boolean(value)) } }, select: { id: true, status: true } });
    const status = new Map(missions.map((row) => [row.id, row.status]));
    return { runs: runs.map((row) => runView(row, row.missionId ? (status.get(row.missionId) ?? null) : null)) };
  });

  // The webhook: no session, the routine's token (Authorization: Bearer, or ?token=). Every refusal is
  // the same 403, so the route says nothing about which routines exist.
  app.post("/api/node/hooks/routines/:id", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const parsed = Id.safeParse(request.params);
    if (!parsed.success) return reply.code(403).send({ error: "Not allowed." });
    const auth = typeof request.headers.authorization === "string" ? request.headers.authorization.match(/^Bearer\s+(\S+)$/i)?.[1] : undefined;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const token = auth ?? (typeof query.token === "string" ? query.token : null);
    const result = await acceptHook(app, parsed.data.id, token, request.headers as Record<string, unknown>, request.body);
    if (!result) return reply.code(403).send({ error: "Not allowed." });
    if (result === "paused") return reply.code(409).send({ error: "This routine is paused." });
    return reply.code(202).send({ accepted: result === "accepted" });
  });
}
