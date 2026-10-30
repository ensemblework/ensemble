/**
 * Secrets a node needs for work on its owner's computer (docs/35 §8.7): an API key, a token. The node
 * asks by name with `node_secret_request`; its owner types the value into a box on the card (on Node or
 * in the Hub's Needs me). The browser encrypts it for the computer's own key (B12, sealed box:
 * credentials/seal.ts), and this server only relays the ciphertext to the computer (`secret.save`),
 * which opens and keeps it. A computer too old to have a key gets the value over TLS through this
 * server instead, which passes it on without keeping it; the card says so. Either way the value is
 * never in a message, a model's input, a log or the database here; the card keeps only the name, why,
 * where it was saved and whether it was encrypted end to end.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Device, NodeAgent, NodeMessage, Prisma, PrismaClient } from "@prisma/client";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool } from "../assistant/types.js";
import { deviceOnline } from "../devices/constants.js";
import { askDeviceFor } from "../devices/file-relay.js";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings } from "../lib/settings.js";
import { allowedOrigin, secretNameProblem } from "../lib/run-secrets.js";
import { pinnedSealKey, reportedSealKey } from "../credentials/device-key.js";
import { readAad, SealedShape, SealError } from "../credentials/seal.js";
import { SEAL_MAX_TTL_MS, SEAL_TTL_MS, type SealKeyInfo, type Sealed } from "@ensemble/shared-types";
import { CodeAnswer } from "../remote/contract.js";
import { SECRET_HTTP_DESCRIPTION, SECRET_HTTP_METHODS } from "../credentials/secret-http.js";
import { pickRunProfile } from "@ensemble/shared-types";
import { enqueueTurn } from "./queue.js";
import { postMessage, updateMessageDataIf } from "./store.js";
import { planLinkOf } from "./plans.js";
import type { SessionToolScope } from "./sessions.js";

const SAVE_MS = 20_000;
/** A card left "saving" this long (the server restarted mid-save) can be answered again. */
export const SAVE_STALE_MS = SAVE_MS + 10_000;

export class SecretError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 | 502, readonly code?: string) {
    super(message);
  }
}

type Computer = { id: string; name: string; online: boolean; secrets: number };

async function computers(prisma: PrismaClient, ownerId: string): Promise<Computer[]> {
  const rows = await prisma.device.findMany({ where: { userId: ownerId, revokedAt: null }, orderBy: [{ lastSeenAt: { sort: "desc", nulls: "last" } }] });
  return rows.map((row) => {
    const caps = (row.capabilities ?? {}) as { secrets?: unknown };
    return { id: row.id, name: row.name, online: deviceOnline(row.lastSeenAt), secrets: typeof caps.secrets === "number" ? caps.secrets : 0 };
  });
}

/** The computer a secret is for: the one named, else the default run profile's, else the one online. */
async function chooseComputer(scope: Pick<SessionToolScope, "prisma" | "node">, named?: string): Promise<Computer> {
  const list = await computers(scope.prisma, scope.node.userId);
  if (!list.length) throw new ToolBlockedError("Your owner has no paired computer, so there is nowhere to keep a secret.", "They pair one with `ensemble login` or the desktop app.");
  const key = named?.trim().toLowerCase();
  let pick = key && key !== "any" ? list.find((row) => row.id === named || row.name.toLowerCase() === key) ?? list.find((row) => row.name.toLowerCase().includes(key)) : undefined;
  if (key && key !== "any" && !pick) throw new ToolBlockedError(`No paired computer is called “${named}”.`, `Their computers: ${list.map((row) => row.name).join(", ")}.`);
  if (!pick) {
    const profile = pickRunProfile(await loadSettings(scope.prisma, scope.node.userId));
    pick = (profile.deviceId ? list.find((row) => row.id === profile.deviceId) : undefined) ?? list.find((row) => row.online) ?? list[0]!;
  }
  if (pick.secrets < 1) throw new ToolBlockedError(`Ensemble on ${pick.name} is too old to keep secrets for its runs.`, "Your owner updates it there (`ensemble update`).");
  return pick;
}

