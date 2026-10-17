/**
 * One place that runs a connector: read → store → propose → record.
 * Used by Fetch now, the per-connector Sync button and the scheduler.
 */
import type { FastifyInstance } from "fastify";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings } from "../lib/settings.js";
import { requireVerifiedUser } from "../lib/hosted-access.js";
import { checkConnectorLimit } from "../lib/hosted-limits.js";
import { sseHub } from "../lib/sse.js";
import { connectionState, getConnector, listConnectors } from "./base.js";
import { syncPeople } from "./people-sync.js";
import { ConnectorError } from "./types.js";

export interface SyncOutcome {
  id: string;
  ok: boolean;
  message: string;
  items?: number;
  proposed?: number;
}

const running = new Map<string, Promise<SyncOutcome>>();

export function syncConnector(app: FastifyInstance, userId: string, id: string): Promise<SyncOutcome> {
  const key = `${userId}:${id}`;
  const existing = running.get(key);
  if (existing) return existing;
  const job = run(app, userId, id).finally(() => running.delete(key));
  running.set(key, job);
  return job;
}

async function run(app: FastifyInstance, userId: string, id: string): Promise<SyncOutcome> {
  await requireVerifiedUser(userId);
  const { prisma } = app;
  const connector = getConnector(id);
  if (!connector) return { id, ok: false, message: "Unknown connector." };
  if (!connector.sync) return { id, ok: true, message: connector.connect === "builtin" ? "Nothing to fetch." : connector.setupHint };
  const settings = await loadSettings(prisma, userId);
  checkConnectorLimit(settings.connections);
  const state = await connectionState(userId, connector);
  const record = async (data: { ok: boolean; message: string; items?: number; cursor?: string | null }) =>
    prisma.syncState.upsert({
      where: { userId_connector: { userId, connector: id } },
      create: {
        userId,
        connector: id,
        lastSyncAt: data.ok ? new Date() : null,
        lastError: data.ok ? null : data.message,
        itemCount: data.items ?? 0,
        cursor: data.cursor ?? null,
      },
      update: {
        ...(data.ok ? { lastSyncAt: new Date(), itemCount: data.items ?? 0 } : {}),
        lastError: data.ok ? null : data.message,
        ...(data.cursor !== undefined ? { cursor: data.cursor } : {}),
      },
    });
  if (!state.configured) {
    const message = `Not connected. ${connector.setupHint}`;
    await record({ ok: false, message });
    return { id, ok: false, message };
  }
  const previous = await prisma.syncState.findUnique({ where: { userId_connector: { userId, connector: id } } });
  const lookback = new Date(Date.now() - settings.fetch.lookbackDays * 86_400_000);
  const since = previous?.lastSyncAt && previous.lastSyncAt > lookback ? new Date(previous.lastSyncAt.getTime() - 10 * 60_000) : lookback;
  try {
    const items = await syncPeople(id, { userId, settings, since, cursor: null });
    const message = `${items} ${items === 1 ? "person" : "people"} updated. Files and messages are saved only when you ask.`;
    await record({ ok: true, message, items });
    await appendLedger({ userId, actor: "me", action: `connector.sync.${id}`, payload: { people: items } });
    sseHub.publish(userId, { event: "sync", data: { id, people: items } });
    return { id, ok: true, message, items, proposed: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    app.log.warn({ connector: id, err: message }, "connector sync failed");
    await record({ ok: false, message: error instanceof ConnectorError ? message : `Sync failed: ${message}` });
    return { id, ok: false, message };
  }
}

export async function fetchAll(app: FastifyInstance, userId: string, reason: "button" | "schedule"): Promise<{ results: SyncOutcome[]; message?: string }> {
  if (reason === "schedule") return { results: [], message: "Use Sync people to update your contacts. Files are saved only when you ask." };
  await requireVerifiedUser(userId);
  const settings = await loadSettings(app.prisma, userId);
  const enabled = listConnectors().filter((connector) => connector.sync && settings.connections[connector.id]?.enabled);
  checkConnectorLimit(settings.connections);
  const results: SyncOutcome[] = [];
  // Mail first, so calendar and GitHub proposals land under the asks from people.
  for (const connector of enabled) results.push(await syncConnector(app, userId, connector.id));
  await appendLedger({ userId, actor: reason === "button" ? "me" : "system", action: "fetch.now", payload: { reason, results: results.map(({ id, ok }) => ({ id, ok })) } });
  sseHub.publish(userId, { event: "sync", data: { results } });
  return {
    results,
    message: enabled.length ? undefined : "No sources are switched on. Turn one on in Settings → Connections.",
  };
}
