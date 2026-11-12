/**
 * Deleting an assistant chat (docs/11 §2, docs/30 §8). The chat and its messages go at once. When
 * its replies ran on the person's own AI subscription, the agent session behind it lives on the
 * computer that ran it (`subscriptions/turn-sessions.ts`), so each of the person's computers is
 * asked to drop it: now if it is online, else when it next connects.
 */
import type { FastifyInstance } from "fastify";
import type { Device, Prisma } from "@prisma/client";
import { ASSISTANT_SESSION_DELETE_API } from "@ensemble/shared-types";
import { deviceOnline } from "../devices/constants.js";
import { askDeviceFor } from "../devices/file-relay.js";
import { requestCancel } from "../lib/activity.js";
import { appendLedger } from "../lib/ledger.js";
import { actorFor } from "../sharing/context.js";
import { deviceOwners } from "../subscriptions/turn.js";
import { abortAssistantTurn } from "./agent.js";

/** Chats whose session a computer has not confirmed dropping yet, by device. Kept per person in preferences. */
const PENDING = "assistant.session-deletes";
/** A computer drops sessions unused this long on its own (turn-sessions.ts), so older requests can go. */
const KEEP_MS = 30 * 24 * 3600_000;
const MAX_PENDING = 500;
const ASK_MS = 30_000;

type Pending = Record<string, Array<{ key: string; at: number }>>;
type Owned = Pick<Device, "id" | "userId" | "lastSeenAt" | "capabilities">;

const capable = (device: Pick<Device, "capabilities">) => Number((device.capabilities as { assistantSessionDelete?: unknown } | null)?.assistantSessionDelete ?? 0) >= ASSISTANT_SESSION_DELETE_API;
/** Computers that ran or could run the assistant on a subscription: only they keep chat sessions. */
const runsTurns = (device: Pick<Device, "capabilities">) => Number((device.capabilities as { assistantTurns?: unknown } | null)?.assistantTurns ?? 0) >= 1;

async function readPending(app: FastifyInstance, userId: string): Promise<Pending> {
  const row = await app.prisma.preference.findUnique({ where: { userId_key: { userId, key: PENDING } } });
  const value = row && !row.deletedAt ? row.value : null;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Pending) : {};
}

async function writePending(app: FastifyInstance, userId: string, pending: Pending): Promise<void> {
  const now = Date.now();
  const tidy: Pending = {};
  for (const [deviceId, rows] of Object.entries(pending)) {
    const kept = rows.filter((row) => now - row.at < KEEP_MS).slice(-MAX_PENDING);
    if (kept.length) tidy[deviceId] = kept;
  }
  const value = tidy as unknown as Prisma.InputJsonValue;
  await app.prisma.preference.upsert({
    where: { userId_key: { userId, key: PENDING } },
    create: { userId, key: PENDING, value, source: "system" },
    update: { value, deletedAt: null },
  });
}

/** Changes the pending list one step at a time, so two deletes (or a delete and a drain) do not undo each other. */
let pendingQueue: Promise<unknown> = Promise.resolve();
function changePending(app: FastifyInstance, userId: string, change: (pending: Pending) => void): Promise<void> {
  const next = pendingQueue.then(async () => {
    const pending = await readPending(app, userId);
    change(pending);
    await writePending(app, userId, pending);
  });
  pendingQueue = next.catch(() => undefined);
  return next;
}

/** Asks one computer to drop a chat's session. True once it confirmed. */
async function askComputer(app: FastifyInstance, deviceId: string, key: string): Promise<boolean> {
  const answer = (await askDeviceFor(app.redis, { deviceId, event: "assistant.session.delete", data: { key } }, ASK_MS).catch(() => null)) as { status?: unknown; body?: { deleted?: unknown } } | null;
  return answer?.status === 200 && answer.body?.deleted === true;
}

/** Drops the chat's session on this computer (desktop or CLI runtime), or asks the person's paired computers (an ask's page session too, ask-sessions.ts). */
export async function dropChatSessions(app: FastifyInstance, userId: string, key: string): Promise<void> {
  if (process.env.ENSEMBLE_DESKTOP === "1") {
    const { dropAssistantSession } = await import("../remote/assistant-session-delete.js");
    await dropAssistantSession(key);
    return;
  }
  const devices: Owned[] = await app.prisma.device.findMany({
    where: { userId: { in: deviceOwners(userId) }, revokedAt: null },
    select: { id: true, userId: true, lastSeenAt: true, capabilities: true },
  });
  const later: Owned[] = [];
  await Promise.all(
    devices.filter(runsTurns).map(async (device) => {
      if (deviceOnline(device.lastSeenAt) && capable(device) && (await askComputer(app, device.id, key))) return;
      later.push(device);
    }),
  );
  // Kept with the computer's owner, where its next connection looks.
  for (const owner of new Set(later.map((device) => device.userId))) {
    await changePending(app, owner, (pending) => {
      for (const device of later.filter((row) => row.userId === owner)) pending[device.id] = [...(pending[device.id] ?? []).filter((row) => row.key !== key), { key, at: Date.now() }];
    });
  }
}

