/**
 * Resource claims (ensemble-node docs/design B13, plan §9.3): what a plan step, a run or the browser
 * broker uses on a computer, so two never use it at once: a folder's checkout, a git worktree, a branch,
 * a development-server port, a browser profile or tab. A claim blocks only that one resource and never
 * refuses work. A holder that finds it taken waits in line (`waiting`); when the holder lets go, the first
 * in line gets it (a handover), in the order they asked.
 *
 * Every change to one resource holds its advisory lock (`ensemble:claim:<kind>:<key>`), so a claim and a
 * release never cross. A plan step's claims end with the step, in the transaction that ends it, and its
 * mission's when the mission ends or stops (`releaseIn`, called from node/plans.ts). A step that waited
 * in line is woken through the mission outbox, holding the resource. A holder that is a step of an ended
 * or deleted mission is let go the next time someone asks for its resource.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Prisma, type PrismaClient, type ResourceClaim } from "@prisma/client";

export const CLAIM_KINDS = ["checkout", "worktree", "branch", "port", "browser_profile", "browser_tab"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** Development-server ports handed to parallel steps, per computer. */
export const PORT_RANGE = { from: 4300, to: 4399 } as const;

export type ClaimInput = {
  userId: string;
  kind: ClaimKind;
  /** The resource, scoped to its computer: `<deviceId>:<folder>`, `<deviceId>:<port>`, `<deviceId>:<profile>`. */
  key: string;
  holder: string;
  missionId?: string | null;
  stepId?: string | null;
  data?: Record<string, unknown>;
};

/** A resource that changed hands: `claim` is now held by the first in line; `from` is the released claim's id. */
export type Handover = { claim: ResourceClaim; from: string };
export type Claimed = ({ ok: true; claim: ResourceClaim } | { ok: false; heldBy: ResourceClaim }) & { handovers: Handover[] };

/** `released`: a resource may be free (waiters in this process look again at once; others poll). */
export const claimEvents = new EventEmitter();
claimEvents.setMaxListeners(0);

const ENDED_STEP = new Set(["done", "blocked", "skipped", "stopped"]);
const ENDED_MISSION = new Set(["succeeded", "partially_completed", "failed", "stopped", "done"]);

export function stepHolder(missionId: string, stepId: string): string {
  return `step:${missionId}:${stepId}`;
}

