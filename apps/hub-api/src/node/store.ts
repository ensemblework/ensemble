/**
 * Ensemble Node rows (docs/35 §6). Every read of messages filters on visibility: an empty
 * `visibleTo` is the whole room, otherwise only the accounts listed (and their nodes).
 */
import type { NodeAgent, NodeMessage, NodeRoom, NodeRoomMember, Prisma, PrismaClient } from "@prisma/client";
import { publishTo } from "./events.js";
import { handleFrom, resolveMentions, uniqueHandle, type DirectoryEntry, type Mention } from "./mentions.js";
import { nodeTemplate, type NodeAvatar } from "./templates.js";

type Db = PrismaClient | Prisma.TransactionClient;

export type MessageKind = "text" | "approval" | "run" | "status" | "error";

export const visibleWhere = (accountId: string): Prisma.NodeMessageWhereInput => ({
  OR: [{ visibleTo: { isEmpty: true } }, { visibleTo: { has: accountId } }],
});

export const canSee = (message: { visibleTo: readonly string[] }, accountId: string): boolean =>
  message.visibleTo.length === 0 || message.visibleTo.includes(accountId);

export function personIn(prisma: Db, roomId: string, accountId: string): Promise<NodeRoomMember | null> {
  return prisma.nodeRoomMember.findFirst({ where: { roomId, userId: accountId, nodeId: null } });
}

export async function roomPeople(prisma: Db, roomId: string): Promise<string[]> {
  const rows = await prisma.nodeRoomMember.findMany({ where: { roomId, nodeId: null }, select: { userId: true } });
  return rows.map((row) => row.userId);
}

export function directoryOf(members: ReadonlyArray<Pick<NodeRoomMember, "handle" | "nodeId" | "userId">>): DirectoryEntry[] {
  return members.map((member) => ({ handle: member.handle, kind: member.nodeId ? "node" : "human", id: member.nodeId ?? member.userId }));
}

/** Mentions in `text`, with `@everyone` / `@nodes` expanded to the nodes that may see the message. */
export function mentionsFor(text: string, members: ReadonlyArray<Pick<NodeRoomMember, "handle" | "nodeId" | "userId">>, visibleTo: readonly string[]): Mention[] {
  const resolved = resolveMentions(text, directoryOf(members));
  if (!resolved.allNodes) return resolved.mentions;
  const all = members
    .filter((member) => member.nodeId && (visibleTo.length === 0 || visibleTo.includes(member.userId)))
    .map((member) => ({ kind: "node" as const, id: member.nodeId! }));
  const seen = new Set(resolved.mentions.map((row) => `${row.kind}:${row.id}`));
  return [...resolved.mentions, ...all.filter((row) => !seen.has(`node:${row.id}`))];
}

export type PostInput = {
  roomId: string;
  /** The author's account: the person, or the node's owner. */
  userId: string;
  authorKind: "human" | "node" | "system";
  authorNodeId?: string | null;
  kind?: MessageKind;
  body?: string;
  data?: Record<string, unknown>;
  visibleTo?: string[];
  mentions?: Mention[];
  rootMessageId?: string | null;
  botDepth?: number;
  clientId?: string | null;
};

export type WireMessage = ReturnType<typeof wireMessage>;

