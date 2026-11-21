/**
 * Routes for the person's AI subscriptions (docs/30 §8, docs/25 §4.7).
 *
 * For the web: which computers have which agents (`GET /api/subscriptions`), check again, start a
 * sign-in there, and set up an agent whose app is there without it. On the desktop runtime the
 * computer is this one.
 *
 * For a paired computer running an assistant turn the web handed it (device token only): read
 * the turn and the files attached to the message, call its tools, ask a node's owner about one of
 * the agent's own calls, stream the reply text (and the agent's own calls), say it is done.
 */
import { hostname } from "node:os";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AGENT_APP_INFO, ASSISTANT_TURNS_MIN, parseAgentApps, SUBSCRIPTION_INFO, SUBSCRIPTION_PROVIDERS, type AgentApp, type SubscriptionAgent } from "@ensemble/shared-types";
import type { Device } from "@prisma/client";
import { deviceOnline } from "../devices/constants.js";
import { publishDeviceFrame } from "../devices/revoke-notify.js";
import { ownDevice } from "../devices/routes.js";
import { runtimeInstanceOf } from "../remote/contract.js";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings } from "../lib/settings.js";
import { appPresence, detectAgents } from "./detect.js";
import { finishTurn, heard, inRelayedRequest, liveTurn, pickTurn, streamInto, turnFor } from "./relay.js";
import { OwnAskShape, OwnToolEventShape } from "./bridge.js";
import { setUpMessage, startSetUp, startSignIn } from "./signin.js";
import { computerAgents, deviceOwners } from "./turn.js";
import { RESTART_REASONS, type RestartReason } from "../workspace/engines/session-restart.js";
import { MAX_OUTSIDE_TURNS } from "./outside.js";

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
  /** Agents' apps there that come without the agent (the Cursor app, VS Code with Copilot): Set up adds it. */
  apps: AgentApp[];
};

/** The agents' apps a computer reports (capabilities `agentApps`); null from a runtime too old to set an agent up. */
function computerApps(device: Pick<Device, "capabilities">): AgentApp[] | null {
  const reported = (device.capabilities as { agentApps?: unknown } | null)?.agentApps;
  return Array.isArray(reported) ? parseAgentApps(reported) : null;
}

const Target = z.object({ deviceId: z.string().min(1).max(80) });
const SignIn = Target.extend({ agent: z.enum(SUBSCRIPTION_PROVIDERS) });

/** Another runtime of the same computer read the turn first and runs it. */
const TAKEN = "This turn was picked up by another Ensemble on this computer.";

/** A plain media type for a turn file's download; anything else goes as bytes. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

const ToolCall = z.object({ name: z.string().min(1).max(200), input: z.unknown().default({}) });
/**
 * `status`: a line for the chat while the computer waits on something (0.8.0); `tools`: the agent's own calls in a
 * node's turn (`assistantTurns` 5). Older computers send neither.
 */