export function secretTools(scope: SessionToolScope): AnyHubTool[] {
  if (scope.lineage.fromNonOwner) return [];
  return [
    defineTool({
      name: "node_secret_request",
      area: "tasks",
      description:
        "Ask your owner for a secret the work on their computer needs (an API key, a token, a password), by environment variable name. They type it into a box on a card; it is encrypted in their browser for their computer and only that computer can read it. Neither you nor any model ever sees the value. " +
        "When it is for one service, suggest where it may be sent (allow: its API's origin, such as https://api.stripe.com): your owner can then keep it out of every run's environment, and runs use it by reference with secret_http. " +
        "Never ask for a secret in a message. Once it is saved you hear about it and how runs can use it; then continue the work (node_session_send).",
      input: z
        .object({
          name: z.string().min(2).max(64).describe("An environment variable name in capitals, for example STRIPE_API_KEY or GITHUB_PAT."),
          why: z.string().min(1).max(300).describe("What it is for, in one line your owner understands (“to call your staging API in the tests”)."),
          computer: z.string().max(120).optional().describe("Only when your owner names the computer."),
          allow: z.array(z.string().max(300)).max(5).optional().describe("Origins it may be sent to, suggested to your owner (https://api.stripe.com). They decide on the card."),
        })
        .strict(),
      isWrite: false,
      risk: "low",
      async run(_ctx, input) {
        const name = input.name.trim().toUpperCase();
        const problem = secretNameProblem(name);
        if (problem) throw new ToolBlockedError(problem);
        const suggested: string[] = [];
        for (const item of input.allow ?? []) {
          const checked = allowedOrigin(item);
          if ("problem" in checked) throw new ToolBlockedError(checked.problem);
          if (!suggested.includes(checked.origin)) suggested.push(checked.origin);
        }
        const computer = await chooseComputer(scope, input.computer);
        const open = await scope.prisma.nodeMessage.findFirst({
          where: { roomId: scope.room.id, kind: "approval", authorNodeId: scope.node.id, data: { path: ["type"], equals: "secret" }, AND: [{ data: { path: ["name"], equals: name } }, { data: { path: ["status"], equals: "pending" } }] },
          select: { id: true },
        });
        if (open) return toolOk(`You already asked for ${name}; the card is waiting for your owner.`);
        await postMessage(scope.prisma, {
          roomId: scope.room.id,
          userId: scope.node.userId,
          authorKind: "node",
          authorNodeId: scope.node.id,
          kind: "approval",
          body: input.why.trim(),
          data: {
            type: "secret",
            status: "pending",
            name,
            deviceId: computer.id,
            computer: computer.name,
            ...(suggested.length ? { allow: suggested } : {}),
            private: Boolean(scope.privateTo),
            ...(scope.plan?.planStep ? { plan: { id: scope.plan.planId, step: scope.plan.planStep } } : {}),
          },
          visibleTo: [scope.node.userId],
          rootMessageId: scope.lineage.rootMessageId,
          botDepth: scope.lineage.botDepth,
        });
        return toolOk(`Asked your owner for ${name} in a secure box. It goes to ${computer.name}; you will not see it. Tell them in one line, and wait to hear it was saved.`, { name, computer: computer.name });
      },
    }),
    // Only where only the owner reads and started the turn, like the node's other tools on the computer.
    ...(scope.ownerOnly ? [secretHttpTool(scope)] : []),
  ];
}

const SECRET_HTTP_ASK_MS = 45_000;