export function wireMessage(row: NodeMessage) {
  return {
    id: row.id,
    roomId: row.roomId,
    seq: row.seq,
    authorKind: row.authorKind,
    authorAccountId: row.userId,
    authorNodeId: row.authorNodeId,
    kind: row.kind,
    body: row.body,
    data: row.data,
    private: row.visibleTo.length > 0,
    mentions: row.mentions,
    rootMessageId: row.rootMessageId,
    clientId: row.clientId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Writes a message with the room's next seq and tells everyone who may see it. A resent clientId returns the first copy. */
export async function postMessage(prisma: PrismaClient, input: PostInput): Promise<{ message: NodeMessage; duplicate: boolean }> {
  if (input.clientId) {
    const existing = await prisma.nodeMessage.findUnique({ where: { roomId_clientId: { roomId: input.roomId, clientId: input.clientId } } });
    if (existing) return { message: existing, duplicate: true };
  }
  let message: NodeMessage;
  try {
    message = await prisma.$transaction(async (tx) => {
      const room = await tx.nodeRoom.update({ where: { id: input.roomId }, data: { lastSeq: { increment: 1 }, lastMessageAt: new Date() }, select: { lastSeq: true } });
      return tx.nodeMessage.create({
        data: {
          roomId: input.roomId,
          seq: room.lastSeq,
          userId: input.userId,
          authorKind: input.authorKind,
          authorNodeId: input.authorNodeId ?? null,
          kind: input.kind ?? "text",
          body: input.body ?? "",
          data: (input.data ?? {}) as Prisma.InputJsonValue,
          visibleTo: input.visibleTo ?? [],
          mentions: (input.mentions ?? []) as Prisma.InputJsonValue,
          rootMessageId: input.rootMessageId ?? null,
          botDepth: input.botDepth ?? 0,
          clientId: input.clientId ?? null,
        },
      });
    });
  } catch (error) {
    if (input.clientId && (error as { code?: string }).code === "P2002") {
      const existing = await prisma.nodeMessage.findUnique({ where: { roomId_clientId: { roomId: input.roomId, clientId: input.clientId } } });
      if (existing) return { message: existing, duplicate: true };
    }
    throw error;
  }
  await announce(prisma, message, "node.message");
  return { message, duplicate: false };
}

/** Sends a message (new or changed) to the people in its room who may see it. */
export async function announce(prisma: Db, message: NodeMessage, event: "node.message" | "node.message.updated"): Promise<void> {
  const people = await roomPeople(prisma, message.roomId);
  publishTo(people.filter((accountId) => canSee(message, accountId)), event, wireMessage(message));
}

export async function updateMessageData(prisma: PrismaClient, message: NodeMessage, patch: Record<string, unknown>, body?: string): Promise<NodeMessage> {
  const data = { ...(message.data as Record<string, unknown>), ...patch };
  const next = await prisma.nodeMessage.update({ where: { id: message.id }, data: { data: data as Prisma.InputJsonValue, ...(body !== undefined ? { body } : {}) } });
  await announce(prisma, next, "node.message.updated");
  return next;
}

/** A person's handle in a room, from their name or email. */
export async function personHandle(prisma: Db, accountId: string, taken: ReadonlySet<string>): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: accountId }, select: { name: true, email: true } });
  const first = user?.name?.trim().split(/\s+/)[0];
  return uniqueHandle(first || user?.email || "me", taken);
}

export async function takenHandles(prisma: Db, roomId: string): Promise<Set<string>> {
  const rows = await prisma.nodeRoomMember.findMany({ where: { roomId }, select: { handle: true } });
  return new Set(rows.map((row) => row.handle));
}

/** Adds a person; returns the existing membership when they are already in. */
export async function addPerson(prisma: Db, roomId: string, accountId: string, role: "owner" | "member" = "member"): Promise<NodeRoomMember> {
  const existing = await prisma.nodeRoomMember.findFirst({ where: { roomId, userId: accountId, nodeId: null } });
  if (existing) return existing;
  const handle = await personHandle(prisma, accountId, await takenHandles(prisma, roomId));
  const room = await prisma.nodeRoom.findUnique({ where: { id: roomId }, select: { lastSeq: true } });
  return prisma.nodeRoomMember.create({ data: { roomId, userId: accountId, handle, role, readSeq: room?.lastSeq ?? 0 } });
}

/**
 * Adds a node; its handle is its slug, or owner-slug when that is taken in this room. It starts reading
 * at the room's newest message, so joining never hands it what was said before.
 */
export async function addNode(prisma: Db, roomId: string, node: NodeAgent, representative = false): Promise<NodeRoomMember> {
  const existing = await prisma.nodeRoomMember.findFirst({ where: { roomId, nodeId: node.id } });
  if (existing) return existing;
  const taken = await takenHandles(prisma, roomId);
  let handle = node.slug;
  if (taken.has(handle)) {
    const owner = await prisma.nodeRoomMember.findFirst({ where: { roomId, userId: node.userId, nodeId: null }, select: { handle: true } });
    handle = uniqueHandle(`${owner?.handle ?? "my"}-${node.slug}`, taken);
  }
  const room = await prisma.nodeRoom.findUnique({ where: { id: roomId }, select: { lastSeq: true } });
  const from = room?.lastSeq ?? 0;
  return prisma.nodeRoomMember.create({ data: { roomId, userId: node.userId, nodeId: node.id, handle, representative, seenSeq: from, privateSeenSeq: from, readSeq: from } });
}

export type NodeInput = {
  templateId?: string;
  name?: string;
  slug?: string;
  role?: string;
  charter?: string;
  avatar?: NodeAvatar;
  provider?: string | null;
  model?: string | null;
};

/**
 * Creates a node and its DM room. Names are unique per account (case-insensitive): a name the caller
 * chose must be checked first (`nodeNameTaken`); a template's default name gets a number. A slug
 * already used by this account gets a number too.
 */
