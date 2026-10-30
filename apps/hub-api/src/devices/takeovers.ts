/**
 * The computer's side of a takeover relay (B21, node/takeovers.ts): its encrypted frames, kept only as
 * the latest for a few seconds, and that it ended one itself. The server cannot read a frame.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ChannelMessage, TakeoverStatePost } from "../remote/contract.js";
import { deviceEnded, storeFrame } from "../node/takeovers.js";
import type { LiveGate } from "./live.js";

export async function takeoverDeviceRoutes(app: FastifyInstance, gate: Pick<LiveGate, "ownDevice">): Promise<void> {
  app.post("/api/devices/self/takeovers/:id/frames", { bodyLimit: 800_000 }, async (request, reply) => {
    const device = await gate.ownDevice(app, request, reply);
    if (!device) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const message = ChannelMessage.safeParse(request.body);
    if (!message.success) return reply.code(400).send({ error: "That frame could not be read." });
    if ((await storeFrame(app, device, id, message.data)) === "gone") return reply.code(410).send({ error: "Nobody controls that tab any more." });
    return { ok: true };
  });

  app.post("/api/devices/self/takeovers/:id/state", async (request, reply) => {
    const device = await gate.ownDevice(app, request, reply);
    if (!device) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = TakeoverStatePost.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "That state could not be read." });
    return { ended: await deviceEnded(app, device, id, body.data.reason) };
  });
}