const Stream = z.object({ seq: z.number().int().min(1), text: z.string().max(64 * 1024).default(""), status: z.string().max(200).optional(), tools: z.array(OwnToolEventShape).max(50).optional() });
const Done = z.object({
  result: z
    .object({
      text: z.string().max(200_000),
      model: z.string().max(200).nullable(),
      tokensIn: z.number().nullable(),
      tokensOut: z.number().nullable(),
      costUsd: z.number().nullable(),
      /** The turn went on in the chat's earlier agent session (false: a new one, with the chat so far). */
      resumed: z.boolean().optional(),
      /** Why it started a new session in place of the chat's earlier one (0.8.0, session-restart.ts). */
      restart: z
        .object({ reason: z.enum(RESTART_REASONS as [RestartReason, ...RestartReason[]]), error: z.string().max(500).optional() })
        .optional()
        // A reason this server does not know yet, or anything malformed, leaves it out; the turn stands.
        .catch(undefined),
      /** What the person added in the agent's own app since Ensemble's last turn (0.8.0, subscriptions/outside.ts). */
      outside: z
        .object({
          app: z.string().min(1).max(100),
          turns: z.array(z.object({ prompt: z.string().max(5_000), answer: z.string().max(5_000), tools: z.string().max(300).optional(), at: z.string().max(40).optional() })).max(MAX_OUTSIDE_TURNS),
          earlier: z.number().int().min(0).max(1_000_000),
        })
        .optional()
        .catch(undefined),
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
    if (computerAgents(device).turns < ASSISTANT_TURNS_MIN) return { ok: false as const, status: 409, error: `Update Ensemble on ${device.name} first (the CLI 0.3.10 or the desktop app 0.3.7).` };
    return { ok: true as const, device };
  }

  app.get("/api/subscriptions", async (request) => {
    const settings = await loadSettings(prisma, request.userId);
    if (isDesktopRuntime()) {
      const agents = await detectAgents();
      const computer: SubscriptionComputer = { id: "local", name: hostname().replace(/\.local$/, "") || "This computer", platform: process.platform, local: true, online: true, lastSeenAt: new Date().toISOString(), appVersion: process.env.ENSEMBLE_APP_VERSION ?? null, ready: true, agents, apps: appPresence() };
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
        ready: caps.turns >= ASSISTANT_TURNS_MIN,
        agents: deviceOnline(device.lastSeenAt) ? caps.agents : [],
        apps: deviceOnline(device.lastSeenAt) ? (computerApps(device) ?? []) : [],
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

  // An agent's app without the agent (the Cursor app, VS Code with Copilot): install the agent there with the vendor's installer, then sign in.
  app.post("/api/subscriptions/set-up", async (request, reply) => {
    const body = SignIn.parse(request.body);
    if (isDesktopRuntime()) {
      try {
        return { message: await startSetUp(body.agent, () => undefined) };
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    const found = await ownedComputer(request.userId, body.deviceId);
    if (!found.ok) return reply.code(found.status).send({ error: found.error });
    const info = SUBSCRIPTION_INFO[body.agent];
    const apps = computerApps(found.device);
    if (!apps) return reply.code(409).send({ error: `Update Ensemble on ${found.device.name} to set up ${info.label} there from here.` });
    const setUp = apps.find((row) => AGENT_APP_INFO[row].agent === body.agent);
    if (!setUp) return reply.code(409).send({ error: `${found.device.name} has no app Ensemble can set ${info.label} up from. ${info.install.label} there (${info.install.url}).` });
    publishDeviceFrame(found.device.id, "agents.setup", { agent: body.agent });
    await appendLedger({ userId: request.userId, actor: "me", action: "subscription.set_up", payload: { deviceId: found.device.id, agent: body.agent } }).catch(() => undefined);
    return reply.code(202).send({ message: setUpMessage(setUp, found.device.name) });
  });

  // ── the computer's side of a relayed turn ──────────────────────────────────────────────────

  app.get("/api/devices/self/assistant-turns/:id", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const turn = liveTurn((request.params as { id: string }).id, device.id);
    if (!turn) return reply.code(410).send({ error: "This turn has ended." });
    if (!pickTurn(turn, runtimeInstanceOf(request.headers))) {
      request.log.warn({ userId: device.userId, device: device.id }, `A second Ensemble on ${device.name} asked for an assistant turn another one took`);
      return reply.code(409).send({ error: TAKEN });
    }
    heard(turn);
    return { spec: turn.spec };
  });

  app.get("/api/devices/self/assistant-turns/:id/files/:fileId", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const params = request.params as { id: string; fileId: string };
    const turn = liveTurn(params.id, device.id);
    if (!turn) return reply.code(410).send({ error: "This turn has ended." });
    if (!turnFor(turn, runtimeInstanceOf(request.headers))) return reply.code(409).send({ error: TAKEN });
    const file = turn.spec.files?.find((row) => row.id === params.fileId);
    if (!file || !turn.read) return reply.code(404).send({ error: "That file is not part of this turn." });
    heard(turn);
    let bytes: Uint8Array | null = null;
    try {
      bytes = await turn.read(file.id);
    } catch (error) {
      request.log.warn({ err: error }, "relayed assistant file could not be read");
    }
    heard(turn);
    if (!bytes) return reply.code(404).send({ error: "That file is no longer available." });
    return reply
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .type(MEDIA_TYPE.test(file.mediaType) ? file.mediaType : "application/octet-stream")
      .send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });

  app.post("/api/devices/self/assistant-turns/:id/tool", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const turn = liveTurn((request.params as { id: string }).id, device.id);
    if (!turn) return reply.code(410).send({ text: "This turn has ended.", isError: true });
    if (!turnFor(turn, runtimeInstanceOf(request.headers))) return reply.code(409).send({ text: TAKEN, isError: true });
    const body = ToolCall.parse(request.body);
    heard(turn);
    // Whether the answer reached the computer: a request that ended before it means the computer's next identical call is this one again.
    let received = false;
    reply.raw.once("finish", () => (received = true));
    try {
      return await inRelayedRequest(() => received, () => turn.call(body.name, body.input));
    } catch (error) {
      request.log.warn({ err: error }, "relayed assistant tool failed");
      return { text: JSON.stringify({ error: "The tool failed on Ensemble's side." }), isError: true };
    } finally {
      heard(turn);
    }
  });

  // One of the agent's own calls in a node's turn needs its owner: their card in the chat, and this request
  // held until they answer, at most 90 seconds (node/own-tool-asks.ts), so a proxy in front never cuts it.
  app.post("/api/devices/self/assistant-turns/:id/ask", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const turn = liveTurn((request.params as { id: string }).id, device.id);
    if (!turn) return reply.code(410).send({ decision: "deny", message: "This turn has ended." });
    if (!turnFor(turn, runtimeInstanceOf(request.headers))) return reply.code(409).send({ decision: "deny", message: TAKEN });
    if (!turn.ask) return reply.code(409).send({ decision: "deny", message: "This turn does not ask its owner about the agent's own calls." });
    const body = OwnAskShape.parse(request.body);
    heard(turn);
    try {
      const answer = await turn.ask(body);
      // Not answered in time: the turn parks, and the agent's run stops once this answer has reached the computer.
      const park = answer.decision === "deny" && answer.waiting ? turn.park : null;
      if (park) {
        let parked = false;
        const after = () => {
          if (parked) return;
          parked = true;
          park();
        };
        reply.raw.once("finish", after);
        reply.raw.once("close", after);
      }
      return answer;
    } catch (error) {
      request.log.warn({ err: error }, "a node's ask about an agent's own call failed");
      return { decision: "deny", message: "Ensemble could not ask your owner, so this call was not run. Say what you need." };
    } finally {
      heard(turn);
    }
  });

  app.post("/api/devices/self/assistant-turns/:id/stream", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const turn = liveTurn((request.params as { id: string }).id, device.id);
    if (!turn) return reply.code(410).send({ stop: true });
    if (!turnFor(turn, runtimeInstanceOf(request.headers))) return reply.code(409).send({ stop: true });
    const body = Stream.parse(request.body);
    streamInto(turn, body.seq, body.text, body.status, body.tools);
    return { stop: false };
  });

  app.post("/api/devices/self/assistant-turns/:id/done", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const turn = liveTurn((request.params as { id: string }).id, device.id);
    if (!turn) return reply.code(410).send({ error: "This turn has ended." });
    if (!turnFor(turn, runtimeInstanceOf(request.headers))) return reply.code(409).send({ error: TAKEN });
    finishTurn(turn, Done.parse(request.body));
    return { ok: true };
  });
}
