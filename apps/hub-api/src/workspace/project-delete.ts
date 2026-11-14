/**
 * Deleting an Ensemble project, on the person's computers (docs/30, In the agents' own apps). The project
 * goes to Trash at once. The Codex projects Ensemble made for it on a computer (`remote/project-delete.ts`)
 * go once it has been there 10 minutes, so Undo finds everything as it was, and not at all if it is back
 * by then. Each computer that may have one is asked then if it is online, else when its event stream next
 * opens; the desktop app or CLI runtime removes those of its own projects itself.
 */
import type { FastifyInstance } from "fastify";
import type { Device, Prisma, PrismaClient } from "@prisma/client";
import { deviceOnline } from "../devices/constants.js";
import { askDeviceFor } from "../devices/file-relay.js";
import { PROJECT_DELETE_API } from "../remote/contract.js";

/** Deleted projects a computer has not removed its Codex projects for yet, by device. Kept per person in preferences. */
const PENDING = "projects.codex-project-deletes";
/** This computer: a project deleted in the desktop app or CLI runtime's own Ensemble. */
const HERE = "this-computer";
/** Undo and Trash bring a project back as it was within this time; only then do its Codex projects go. */
export const PROJECT_UNDO_MS = 10 * 60_000;
/** A computer away longer keeps them. */
const KEEP_MS = 90 * 86_400_000;
const MAX_PENDING = 500;
/** Codex starts twice on the computer: once to find the projects, once to delete them. */
const ASK_MS = 60_000;
/** A computer that is online but has not confirmed is asked again at most this often. */
const RETRY_MS = 5 * 60_000;

type Pending = Record<string, Array<{ key: string; at: number }>>;
type Owned = Pick<Device, "id" | "userId" | "lastSeenAt" | "capabilities">;
type Db = Pick<PrismaClient, "preference" | "device" | "workspaceJob" | "project">;

const capable = (device: Pick<Device, "capabilities">) => Number((device.capabilities as { projectDelete?: unknown } | null)?.projectDelete ?? 0) >= PROJECT_DELETE_API;
const asPending = (value: unknown): Pending => (value && typeof value === "object" && !Array.isArray(value) ? (value as Pending) : {});
const local = () => process.env.ENSEMBLE_DESKTOP === "1";

async function readPending(db: Db, userId: string): Promise<Pending> {
  const row = await db.preference.findUnique({ where: { userId_key: { userId, key: PENDING } } });
  return asPending(row && !row.deletedAt ? row.value : null);
}

async function writePending(db: Db, userId: string, pending: Pending): Promise<void> {
  const now = Date.now();
  const tidy: Pending = {};
  for (const [computer, rows] of Object.entries(pending)) {
    const kept = rows.filter((row) => now - row.at < KEEP_MS).slice(-MAX_PENDING);
    if (kept.length) tidy[computer] = kept;
  }
  const value = tidy as unknown as Prisma.InputJsonValue;
  await db.preference.upsert({
    where: { userId_key: { userId, key: PENDING } },
    create: { userId, key: PENDING, value, source: "system" },
    update: { value, deletedAt: null },
  });
}

/** Changes the pending list one step at a time, so two deletes (or a delete and a drain) do not undo each other. */
let pendingQueue: Promise<unknown> = Promise.resolve();
function changePending(db: Db, userId: string, change: (pending: Pending) => void): Promise<void> {
  const next = pendingQueue.then(async () => {
    const pending = await readPending(db, userId);
    change(pending);
    await writePending(db, userId, pending);
  });
  pendingQueue = next.catch(() => undefined);
  return next;
}

/** Of these projects, the ones back from Trash (Undo, a restore, an Apply that did not happen). One erased for good is still deleted. */
async function restored(db: Db, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  return new Set((await db.project.findMany({ where: { id: { in: keys }, deletedAt: null }, select: { id: true } })).map((row) => row.id));
}

const due = (rows: Pending[string] | undefined, now: number) => (rows ?? []).filter((row) => now - row.at >= PROJECT_UNDO_MS).map((row) => row.key);

/** Takes projects off a computer's list. */
function settle(db: Db, userId: string, computer: string, keys: Set<string>): Promise<void> {
  if (!keys.size) return Promise.resolve();
  return changePending(db, userId, (pending) => {
    const rest = (pending[computer] ?? []).filter((row) => !keys.has(row.key));
    if (rest.length) pending[computer] = rest;
    else delete pending[computer];
  });
}

/**
 * A project went to Trash: the computers that may have a Codex project for it are noted, kept with each
 * computer's owner, where its next connection looks. That is every computer that ran a Codex task of the
 * project (in a shared space, a member's too) and every computer of the account itself.
 */
