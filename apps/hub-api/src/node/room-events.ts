/**
 * Room events (docs/35 §12.12; ensemble-node design C5, extension §17.1 and §18). What concerns each
 * person in a room with other people reaches them once, privately, through their own lead:
 *
 *   - from the room's linked space: a task assigned to them, a status change on a task they hold or
 *     asked for, a comment that mentions them or one of their nodes, an edit to a page they watch;
 *   - from the room: a public message that mentions them (it wakes no node: a private note instead).
 *
 * Code finds the changes (space frames, and a sweep for what no frame announced), deduplicates them
 * and batches them into one private message from the person's lead in My crew. No model runs. Every
 * delivery checks again that the person is still in the room and can still open the space. While a
 * person is away their events wait; when they come back (or open the room after a long gap), their
 * lead gives them a short catch-up digest: code gathers the facts, and a model only words a few lines.
 */
import type { FastifyInstance } from "fastify";
import type { NodeMessage, NodeRoom, NodeRoomEvent, Prisma, PrismaClient } from "@prisma/client";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";
import { truncateText } from "../lib/text.js";
import { publishTo } from "./events.js";
import { resolveMentions } from "./mentions.js";
import { inBackground } from "./queue.js";
import { boundSpaceId, linkedSpace, onSpaceBound, roleIn } from "./room-space.js";
import { directoryOf, postMessage } from "./store.js";
import { awayNow, personRow, prefsOf, updatePrefs } from "./trust.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const EVENT_KINDS = ["assigned", "status", "mention", "page_edited"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

let BATCH_MS = 60_000;
let DIGEST_GAP_MS = 8 * 3_600_000;
/** An away person's events wait out of the delivery queue: until their away ends, or this long before a recheck. */
const HOLD_MS = 6 * 3_600_000;
/** Events nobody could deliver (a person away for a long time) go after this long, and at most this many wait per person and room. */
const HELD_TTL_MS = 14 * 86_400_000;
const HELD_MAX = 200;
const DUE_PAGE = 500;
const SWEEP_MS = 30_000;
/** A change is read again a little before the last read: one committed just behind it is not missed (keys dedupe). */
const OVERLAP_MS = 5_000;

/** Tests: deliver at once, and treat a shorter gap as being away. */
export function setRoomEventTimingForTests(timing: { batchMs?: number; digestGapMs?: number }): void {
  if (timing.batchMs !== undefined) BATCH_MS = timing.batchMs;
  if (timing.digestGapMs !== undefined) DIGEST_GAP_MS = timing.digestGapMs;
}

type NewEvent = {
  roomId: string;
  userId: string;
  kind: EventKind;
  spaceId?: string | null;
  subjectKind: "task" | "page" | "comment" | "message";
  subjectId: string;
  title: string;
  actorAccountId?: string | null;
  actorNodeId?: string | null;
  data?: Record<string, unknown>;
  dedupeKey: string;
};

async function addEvents(db: Db, events: NewEvent[]): Promise<number> {
  if (!events.length) return 0;
  const deliverAfter = new Date(Date.now() + BATCH_MS);
  const made = await db.nodeRoomEvent.createMany({
    data: events.map((row) => ({ ...row, title: truncateText(row.title, 200), data: (row.data ?? {}) as Prisma.InputJsonValue, deliverAfter })),
    skipDuplicates: true,
  });
  return made.count;
}

const nameOf = (row: { name: string | null; email: string } | null | undefined): string => row?.name?.trim() || row?.email.split("@")[0] || "Someone";

async function spaceOwnerOf(db: Db, spaceId: string): Promise<string | null> {
  const row = await db.user.findUnique({ where: { id: spaceId }, select: { id: true, ownerId: true } });
  return row ? (row.ownerId ?? row.id) : null;
}

/** Who a task is with: the space's owner for their own "me" tasks, else its assignee account; null when nobody. */
function holder(task: { owner: string; assigneeAccountId: string | null; deletedAt: Date | null }, owner: string): string | null {
  if (task.deletedAt || task.owner !== "me") return null;
  return task.assigneeAccountId ?? owner;
}

/** Who changed a task last, from its undo entry: the person (null: the space's owner) and the node acting for them. */
async function changedBy(db: Db, spaceId: string, taskId: string, at: Date): Promise<{ accountId: string | null; nodeId: string | null } | null> {
  const entry = await db.undoEntry.findFirst({
    where: { userId: spaceId, href: `/tasks/${taskId}`, createdAt: { gte: new Date(at.getTime() - 120_000) } },
    orderBy: { seq: "desc" },
    select: { actorAccountId: true, source: true },
  });
  if (!entry) return null;
  return { accountId: entry.actorAccountId, nodeId: entry.source.startsWith("node:") ? entry.source.slice(5) : null };
}

// ── following a space ───────────────────────────────────────────────────────────────────────

/** Space id → the rooms following it, for frames (refreshed from node_room_feeds). */
const following = new Map<string, Set<string>>();

async function refreshFollowing(db: Db): Promise<void> {
  const feeds = await db.nodeRoomFeed.findMany({ select: { roomId: true, spaceId: true } });
  following.clear();
  for (const feed of feeds) following.set(feed.spaceId, (following.get(feed.spaceId) ?? new Set()).add(feed.roomId));
}

