/**
 * A person's own settings for a room with other people (docs/35 §12): what their lead may do for each
 * collaborator without asking (trust), an optional monthly budget for free-form answers to others, an
 * away status, and the items they marked shareable in the room. They live on the person's member row
 * (`node_room_members.prefs`) and are the person's choices, not product limits: unset, the defaults
 * below apply, and nothing is capped.
 *
 * A public answer is read by everyone in the room, so what a lead may disclose there is the most
 * careful of its owner's settings for everyone who reads it. The asker's own settings decide only
 * what concerns the asker: whether a free-form answer may use the lead's model, and which work
 * requests are accepted without asking.
 */
import { z } from "zod";
import type { NodeRoomMember, Prisma, PrismaClient } from "@prisma/client";
import { openedSpace } from "../lib/auth.js";
import { fileText } from "../files/attached.js";
import { truncateText } from "../lib/text.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const PEER_KINDS = ["question", "share", "review", "work"] as const;
export type PeerKind = (typeof PEER_KINDS)[number];
export const DETAIL_LEVELS = ["nothing", "titles", "details"] as const;
export type Detail = (typeof DETAIL_LEVELS)[number];

export const TrustSettings = z
  .object({
    /** Status questions: answered from the status card, or asked about first. */
    status: z.enum(["answer", "ask"]),
    /** How much of the status card: nothing, titles (default) or details. */
    statusDetail: z.enum(DETAIL_LEVELS),
    /** Items in the room's shared space. */
    shareSpaceArtefacts: z.enum(["answer", "ask"]),
    /** Anything else of the owner's: asked about each time, or never shared. */
    shareOther: z.enum(["ask", "never"]),
    /** Requests for work: always asked about, or accepted for the kinds in acceptKinds. */
    workRequests: z.enum(["ask", "accept"]),
    acceptKinds: z.array(z.enum(PEER_KINDS)).max(PEER_KINDS.length),
    /** Whether the lead may answer this person in its own words (the owner's credits), or asks first. */
    freeFormAnswers: z.enum(["allow", "ask"]),
  })
  .strict();
export type TrustSettings = z.infer<typeof TrustSettings>;
export const TrustPatch = TrustSettings.partial().strict();
export type TrustPatch = z.infer<typeof TrustPatch>;

export const DEFAULT_TRUST: TrustSettings = {
  status: "answer",
  statusDetail: "titles",
  shareSpaceArtefacts: "answer",
  shareOther: "ask",
  workRequests: "ask",
  acceptKinds: [],
  freeFormAnswers: "allow",
};

export type Away = { until: string | null; note: string | null; since: string };
export const SHAREABLE_KINDS = ["page", "task", "file"] as const;
export type Shareable = { kind: (typeof SHAREABLE_KINDS)[number]; id: string; spaceId: string; title: string; addedAt: string };
export type RoomPrefs = {
  trust?: { everyone?: TrustPatch; people?: Record<string, TrustPatch> };
  /** Included credits a month the lead may spend answering other people in its own words; null or unset: no cap. */
  budget?: number | null;
  away?: Away | null;
  shareable?: Shareable[];
};

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Only the settings that parse: a bad value falls back to the default instead of failing a turn. */
function cleanPatch(value: unknown): TrustPatch {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(record(value))) {
    const field = (TrustSettings.shape as Record<string, z.ZodTypeAny>)[key];
    if (field?.safeParse(raw).success) out[key] = raw;
  }
  return out as TrustPatch;
}

export function prefsOf(member: Pick<NodeRoomMember, "prefs"> | null | undefined): RoomPrefs {
  const raw = record(member?.prefs);
  const trust = record(raw.trust);
  const people = Object.fromEntries(Object.entries(record(trust.people)).map(([id, patch]) => [id, cleanPatch(patch)]));
  const away = record(raw.away);
  return {
    trust: { everyone: cleanPatch(trust.everyone), people },
    budget: typeof raw.budget === "number" && Number.isFinite(raw.budget) && raw.budget >= 0 ? raw.budget : null,
    away: typeof away.since === "string" ? { since: away.since, until: typeof away.until === "string" ? away.until : null, note: typeof away.note === "string" ? away.note : null } : null,
    shareable: Array.isArray(raw.shareable) ? (raw.shareable as Shareable[]).filter((row) => row && typeof row.id === "string" && (SHAREABLE_KINDS as readonly string[]).includes(row.kind)) : [],
  };
}

