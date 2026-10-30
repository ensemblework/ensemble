/**
 * A room's shared Ensemble space (docs/35 §12.11; ensemble-node design C4, extension §17.1). The room is the
 * conversation; the space is the work. The room's creator binds a space they own, or makes one; every
 * other person is offered membership as an editor, which they take or leave separately from joining the
 * room. A work request between two current editors of the space becomes a proposed task there, assigned
 * to the person asked, with who asked; accepting it asks one question: private work with a shared result
 * (the default: the mission runs in the assignee's own space and delivers to the task), or a shared run
 * (the mission works in the shared space, where its members see it).
 */
import type { FastifyInstance } from "fastify";
import type { NodePeerRequest, NodeRoom, Prisma, PrismaClient } from "@prisma/client";
import { openedSpace } from "../lib/auth.js";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { truncateText } from "../lib/text.js";
import { lockUserTransaction } from "../lib/user-lock.js";
import { createTask } from "../services/tasks.js";
import { addMember, SharingError } from "../sharing/store.js";
import { copySettings, createSpaceUser, listSpaces } from "../spaces/store.js";
import { publishTo } from "./events.js";
import { nodeSpace } from "./spaces.js";
import { personIn, postMessage, roomPeople, roomSettings, updateMessageData } from "./store.js";

type Db = PrismaClient | Prisma.TransactionClient;

export class RoomSpaceError extends Error {
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409) {
    super(message);
  }
}

/** The space bound to a room, if any. */
export function boundSpaceId(room: Pick<NodeRoom, "settings">): string | null {
  const value = (room.settings as { spaceId?: unknown } | null)?.spaceId;
  return typeof value === "string" && value ? value : null;
}

/**
 * The room's linked space while the room's creator still owns it. A space that changed hands (a transfer)
 * or is gone unlinks the room here, at first use: nothing more is offered, proposed or followed in it.
 */
export async function linkedSpace(app: FastifyInstance, room: NodeRoom): Promise<string | null> {
  const spaceId = boundSpaceId(room);
  if (!spaceId) return null;
  if ((await spaceOwner(app.prisma, spaceId)) === room.userId) return spaceId;
  await unlinkLost(app, room, spaceId);
  return null;
}