export async function createNode(prisma: PrismaClient, accountId: string, input: NodeInput): Promise<{ node: NodeAgent; room: NodeRoom }> {
  const template = input.templateId ? nodeTemplate(input.templateId) : undefined;
  const wanted = (input.name ?? template?.name ?? "Assistant").trim().slice(0, 60) || "Assistant";
  const existing = await prisma.nodeAgent.findMany({ where: { userId: accountId }, select: { slug: true, name: true } });
  const name = numbered(wanted, new Set(existing.map((row) => row.name.trim().toLowerCase())), 60);
  const slug = uniqueHandle(input.slug ?? template?.slug ?? handleFrom(name), new Set(existing.map((row) => row.slug)));
  return prisma.$transaction(async (tx) => {
    const node = await tx.nodeAgent.create({
      data: {
        userId: accountId,
        slug,
        name,
        role: (input.role ?? template?.role ?? "assistant").slice(0, 40),
        charter: (input.charter ?? template?.charter ?? "").slice(0, 8000),
        avatar: (input.avatar ?? template?.avatar ?? { shape: "orb", color: "#D7B56F", eyes: "dot" }) as Prisma.InputJsonValue,
        provider: input.provider ?? null,
        model: input.model ?? null,
        templateId: template?.id ?? null,
        autonomy: { sharedRooms: "ask" },
      },
    });
    const room = await tx.nodeRoom.create({ data: { userId: accountId, kind: "dm", title: name, settings: { leadNodeIds: [node.id] } } });
    await addPerson(tx, room.id, accountId, "owner");
    await addNode(tx, room.id, node);
    return { node, room };
  });
}

export function wireNode(node: NodeAgent) {
  return {
    id: node.id,
    ownerId: node.userId,
    slug: node.slug,
    name: node.name,
    role: node.role,
    avatar: node.avatar,
    charter: node.charter,
    provider: node.provider,
    model: node.model,
    runProfileId: node.runProfileId,
    autonomy: node.autonomy,
    status: node.status,
    templateId: node.templateId,
    createdAt: node.createdAt.toISOString(),
  };
}

/** What other people in a room may know about someone else's node. */
export function publicNode(node: NodeAgent) {
  return { id: node.id, ownerId: node.userId, slug: node.slug, name: node.name, role: node.role, avatar: node.avatar, status: node.status };
}

export type RoomSettings = { leadNodeIds: string[]; responsibilities: Record<string, string>; pinned: string[] };

export function roomSettings(room: Pick<NodeRoom, "settings">): RoomSettings {
  const raw = (room.settings && typeof room.settings === "object" ? room.settings : {}) as Record<string, unknown>;
  const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  const duties = raw.responsibilities && typeof raw.responsibilities === "object" ? (raw.responsibilities as Record<string, unknown>) : {};
  return {
    leadNodeIds: ids(raw.leadNodeIds),
    responsibilities: Object.fromEntries(Object.entries(duties).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    pinned: ids(raw.pinned),
  };
}

/** `base`, or `base 2`, `base 3`… when a name in `taken` (lowercased) already has it. */
export function numbered(base: string, taken: ReadonlySet<string>, max: number): string {
  const clean = base.trim().slice(0, max);
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let n = 2; ; n += 1) {
    const candidate = `${clean.slice(0, max - String(n).length - 1)} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Whether another of this account's nodes already has this name (case-insensitive). */
export async function nodeNameTaken(prisma: Db, accountId: string, name: string, exceptId?: string): Promise<boolean> {
  const hit = await prisma.nodeAgent.findFirst({
    where: { userId: accountId, name: { equals: name.trim(), mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return Boolean(hit);
}

/** Crew and room titles are unique among the crews and rooms an account made (case-insensitive). */
export async function roomTitleTaken(prisma: Db, accountId: string, title: string, exceptId?: string): Promise<boolean> {
  const hit = await prisma.nodeRoom.findFirst({
    where: { userId: accountId, kind: { in: ["crew", "room"] }, archivedAt: null, title: { equals: title.trim(), mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return Boolean(hit);
}

/** A free crew or room title for this account, from `base`. */
export async function freeRoomTitle(prisma: Db, accountId: string, base: string): Promise<string> {
  const rows = await prisma.nodeRoom.findMany({ where: { userId: accountId, kind: { in: ["crew", "room"] }, archivedAt: null }, select: { title: true } });
  return numbered(base, new Set(rows.map((row) => row.title.trim().toLowerCase())), 80);
}
