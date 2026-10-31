/**
 * A run's agent waits for its owner to sign in (B11, protocol 8): its computer says so here, under the
 * job's lease, and the server raises the sign-in card where the run is followed (node/logins.ts): a
 * node's run, in its conversation, by its node. A run no node follows gets no card here; the computer
 * asks on Needs me itself. Only the site, tab and why come in, never a value. A sign-in the computer
 * saw end by itself (logins 2: done in the node's tab, a window or the remote view) is told at
 * `/api/devices/self/logins/:loginId/state`, and its card follows. A node's command that needs a sign-in
 * (`cliLogins`) posts the code it printed, or the sign-in page it opened (node/device-codes.ts).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LoginStatePost, NodeCliLoginPost, NodeDeviceCodePost, RunLoginPost } from "../remote/contract.js";
import { loginCardForRun, loginStateFromComputer } from "../node/logins.js";
import { cliLoginFromComputer, deviceCodeFromComputer } from "../node/device-codes.js";
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

  app.post("/api/devices/self/nodes/device-codes", async (request, reply) => {
    const device = await gate.ownDevice(app, request, reply);
    if (!device) return;
    const body = NodeDeviceCodePost.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "That sign-in code could not be read." });
    const card = await deviceCodeFromComputer(app, { id: device.id, name: device.name, userId: device.userId }, body.data);
    if (!card) return reply.code(404).send({ error: "No command of that node runs on this computer." });
    return { ok: true, messageId: card.id };
  });

  app.post("/api/devices/self/nodes/logins", async (request, reply) => {
    const device = await gate.ownDevice(app, request, reply);
    if (!device) return;
    const body = NodeCliLoginPost.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "That sign-in could not be read." });
    const card = await cliLoginFromComputer(app, { id: device.id, name: device.name, userId: device.userId }, body.data);
    if (!card) return reply.code(404).send({ error: "No command of that node runs on this computer." });
    return { decisionId: card.id };
  });

  app.post("/api/devices/self/logins/:loginId/state", async (request, reply) => {
    const device = await gate.ownDevice(app, request, reply);
    if (!device) return;
    const { loginId } = z.object({ loginId: z.string().regex(/^lg_[0-9a-f]{32}$/) }).parse(request.params);
    const body = LoginStatePost.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "That sign-in state could not be read." });
    const card = await loginStateFromComputer(app, { id: device.id, userId: device.userId }, loginId, body.data);
    if (!card) return reply.code(404).send({ error: "No sign-in card waits for that." });
    return { ok: true };
  });
}