async function unlinkLost(app: FastifyInstance, room: NodeRoom, spaceId: string): Promise<void> {
  const prisma = app.prisma;
  const gone = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE node_rooms SET settings = settings - 'spaceId' WHERE id = ${room.id} AND settings->>'spaceId' = ${spaceId} RETURNING id`;
  if (!gone.length) return;
  await expireOffers(app, room.id, spaceId);
  await postMessage(prisma, {
    roomId: room.id,
    userId: room.userId,
    authorKind: "system",
    kind: "status",
    body: "The room's space is no longer linked: it now belongs to someone else, or it is gone. Its board and members stay as they are.",
    data: { roomSpace: { spaceId, action: "unbound", why: "owner_changed" } },
  });
  publishTo(await roomPeople(prisma, room.id), "node.room", { roomId: room.id });
}

/**
 * Someone lost a space (its owner removed them, or them as a contact, or they left): their open offers to
 * join it through a room are withdrawn, so Join cannot bring them back. Registered with sharing/revoke.ts.
 */
export async function expireOffersFor(db: Pick<PrismaClient, "nodeMessage">, spaceIds: readonly string[], accountId: string): Promise<void> {
  if (!spaceIds.length) return;
  const cards = await db.nodeMessage.findMany({
    where: { kind: "status", visibleTo: { equals: [accountId] }, AND: [{ data: { path: ["type"], equals: "space_offer" } }, { OR: [{ data: { path: ["status"], equals: "pending" } }, { data: { path: ["status"], equals: "declined" } }] }] },
  });
  for (const card of cards) {
    if (!spaceIds.includes(String((card.data as { spaceId?: unknown }).spaceId))) continue;
    await updateMessageData(db as PrismaClient, card, { status: "expired" });
  }
}

export type SpaceRole = "owner" | "editor" | "viewer";

/** What `accountId` may do in the space now (read every time), or null. */
export async function roleIn(accountId: string, spaceId: string): Promise<SpaceRole | null> {
  const opened = await openedSpace(accountId, spaceId);
  if (!opened) return null;
  return opened.access.kind === "owner" ? "owner" : opened.access.role;
}

const canEdit = (role: SpaceRole | null) => role === "owner" || role === "editor";

/** The account that owns a space: the space itself for an account, else its owner. */
async function spaceOwner(db: Db, spaceId: string): Promise<string | null> {
  const row = await db.user.findUnique({ where: { id: spaceId }, select: { id: true, ownerId: true } });
  return row ? (row.ownerId ?? row.id) : null;
}

const nameOf = (row: { name: string | null; email: string } | null | undefined): string => row?.name?.trim() || row?.email.split("@")[0] || "Someone";
const nameKey = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The room's creator binds a space they own (`spaceId`), or makes a new one (`create`, named after the
 * room unless `name` is given). Everyone else in the room is offered membership. Returns the space id.
 */
export async function bindSpace(app: FastifyInstance, room: NodeRoom, accountId: string, input: { spaceId?: string; create?: boolean; name?: string }): Promise<string> {
  const prisma = app.prisma;
  if (room.kind !== "room") throw new RoomSpaceError("Only rooms with other people have a shared space.", 400);
  if (room.userId !== accountId) throw new RoomSpaceError("Only the person who made this room links its space.", 403);
  let spaceId = input.spaceId ?? null;
  if (input.create) {
    const name = truncateText((input.name ?? `${room.title} space`).trim(), 60) || "Room space";
    spaceId = await prisma.$transaction(async (tx) => {
      await lockUserTransaction(tx, accountId);
      const { spaces } = await listSpaces(tx, accountId);
      const taken = spaces.find((row) => nameKey(row.name) === nameKey(name));
      if (taken) throw new RoomSpaceError(`You already have a space called ${taken.name}. Pick another name.`, 409);
      return createSpaceUser(tx, accountId, { name, icon: null });
    });
    await copySettings(prisma, accountId, spaceId);
    await appendLedger({ userId: accountId, actor: "me", action: "space.create", payload: { spaceId, roomId: room.id } });
    sseHub.publish(accountId, { event: "sharing.changed", data: {} });
  }
  if (!spaceId) throw new RoomSpaceError("Pick a space, or make one.", 400);
  if ((await roleIn(accountId, spaceId)) !== "owner") throw new RoomSpaceError("Link a space you own.", 403);
  const fresh = await prisma.nodeRoom.findUniqueOrThrow({ where: { id: room.id } });
  const previous = boundSpaceId(fresh);
  await prisma.nodeRoom.update({ where: { id: room.id }, data: { settings: { ...roomSettings(fresh), spaceId } as Prisma.InputJsonValue } });
  const space = await nodeSpace(prisma, accountId, spaceId);
  const who = nameOf(await prisma.user.findUnique({ where: { id: accountId }, select: { name: true, email: true } }));
  if (previous !== spaceId) {
    await postMessage(prisma, {
      roomId: room.id,
      userId: accountId,
      authorKind: "system",
      kind: "status",
      body: `${who} linked the space “${space?.name ?? "Room space"}” to this room: its board holds the room's work.`,
      data: { roomSpace: { spaceId, action: "bound" } },
    });
    if (previous) await expireOffers(app, room.id, previous);
    for (const person of await roomPeople(prisma, room.id)) if (person !== accountId) await offerSpace(app, room.id, person);
    await spaceBound(app, room.id, spaceId);
  }
  publishTo(await roomPeople(prisma, room.id), "node.room", { roomId: room.id });
  return spaceId;
}

/** The room's creator unlinks its space. The space and its members stay as they are. */
export async function unbindSpace(app: FastifyInstance, room: NodeRoom, accountId: string): Promise<void> {
  const prisma = app.prisma;
  if (room.userId !== accountId) throw new RoomSpaceError("Only the person who made this room links its space.", 403);
  const fresh = await prisma.nodeRoom.findUniqueOrThrow({ where: { id: room.id } });
  const spaceId = boundSpaceId(fresh);
  if (!spaceId) return;
  const { spaceId: _gone, ...rest } = roomSettings(fresh);
  await prisma.nodeRoom.update({ where: { id: room.id }, data: { settings: rest as Prisma.InputJsonValue } });
  await expireOffers(app, room.id, spaceId);
  const who = nameOf(await prisma.user.findUnique({ where: { id: accountId }, select: { name: true, email: true } }));
  await postMessage(prisma, { roomId: room.id, userId: accountId, authorKind: "system", kind: "status", body: `${who} unlinked the room's space. Its board and members stay as they are.`, data: { roomSpace: { spaceId, action: "unbound" } } });
  publishTo(await roomPeople(prisma, room.id), "node.room", { roomId: room.id });
}

