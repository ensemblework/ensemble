/**
 * Routes for the person's AI subscriptions (docs/30 §8, docs/25 §4.7).
 *
 * For the web: which computers have which agents (`GET /api/subscriptions`), check again, and
 * start a sign-in there. On the desktop runtime the computer is this one.
 *
 * For a paired computer running an assistant turn the web handed it (device token only): read
 * the turn, call its tools, stream the reply text, say it is done.
 */
import { hostname } from "node:os";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ASSISTANT_TURNS_API, SUBSCRIPTION_PROVIDERS, type SubscriptionAgent } from "@ensemble/shared-types";
import { deviceOnline } from "../devices/constants.js";
import { publishDeviceFrame } from "../devices/revoke-notify.js";
import { ownDevice } from "../devices/routes.js";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings } from "../lib/settings.js";
import { detectAgents } from "./detect.js";
import { finishTurn, heard, liveTurn, streamInto } from "./relay.js";
import { startSignIn } from "./signin.js";
import { computerAgents, deviceOwners } from "./turn.js";

const isDesktopRuntime = () => process.env.ENSEMBLE_DESKTOP === "1";

export type SubscriptionComputer = {
  id: string;
  name: string;
  platform: string | null;
  /** This runtime's own computer (the desktop app or the CLI's runtime). */
  local: boolean;
  online: boolean;
  lastSeenAt: string | null;
  appVersion: string | null;
  /** Whether it can run assistant turns at all (new enough). */
  ready: boolean;
  agents: SubscriptionAgent[];
};

const Target = z.object({ deviceId: z.string().min(1).max(80) });
const SignIn = Target.extend({ agent: z.enum(SUBSCRIPTION_PROVIDERS) });

const ToolCall = z.object({ name: z.string().min(1).max(200), input: z.unknown().default({}) });
const Stream = z.object({ seq: z.number().int().min(1), text: z.string().max(64 * 1024).default("") });
const Done = z.object({
  result: z
    .object({
      text: z.string().max(200_000),
      model: z.string().max(200).nullable(),
      tokensIn: z.number().nullable(),
      tokensOut: z.number().nullable(),
      costUsd: z.number().nullable(),
    })
    .optional(),
  error: z.object({ problem: z.string().max(40).optional(), message: z.string().max(2000).optional() }).optional(),
});

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  async function ownedComputer(userId: string, deviceId: string) {
    const device = await prisma.device.findFirst({ where: { id: deviceId, userId: { in: deviceOwners(userId) }, revokedAt: null } });
    if (!device) return { ok: false as const, status: 404, error: "That computer is not paired with your account." };
    if (!deviceOnline(device.lastSeenAt)) return { ok: false as const, status: 409, error: `${device.name} is offline. Open Ensemble on it, then try again.` };
    if (computerAgents(device).turns < ASSISTANT_TURNS_API) return { ok: false as const, status: 409, error: `Update Ensemble on ${device.name} first (the CLI 0.3.10 or the desktop app 0.3.7).` };
    return { ok: true as const, device };
  }

  app.get("/api/subscriptions", async (request) => {
    const settings = await loadSettings(prisma, request.userId);
    if (isDesktopRuntime()) {
      const agents = await detectAgents();
      const computer: SubscriptionComputer = { id: "local", name: hostname().replace(/\.local$/, "") || "This computer", platform: process.platform, local: true, online: true, lastSeenAt: new Date().toISOString(), appVersion: process.env.ENSEMBLE_APP_VERSION ?? null, ready: true, agents };
      return { computers: [computer], preferred: settings.models.computer };
    }
    const devices = await prisma.device.findMany({ where: { userId: { in: deviceOwners(request.userId) }, revokedAt: null }, orderBy: { lastSeenAt: "desc" } });
    const computers: SubscriptionComputer[] = devices.map((device) => {
      const caps = computerAgents(device);
      return {
        id: device.id,
        name: device.name,
        platform: device.platform,
        local: false,
        online: deviceOnline(device.lastSeenAt),
        lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
        appVersion: device.appVersion,
        ready: caps.turns >= ASSISTANT_TURNS_API,
        agents: deviceOnline(device.lastSeenAt) ? caps.agents : [],
      };
    });
    return { computers, preferred: settings.models.computer };
  });

  app.post("/api/subscriptions/check", async (request, reply) => {
    const body = Target.parse(request.body);
    if (isDesktopRuntime()) return { agents: await detectAgents({ force: true }) };
    const found = await ownedComputer(request.userId, body.deviceId);
    if (!found.ok) return reply.code(found.status).send({ error: found.error });
    publishDeviceFrame(found.device.id, "agents.refresh", {});
    return reply.code(202).send({ sent: true });
  });

  app.post("/api/subscriptions/sign-in", async (request, reply) => {
    const body = SignIn.parse(request.body);
    if (isDesktopRuntime()) {
      try {
        return { message: await startSignIn(body.agent, () => undefined) };
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    const found = await ownedComputer(request.userId, body.deviceId);
    if (!found.ok) return reply.code(found.status).send({ error: found.error });
    publishDeviceFrame(found.device.id, "agents.signin", { agent: body.agent });
    await appendLedger({ userId: request.userId, actor: "me", action: "subscription.sign_in", payload: { deviceId: found.device.id, agent: body.agent } }).catch(() => undefined);
    return reply.code(202).send({ message: `A sign-in window is opening on ${found.device.name}. Finish signing in there.` });
  });

  // ── the computer's side of a relayed turn ──────────────────────────────────────────────────

  app.get("/api/devices/self/assistant-turns/:id", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const turn = liveTurn((request.params as { id: string }).id, device.id);
    if (!turn) return reply.code(410).send({ error: "This turn has ended." });
    turn.picked = true;
    heard(turn);
    return { spec: turn.spec };
  });

  app.post("/api/devices/self/assistant-turns/:id/tool", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const turn = liveTurn((request.params as { id: string }).id, device.id);
    if (!turn) return reply.code(410).send({ text: "This turn has ended.", isError: true });
    const body = ToolCall.parse(request.body);
    heard(turn);
    try {
      return await turn.call(body.name, body.input);
    } catch (error) {
      request.log.warn({ err: error }, "relayed assistant tool failed");
      return { text: JSON.stringify({ error: "The tool failed on Ensemble's side." }), isError: true };
    } finally {
      heard(turn);
    }
  });

  app.post("/api/devices/self/assistant-turns/:id/stream", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const turn = liveTurn((request.params as { id: string }).id, device.id);
    if (!turn) return reply.code(410).send({ stop: true });
    const body = Stream.parse(request.body);
    streamInto(turn, body.seq, body.text);
    return { stop: false };
  });

  app.post("/api/devices/self/assistant-turns/:id/done", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const turn = liveTurn((request.params as { id: string }).id, device.id);
    if (!turn) return reply.code(410).send({ error: "This turn has ended." });
    finishTurn(turn, Done.parse(request.body));
    return { ok: true };
  });
}
