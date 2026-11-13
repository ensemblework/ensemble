/**
 * Routines (docs/02 §3.10): the Routines page's list, and adding, changing, pausing, running and
 * deleting a routine (with its conversation and agent session). Only the space's owner keeps routines:
 * they run with the owner's models and apps.
 */
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadSettings } from "../lib/settings.js";
import { isGuestIn } from "../sharing/context.js";
import { createRoutine, deleteRoutine, dropRoutineChat, findRoutine, listRoutines, RoutineError, routineView, runRoutine, updateRoutine, WEEKDAYS } from "../routines/service.js";

export const CadenceInput = z.object({
  every: z.enum(["hour", "day", "weekday", "week", "month"]).optional(),
  time: z.string().max(5).optional(),
  days: z.array(z.enum(WEEKDAYS)).max(7).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  cron: z.string().max(120).optional(),
});

const Create = z.object({ title: z.string().max(200), instruction: z.string().max(100_000), cadence: CadenceInput, paused: z.boolean().optional() });
const Patch = z.object({ title: z.string().max(200).optional(), instruction: z.string().max(100_000).optional(), cadence: CadenceInput.optional(), status: z.enum(["active", "paused"]).optional() });

export async function routineRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  const owner = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!isGuestIn(request.userId)) return true;
    void reply.code(403).send({ error: "Routines belong to the space's owner." });
    return false;
  };
  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof RoutineError) return reply.code(error.statusCode).send({ error: error.message });
    throw error;
  };

  app.get("/api/routines", async (request, reply) => {
    if (!owner(request, reply)) return reply;
    const settings = await loadSettings(prisma, request.userId);
    return { routines: await listRoutines(prisma, request.userId), enabled: settings.routines.enabled, timezone: settings.timezone };
  });

  app.post("/api/routines", async (request, reply) => {
    if (!owner(request, reply)) return reply;
    const body = Create.parse(request.body);
    try {
      return reply.code(201).send({ routine: await createRoutine(prisma, request.userId, { title: body.title, instruction: body.instruction, cadence: body.cadence, paused: body.paused }) });
    } catch (error) {
      return failed(reply, error);
    }
  });

  app.patch("/api/routines/:id", async (request, reply) => {
    if (!owner(request, reply)) return reply;
    const { id } = request.params as { id: string };
    try {
      return { routine: await updateRoutine(prisma, request.userId, id, Patch.parse(request.body)) };
    } catch (error) {
      return failed(reply, error);
    }
  });

  app.delete("/api/routines/:id", async (request, reply) => {
    if (!owner(request, reply)) return reply;
    const { id } = request.params as { id: string };
    try {
      const gone = await deleteRoutine(prisma, request.userId, id);
      // Its conversation and the agent session behind it go too (after the reply: the routine is gone at once).
      void dropRoutineChat(app, request.userId, gone);
      return reply.code(204).send();
    } catch (error) {
      return failed(reply, error);
    }
  });

  /** Run it now, whatever its schedule: it starts here and reports in the bell, as a scheduled run does. */
  app.post("/api/routines/:id/run", async (request, reply) => {
    if (!owner(request, reply)) return reply;
    const { id } = request.params as { id: string };
    const settings = await loadSettings(prisma, request.userId);
    if (!settings.routines.enabled) return reply.code(409).send({ error: "Routines are off. Turn them on in Settings › Notifications." });
    try {
      const row = await findRoutine(prisma, request.userId, id);
      if (row.lastStatus === "running" && row.lastRunAt && Date.now() - row.lastRunAt.getTime() < 30 * 60_000) return reply.code(409).send({ error: "It is running now." });
      void runRoutine(app, row, "manual").catch((error: unknown) => app.log.error({ err: error, routineId: row.id }, "routine run failed"));
      return reply.code(202).send({ routine: { ...routineView(row), lastStatus: "running" } });
    } catch (error) {
      return failed(reply, error);
    }
  });
}