/** The owner's settings for one collaborator: the defaults, then "everyone in the room", then that person's own. */
export function trustFor(prefs: RoomPrefs, collaboratorId: string | null): TrustSettings {
  return { ...DEFAULT_TRUST, ...(prefs.trust?.everyone ?? {}), ...(collaboratorId ? (prefs.trust?.people?.[collaboratorId] ?? {}) : {}) };
}

const DETAIL_RANK: Record<Detail, number> = { nothing: 0, titles: 1, details: 2 };

/**
 * What a public answer may disclose: for each setting, the most careful one across everyone who
 * reads it (the room's other people); the asker's own settings for free-form answers and work.
 */
export function publicTrust(prefs: RoomPrefs, readers: readonly string[], askerId: string | null): TrustSettings {
  const all = (readers.length ? readers : [null]).map((id) => trustFor(prefs, id));
  const asker = askerId ? trustFor(prefs, askerId) : trustFor(prefs, null);
  return {
    status: all.some((row) => row.status === "ask") ? "ask" : "answer",
    statusDetail: all.reduce<Detail>((low, row) => (DETAIL_RANK[row.statusDetail] < DETAIL_RANK[low] ? row.statusDetail : low), "details"),
    shareSpaceArtefacts: all.some((row) => row.shareSpaceArtefacts === "ask") ? "ask" : "answer",
    shareOther: all.some((row) => row.shareOther === "never") ? "never" : "ask",
    workRequests: asker.workRequests,
    acceptKinds: asker.acceptKinds,
    freeFormAnswers: asker.freeFormAnswers,
  };
}

/** The away status in force now (one with a time that has passed is over). */
export function awayNow(prefs: RoomPrefs, now = Date.now()): Away | null {
  const away = prefs.away;
  if (!away) return null;
  if (away.until && Date.parse(away.until) <= now) return null;
  return away;
}

/** A person's row in a room (their prefs live on it). */
export function personRow(db: Db, roomId: string, accountId: string): Promise<NodeRoomMember | null> {
  return db.nodeRoomMember.findFirst({ where: { roomId, userId: accountId, nodeId: null } });
}