/** Rooms linked to a space with nothing following it yet (linked before this ran, or by hand): they start now. */
async function followLinked(app: FastifyInstance): Promise<void> {
  const rows = await app.prisma.$queryRaw<Array<{ id: string; space_id: string }>>`
    SELECT r.id, r.settings->>'spaceId' AS space_id FROM node_rooms r LEFT JOIN node_room_feeds f ON f.room_id = r.id
    WHERE r.kind = 'room' AND r.archived_at IS NULL AND f.room_id IS NULL AND COALESCE(r.settings->>'spaceId', '') <> ''`;
  for (const row of rows) await followSpace(app, row.id, row.space_id);
}

/** A room starts following its newly linked space: what is there now is the baseline (no events for it). */
export async function followSpace(app: FastifyInstance, roomId: string, spaceId: string): Promise<void> {
  const prisma = app.prisma;
  const now = new Date();
  const owner = await spaceOwnerOf(prisma, spaceId);
  const tasks = owner ? await prisma.task.findMany({ where: { userId: spaceId, deletedAt: null }, select: { id: true, owner: true, assigneeAccountId: true, deletedAt: true, status: true, updatedAt: true } }) : [];
  await prisma.$transaction(async (tx) => {
    await tx.nodeRoomTask.deleteMany({ where: { roomId } });
    if (tasks.length) await tx.nodeRoomTask.createMany({ data: tasks.map((task) => ({ roomId, taskId: task.id, assignee: holder(task, owner!), status: task.status, taskUpdatedAt: task.updatedAt })) });
    await tx.nodeRoomFeed.upsert({ where: { roomId }, create: { roomId, spaceId, scannedAt: now }, update: { spaceId, scannedAt: now } });
  });
  await refreshFollowing(prisma);
}

const scans = new Map<string, { again: boolean }>();
let scanned: ((roomId: string) => void) | null = null;
/** Tests: told of every read of a room's space. */
export function setScanObserverForTests(observer: ((roomId: string) => void) | null): void {
  scanned = observer;
}

/** Reads a room's space, once at a time per room: a call while one runs makes it read again after, and returns. */
async function guardedScan(app: FastifyInstance, roomId: string): Promise<void> {
  const running = scans.get(roomId);
  if (running) {
    running.again = true;
    return;
  }
  const state = { again: false };
  scans.set(roomId, state);
  try {
    do {
      state.again = false;
      scanned?.(roomId);
      await scanRoom(app, roomId);
    } while (state.again);
  } finally {
    scans.delete(roomId);
  }
}

/** A frame from a followed space: read it now, in the background. */
function kick(app: FastifyInstance, roomId: string): void {
  inBackground(app, () => guardedScan(app, roomId));
}

/** Whether anything a room follows in its space may have changed since it last read it (cheap; the scan decides). */
async function stirred(app: FastifyInstance, feed: { roomId: string; spaceId: string; scannedAt: Date }): Promise<boolean> {
  const prisma = app.prisma;
  const since = new Date(feed.scannedAt.getTime() - OVERLAP_MS);
  if (await prisma.task.findFirst({ where: { userId: feed.spaceId, updatedAt: { gt: since } }, select: { id: true } })) return true;
  if (await prisma.pageDiscussion.findFirst({ where: { userId: feed.spaceId, createdAt: { gt: since } }, select: { id: true } })) return true;
  const watched = await prisma.nodeRoomPage.findMany({ where: { roomId: feed.roomId }, select: { pageId: true } });
  if (watched.length && (await prisma.taskPage.findFirst({ where: { id: { in: watched.map((row) => row.pageId) }, updatedAt: { gt: since } }, select: { id: true } }))) return true;
  // Unlinked, linked elsewhere or gone: the scan settles the feed.
  const room = await prisma.nodeRoom.findUnique({ where: { id: feed.roomId }, select: { settings: true, archivedAt: true } });
  return !room || Boolean(room.archivedAt) || boundSpaceId(room) !== feed.spaceId;
}

let sweeping = false;
let sweeps = 0;
const SWEEP_BATCH = 100;
/** followLinked (a full read of rooms) runs on every this many sweeps: binding follows at once anyway. */
const FOLLOW_EVERY = 20;

/**
 * One sweep, never two at once: rooms linked out of band start following now and then, the rooms whose
 * space stirred since they last read it are read (the longest-unread first, a bounded batch, through the
 * same one-at-a-time guard as frames), then what is due is delivered. False when a sweep was running.
 */
export async function sweepRoomEvents(app: FastifyInstance): Promise<boolean> {
  if (sweeping) return false;
  sweeping = true;
  try {
    if (sweeps++ % FOLLOW_EVERY === 0) await followLinked(app);
    await refreshFollowing(app.prisma);
    const feeds = await app.prisma.nodeRoomFeed.findMany({ orderBy: { scannedAt: "asc" }, take: SWEEP_BATCH });
    for (const feed of feeds) {
      const checkedAt = new Date();
      if (await stirred(app, feed)) await guardedScan(app, feed.roomId);
      // Nothing changed: it was read up to now (the next read still looks a little further back), and the batch moves on.
      else await app.prisma.nodeRoomFeed.updateMany({ where: { roomId: feed.roomId, scannedAt: feed.scannedAt }, data: { scannedAt: checkedAt } });
    }
    await deliverRoomEvents(app);
    return true;
  } finally {
    sweeping = false;
  }
}

/**
 * What changed in the room's space since it last looked: assignments and status changes (against what it
 * last saw of each task), comments that mention people here or their nodes, and edits to pages watched here.
 */