async function lock(tx: Prisma.TransactionClient, kind: string, key: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS held FROM pg_advisory_xact_lock(hashtext(${`ensemble:claim:${kind}:${key}`}))`;
}

/** A plan step's claim whose step or mission has ended, or is gone (its node was deleted). */
async function deadStep(tx: Prisma.TransactionClient, row: Pick<ResourceClaim, "missionId" | "stepId">): Promise<boolean> {
  if (!row.missionId || !row.stepId) return false;
  const [mission, step] = await Promise.all([
    tx.nodeMission.findUnique({ where: { id: row.missionId }, select: { status: true } }),
    tx.nodeStep.findUnique({ where: { missionId_id: { missionId: row.missionId, id: row.stepId } }, select: { status: true } }),
  ]);
  return !mission || !step || ENDED_MISSION.has(mission.status) || ENDED_STEP.has(step.status);
}

/** A step that waited in line gets its turn: its attempt is delivered again through the mission outbox, now holding the resource. */
async function wakeStep(tx: Prisma.TransactionClient, claim: ResourceClaim, from: string): Promise<void> {
  if (!claim.missionId || !claim.stepId) return;
  const data = (claim.data ?? {}) as { attempt?: unknown; reason?: unknown };
  const operationId = `${claim.missionId}:wake:${claim.stepId}:${from}`;
  await tx.nodeOutbox.upsert({
    where: { operationId },
    create: { operationId, missionId: claim.missionId, kind: "turn", payload: { stepId: claim.stepId, attempt: Number(data.attempt ?? 1), reason: String(data.reason ?? "first"), woken: claim.kind } },
    update: {},
  });
}

/** The resource is free: the first one still waiting for it (in the order they asked) holds it now. */
async function handOver(tx: Prisma.TransactionClient, kind: string, key: string, from: string): Promise<Handover | null> {
  if (await tx.resourceClaim.findFirst({ where: { kind, key, state: "held" }, select: { id: true } })) return null;
  const waiting = await tx.resourceClaim.findMany({ where: { kind, key, state: "waiting" }, orderBy: { sequence: "asc" } });
  for (const next of waiting) {
    if (await deadStep(tx, next)) {
      await tx.resourceClaim.delete({ where: { id: next.id } });
      continue;
    }
    const claim = await tx.resourceClaim.update({ where: { id: next.id }, data: { state: "held" } });
    await wakeStep(tx, claim, from);
    return { claim, from };
  }
  return null;
}

/**
 * Takes a resource for `holder` inside a transaction, or puts the holder in line for it (unless `wait`
 * is false). Taking one it already holds is fine and keeps its place.
 */
export async function claimIn(tx: Prisma.TransactionClient, input: ClaimInput, options: { wait?: boolean } = {}): Promise<Claimed> {
  await lock(tx, input.kind, input.key);
  const handovers: Handover[] = [];
  let held = await tx.resourceClaim.findFirst({ where: { kind: input.kind, key: input.key, state: "held" } });
  if (held && held.holder !== input.holder && (await deadStep(tx, held))) {
    await tx.resourceClaim.delete({ where: { id: held.id } });
    const handover = await handOver(tx, input.kind, input.key, held.id);
    if (handover) handovers.push(handover);
    held = handover?.claim ?? null;
  }
  const data = input.data as Prisma.InputJsonValue | undefined;
  if (held && held.holder === input.holder) return { ok: true, claim: data ? await tx.resourceClaim.update({ where: { id: held.id }, data: { data } }) : held, handovers };
  const where = { kind_key_holder: { kind: input.kind, key: input.key, holder: input.holder } };
  const fields = { userId: input.userId, kind: input.kind, key: input.key, holder: input.holder, missionId: input.missionId ?? null, stepId: input.stepId ?? null, data: data ?? {} };
  if (held) {
    // In line, keeping its first place when it asks again.
    if (options.wait !== false) await tx.resourceClaim.upsert({ where, create: { ...fields, state: "waiting" }, update: data ? { data } : {} });
    return { ok: false, heldBy: held, handovers };
  }
  const claim = await tx.resourceClaim.upsert({ where, create: { ...fields, state: "held" }, update: { state: "held", ...(data ? { data } : {}) } });
  return { ok: true, claim, handovers };
}

/** `claimIn` in a transaction of its own. Wake the outbox when `handovers` is not empty (a step got a resource). */
export async function claimResource(db: PrismaClient, input: ClaimInput, options: { wait?: boolean } = {}): Promise<Claimed> {
  const result = await db.$transaction((tx) => claimIn(tx, input, options));
  if (result.handovers.length) claimEvents.emit("released");
  return result;
}

export type ReleaseWhere = { holders?: string[]; missionId?: string; kind?: ClaimKind; key?: string };

/**
 * Lets go of the claims (held, or waiting in line) of `holders` or of a whole mission, inside a
 * transaction; each resource that comes free goes to the first in line. Locks resources in one order.
 */
export async function releaseIn(tx: Prisma.TransactionClient, where: ReleaseWhere): Promise<Handover[]> {
  const who = [...(where.holders?.length ? [{ holder: { in: where.holders } }] : []), ...(where.missionId ? [{ missionId: where.missionId }] : [])];
  if (!who.length) return [];
  const rows = await tx.resourceClaim.findMany({
    where: { OR: who, ...(where.kind ? { kind: where.kind } : {}), ...(where.key ? { key: where.key } : {}) },
    orderBy: [{ kind: "asc" }, { key: "asc" }],
  });
  const freed = new Map<string, { kind: string; key: string; from: string }>();
  for (const row of rows) {
    await lock(tx, row.kind, row.key);
    await tx.resourceClaim.deleteMany({ where: { id: row.id } });
    if (row.state === "held") freed.set(`${row.kind}\u0000${row.key}`, { kind: row.kind, key: row.key, from: row.id });
  }
  const handovers: Handover[] = [];
  for (const { kind, key, from } of freed.values()) {
    const handover = await handOver(tx, kind, key, from);
    if (handover) handovers.push(handover);
  }
  return handovers;
}

/** `releaseIn` in a transaction of its own (a run, a browser session or a tab letting go). */
export async function releaseResource(db: PrismaClient, holder: string, only: Pick<ReleaseWhere, "kind" | "key"> = {}): Promise<Handover[]> {
  const handovers = await db.$transaction((tx) => releaseIn(tx, { holders: [holder], ...only }));
  claimEvents.emit("released");
  return handovers;
}

/**
 * Waits in line until `holder` has the resource, then returns its claim: for callers that hold a
 * process open while they wait (the browser broker). Leaving (`signal`) takes the holder out of line.
 */
export async function waitForResource(db: PrismaClient, input: ClaimInput, options: { signal?: AbortSignal; pollMs?: number } = {}): Promise<ResourceClaim> {
  for (;;) {
    if (options.signal?.aborted) {
      await releaseResource(db, input.holder, { kind: input.kind, key: input.key });
      throw new DOMException("Stopped waiting", "AbortError");
    }
    const result = await claimResource(db, input);
    if (result.ok) return result.claim;
    await new Promise<void>((done) => {
      const finish = () => {
        clearTimeout(timer);
        claimEvents.off("released", finish);
        options.signal?.removeEventListener("abort", finish);
        done();
      };
      const timer = setTimeout(finish, options.pollMs ?? 1_000);
      claimEvents.on("released", finish);
      options.signal?.addEventListener("abort", finish, { once: true });
    });
  }
}

/** The claims a holder has (held and waiting). */
export async function claimsOf(db: PrismaClient | Prisma.TransactionClient, holder: string): Promise<ResourceClaim[]> {
  return db.resourceClaim.findMany({ where: { holder }, orderBy: [{ kind: "asc" }, { key: "asc" }] });
}

/**
 * A free development-server port on one computer (`scope`, its device id) for `holder`: the one it
 * already has, else the lowest nobody holds in `PORT_RANGE`. Never waits: null when every one is taken.
 */
export async function claimPort(db: PrismaClient, input: Omit<ClaimInput, "kind" | "key" | "data"> & { scope: string }): Promise<number | null> {
  const prefix = `${input.scope}:`;
  const portOf = (key: string) => Number(key.slice(prefix.length));
  const mine = await db.resourceClaim.findFirst({ where: { kind: "port", holder: input.holder, state: "held", key: { startsWith: prefix } } });
  if (mine) return portOf(mine.key);
  const taken = new Set((await db.resourceClaim.findMany({ where: { kind: "port", state: "held", key: { startsWith: prefix } }, select: { key: true } })).map((row) => portOf(row.key)));
  const range = Array.from({ length: PORT_RANGE.to - PORT_RANGE.from + 1 }, (_, index) => PORT_RANGE.from + index);
  // Free ones first; then the taken ones, in case a holder is gone (claimIn lets go of a dead step's).
  for (const port of [...range.filter((port) => !taken.has(port)), ...range.filter((port) => taken.has(port))]) {
    const got = await claimResource(db, { ...input, kind: "port", key: `${prefix}${port}`, data: { port } }, { wait: false });
    if (got.ok) return port;
  }
  return null;
}

/** A fresh holder id for a caller that is not a plan step (a browser session, a tab lease). */
export function newHolder(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}
