/**
 * Secrets a node needs for work on its owner's computer (docs/35 §8.7): an API key, a token. The node
 * asks by name with `node_secret_request`; its owner types the value into a secure box on the card (on
 * Node or in the Hub's Needs me), and the value goes straight to the paired computer (`secret.save`),
 * which keeps it encrypted and gives it to its agent runs as an environment variable. The value is
 * never in a message, a model's input or the database here; the card keeps only the name, why, and
 * where it was saved.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { NodeAgent, NodeMessage, Prisma, PrismaClient } from "@prisma/client";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool } from "../assistant/types.js";
import { deviceOnline } from "../devices/constants.js";
import { askDeviceFor } from "../devices/file-relay.js";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings } from "../lib/settings.js";
import { secretNameProblem } from "../lib/run-secrets.js";
import { pickRunProfile } from "@ensemble/shared-types";
import { enqueueTurn } from "./queue.js";
import { postMessage, updateMessageDataIf } from "./store.js";
import { planLinkOf } from "./plans.js";
import type { SessionToolScope } from "./sessions.js";

const SAVE_MS = 20_000;
/** A card left "saving" this long (the server restarted mid-save) can be answered again. */
export const SAVE_STALE_MS = SAVE_MS + 10_000;

export class SecretError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 | 502) {
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
        "Ask your owner for a secret the work on their computer needs (an API key, a token, a password), by environment variable name. They type it into a secure box on a card; it goes straight to their computer, which gives it to the coding agents' runs there as $NAME. Neither you nor any model ever sees the value. " +
        "Never ask for a secret in a message. Once it is saved you hear about it; then continue the work (node_session_send) and tell the agent to use $NAME.",
      input: z
        .object({
          name: z.string().min(2).max(64).describe("An environment variable name in capitals, for example STRIPE_API_KEY or GITHUB_PAT."),
          why: z.string().min(1).max(300).describe("What it is for, in one line your owner understands (“to call your staging API in the tests”)."),
          computer: z.string().max(120).optional().describe("Only when your owner names the computer."),
        })
        .strict(),
      isWrite: false,
      risk: "low",
      async run(_ctx, input) {
        const name = input.name.trim().toUpperCase();
        const problem = secretNameProblem(name);
        if (problem) throw new ToolBlockedError(problem);
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
            private: Boolean(scope.privateTo),
            ...(scope.plan?.planStep ? { plan: { id: scope.plan.planId, step: scope.plan.planStep } } : {}),
          },
          visibleTo: [scope.node.userId],
          rootMessageId: scope.lineage.rootMessageId,
          botDepth: scope.lineage.botDepth,
        });
        return toolOk(`Asked your owner for ${name} in a secure box. It goes straight to ${computer.name}; you will not see it. Tell them in one line, and wait to hear it was saved.`, { name, computer: computer.name });
      },
    }),
  ];
}

const SecretCard = z
  .object({ type: z.literal("secret"), status: z.string(), name: z.string(), deviceId: z.string(), computer: z.string().nullish(), private: z.boolean().optional(), savingId: z.string().optional(), savingAt: z.string().optional() })
  .passthrough();

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

/**
 * Sends the value to the card's computer and records only that it was saved there. Nothing here keeps
 * or logs the value; a failure leaves the card pending with the reason.
 */
export async function saveSecret(app: FastifyInstance, accountId: string, messageId: string, value: string): Promise<NodeMessage> {
  const { card, node, data } = await ownSecretCard(app, accountId, messageId);
  const when = answerable(data);
  if (!when) throw new SecretError("This was already answered.", 409);
  const device = await app.prisma.device.findFirst({ where: { id: data.deviceId, userId: accountId, revokedAt: null } });
  if (!device) throw new SecretError(`${data.computer ?? "That computer"} is no longer paired.`, 409);
  if (!deviceOnline(device.lastSeenAt)) throw new SecretError(`${device.name} is offline. Open Ensemble there, then save it again.`, 409);
  const savingId = randomUUID();
  const current = await updateMessageDataIf(app.prisma, card, when, { status: "saving", savingId, savingAt: new Date().toISOString(), error: null });
  if (!current) throw new SecretError("This was already answered.", 409);
  const ours = savingBy(savingId);
  const answer = (await askDeviceFor(app.redis as never, { deviceId: device.id, event: "secret.save", data: { name: data.name, value } }, SAVE_MS).catch(() => null)) as { status?: number; body?: { error?: unknown } } | null;
  if (!answer || (answer.status ?? 500) >= 400) {
    const reason = answer ? (typeof answer.body?.error === "string" ? answer.body.error : `${device.name} could not save it.`) : `${device.name} did not answer. Check Ensemble is running there and save it again.`;
    await updateMessageDataIf(app.prisma, current, ours, { status: "pending", error: reason });
    throw new SecretError(reason, 502);
  }
  await appendLedger({ userId: accountId, actor: "me", action: "node.secret_saved", payload: { nodeId: node.id, name: data.name, deviceId: device.id } });
  const updated = await updateMessageDataIf(app.prisma, current, ours, { status: "saved", error: null, savedAt: new Date().toISOString(), computer: device.name });
  if (!updated) throw new SecretError("This was already answered.", 409);
  await enqueueTurn(app, {
    nodeId: node.id,
    roomId: card.roomId,
    reason: "approval",
    note: `Your owner saved ${data.name} on ${device.name}. Agent runs there now have it as $${data.name} (you never see the value). Continue the work that needed it: send the session the next step and tell the agent to use $${data.name}.`,
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
