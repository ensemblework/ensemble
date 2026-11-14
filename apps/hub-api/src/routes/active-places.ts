import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { activePlaces, heartbeatPlace, PlaceInput, placeSession, releasePlace } from "../lib/active-places.js";
import { accountIdOf } from "../lib/auth.js";

export async function activePlaceRoutes(app: FastifyInstance) {
  app.get("/api/auth/places", async (request) => {
    placeSession(request);
    const { surface } = z.object({ surface: PlaceInput.shape.surface.default("hub") }).parse(request.query);
    return { places: await activePlaces(app.prisma, accountIdOf(request), surface) };
  });
  app.post("/api/auth/places", async (request, reply) => {
    const result = await heartbeatPlace(app.prisma, request, PlaceInput.parse(request.body));
    return reply.code(result.allowed ? 200 : 409).send(result);
  });
  app.post("/api/auth/places/continue", async (request, reply) => {
    const body = PlaceInput.extend({ replace: z.union([z.literal("oldest"), z.string().uuid()]) }).parse(request.body);
    const result = await heartbeatPlace(app.prisma, request, body, body.replace);
    return reply.code(result.allowed ? 200 : 409).send(result);
  });
  app.post("/api/auth/places/release", async (request, reply) => {
    await releasePlace(app.prisma, request, PlaceInput.parse(request.body));
    return reply.code(204).send();
  });
}