/**
 * Deletes one of the person's own chats. False when it is not theirs (or is an Ensemble Node room's
 * working chat). The agent sessions are dropped after the reply, so the chat disappears at once.
 * `keepTurn`: the deletion comes from a tool in this chat's own turn (a routine deleted from its own
 * conversation), which finishes instead of being stopped.
 */
export async function deleteAssistantChat(app: FastifyInstance, userId: string, id: string, options: { keepTurn?: boolean } = {}): Promise<boolean> {
  const chat = await app.prisma.assistantConversation.findFirst({
    where: { id, userId, accountId: actorFor(userId), OR: [{ startedOn: null }, { startedOn: { not: "node" } }] },
    select: { id: true },
  });
  if (!chat) return false;
  if (!options.keepTurn) {
    abortAssistantTurn(id);
    await requestCancel(app.redis, userId, `assistant:${id}`);
  }
  await app.prisma.$transaction([
    app.prisma.assistantWorkflow.deleteMany({ where: { userId, conversationId: id } }),
    app.prisma.assistantConversation.delete({ where: { id } }),
  ]);
  await appendLedger({ userId, actor: "me", action: "assistant.conversation.delete", payload: { conversationId: id } });
  void dropChatSessions(app, userId, id).catch((error: unknown) => app.log.warn({ err: error }, "Could not delete a chat's agent sessions"));
  return true;
}

const draining = new Set<string>();

/**
 * The scheduler's minute: chat sessions still waiting on a computer that is online now (it was busy
 * finishing that chat's turn, or did not answer in time) are asked for again, and the waits of computers
 * no longer paired are dropped.
 */
export async function retryAssistantSessionDeletes(app: FastifyInstance): Promise<void> {
  const rows = await app.prisma.preference.findMany({ where: { key: PENDING, deletedAt: null }, select: { userId: true, value: true } });
  for (const row of rows) {
    const pending = row.value && typeof row.value === "object" && !Array.isArray(row.value) ? (row.value as Pending) : {};
    const ids = Object.keys(pending);
    if (!ids.length) continue;
    const devices = await app.prisma.device.findMany({ where: { id: { in: ids } }, select: { id: true, userId: true, lastSeenAt: true, capabilities: true, revokedAt: true } });
    const paired = new Set(devices.filter((device) => !device.revokedAt).map((device) => device.id));
    if (ids.some((id) => !paired.has(id))) {
      await changePending(app, row.userId, (current) => {
        for (const id of Object.keys(current)) if (!paired.has(id)) delete current[id];
      });
    }
    for (const device of devices) {
      if (device.revokedAt || !deviceOnline(device.lastSeenAt)) continue;
      const last = retried.get(device.id) ?? 0;
      if (Date.now() - last < RETRY_MS) continue;
      retried.set(device.id, Date.now());
      await drainAssistantSessionDeletes(app, device).catch(() => undefined);
    }
  }
}

/** A computer that is online but has not confirmed is asked again at most this often. */
const RETRY_MS = 5 * 60_000;
const retried = new Map<string, number>();

/**
 * A computer opened its event stream: send it the chat sessions it missed while it was away. Each one
 * it confirms leaves the list; the rest wait for its next connection.
 */
export async function drainAssistantSessionDeletes(app: FastifyInstance, device: Owned): Promise<void> {
  if (draining.has(device.id) || !capable(device)) return;
  const keys = (await readPending(app, device.userId))[device.id]?.map((row) => row.key) ?? [];
  if (!keys.length) return;
  draining.add(device.id);
  try {
    const done = new Set<string>();
    for (const key of keys) if (await askComputer(app, device.id, key)) done.add(key);
    if (done.size) {
      await changePending(app, device.userId, (pending) => {
        const rest = (pending[device.id] ?? []).filter((row) => !done.has(row.key));
        if (rest.length) pending[device.id] = rest;
        else delete pending[device.id];
      });
    }
  } finally {
    draining.delete(device.id);
  }
}