export async function scanRoom(app: FastifyInstance, roomId: string): Promise<number> {
  const prisma = app.prisma;
  const feed = await prisma.nodeRoomFeed.findUnique({ where: { roomId } });
  if (!feed) return 0;
  const room = await prisma.nodeRoom.findUnique({ where: { id: roomId } });
  // Only while the room's creator still owns it (a transfer unlinks the room, node/room-space.ts).
  const spaceId = room && !room.archivedAt && room.kind === "room" ? await linkedSpace(app, room) : null;
  if (!room || spaceId !== feed.spaceId) {
    // Unlinked (or linked elsewhere, which follows anew): this feed and what it saw go.
    await prisma.$transaction([prisma.nodeRoomTask.deleteMany({ where: { roomId } }), prisma.nodeRoomFeed.deleteMany({ where: { roomId, spaceId: feed.spaceId } })]);
    if (room && spaceId) await followSpace(app, roomId, spaceId);
    else await refreshFollowing(prisma);
    return 0;
  }
  const owner = await spaceOwnerOf(prisma, spaceId);
  if (!owner) return 0;
  const started = new Date();
  const since = new Date(feed.scannedAt.getTime() - OVERLAP_MS);
  const members = await prisma.nodeRoomMember.findMany({ where: { roomId } });
  const people = new Set(members.filter((row) => !row.nodeId).map((row) => row.userId));
  const events: NewEvent[] = [];
  let moved = false;

  // Tasks: assignments and status changes.
  const tasks = await prisma.task.findMany({
    where: { userId: spaceId, updatedAt: { gt: since } },
    select: { id: true, title: true, owner: true, assigneeAccountId: true, status: true, deletedAt: true, updatedAt: true, peerRequestId: true, requestedByAccountId: true, createdByAccountId: true, createdByNodeId: true },
  });
  const seen = new Map((await prisma.nodeRoomTask.findMany({ where: { roomId, taskId: { in: tasks.map((task) => task.id) } } })).map((row) => [row.taskId, row]));
  for (const task of tasks) {
    const before = seen.get(task.id);
    const now = holder(task, owner);
    if (before && before.taskUpdatedAt.getTime() >= task.updatedAt.getTime()) continue;
    const at = task.updatedAt.getTime();
    const by = before ? await changedBy(prisma, spaceId, task.id, task.updatedAt) : { accountId: task.createdByAccountId, nodeId: task.createdByNodeId };
    const actor = by ? (by.accountId ?? owner) : null;
    const base = { roomId, spaceId, subjectKind: "task" as const, subjectId: task.id, title: task.title, actorAccountId: actor, actorNodeId: by?.nodeId ?? null };
    // A requested task's own card already asks the person (node/peer-requests.ts): no second message.
    if (now && people.has(now) && now !== (before?.assignee ?? null) && !task.peerRequestId && !task.deletedAt && !["done", "dropped"].includes(task.status)) {
      events.push({ ...base, userId: now, kind: "assigned", data: { status: task.status, self: actor === now }, dedupeKey: `assigned:${task.id}:${now}:${at}` });
    }
    // A request's own card shows its decision and its end (node/peer-requests.ts): only other moves are news.
    const shown = Boolean(task.peerRequestId) && (before?.status === "proposed" || task.status === "done");
    if (before && before.status !== task.status && !task.deletedAt && !shown) {
      for (const person of new Set([now, task.requestedByAccountId].filter((id): id is string => Boolean(id)))) {
        if (!people.has(person) || person === actor) continue;
        events.push({ ...base, userId: person, kind: "status", data: { from: before.status, to: task.status }, dedupeKey: `status:${task.id}:${task.status}:${at}` });
      }
    }
    if (!before || before.assignee !== now || before.status !== task.status) moved = true;
    await prisma.nodeRoomTask.upsert({
      where: { roomId_taskId: { roomId, taskId: task.id } },
      create: { roomId, taskId: task.id, assignee: now, status: task.status, taskUpdatedAt: task.updatedAt },
      update: { assignee: now, status: task.status, taskUpdatedAt: task.updatedAt },
    });
  }

  // Comments that mention a person here, or one of their nodes (by handle, or as the person's Ensemble contact).
  const comments = await prisma.pageDiscussion.findMany({
    where: { userId: spaceId, kind: "comment", authorKind: "human", deletedAt: null, createdAt: { gt: since } },
    select: { id: true, pageKind: true, pageId: true, body: true, mentions: true, authorAccountId: true, authorNodeId: true },
    take: 200,
  });
  if (comments.length) {
    const directory = directoryOf(members);
    const emails = new Map(
      (await prisma.user.findMany({ where: { id: { in: [...people] } }, select: { id: true, email: true } })).map((row) => [row.email.trim().toLowerCase(), row.id]),
    );
    for (const comment of comments) {
      const text = commentText(comment.body);
      const named = new Set<string>();
      for (const mention of resolveMentions(text, directory).mentions) {
        named.add(mention.kind === "human" ? mention.id : (members.find((row) => row.nodeId === mention.id)?.userId ?? ""));
      }
      const contacts = (Array.isArray(comment.mentions) ? (comment.mentions as Array<{ kind?: unknown; id?: unknown }>) : []).filter((row) => row.kind === "people" && typeof row.id === "string").map((row) => row.id as string);
      if (contacts.length) {
        for (const person of await prisma.person.findMany({ where: { userId: spaceId, id: { in: contacts } }, select: { email: true } })) {
          const id = person.email ? emails.get(person.email.trim().toLowerCase()) : undefined;
          if (id) named.add(id);
        }
      }
      const author = comment.authorAccountId ?? owner;
      const title = await pageTitle(prisma, spaceId, comment.pageKind, comment.pageId);
      for (const person of named) {
        if (!person || !people.has(person) || person === author) continue;
        events.push({ roomId, spaceId, userId: person, kind: "mention", subjectKind: "comment", subjectId: comment.id, title: title ?? "a page", actorAccountId: author, actorNodeId: comment.authorNodeId, data: { pageKind: comment.pageKind, pageId: comment.pageId, excerpt: truncateText(text, 200) }, dedupeKey: `comment:${comment.id}` });
      }
    }
  }

  // Edits to pages watched here.
  const watched = await prisma.nodeRoomPage.findMany({ where: { roomId, spaceId } });
  if (watched.length) {
    const pages = await prisma.taskPage.findMany({ where: { id: { in: watched.map((row) => row.pageId) }, userId: spaceId, deletedAt: null, updatedAt: { gt: since } }, select: { id: true, title: true, revision: true, editorAccountId: true, editorNodeId: true, taskId: true } });
    for (const page of pages) {
      const row = watched.find((entry) => entry.pageId === page.id)!;
      const editor = page.editorAccountId ?? owner;
      for (const person of row.watchers) {
        if (!people.has(person) || person === editor) continue;
        events.push({ roomId, spaceId, userId: person, kind: "page_edited", subjectKind: "page", subjectId: page.id, title: page.title || "Untitled", actorAccountId: editor, actorNodeId: page.editorNodeId, data: { revision: page.revision, role: row.role }, dedupeKey: `page:${page.id}:${page.revision}` });
      }
      await pageEdited(app, row, page);
    }
  }

  const added = await addEvents(prisma, events);
  await prisma.nodeRoomFeed.updateMany({ where: { roomId, spaceId }, data: { scannedAt: started } });
  // Status cards read the board live: the people here re-read them.
  if (added || moved) publishTo([...people], "node.cards", { roomId });
  return added;
}