/** Changes a person's prefs under a row lock, so two changes never undo each other. */
export async function updatePrefs(db: PrismaClient, memberId: string, change: (prefs: RoomPrefs) => RoomPrefs): Promise<RoomPrefs> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM node_room_members WHERE id = ${memberId} FOR UPDATE`;
    const row = await tx.nodeRoomMember.findUniqueOrThrow({ where: { id: memberId } });
    const next = change(prefsOf(row));
    await tx.nodeRoomMember.update({ where: { id: memberId }, data: { prefs: next as unknown as Prisma.InputJsonValue } });
    return next;
  });
}

/** The owner's settings as the website shows them: everyone, then each other person in the room. */
export async function trustView(db: Db, roomId: string, owner: NodeRoomMember) {
  const prefs = prefsOf(owner);
  const people = await db.nodeRoomMember.findMany({ where: { roomId, nodeId: null, userId: { not: owner.userId } }, orderBy: { joinedAt: "asc" } });
  const users = await db.user.findMany({ where: { id: { in: people.map((row) => row.userId) } }, select: { id: true, name: true, email: true } });
  const name = new Map(users.map((row) => [row.id, row.name?.trim() || row.email.split("@")[0]!]));
  return {
    defaults: DEFAULT_TRUST,
    everyone: trustFor(prefs, null),
    people: people.map((row) => ({
      accountId: row.userId,
      name: name.get(row.userId) ?? "Someone",
      handle: row.handle,
      overrides: prefs.trust?.people?.[row.userId] ?? null,
      effective: trustFor(prefs, row.userId),
    })),
    budget: { credits: prefs.budget ?? null, usedThisMonth: await budgetUsed(db, roomId, owner.userId) },
  };
}

const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** Credits the owner's nodes spent this month answering other people in this room in their own words. */
export async function budgetUsed(db: Db, roomId: string, ownerId: string): Promise<number> {
  const turns = await db.nodeTurn.findMany({
    where: { roomId, userId: ownerId, audience: "room", createdAt: { gte: monthStart() }, credits: { not: null } },
    select: { credits: true, principals: true },
  });
  return turns.reduce((sum, row) => {
    const askedBy = record(row.principals).askedBy;
    return typeof askedBy === "string" && askedBy !== ownerId ? sum + (row.credits ?? 0) : sum;
  }, 0);
}

/** Whether the owner's budget for answering others here is spent (no budget: never). */
export async function budgetSpent(db: Db, roomId: string, ownerId: string, prefs: RoomPrefs): Promise<boolean> {
  if (prefs.budget === null || prefs.budget === undefined) return false;
  return (await budgetUsed(db, roomId, ownerId)) >= prefs.budget;
}

/**
 * A person leaves: every grant other people in the room gave them goes, in the caller's transaction
 * (node_room_members.prefs → trust.people.<them>).
 */
export async function revokeTrustTo(tx: Prisma.TransactionClient, roomId: string, accountId: string): Promise<void> {
  await tx.$executeRaw`UPDATE node_room_members SET prefs = prefs #- ARRAY['trust', 'people', ${accountId}]::text[] WHERE room_id = ${roomId} AND node_id IS NULL`;
}

// ── shareable items ──────────────────────────────────────────────────────────────────────────

/** Checks the owner can read the item now, and returns it with its title (null: not available). */
export async function shareableItem(db: Db, ownerId: string, item: { kind: Shareable["kind"]; id: string; spaceId?: string | null }): Promise<Omit<Shareable, "addedAt"> | null> {
  const spaceId = item.spaceId ?? ownerId;
  if (!(await openedSpace(ownerId, spaceId))) return null;
  if (item.kind === "page") {
    const page = await db.taskPage.findFirst({ where: { id: item.id, userId: spaceId, deletedAt: null }, select: { title: true, task: { select: { title: true } } } });
    return page ? { kind: "page", id: item.id, spaceId, title: page.task?.title || page.title || "Untitled" } : null;
  }
  if (item.kind === "task") {
    const task = await db.task.findFirst({ where: { id: item.id, userId: spaceId, deletedAt: null }, select: { title: true } });
    return task ? { kind: "task", id: item.id, spaceId, title: task.title } : null;
  }
  const file = await db.document.findFirst({ where: { id: item.id, userId: spaceId, deletedAt: null }, select: { filename: true } });
  return file ? { kind: "file", id: item.id, spaceId, title: file.filename } : null;
}

/** What a shareable item says, read now with the owner's current access (null: it is gone). */
export async function shareableText(db: Db, ownerId: string, item: Shareable): Promise<string | null> {
  if (!(await openedSpace(ownerId, item.spaceId))) return null;
  if (item.kind === "page") {
    const page = await db.taskPage.findFirst({ where: { id: item.id, userId: item.spaceId, deletedAt: null }, select: { title: true, searchText: true } });
    return page ? truncateText(page.searchText ?? page.title, 8000) : null;
  }
  if (item.kind === "task") {
    const task = await db.task.findFirst({
      where: { id: item.id, userId: item.spaceId, deletedAt: null },
      select: { title: true, status: true, due: true, description: true, page: { select: { searchText: true } } },
    });
    if (!task) return null;
    return truncateText([`Task: ${task.title}`, `Status: ${task.status.replace(/_/g, " ")}`, task.due ? `Due: ${task.due.toISOString().slice(0, 10)}` : "", task.description, task.page?.searchText ?? ""].filter(Boolean).join("\n"), 8000);
  }
  const file = await fileText(db, item.spaceId, item.id, 0, 8000);
  return file ? (file.text || file.note || "This file has no text.") : null;
}