/** Called once a space is bound (C5 starts following it). Set by node/room-events.ts. */
let onBound: ((app: FastifyInstance, roomId: string, spaceId: string) => Promise<void>) | null = null;
export function onSpaceBound(hook: (app: FastifyInstance, roomId: string, spaceId: string) => Promise<void>): void {
  onBound = hook;
}
async function spaceBound(app: FastifyInstance, roomId: string, spaceId: string): Promise<void> {
  if (onBound) await onBound(app, roomId, spaceId);
}

type OfferData = { type: "space_offer"; status: string; spaceId: string; spaceName: string; ownerName: string; role: "editor" };

async function offerCard(db: Db, roomId: string, personId: string, spaceId: string) {
  return db.nodeMessage.findFirst({
    where: { roomId, kind: "status", visibleTo: { equals: [personId] }, AND: [{ data: { path: ["type"], equals: "space_offer" } }, { data: { path: ["spaceId"], equals: spaceId } }] },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Offers one person membership of the room's space as an editor: a private card they answer (Join, or
 * Not now). Nothing when they already have the space, an offer waits, or they said no to this space.
 */
export async function offerSpace(app: FastifyInstance, roomId: string, personId: string): Promise<void> {
  const prisma = app.prisma;
  const room = await prisma.nodeRoom.findUnique({ where: { id: roomId } });
  const spaceId = room ? await linkedSpace(app, room) : null;
  if (!room || !spaceId || !(await personIn(prisma, roomId, personId))) return;
  if (await roleIn(personId, spaceId)) return;
  const existing = await offerCard(prisma, roomId, personId, spaceId);
  if (existing && ["pending", "declined"].includes(String((existing.data as { status?: unknown }).status))) return;
  const owner = await spaceOwner(prisma, spaceId);
  const space = owner ? await nodeSpace(prisma, owner, spaceId) : null;
  if (!owner || !space) return;
  const ownerName = nameOf(await prisma.user.findUnique({ where: { id: owner }, select: { name: true, email: true } }));
  const data: OfferData = { type: "space_offer", status: "pending", spaceId, spaceName: space.name, ownerName, role: "editor" };
  await postMessage(prisma, {
    roomId,
    userId: personId,
    authorKind: "system",
    kind: "status",
    body: `This room's work lives in ${ownerName}'s space “${space.name}”. Join it as an editor to see and work on its board, pages and runs?`,
    data,
    visibleTo: [personId],
  });
}

async function expireOffers(app: FastifyInstance, roomId: string, spaceId: string): Promise<void> {
  const cards = await app.prisma.nodeMessage.findMany({ where: { roomId, kind: "status", AND: [{ data: { path: ["type"], equals: "space_offer" } }, { data: { path: ["spaceId"], equals: spaceId } }, { data: { path: ["status"], equals: "pending" } }] } });
  for (const card of cards) await updateMessageData(app.prisma, card, { status: "expired" });
}

/**
 * A person answers their offer. Joining makes them an editor of the space for its owner, who offered
 * it by linking the space to the room; the owner's sharing limits apply (Settings, Sharing).
 */
export async function answerSpaceOffer(app: FastifyInstance, room: NodeRoom, personId: string, join: boolean): Promise<{ status: string }> {
  const prisma = app.prisma;
  const spaceId = await linkedSpace(app, room);
  if (!spaceId) throw new RoomSpaceError("This room has no shared space.", 404);
  const card = await offerCard(prisma, room.id, personId, spaceId);
  if (!card) throw new RoomSpaceError("There is no offer to answer.", 404);
  // Not now can become Join later; joined and expired offers are settled.
  const status = (card.data as { status?: unknown }).status;
  if (status !== "pending" && !(join && status === "declined")) throw new RoomSpaceError("This was already settled.", 409);
  if (!join) {
    await updateMessageData(prisma, card, { status: "declined" });
    return { status: "declined" };
  }
  const owner = await spaceOwner(prisma, spaceId);
  if (!owner) throw new RoomSpaceError("That space is gone.", 404);
  if (await roleIn(personId, spaceId)) {
    await updateMessageData(prisma, card, { status: "joined" });
    return { status: "joined" };
  }
  try {
    await addMember(prisma, owner, spaceId, personId, "editor");
  } catch (error) {
    if (error instanceof SharingError && (error.code === "MEMBER_LIMIT" || error.code === "CONTACT_LIMIT")) {
      const ownerName = nameOf(await prisma.user.findUnique({ where: { id: owner }, select: { name: true, email: true } }));
      throw new RoomSpaceError(`${ownerName} has reached their sharing limit (${error.code === "MEMBER_LIMIT" ? "people in a space" : "contacts"}). They can raise it in Settings, Sharing.`, 409);
    }
    throw error;
  }
  await appendLedger({ userId: spaceId, actor: "me", action: "sharing.member.add", payload: { memberId: personId, role: "editor", roomId: room.id } });
  for (const id of new Set([personId, owner])) sseHub.publish(id, { event: "sharing.changed", data: {} });
  await updateMessageData(prisma, card, { status: "joined" });
  return { status: "joined" };
}

/** The room's space as one person sees it: which space, their role there, and their offer. */
export async function spaceView(app: FastifyInstance, room: NodeRoom, viewerId: string) {
  const prisma = app.prisma;
  const spaceId = await linkedSpace(app, room);
  if (!spaceId) return { space: null, offer: null };
  const owner = await spaceOwner(prisma, spaceId);
  const role = await roleIn(viewerId, spaceId);
  const named = owner ? await nodeSpace(prisma, owner, spaceId) : null;
  const ownerName = owner ? nameOf(await prisma.user.findUnique({ where: { id: owner }, select: { name: true, email: true } })) : null;
  const card = await offerCard(prisma, room.id, viewerId, spaceId);
  return {
    space: named ? { id: spaceId, name: named.name, ownerId: owner, ownerName, role } : { id: spaceId, name: null, ownerId: owner, ownerName, role },
    offer: card ? { messageId: card.id, status: (card.data as { status?: unknown }).status } : null,
  };
}

/**
 * The room's board as one person sees it: the space's tasks, for its owner and members only (read
 * every time). Who each task is with, who asked for it, and which node made it for whom.
 */
export async function roomBoard(app: FastifyInstance, room: NodeRoom, viewerId: string) {
  const prisma = app.prisma;
  const spaceId = await linkedSpace(app, room);
  if (!spaceId) return { space: null, tasks: [] };
  const role = await roleIn(viewerId, spaceId);
  const owner = await spaceOwner(prisma, spaceId);
  if (!role || !owner) return { space: { id: spaceId, name: null, role: null }, tasks: [] };
  const space = await nodeSpace(prisma, owner, spaceId);
  const rows = await prisma.task.findMany({
    where: { userId: spaceId, deletedAt: null, status: { not: "dropped" } },
    orderBy: [{ boardOrder: "asc" }, { createdAt: "asc" }],
    take: 300,
    select: { id: true, title: true, status: true, priority: true, due: true, owner: true, assigneeAccountId: true, peerRequestId: true, requestedByAccountId: true, requestedByNodeId: true, createdByAccountId: true, createdByNodeId: true, updatedAt: true },
  });
  const accounts = new Set<string>([owner]);
  const nodes = new Set<string>();
  for (const row of rows) {
    for (const id of [row.assigneeAccountId, row.requestedByAccountId, row.createdByAccountId]) if (id) accounts.add(id);
    for (const id of [row.requestedByNodeId, row.createdByNodeId]) if (id) nodes.add(id);
  }
  const people = new Map((await prisma.user.findMany({ where: { id: { in: [...accounts] } }, select: { id: true, name: true, email: true } })).map((row) => [row.id, nameOf(row)]));
  const nodeNames = new Map((await prisma.nodeAgent.findMany({ where: { id: { in: [...nodes] } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]));
  const who = (accountId: string | null) => (accountId ? { accountId, name: people.get(accountId) ?? "Someone" } : null);
  return {
    space: { id: spaceId, name: space?.name ?? null, role },
    tasks: rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      priority: row.priority,
      due: row.due?.toISOString() ?? null,
      // A "me" task with no assignee account is the space owner's.
      assignee: row.owner === "me" ? who(row.assigneeAccountId ?? owner) : null,
      requestedBy: row.requestedByAccountId ? { ...who(row.requestedByAccountId)!, node: row.requestedByNodeId ? { id: row.requestedByNodeId, name: nodeNames.get(row.requestedByNodeId) ?? null } : null } : null,
      peerRequestId: row.peerRequestId,
      // "@node for person".
      madeBy: row.createdByNodeId ? { node: { id: row.createdByNodeId, name: nodeNames.get(row.createdByNodeId) ?? null }, for: who(row.createdByAccountId ?? owner) } : null,
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

// ── pages the room follows ──────────────────────────────────────────────────────────────────

/** Pages of the linked space the room follows (watched, a contract, the decisions log), as one person sees them. */
export async function roomPages(app: FastifyInstance, room: NodeRoom, viewerId: string) {
  const prisma = app.prisma;
  const spaceId = await linkedSpace(app, room);
  if (!spaceId || !(await roleIn(viewerId, spaceId))) return [];
  const rows = await prisma.nodeRoomPage.findMany({ where: { roomId: room.id, spaceId }, orderBy: { createdAt: "asc" } });
  const pages = new Map((await prisma.taskPage.findMany({ where: { id: { in: rows.map((row) => row.pageId) }, userId: spaceId, deletedAt: null }, select: { id: true, title: true, taskId: true, updatedAt: true } })).map((row) => [row.id, row]));
  return rows
    .filter((row) => pages.has(row.pageId))
    .map((row) => {
      const page = pages.get(row.pageId)!;
      return { pageId: row.pageId, taskId: page.taskId, title: page.title || "Untitled", role: row.role, watchers: row.watchers.length, watching: row.watchers.includes(viewerId), updatedAt: page.updatedAt.toISOString() };
    });
}

/** The page, if it is in the room's linked space and the person can open that space. */
export async function followedPage(app: FastifyInstance, room: NodeRoom, accountId: string, pageId: string): Promise<{ spaceId: string; pageId: string }> {
  const spaceId = await linkedSpace(app, room);
  if (!spaceId) throw new RoomSpaceError("This room has no shared space.", 404);
  if (!(await roleIn(accountId, spaceId))) throw new RoomSpaceError("Join the room's space first.", 403);
  const page = await app.prisma.taskPage.findFirst({ where: { userId: spaceId, deletedAt: null, OR: [{ id: pageId }, { taskId: pageId }] }, select: { id: true } });
  if (!page) throw new RoomSpaceError("That page is not in the room's space.", 404);
  return { spaceId, pageId: page.id };
}

/** One person watches a page of the room's space (its edits reach them through their lead), or stops. */
export async function watchPage(app: FastifyInstance, room: NodeRoom, accountId: string, pageId: string, watching: boolean): Promise<void> {
  const prisma = app.prisma;
  const page = await followedPage(app, room, accountId, pageId);
  await prisma.nodeRoomPage.upsert({
    where: { roomId_pageId: { roomId: room.id, pageId: page.pageId } },
    create: { roomId: room.id, spaceId: page.spaceId, pageId: page.pageId, createdBy: accountId, watchers: [] },
    update: {},
  });
  await prisma.$executeRaw`
    UPDATE node_room_pages SET updated_at = now(),
      watchers = CASE WHEN ${watching} THEN (CASE WHEN ${accountId} = ANY(watchers) THEN watchers ELSE array_append(watchers, ${accountId}) END) ELSE array_remove(watchers, ${accountId}) END
    WHERE room_id = ${room.id} AND page_id = ${page.pageId}`;
  // A page that is only watched goes when nobody watches it.
  await prisma.nodeRoomPage.deleteMany({ where: { roomId: room.id, pageId: page.pageId, role: "watched", watchers: { isEmpty: true } } });
}

// ── proposed tasks ──────────────────────────────────────────────────────────────────────────

/**
 * A work request becomes a proposed task in the room's space, assigned to the person asked, when both
 * people are current editors there (the space's owner counts). Otherwise null: it stays a private card.
 */
export async function proposeTask(app: FastifyInstance, request: NodePeerRequest, room: NodeRoom): Promise<string | null> {
  const prisma = app.prisma;
  const spaceId = await linkedSpace(app, room);
  if (!spaceId || request.kind !== "work") return null;
  if (!canEdit(await roleIn(request.fromAccountId, spaceId)) || !canEdit(await roleIn(request.toAccountId, spaceId))) return null;
  const users = await prisma.user.findMany({ where: { id: { in: [request.fromAccountId, request.toAccountId] } }, select: { id: true, name: true, email: true } });
  const from = nameOf(users.find((row) => row.id === request.fromAccountId));
  const via = request.fromNodeId ? (await prisma.nodeRoomMember.findFirst({ where: { roomId: room.id, nodeId: request.fromNodeId }, select: { handle: true } }))?.handle : null;
  const refs = Array.isArray(request.refs) ? (request.refs as Array<{ title?: string; url?: string }>) : [];
  const title = truncateText(request.text.split("\n")[0]!.trim(), 200) || "Requested work";
  const description = [
    request.text,
    refs.length ? `\nReferences:\n${refs.map((row) => `- ${row.title ?? "link"}${row.url ? `: ${row.url}` : ""}`).join("\n")}` : "",
    `\nAsked by ${from}${via ? ` (via @${via})` : ""} in the room “${room.title}”.`,
  ].filter(Boolean).join("\n");
  const task = await prisma.$transaction(async (tx) => {
    const created = await createTask(tx, spaceId, { title, description, owner: "me", assignee: request.toAccountId, status: "proposed", sourceRef: `room-request:${request.id}` }, "agent", false);
    return tx.task.update({
      where: { id: created.id },
      data: {
        rationale: truncateText(`${from} asked for this in “${room.title}”${via ? ` (via @${via})` : ""}.`, 300),
        requestedByAccountId: request.fromAccountId,
        requestedByNodeId: request.fromNodeId,
        peerRequestId: request.id,
        createdByAccountId: request.fromAccountId,
        createdByNodeId: request.fromNodeId,
      },
    });
  });
  sseHub.publish(spaceId, { event: "task", data: { id: task.id, action: "create" } });
  return task.id;
}

/**
 * A review's result goes on the requester's own task: the first task the request refers to that is on the
 * board of the room's space, while the requester can edit there. Null otherwise (the result stays in the room).
 */
export async function requesterTask(app: FastifyInstance, request: NodePeerRequest, room: NodeRoom): Promise<string | null> {
  const spaceId = await linkedSpace(app, room);
  if (!spaceId || !canEdit(await roleIn(request.fromAccountId, spaceId))) return null;
  const ids = (Array.isArray(request.refs) ? (request.refs as Array<{ kind?: unknown; id?: unknown }>) : []).filter((ref) => ref.kind === "task" && typeof ref.id === "string").map((ref) => ref.id as string);
  if (!ids.length) return null;
  const tasks = await app.prisma.task.findMany({ where: { id: { in: ids }, userId: spaceId, deletedAt: null }, select: { id: true } });
  return ids.find((id) => tasks.some((task) => task.id === id)) ?? null;
}

/**
 * Keeps a request's proposed task in step with the request: accepted → in progress (with the edited
 * text), declined or cancelled → dropped. Done is C6's (the result is delivered to the task).
 */
export async function syncRequestTask(app: FastifyInstance, request: NodePeerRequest): Promise<void> {
  if (!request.taskId) return;
  const prisma = app.prisma;
  const task = await prisma.task.findFirst({ where: { id: request.taskId, deletedAt: null } });
  if (!task) return;
  let data: Prisma.TaskUpdateInput | null = null;
  // Accepted, it keeps what was asked: the person's own words for their lead (`brief`) are theirs alone.
  if (request.status === "approved" && task.status === "proposed") {
    data = { status: "in_progress" };
  } else if ((request.status === "declined" || request.status === "cancelled") && task.status === "proposed") {
    data = { status: "dropped", completedAt: new Date() };
  }
  if (!data) return;
  await prisma.task.update({ where: { id: task.id }, data });
  await prisma.taskTransition.create({ data: { userId: task.userId, taskId: task.id, fromStatus: task.status, toStatus: data.status as "in_progress" | "dropped", actor: "system", reason: `room request ${request.status}` } });
  sseHub.publish(task.userId, { event: "task", data: { id: task.id, action: "update" } });
}

/** Where accepted work runs, written into the lead's note and the mission. */
export function modeLine(request: Pick<NodePeerRequest, "mode" | "taskId">, spaceName: string | null): string {
  if (!request.taskId) return "";
  return request.mode === "shared"
    ? ` Your owner chose a shared run: work in the room's space “${spaceName ?? "the shared space"}” (name it as the space in Ensemble calls, and pass the task to your agent sessions), where its members see the run.`
    : ` Your owner chose private work with a shared result: work in your owner's own space as usual; the result is delivered to the task in “${spaceName ?? "the shared space"}”.`;
}