/** The computer that keeps the secret: the one named, else the default run profile's, else one online. It must take `secret_http`. */
async function secretHttpComputer(scope: Pick<SessionToolScope, "prisma" | "node">, named?: string): Promise<Device> {
  const devices = await scope.prisma.device.findMany({ where: { userId: scope.node.userId, revokedAt: null }, orderBy: [{ lastSeenAt: { sort: "desc", nulls: "last" } }] });
  if (!devices.length) throw new ToolBlockedError("Your owner has no paired computer, so no secret is kept anywhere.");
  const key = named?.trim().toLowerCase();
  let device = key && key !== "any" ? devices.find((row) => row.id === named || row.name.toLowerCase() === key) : undefined;
  if (key && key !== "any" && !device) throw new ToolBlockedError(`No paired computer is called “${named}”.`, `Their computers: ${devices.map((row) => row.name).join(", ")}.`);
  if (!device) {
    const profile = pickRunProfile(await loadSettings(scope.prisma, scope.node.userId));
    device = (profile.deviceId ? devices.find((row) => row.id === profile.deviceId && deviceOnline(row.lastSeenAt)) : undefined) ?? devices.find((row) => deviceOnline(row.lastSeenAt)) ?? devices[0]!;
  }
  if (!deviceOnline(device.lastSeenAt)) throw new ToolBlockedError(`${device.name} is offline.`, "Ensemble must be running there (`ensemble runner start`).");
  const caps = (device.capabilities ?? {}) as { secretHttp?: unknown };
  if (typeof caps.secretHttp !== "number" || caps.secretHttp < 1) throw new ToolBlockedError(`Update Ensemble on ${device.name}: it is too old to use a saved secret by reference.`, "Your owner updates it there (`ensemble update`). Until then a coding agent's run can use the secret as $NAME.");
  return device;
}

/**
 * `secret_http` for a node: the request is made on the owner's computer that keeps the secret, with the
 * value put in there; it goes only to the destinations the owner allowed for that secret, and the
 * answer comes back with the value hidden (credentials/secret-http.ts). Only in a turn only the owner
 * reads and started, like the node's other tools on the computer.
 */
function secretHttpTool(scope: SessionToolScope): AnyHubTool {
  return defineTool({
    name: "secret_http",
    area: "tasks",
    description: `${SECRET_HTTP_DESCRIPTION} It runs on your owner's computer that keeps the secret; you never see the value.`,
    input: z
      .object({
        ref: z.string().min(2).max(80).describe("The saved secret's name, for example STRIPE_KEY."),
        url: z.string().min(1).max(2000).describe("The full https address, on one of the secret's allowed origins."),
        method: z.enum(SECRET_HTTP_METHODS).default("GET"),
        headers: z.record(z.string().min(1).max(100), z.string().max(8000)).optional().describe("Request headers; {{NAME}} in a value is replaced by the secret."),
        body: z.string().max(60_000).optional().describe("The request body (JSON as text); {{NAME}} inside it is replaced by the secret."),
        computer: z.string().max(120).optional().describe("The computer's name, when your owner has more than one."),
      })
      .strict(),
    isWrite: false,
    risk: "medium",
    async run(ctx, input) {
      if (!scope.ownerOnly || scope.lineage.fromNonOwner) throw new ToolBlockedError("A saved secret is used only in a chat with just your owner, started by them.");
      const device = await secretHttpComputer(scope, input.computer);
      const operationId = `${scope.plan?.planId ?? scope.room.id}:secret_http:${randomUUID()}`;
      const mission = scope.plan?.planId ?? `conversation:${scope.room.id}:${scope.privateTo ? "private" : "shared"}`;
      const raw = await askDeviceFor(
        ctx.app.redis as never,
        { deviceId: device.id, event: "node.tool.request", data: { tool: "secret_http", nodeId: scope.node.id, mission, attended: true, grants: [], operationId, ref: input.ref, url: input.url, method: input.method, headers: input.headers, body: input.body } },
        SECRET_HTTP_ASK_MS,
      );
      if (!raw) throw new ToolBlockedError(`${device.name} did not answer. It may be asleep or busy; try again.`);
      const answer = CodeAnswer.safeParse(raw);
      if (!answer.success) throw new ToolBlockedError(`${device.name} sent an answer that could not be read.`);
      const body = (answer.data.body && typeof answer.data.body === "object" ? answer.data.body : {}) as Record<string, unknown>;
      if (answer.data.status >= 400) throw new ToolBlockedError(`${device.name} did not send it: ${typeof body.error === "string" ? body.error : `status ${answer.data.status}`}`);
      let origin: string | null = null;
      try {
        origin = new URL(input.url).origin;
      } catch {
        origin = null;
      }
      await appendLedger({ userId: scope.node.userId, actor: "agent", action: "node.device_tool.secret_http", payload: { nodeId: scope.node.id, deviceId: device.id, origin, ref: input.ref.slice(0, 80), operationId } });
      return toolOk(`HTTP ${String(body.status ?? "?")} from ${typeof body.url === "string" ? body.url : input.url} (the secret's value is hidden).`, { computer: device.name, ...body });
    },
  });
}