/** Called for each edit of a page the room follows (C7 sets it: contracts). */
let onPageEdited: ((app: FastifyInstance, page: { roomId: string; spaceId: string; pageId: string; role: string; watchers: string[] }, edit: { id: string; revision: number; editorAccountId: string | null; editorNodeId: string | null }) => Promise<void>) | null = null;
export function onWatchedPageEdited(hook: NonNullable<typeof onPageEdited>): void {
  onPageEdited = hook;
}
async function pageEdited(app: FastifyInstance, page: Parameters<NonNullable<typeof onPageEdited>>[1], edit: Parameters<NonNullable<typeof onPageEdited>>[2]): Promise<void> {
  if (onPageEdited) await onPageEdited(app, page, edit);
}

function commentText(body: unknown): string {
  const record = (body && typeof body === "object" ? body : {}) as { text?: unknown; content?: unknown[] };
  if (typeof record.text === "string" && record.text) return record.text;
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const row = node as { text?: unknown; content?: unknown[]; attrs?: { label?: unknown } };
    if (typeof row.text === "string") parts.push(row.text);
    for (const child of row.content ?? []) walk(child);
  };
  for (const node of record.content ?? []) walk(node);
  return parts.join(" ").trim();
}

async function pageTitle(db: Db, spaceId: string, kind: string, id: string): Promise<string | null> {
  if (kind === "task") return (await db.task.findFirst({ where: { id, userId: spaceId }, select: { title: true } }))?.title ?? null;
  if (kind === "page") return (await db.taskPage.findFirst({ where: { id, userId: spaceId }, select: { title: true } }))?.title || null;
  return null;
}

/** A public message in a room with other people that mentions a person: no node wakes; that person hears of it privately. */
export async function noteMentions(app: FastifyInstance, room: NodeRoom, message: NodeMessage): Promise<void> {
  if (room.kind !== "room" || message.authorKind !== "human" || message.kind !== "text" || message.visibleTo.length) return;
  const named = ((Array.isArray(message.mentions) ? message.mentions : []) as Array<{ kind?: unknown; id?: unknown }>)
    .filter((row) => row.kind === "human" && typeof row.id === "string" && row.id !== message.userId)
    .map((row) => row.id as string);
  if (!named.length) return;
  const added = await addEvents(
    app.prisma,
    named.map((userId) => ({ roomId: room.id, userId, kind: "mention" as const, subjectKind: "message" as const, subjectId: message.id, title: room.title, actorAccountId: message.userId, data: { seq: message.seq, excerpt: truncateText(message.body, 200) }, dedupeKey: `message:${message.id}` })),
  );
  if (added) schedule(app);
}

// ── delivery ────────────────────────────────────────────────────────────────────────────────

let pending: ReturnType<typeof setTimeout> | null = null;

/** Delivery runs a moment after a batch is due (and on the sweep). */
function schedule(app: FastifyInstance): void {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    inBackground(app, () => deliverRoomEvents(app).then(() => undefined));
  }, BATCH_MS + 250);
  pending.unref?.();
}

/** May this person still hear of this event: still in the room, and (for the space) the room still follows it and they can open it. */
async function stillFor(db: Db, event: NodeRoomEvent, room: NodeRoom, linked: string | null): Promise<boolean> {
  if (event.spaceId) {
    if (linked !== event.spaceId) return false;
    if (!(await roleIn(event.userId, event.spaceId))) return false;
  }
  if (event.subjectKind === "message") {
    const message = await db.nodeMessage.findUnique({ where: { id: event.subjectId }, select: { visibleTo: true, data: true } });
    if (!message || message.visibleTo.length || (message.data as { deleted?: unknown } | null)?.deleted) return false;
  }
  return true;
}