export async function noteProjectDeleted(db: Db, userId: string, projectId: string, now = Date.now()): Promise<void> {
  const add = (pending: Pending, computer: string) => {
    pending[computer] = [...(pending[computer] ?? []).filter((row) => row.key !== projectId), { key: projectId, at: now }];
  };
  if (local()) {
    await changePending(db, userId, (pending) => add(pending, HERE));
    return;
  }
  const ran = await db.workspaceJob.findMany({ where: { userId, provider: "codex", deviceId: { not: null }, task: { projectId } }, select: { deviceId: true }, distinct: ["deviceId"] });
  const devices = await db.device.findMany({
    where: { revokedAt: null, OR: [{ userId }, { id: { in: ran.flatMap((row) => (row.deviceId ? [row.deviceId] : [])) } }] },
    select: { id: true, userId: true },
  });
  for (const owner of new Set(devices.map((device) => device.userId))) {
    await changePending(db, owner, (pending) => {
      for (const device of devices) if (device.userId === owner) add(pending, device.id);
    });
  }
}

/** Asks one computer to remove a project's Codex projects. True once it confirmed. */
async function askComputer(app: FastifyInstance, deviceId: string, projectId: string): Promise<boolean> {
  const answer = (await askDeviceFor(app.redis, { deviceId, event: "project.delete", data: { projectId } }, ASK_MS).catch(() => null)) as { status?: unknown; body?: { deleted?: unknown } } | null;
  return answer?.status === 200 && answer.body?.deleted === true;
}

const draining = new Set<string>();
const retried = new Map<string, number>();

/** One computer's removals at a time. True when none of its due ones is left. */
async function exclusive(computer: string, run: () => Promise<boolean>): Promise<boolean> {
  if (draining.has(computer)) return false;
  draining.add(computer);
  try {
    return await run();
  } finally {
    draining.delete(computer);
  }
}

/**
 * A computer opened its event stream, or the scheduler found it online: it is asked to remove the Codex
 * projects of each project that has been in Trash 10 minutes. Each it confirms leaves the list, and so
 * does each project back from Trash; the rest wait for its next connection. True when none is left.
 */
export function drainProjectDeletes(app: FastifyInstance, device: Owned, now = Date.now()): Promise<boolean> {
  if (!capable(device)) return Promise.resolve(false);
  return exclusive(device.id, async () => {
    const keys = due((await readPending(app.prisma, device.userId))[device.id], now);
    const done = await restored(app.prisma, keys);
    for (const key of keys) if (!done.has(key) && (await askComputer(app, device.id, key))) done.add(key);
    await settle(app.prisma, device.userId, device.id, done);
    return done.size === keys.length;
  });
}

/** The desktop app or CLI runtime: the Codex projects of its own deleted projects, on this computer. */
function removeHere(app: FastifyInstance, userId: string, now: number): Promise<boolean> {
  return exclusive(`${HERE}:${userId}`, async () => {
    const keys = due((await readPending(app.prisma, userId))[HERE], now);
    const done = await restored(app.prisma, keys);
    const { removeProjectHere } = await import("../remote/project-delete.js");
    for (const key of keys) {
      if (done.has(key)) continue;
      try {
        await removeProjectHere(key);
        done.add(key);
      } catch (error) {
        app.log.warn({ err: error }, "Could not remove a deleted project's Codex projects");
      }
    }
    await settle(app.prisma, userId, HERE, done);
    return done.size === keys.length;
  });
}

/**
 * The scheduler's minute: projects 10 minutes in Trash have their Codex projects removed, on this computer
 * and on each online paired computer, again at most every 5 minutes until it confirms. The waits of
 * computers no longer paired are dropped.
 */
export async function sendProjectDeletes(app: FastifyInstance, now = Date.now()): Promise<void> {
  const rows = await app.prisma.preference.findMany({ where: { key: PENDING, deletedAt: null }, select: { userId: true, value: true } });
  for (const row of rows) {
    const pending = asPending(row.value);
    const ids = Object.keys(pending).filter((id) => id !== HERE);
    const devices = ids.length ? await app.prisma.device.findMany({ where: { id: { in: ids } }, select: { id: true, userId: true, lastSeenAt: true, capabilities: true, revokedAt: true } }) : [];
    const paired = new Set(devices.filter((device) => !device.revokedAt).map((device) => device.id));
    const unpaired = ids.filter((id) => !paired.has(id));
    if (unpaired.length) {
      await changePending(app.prisma, row.userId, (current) => {
        for (const id of unpaired) delete current[id];
      });
    }
    const computers: Array<{ id: string; run: () => Promise<boolean> }> = [];
    if (local() && due(pending[HERE], now).length) computers.push({ id: `${HERE}:${row.userId}`, run: () => removeHere(app, row.userId, now) });
    for (const device of devices) {
      if (device.revokedAt || !deviceOnline(device.lastSeenAt) || !capable(device) || !due(pending[device.id], now).length) continue;
      computers.push({ id: device.id, run: () => drainProjectDeletes(app, device, now) });
    }
    for (const computer of computers) {
      if (now - (retried.get(computer.id) ?? 0) < RETRY_MS) continue;
      if (await computer.run().catch(() => false)) retried.delete(computer.id);
      else retried.set(computer.id, now);
    }
  }
}