const SecretCard = z
  .object({ type: z.literal("secret"), status: z.string(), name: z.string(), deviceId: z.string(), computer: z.string().nullish(), private: z.boolean().optional(), savingId: z.string().optional(), savingAt: z.string().optional() })
  .passthrough();

/** What the owner's browser sends: a box sealed for the computer's key, or (for a computer too old for one) the value itself over TLS. */
export const SecretAnswer = z.union([
  z.object({ sealed: SealedShape }).strict(),
  z.object({ value: z.string().min(1).max(16 * 1024), allow: z.array(z.string().max(300)).max(20).optional() }).strict(),
]);
export type SecretAnswer = z.infer<typeof SecretAnswer>;

/**
 * How the value goes to a computer: `sealed` (its key is pinned and it opens boxes: end to end),
 * `tls` (a computer too old for a key: over HTTPS through this server, not kept), or `pair_again`
 * (it now reports a key other than the one pinned at pairing: nothing is sent until it is paired again).
 */
export type SecretRoute = { mode: "sealed"; sealKey: SealKeyInfo } | { mode: "tls" } | { mode: "pair_again" };

export function secretRouteFor(device: Pick<Device, "sealKey" | "capabilities">): SecretRoute {
  const pinned = pinnedSealKey(device);
  const reported = reportedSealKey(device.capabilities);
  const caps = (device.capabilities ?? {}) as { secrets?: unknown };
  if (pinned && reported && reported.kid !== pinned.kid) return { mode: "pair_again" };
  if (pinned && typeof caps.secrets === "number" && caps.secrets >= 2) return { mode: "sealed", sealKey: { kid: pinned.kid, alg: pinned.alg, spki: pinned.spki, fingerprint: pinned.fingerprint } };
  return { mode: "tls" };
}

const PAIR_AGAIN = (name: string) => `${name} now reports a different key from the one it was paired with, so nothing is sent to it. Pair it again (\`ensemble login\`, or the desktop app), then type the value again.`;

/**
 * The condition under which a card can still be answered: pending, or stuck saving past `SAVE_STALE_MS`.
 * Every change of a card's status is a compare-and-set on it, so a save and a decline never both win.
 */
function answerable(data: z.infer<typeof SecretCard>, now = Date.now()): Prisma.NodeMessageWhereInput | null {
  if (data.status === "pending") return { data: { path: ["status"], equals: "pending" } };
  if (secretStuck(data, now)) return savingBy(data.savingId!);
  return null;
}

/** Still saving, by this save. */
const savingBy = (savingId: string): Prisma.NodeMessageWhereInput => ({ AND: [{ data: { path: ["status"], equals: "saving" } }, { data: { path: ["savingId"], equals: savingId } }] });

/** A secret card left saving by a restart. */
export function secretStuck(raw: unknown, now = Date.now()): boolean {
  const data = (raw ?? {}) as { type?: unknown; status?: unknown; savingId?: unknown; savingAt?: unknown };
  return data.status === "saving" && typeof data.savingId === "string" && typeof data.savingAt === "string" && now - Date.parse(data.savingAt) > SAVE_STALE_MS;
}