const STATUS_WORDS: Record<string, string> = { proposed: "Proposed", todo: "To do", in_progress: "In progress", waiting_approval: "Waiting for approval", blocked: "Blocked", done: "Done", dropped: "Dropped" };

/** The person's lead in the room (it tells them), and a node of theirs suited to start work. */
async function crewOf(db: Db, roomId: string, personId: string) {
  const nodes = await db.nodeRoomMember.findMany({ where: { roomId, userId: personId, nodeId: { not: null } }, include: { node: { select: { id: true, role: true, name: true } } }, orderBy: { joinedAt: "asc" } });
  const lead = nodes.find((row) => row.representative) ?? nodes[0] ?? null;
  const others = nodes.filter((row) => row !== lead);
  const builder = others.find((row) => /engineer|build|develop|code|program/i.test(`${row.node?.role ?? ""} ${row.node?.name ?? ""}`)) ?? others[0] ?? null;
  return { lead, builder };
}

/** One person's events, as lines their lead says, with the items for the site. */
async function describe(db: Db, events: NodeRoomEvent[], builderHandle: string | null) {
  const ids = [...new Set(events.map((row) => row.actorAccountId).filter((id): id is string => Boolean(id)))];
  const people = new Map((await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })).map((row) => [row.id, nameOf(row)]));
  const who = (id: string | null) => (id ? (people.get(id) ?? "Someone") : null);
  const lines: string[] = [];
  const items: Array<Record<string, unknown>> = [];
  // Several edits of one page are one line.
  const edits = new Map<string, NodeRoomEvent[]>();
  const start: string[] = [];
  let assigned = 0;
  for (const event of events) {
    const data = event.data as Record<string, unknown>;
    const actor = who(event.actorAccountId);
    items.push({ kind: event.kind, subjectKind: event.subjectKind, subjectId: event.subjectId, title: event.title, spaceId: event.spaceId, actor: event.actorAccountId ? { accountId: event.actorAccountId, name: actor, nodeId: event.actorNodeId } : null, ...data, at: event.createdAt.toISOString() });
    if (event.kind === "page_edited") {
      edits.set(event.subjectId, [...(edits.get(event.subjectId) ?? []), event]);
      continue;
    }
    if (event.kind === "assigned") {
      assigned += 1;
      if (!start.includes(event.subjectId)) start.push(event.subjectId);
      lines.push(data.self || event.actorAccountId === event.userId ? `“${event.title}” is yours.` : actor ? `${actor} assigned you “${event.title}”.` : `“${event.title}” is now assigned to you.`);
    } else if (event.kind === "status") {
      const to = STATUS_WORDS[String(data.to)] ?? String(data.to);
      lines.push(actor ? `${actor} moved “${event.title}” to ${to}.` : `“${event.title}” moved to ${to}.`);
    } else if (event.kind === "mention") {
      const excerpt = typeof data.excerpt === "string" && data.excerpt ? `: “${truncateText(data.excerpt, 140)}”` : ".";
      lines.push(event.subjectKind === "message" ? `${actor ?? "Someone"} mentioned you in the room${excerpt}` : `${actor ?? "Someone"} mentioned you on “${event.title}”${excerpt}`);
    }
  }
  for (const group of edits.values()) {
    const names = [...new Set(group.map((row) => who(row.actorAccountId)).filter(Boolean))];
    lines.push(`${names.join(" and ") || "Someone"} edited “${group[0]!.title}”${group.length > 1 ? ` (${group.length} changes)` : ""}.`);
  }
  const offer = assigned ? (builderHandle ? `Shall I start ${assigned > 1 ? "them" : "it"} with @${builderHandle}?` : `Shall I plan ${assigned > 1 ? "them" : "it"}?`) : null;
  return { lines, offer, items, start };
}

/** One line as a sentence; several as a list; the offer to start last. */
function messageText(lines: string[], offer: string | null): string {
  const text = lines.length > 1 ? lines.map((line) => `- ${line}`).join("\n") : (lines[0] ?? "");
  return offer ? `${text}${lines.length > 1 ? "\n" : " "}${offer}` : text;
}

/**
 * Delivers the events that are due: one private message per person and room, from their lead, after
 * checking each event again. A person who is away (or has not come back to the room yet) keeps theirs
 * for the catch-up digest.
 */
export async function deliverRoomEvents(app: FastifyInstance, options: { now?: Date } = {}): Promise<number> {
  const prisma = app.prisma;
  const now = options.now ?? new Date();
  // Nothing waits for ever: what an away person could not hear in two weeks goes.
  await prisma.nodeRoomEvent.deleteMany({ where: { deliveredAt: null, createdAt: { lt: new Date(now.getTime() - HELD_TTL_MS) } } });
  let sent = 0;
  // Held events leave the due window (their deliverAfter moves), so a page full of them never hides anyone else's.
  for (let page = 0; page < 10; page++) {
    const due = await prisma.nodeRoomEvent.findMany({ where: { deliveredAt: null, deliverAfter: { lte: now } }, orderBy: { createdAt: "asc" }, take: DUE_PAGE });
    if (!due.length) break;
    sent += await deliverPage(app, due, now);
    if (due.length < DUE_PAGE) break;
  }
  return sent;
}

