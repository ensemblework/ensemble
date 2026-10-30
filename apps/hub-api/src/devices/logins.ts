/**
 * A run's agent waits for its owner to sign in (B11, protocol 8): its computer says so here, under the
 * job's lease, and the server raises the sign-in card where the run is followed (node/logins.ts): a
 * node's run, in its conversation, by its node. A run no node follows gets no card here; the computer
 * asks on Needs me itself. Only the site, tab and why come in, never a value.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RunLoginPost } from "../remote/contract.js";
import { loginCardForRun } from "../node/logins.js";
import type { LiveGate } from "./live.js";

export async function loginDeviceRoutes(app: FastifyInstance, gate: LiveGate): Promise<void> {
  app.post("/api/devices/self/jobs/:id/logins", async (request, reply) => {
    const device = await gate.ownDevice(app, request, reply);
    if (!device) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = RunLoginPost.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "That sign-in could not be read." });
    const held = await gate.holdLease(app, device, id, body.data.leaseToken);
    if (!held.ok) return reply.code(held.status).send({ error: held.message });
    const { leaseToken: _lease, ...login } = body.data;
    const card = await loginCardForRun(app, { id: device.id, name: device.name, userId: device.userId }, id, login);
    return { decisionId: card?.id ?? null };
  });
}