/** The card, if this account may answer it: its owner, still in the room. */
async function ownSecretCard(app: FastifyInstance, accountId: string, messageId: string): Promise<{ card: NodeMessage; node: NodeAgent; data: z.infer<typeof SecretCard> }> {
  const card = await app.prisma.nodeMessage.findUnique({ where: { id: messageId } });
  const parsed = card ? SecretCard.safeParse(card.data) : null;
  if (!card || !parsed?.success || card.kind !== "approval" || card.userId !== accountId || !card.authorNodeId) throw new SecretError("That request is not available.", 404);
  const [node, member] = await Promise.all([
    app.prisma.nodeAgent.findUnique({ where: { id: card.authorNodeId } }),
    app.prisma.nodeRoomMember.findFirst({ where: { roomId: card.roomId, userId: accountId, nodeId: null }, select: { id: true } }),
  ]);
  if (!node || node.userId !== accountId || !member) throw new SecretError("That request is not available.", 404);
  return { card, node, data: parsed.data };
}

/** The card's computer and how a value would reach it, for the box on the card (`GET /api/node/secrets/:messageId`). */
export async function secretTarget(app: FastifyInstance, accountId: string, messageId: string): Promise<{ id: string; name: string; status: string; computer: { id: string; name: string; online: boolean }; route: SecretRoute; ttlMs: number; allow: string[] }> {
  const { card, data } = await ownSecretCard(app, accountId, messageId);
  const device = await app.prisma.device.findFirst({ where: { id: data.deviceId, userId: accountId, revokedAt: null } });
  if (!device) throw new SecretError(`${data.computer ?? "That computer"} is no longer paired.`, 409);
  const allow = Array.isArray((card.data as { allow?: unknown }).allow) ? ((card.data as { allow: unknown[] }).allow.filter((item) => typeof item === "string") as string[]) : [];
  return { id: card.id, name: data.name, status: data.status, computer: { id: device.id, name: device.name, online: deviceOnline(device.lastSeenAt) }, route: secretRouteFor(device), ttlMs: SEAL_TTL_MS, allow };
}

/**
 * The frame for the computer: the sealed box as it came, once its associated data matches this card,
 * this computer's pinned key and the page that sent it; or the value, only for a computer with no key.
 * A refusal here is for the owner's browser; the computer checks the box again for itself.
 */
function frameFor(route: SecretRoute, card: NodeMessage, data: z.infer<typeof SecretCard>, deviceName: string, answer: SecretAnswer, origin: string | undefined): Record<string, unknown> {
  if (route.mode === "pair_again") throw new SecretError(PAIR_AGAIN(deviceName), 409, "pair_again");
  if ("value" in answer) {
    if (route.mode === "sealed") throw new SecretError(`${deviceName} takes secrets encrypted in your browser. Reload the page and type it again.`, 400, "seal_required");
    return { name: data.name, value: answer.value, ...(answer.allow ? { allow: answer.allow } : {}) };
  }
  if (route.mode !== "sealed") throw new SecretError(`Ensemble on ${deviceName} is too old to open encrypted values. Update it there, or reload the page to send it over HTTPS.`, 409, "seal_unsupported");
  let aad;
  try {
    aad = readAad(answer.sealed as Sealed);
  } catch (error) {
    throw new SecretError(error instanceof SealError ? error.message : "That encrypted value could not be read.", 400, "seal_shape");
  }
  const now = Date.now();
  const expires = Date.parse(aad.expiresAt);
  const problem =
    answer.sealed.kid !== route.sealKey.kid || aad.kid !== route.sealKey.kid
      ? "It was encrypted for an older key of this computer. Reload the page and type it again."
      : aad.deviceId !== data.deviceId
        ? "It was encrypted for another computer."
        : aad.decisionId !== card.id
          ? "It was encrypted for another request."
          : aad.purpose !== "secret" || aad.name !== data.name
            ? "It was encrypted for another secret."
            : origin && aad.origin !== origin
              ? "It was encrypted on another site."
              : !Number.isFinite(expires) || expires <= now || expires - now > SEAL_MAX_TTL_MS
                ? "It expired. Type it again."
                : null;
  if (problem) throw new SecretError(problem, 400, "seal_bound");
  return { name: data.name, decisionId: card.id, sealed: answer.sealed };
}