/** An away person's events wait until their away ends (or a recheck); only the newest HELD_MAX of them are kept. */
async function holdFor(app: FastifyInstance, roomId: string, userId: string, until: string | null, now: Date): Promise<void> {
  const prisma = app.prisma;
  const at = until ? new Date(Math.max(Date.parse(until), now.getTime() + 60_000)) : new Date(now.getTime() + HOLD_MS);
  await prisma.nodeRoomEvent.updateMany({ where: { roomId, userId, deliveredAt: null, deliverAfter: { lte: at } }, data: { deliverAfter: at } });
  const extra = await prisma.nodeRoomEvent.findMany({ where: { roomId, userId, deliveredAt: null }, orderBy: { createdAt: "desc" }, skip: HELD_MAX, select: { id: true } });
  if (extra.length) await prisma.nodeRoomEvent.deleteMany({ where: { id: { in: extra.map((row) => row.id) } } });
}

async function deliverPage(app: FastifyInstance, due: NodeRoomEvent[], now: Date): Promise<number> {
  const prisma = app.prisma;
  const groups = new Map<string, NodeRoomEvent[]>();
  for (const event of due) groups.set(`${event.roomId}:${event.userId}`, [...(groups.get(`${event.roomId}:${event.userId}`) ?? []), event]);
  let sent = 0;
  for (const events of groups.values()) {
    const { roomId, userId } = events[0]!;
    const room = await prisma.nodeRoom.findUnique({ where: { id: roomId } });
    const member = room && !room.archivedAt ? await personRow(prisma, roomId, userId) : null;
    if (!room || !member) {
      await prisma.nodeRoomEvent.deleteMany({ where: { id: { in: events.map((row) => row.id) } } });
      continue;
    }
    // Away (and not past its end): theirs wait for the catch-up. An away whose end has passed counts as back.
    const away = awayNow(prefsOf(member), now.getTime());
    if (away) {
      await holdFor(app, roomId, userId, away.until, now);
      continue;
    }
    const kept: NodeRoomEvent[] = [];
    const gone: string[] = [];
    const linked = await linkedSpace(app, room);
    for (const event of events) {
      if (await stillFor(prisma, event, room, linked)) kept.push(event);
      else gone.push(event.id);
    }
    // What they may no longer see never reaches them.
    if (gone.length) await prisma.nodeRoomEvent.deleteMany({ where: { id: { in: gone } } });
    if (!kept.length) continue;
    // Claimed once: a second delivery running at the same time takes none of these.
    const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE node_room_events SET delivered_at = ${now} WHERE id = ANY(${kept.map((row) => row.id)}::text[]) AND delivered_at IS NULL RETURNING id`;
    const mine = kept.filter((row) => claimed.some((hit) => hit.id === row.id));
    if (!mine.length) continue;
    try {
      const { lead, builder } = await crewOf(prisma, roomId, userId);
      const { lines, offer, items, start } = await describe(prisma, mine, builder?.handle ?? null);
      const { message } = await postMessage(prisma, {
        roomId,
        userId,
        authorKind: lead?.nodeId ? "node" : "system",
        authorNodeId: lead?.nodeId ?? null,
        kind: lead?.nodeId ? "text" : "status",
        body: messageText(lines, offer),
        // `start`: the tasks the Start button (or the person's yes) starts (node/room-results.ts).
        data: { type: "room_events", items, ...(start.length ? { start: { taskIds: start } } : {}), ...(builder ? { suggest: { nodeId: builder.nodeId, handle: builder.handle } } : {}) },
        visibleTo: [userId],
        clientId: `room-events:${mine[0]!.id}`,
      });
      await prisma.nodeRoomEvent.updateMany({ where: { id: { in: mine.map((row) => row.id) } }, data: { messageId: message.id } });
      sent += 1;
    } catch (error) {
      await prisma.nodeRoomEvent.updateMany({ where: { id: { in: mine.map((row) => row.id) } }, data: { deliveredAt: null } });
      throw error;
    }
  }
  return sent;
}

// ── catch-up ────────────────────────────────────────────────────────────────────────────────

export type DigestFacts = { name: string; room: string; lines: string[] };
type Writer = (app: FastifyInstance, accountId: string, facts: DigestFacts) => Promise<string>;

/** A model words the digest from the facts code gathered, at most five short lines, on the person's own usage. */
const defaultWriter: Writer = async (app, accountId, facts) => {
  const settings = await loadSettings(app.prisma, accountId);
  const { complete } = await import("../lib/runtime.js");
  const result = await complete({
    userId: accountId,
    settings,
    tier: "easy",
    purpose: "Ensemble Node catch-up",
    system:
      `You write ${facts.name}'s catch-up for the room “${facts.room}”, as their own assistant, in at most five short plain lines (no greeting, no markdown headings). ` +
      "Use only the facts given. Name every request made of them. Put what needs them first.",
    prompt: facts.lines.join("\n"),
  });
  return result.text;
};
let writer: Writer = defaultWriter;
export function setDigestWriterForTests(next: Writer | null): void {
  writer = next ?? defaultWriter;
}

/**
 * The person's catch-up digest since `since`: what was asked of them (every request, and proposed tasks
 * waiting), their events (held ones included), what changed on the board and in the room. One private
 * message from their lead; its `data.items` lists everything, its text is a few lines.
 */
