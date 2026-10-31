/**
 * The computer's side of a node's live terminals and watched tabs (`capabilities.live`, node/live-views.ts):
 * it says when one ended, and its live card ends.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LiveEndedPost, LiveId } from "../remote/contract.js";
import { endLiveCard, liveCard } from "../node/live-views.js";
import type { LiveGate } from "./live.js";

export async function liveSessionDeviceRoutes(app: FastifyInstance, gate: Pick<LiveGate, "ownDevice">): Promise<void> {
  app.post("/api/devices/self/live/:liveId/ended", async (request, reply) => {
    const device = await gate.ownDevice(app, request, reply);
    if (!device) return;
    const params = z.object({ liveId: LiveId }).safeParse(request.params);
    const body = LiveEndedPost.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "That could not be read." });
    const card = await liveCard(app, params.data.liveId, device.userId);
    if (card && (card.data as { deviceId?: unknown }).deviceId !== device.id) return reply.code(404).send({ error: "That live view is not this computer's." });
    return { ended: await endLiveCard(app, device.userId, params.data.liveId, body.data.reason) };
  });
}