/**
 * Relays the owner's answer to the card's computer and records only that it was saved there. Nothing
 * here keeps or logs the value or the box; a failure leaves the card pending with the reason.
 * `origin`: the browser's Origin header, which a sealed box must name.
 */
export async function saveSecret(app: FastifyInstance, accountId: string, messageId: string, answer: SecretAnswer, origin?: string): Promise<NodeMessage> {
  const { card, node, data } = await ownSecretCard(app, accountId, messageId);
  const when = answerable(data);
  if (!when) throw new SecretError("This was already answered.", 409);
  const device = await app.prisma.device.findFirst({ where: { id: data.deviceId, userId: accountId, revokedAt: null } });
  if (!device) throw new SecretError(`${data.computer ?? "That computer"} is no longer paired.`, 409);
  const frame = frameFor(secretRouteFor(device), card, data, device.name, answer, origin);
  if (!deviceOnline(device.lastSeenAt)) throw new SecretError(`${device.name} is offline. Open Ensemble there, then save it again.`, 409);
  const savingId = randomUUID();
  const current = await updateMessageDataIf(app.prisma, card, when, { status: "saving", savingId, savingAt: new Date().toISOString(), error: null });
  if (!current) throw new SecretError("This was already answered.", 409);
  const ours = savingBy(savingId);
  const reply = (await askDeviceFor(app.redis as never, { deviceId: device.id, event: "secret.save", data: frame }, SAVE_MS).catch(() => null)) as { status?: number; body?: { error?: unknown; allow?: unknown } } | null;
  if (!reply || (reply.status ?? 500) >= 400) {
    const reason = reply ? (typeof reply.body?.error === "string" ? reply.body.error.slice(0, 300) : `${device.name} could not save it.`) : `${device.name} did not answer. Check Ensemble is running there and save it again.`;
    await updateMessageDataIf(app.prisma, current, ours, { status: "pending", error: reason });
    throw new SecretError(reason, 502);
  }
  const sealed = "sealed" in frame;
  const allow = Array.isArray(reply.body?.allow) ? (reply.body.allow as unknown[]).filter((item): item is string => typeof item === "string" && "origin" in allowedOrigin(item)).slice(0, 20) : [];
  await appendLedger({ userId: accountId, actor: "me", action: "node.secret_saved", payload: { nodeId: node.id, name: data.name, deviceId: device.id, sealed, allow } });
  const updated = await updateMessageDataIf(app.prisma, current, ours, { status: "saved", error: null, savedAt: new Date().toISOString(), computer: device.name, sealed, allow });
  if (!updated) throw new SecretError("This was already answered.", 409);
  const use = allow.length
    ? `It is kept for use by reference only, never in a run's environment: runs there can send it to ${allow.join(", ")} with the secret_http tool ({{${data.name}}} where the value goes), and git over https to those hosts signs in with it. Tell the agent that.`
    : `Agent runs there that may have it get it as $${data.name}; tell the agent to use $${data.name}.`;
  await enqueueTurn(app, {
    nodeId: node.id,
    roomId: card.roomId,
    reason: "approval",
    note: `Your owner saved ${data.name} on ${device.name} (you never see the value). ${use} Continue the work that needed it: send the session the next step.`,
    private: data.private === true,
    ...(planLinkOf(card.data) ?? {}),
  });
  return updated;
}

/** The owner said no: the node hears it and goes on without. */
export async function declineSecret(app: FastifyInstance, accountId: string, messageId: string): Promise<NodeMessage> {
  const { card, node, data } = await ownSecretCard(app, accountId, messageId);
  const when = answerable(data);
  if (!when) throw new SecretError("This was already answered.", 409);
  const updated = await updateMessageDataIf(app.prisma, card, when, { status: "discarded" });
  if (!updated) throw new SecretError("This was already answered.", 409);
  await enqueueTurn(app, { nodeId: node.id, roomId: card.roomId, reason: "approval", note: `Your owner declined to give ${data.name}. Go on without it, or say what cannot be done without it.`, private: data.private === true, ...(planLinkOf(card.data) ?? {}) });
  return updated;
}