export async function catchUp(app: FastifyInstance, room: NodeRoom, personId: string, since: Date, reason: "back" | "gap"): Promise<NodeMessage | null> {
  const prisma = app.prisma;
  const member = await personRow(prisma, room.id, personId);
  if (!member || room.kind !== "room") return null;
  // Everything up to now is this digest's; what arrives while it is written waits for the next.
  const started = new Date();
  const from = member.digestAt && member.digestAt > since ? member.digestAt : since;
  const spaceId = await linkedSpace(app, room);
  const role = spaceId ? await roleIn(personId, spaceId) : null;
  const owner = spaceId && role ? await spaceOwnerOf(prisma, spaceId) : null;
  const users = new Map<string, string>();
  const nameFor = async (id: string) => {
    if (!users.has(id)) users.set(id, nameOf(await prisma.user.findUnique({ where: { id }, select: { name: true, email: true } })));
    return users.get(id)!;
  };

  const requests = await prisma.nodePeerRequest.findMany({ where: { roomId: room.id, toAccountId: personId, createdAt: { gte: from } }, orderBy: { createdAt: "asc" } });
  const asked = await Promise.all(requests.map(async (row) => ({ requestId: row.id, kind: row.kind, from: { accountId: row.fromAccountId, name: await nameFor(row.fromAccountId) }, text: truncateText(row.text, 200), status: row.status, taskId: row.taskId })));
  const mine = spaceId && owner ? (owner === personId ? { owner: "me" as const, assigneeAccountId: null } : { owner: "me" as const, assigneeAccountId: personId }) : null;
  const waiting = spaceId && mine ? await prisma.task.findMany({ where: { userId: spaceId, deletedAt: null, status: "proposed", ...mine }, orderBy: { createdAt: "asc" }, take: 20, select: { id: true, title: true, requestedByAccountId: true } }) : [];
  const proposed = await Promise.all(waiting.map(async (row) => ({ taskId: row.id, title: row.title, requestedBy: row.requestedByAccountId ? await nameFor(row.requestedByAccountId) : null })));
  // Every event still waiting for them, however old, and those already told since `from`, all of them.
  const held: NodeRoomEvent[] = [];
  for (let cursor: string | null = null; ; ) {
    const page: NodeRoomEvent[] = await prisma.nodeRoomEvent.findMany({ where: { roomId: room.id, userId: personId, deliveredAt: null, createdAt: { lte: started } }, orderBy: { id: "asc" }, take: 500, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    held.push(...page);
    if (page.length < 500) break;
    cursor = page.at(-1)!.id;
  }
  const told: NodeRoomEvent[] = [];
  for (let cursor: string | null = null; ; ) {
    const page: NodeRoomEvent[] = await prisma.nodeRoomEvent.findMany({ where: { roomId: room.id, userId: personId, deliveredAt: { not: null }, createdAt: { gte: from, lte: started } }, orderBy: { id: "asc" }, take: 500, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    told.push(...page);
    if (page.length < 500) break;
    cursor = page.at(-1)!.id;
  }
  const rows = [...held, ...told].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const allowed: NodeRoomEvent[] = [];
  const lost: string[] = [];
  for (const row of rows) {
    if (await stillFor(prisma, row, room, spaceId)) allowed.push(row);
    else if (!row.deliveredAt) lost.push(row.id);
  }
  // What they may no longer see is never shown, and never delivered.
  if (lost.length) await prisma.nodeRoomEvent.deleteMany({ where: { id: { in: lost } } });
  const shown = new Set(allowed.filter((row) => !row.deliveredAt).map((row) => row.id));
  const { lines: eventLines, items: events } = await describe(prisma, allowed, null);
  const touched = new Set([...allowed.map((row) => row.subjectId), ...waiting.map((row) => row.id)]);
  const board = spaceId && role ? (await prisma.task.findMany({ where: { userId: spaceId, deletedAt: null, updatedAt: { gte: from } }, orderBy: { updatedAt: "desc" }, take: 20, select: { id: true, title: true, status: true } })).filter((row) => !touched.has(row.id)).slice(0, 8) : [];
  const said = await prisma.nodeMessage.findMany({ where: { roomId: room.id, visibleTo: { isEmpty: true }, authorKind: "human", createdAt: { gte: from }, userId: { not: personId } }, select: { userId: true }, take: 1000 });
  const writers = await Promise.all([...new Set(said.map((row) => row.userId))].map((id) => nameFor(id)));
  // Results and decisions the room saw (C6, C7 write these).
  const notes = await prisma.nodeMessage.findMany({
    where: { roomId: room.id, visibleTo: { isEmpty: true }, createdAt: { gte: from }, OR: [{ data: { path: ["type"], equals: "room_result" } }, { data: { path: ["type"], equals: "decision_logged" } }] },
    orderBy: { seq: "asc" },
    take: 20,
    select: { id: true, body: true, data: true },
  });
  const results = notes.filter((row) => (row.data as { type?: unknown }).type === "room_result").map((row) => ({ messageId: row.id, text: truncateText(row.body.split("\n")[0]!, 200) }));
  const decisions = notes.filter((row) => (row.data as { type?: unknown }).type === "decision_logged").map((row) => ({ messageId: row.id, text: truncateText(String((row.data as { text?: unknown }).text ?? row.body), 200) }));

  if (!asked.length && !proposed.length && !events.length && !board.length && !said.length && !results.length && !decisions.length) {
    await prisma.nodeRoomMember.update({ where: { id: member.id }, data: { digestAt: started } });
    return null;
  }
  const facts: string[] = [
    ...asked.map((row) => `Asked of them: ${row.from.name} asked for ${row.kind === "question" ? "an answer" : row.kind}: “${row.text}” (${row.status.replace(/_/g, " ")}).`),
    ...proposed.map((row) => `Waiting for them on the board: proposed task “${row.title}”${row.requestedBy ? `, asked by ${row.requestedBy}` : ""}.`),
    ...eventLines,
    ...board.map((row) => `On the board: “${row.title}” is ${STATUS_WORDS[row.status] ?? row.status}.`),
    ...results.map((row) => `Delivered in the room: ${row.text}`),
    ...decisions.map((row) => `Decision logged: ${row.text}`),
    ...(said.length ? [`In the room: ${said.length} message${said.length === 1 ? "" : "s"} from ${writers.join(", ")}.`] : []),
  ];
  const name = await nameFor(personId);
  let text: string;
  try {
    text = await writer(app, personId, { name, room: room.title, lines: facts });
  } catch {
    text = "";
  }
  const summary = text.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 5).map((line) => truncateText(line, 240));
  const body = (summary.length ? summary : facts.slice(0, 5)).join("\n");
  const { lead } = await crewOf(prisma, room.id, personId);
  const { message } = await postMessage(prisma, {
    roomId: room.id,
    userId: personId,
    authorKind: lead?.nodeId ? "node" : "system",
    authorNodeId: lead?.nodeId ?? null,
    kind: lead?.nodeId ? "text" : "status",
    body,
    data: { type: "digest", reason, since: from.toISOString(), items: { asked, proposed, events, board: board.map((row) => ({ taskId: row.id, title: row.title, status: row.status })), results, decisions, room: { messages: said.length, from: writers } } },
    visibleTo: [personId],
    clientId: `digest:${member.id}:${from.toISOString()}`,
  });
  // What the digest showed them is delivered (only that): no batch repeats it.
  if (shown.size) await prisma.nodeRoomEvent.updateMany({ where: { id: { in: [...shown] }, deliveredAt: null }, data: { deliveredAt: started, messageId: message.id } });
  await prisma.nodeRoomMember.update({ where: { id: member.id }, data: { digestAt: started } });
  return message;
}

/**
 * A person opens a room (its read mark moves). Back from away (its end has passed), or here again after a
 * long gap: their lead gives them the digest. Returns once it is posted (tests), or at once when there is none.
 */
export async function roomOpened(app: FastifyInstance, room: NodeRoom, personId: string): Promise<void> {
  if (room.kind !== "room") return;
  const prisma = app.prisma;
  const member = await personRow(prisma, room.id, personId);
  if (!member) return;
  const prefs = prefsOf(member);
  const now = new Date();
  let digest: { since: Date; reason: "back" | "gap" } | null = null;
  if (prefs.away && !awayNow(prefs)) {
    digest = { since: new Date(prefs.away.since), reason: "back" };
    await updatePrefs(prisma, member.id, (current) => ({ ...current, away: null }));
  } else if (!prefs.away && member.seenAt && now.getTime() - member.seenAt.getTime() >= DIGEST_GAP_MS) {
    digest = { since: member.seenAt, reason: "gap" };
  }
  if (!member.seenAt || now.getTime() - member.seenAt.getTime() > 60_000 || digest) await prisma.nodeRoomMember.update({ where: { id: member.id }, data: { seenAt: now } });
  if (digest) await catchUp(app, room, personId, digest.since, digest.reason);
}

/** A person says they are back: the digest of what happened while they were away. */
export async function cameBack(app: FastifyInstance, room: NodeRoom, personId: string, since: string): Promise<void> {
  await catchUp(app, room, personId, new Date(since), "back");
}

// ── watching ────────────────────────────────────────────────────────────────────────────────

let watching = false;

/** Frames from linked spaces start a read of the rooms following them; a sweep catches the rest and delivers what is due. */
export function watchRoomEvents(app: FastifyInstance): void {
  if (watching) return;
  watching = true;
  onSpaceBound(async (_app, roomId, spaceId) => followSpace(app, roomId, spaceId));
  inBackground(app, async () => {
    await followLinked(app);
    await refreshFollowing(app.prisma);
  });
  const stop = sseHub.onFrame(({ userId, frame }) => {
    const rooms = following.get(userId);
    if (!rooms?.size) return;
    if (!["task", "page", "assistant.acted", "undo.recorded", "board"].includes(frame.event)) return;
    for (const roomId of rooms) kick(app, roomId);
    schedule(app);
  });
  const sweep = setInterval(() => {
    if (!sweeping) inBackground(app, () => sweepRoomEvents(app).then(() => undefined));
  }, SWEEP_MS);
  sweep.unref?.();
  app.addHook("onClose", async () => {
    clearInterval(sweep);
    if (pending) clearTimeout(pending);
    pending = null;
    stop();
    watching = false;
  });
}

/** Tests: read every followed space now (the sweep reads only those that stirred). */
export async function scanRoomSpaces(app: FastifyInstance): Promise<void> {
  await followLinked(app);
  for (const feed of await app.prisma.nodeRoomFeed.findMany({ select: { roomId: true } })) await guardedScan(app, feed.roomId);
}

/** Leaving a room: nothing more reaches the person from it, and they stop watching its pages. */
export async function forgetPerson(tx: Prisma.TransactionClient, roomId: string, accountId: string): Promise<void> {
  await tx.nodeRoomEvent.deleteMany({ where: { roomId, userId: accountId, deliveredAt: null } });
  await tx.$executeRaw`UPDATE node_room_pages SET watchers = array_remove(watchers, ${accountId}) WHERE room_id = ${roomId}`;
}
