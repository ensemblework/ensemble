/**
 * What a node remembers (docs/35 §5.6): facts and preferences its owner gave it, each with a scope, what it
 * is about (`key`), where it came from, and its earlier revisions kept as history.
 *
 * - Scopes: `owner` (about the owner: every node of theirs reads it), `node` (the node's own, the default),
 *   `room` (read only in that room), `project` (read when that project is open in a turn).
 * - Writes: a fact with the key of one the turn can read replaces it; the old row stays, linked to the new one
 *   (`supersededById`). No node changes a pinned memory, and an edit the owner made in Node after the turn
 *   began wins over the node's (compare-and-set on `updatedAt`). The owner's own edits replace a fact the
 *   same way and may change a pinned one.
 * - Past `MAX_MEMORIES` live memories a node keeps, the oldest unused (not pinned) are archived, never deleted.
 * - Reads (`memoriesForTurn`): pinned memories and the owner's preferences always (within `alwaysBytes`), then
 *   the rest by full-text rank for the turn's words, newest first among equals, within the token budget of the
 *   versioned config (context/config.ts). Each memory given is marked used.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type NodeMemory, type PrismaClient } from "@prisma/client";
import type { MemoryConfig } from "../context/config.js";
import { queryTerms, tsQuery } from "../context/fulltext.js";
import { truncateText } from "../lib/text.js";

/** Live memories a node keeps; past it the oldest unused are archived. */
export const MAX_MEMORIES = 200;
export const MEMORY_CHARS = 500;
export const KEY_CHARS = 80;
export const MEMORY_SCOPES = ["owner", "node", "room", "project"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

type Db = PrismaClient | Prisma.TransactionClient;
type Owner = { id: string; userId: string };

/** A write a memory's rules refuse: `status` for a route, `hint` for a tool. */
export class MemoryRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "MemoryRefused";
  }
}

const normal = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const cleanKey = (key: string | null | undefined) => (key?.replace(/\s+/g, " ").trim() ? truncateText(key.replace(/\s+/g, " ").trim(), KEY_CHARS) : null);

/** The memories a turn of `node` may read: the owner's, its own, and those of this room and project. */
export function visibleTo(node: Owner, roomId: string | null, projectId: string | null): Prisma.NodeMemoryWhereInput {
  return {
    userId: node.userId,
    OR: [{ scope: "owner" }, { scope: "node", nodeId: node.id }, ...(roomId ? [{ scope: "room", scopeId: roomId }] : []), ...(projectId ? [{ scope: "project", scopeId: projectId }] : [])],
  };
}

const SPECIFIC: Record<string, number> = { room: 0, project: 1, node: 2, owner: 3 };

/** The current memory with this key the turn can read (archived ones too), the most specific scope first. */
async function byKey(db: Db, node: Owner, key: string, scope: MemoryScope | undefined, roomId: string | null, projectId: string | null): Promise<NodeMemory | null> {
  const rows = await db.nodeMemory.findMany({ where: { AND: [visibleTo(node, roomId, projectId), { supersededById: null, key: { equals: key, mode: "insensitive" } }, scope ? { scope } : {}] }, orderBy: { updatedAt: "desc" } });
  return rows.sort((a, b) => (SPECIFIC[a.scope] ?? 9) - (SPECIFIC[b.scope] ?? 9))[0] ?? null;
}

/** Archives the node's oldest unused memories (never a pinned one) past `MAX_MEMORIES` live ones; how many. */
export async function archiveBeyondLimit(db: Db, nodeId: string, now = new Date(), max = MAX_MEMORIES): Promise<number> {
  const live = await db.nodeMemory.findMany({ where: { nodeId, supersededById: null, archivedAt: null }, select: { id: true, pinned: true, lastUsedAt: true, createdAt: true } });
  const extra = live.length - max;
  if (extra <= 0) return 0;
  const oldest = live
    .filter((row) => !row.pinned)
    .sort((a, b) => (a.lastUsedAt?.getTime() ?? 0) - (b.lastUsedAt?.getTime() ?? 0) || a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, extra);
  if (!oldest.length) return 0;
  await db.nodeMemory.updateMany({ where: { id: { in: oldest.map((row) => row.id) } }, data: { archivedAt: now, updatedAt: now } });
  return oldest.length;
}

/** Replaces `current` with `next` in one step: false when `current` changed since it was read. */
async function supersede(db: Db, current: NodeMemory, nextId: string, now: Date, guard: { pinned?: false }): Promise<boolean> {
  const moved = await db.nodeMemory.updateMany({ where: { id: current.id, supersededById: null, updatedAt: current.updatedAt, ...guard }, data: { supersededById: nextId, updatedAt: now } });
  return moved.count === 1;
}

export type NodeRemember = {
  node: Owner;
  /** The room the turn is in: a room memory's room. */
  roomId: string;
  turnId: string | null;
  /** The owner's message that asked for it. */
  sourceMessageId: string | null;
  content: string;
  key?: string | null;
  scope?: MemoryScope;
  /** A project memory's project. */
  projectId?: string | null;
  /** When the turn began: an edit the owner made after it wins. */
  since: Date;
  now?: Date;
};

export type Remembered = { status: "saved" | "revised" | "same"; memory: NodeMemory; replaced: NodeMemory | null; archived: number };

/** `node_remember`: a node saves what its owner told it (see the file's comment for the rules). */
export async function rememberAsNode(prisma: PrismaClient, input: NodeRemember): Promise<Remembered> {
  const content = input.content.trim();
  const key = cleanKey(input.key);
  const now = input.now ?? new Date();
  const projectId = input.projectId ?? null;
  return prisma.$transaction(async (tx) => {
    const current = key ? await byKey(tx, input.node, key, input.scope, input.roomId, projectId) : null;
    if (current?.pinned) throw new MemoryRefused(`Your owner pinned this memory: “${current.content}”. Only they can change it.`, 409, "Tell your owner what you would change instead.");
    if (current && !current.turnId && current.updatedAt > input.since) {
      throw new MemoryRefused(`Your owner changed this memory themselves a moment ago: “${current.content}”. Their version stands.`, 409, "Tell your owner if you think it should change.");
    }
    const scope: MemoryScope = input.scope ?? ((current?.scope as MemoryScope | undefined) ?? "node");
    if (current && normal(current.content) === normal(content) && current.scope === scope) return { status: "same", memory: current, replaced: null, archived: 0 };
    if (!current) {
      const twin = await tx.nodeMemory.findFirst({ where: { AND: [visibleTo(input.node, input.roomId, projectId), { supersededById: null, archivedAt: null, content: { equals: content, mode: "insensitive" } }] } });
      if (twin) return { status: "same", memory: twin, replaced: null, archived: 0 };
    }
    const memory = await tx.nodeMemory.create({
      data: {
        id: randomUUID(),
        userId: input.node.userId,
        nodeId: input.node.id,
        content,
        key,
        scope,
        scopeId: scope === "room" ? input.roomId : scope === "project" ? projectId : null,
        turnId: input.turnId,
        sourceMessageId: input.sourceMessageId,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (current && !(await supersede(tx, current, memory.id, now, { pinned: false }))) {
      throw new MemoryRefused("That memory changed while you were saving; it was not replaced.", 409, "Read your memories again on your next turn.");
    }
    const archived = await archiveBeyondLimit(tx, input.node.id, now);
    return { status: current ? "revised" : "saved", memory, replaced: current, archived };
  });
}

export type OwnerMemory = { content?: string; key?: string | null; scope?: MemoryScope; scopeId?: string | null; pinned?: boolean; archived?: boolean };

/** A room or project memory names one the owner has; the others name none. */
export async function checkScope(prisma: PrismaClient, node: Owner, scope: MemoryScope, scopeId: string | null | undefined): Promise<string | null> {
  if (scope === "owner" || scope === "node") return null;
  if (!scopeId) throw new MemoryRefused(`A ${scope} memory names its ${scope}.`, 400);
  const found =
    scope === "room"
      ? await prisma.nodeRoomMember.findFirst({ where: { roomId: scopeId, nodeId: node.id }, select: { roomId: true } })
      : await prisma.project.findFirst({ where: { id: scopeId, userId: node.userId, deletedAt: null }, select: { id: true } });
  if (!found) throw new MemoryRefused(scope === "room" ? "That room is not one of this node's." : "That project is not available.", 404);
  return scopeId;
}

/** The owner adds a memory in Node; a key it already has replaces that memory (a pinned one stays pinned). */
export async function rememberAsOwner(prisma: PrismaClient, node: Owner, input: OwnerMemory & { content: string }): Promise<{ memory: NodeMemory; replaced: NodeMemory | null; archived: number }> {
  const key = cleanKey(input.key);
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const current = key
      ? ((await tx.nodeMemory.findMany({ where: { userId: node.userId, supersededById: null, key: { equals: key, mode: "insensitive" }, OR: [{ nodeId: node.id }, { scope: "owner" }] }, orderBy: { updatedAt: "desc" } }))[0] ?? null)
      : null;
    const scope: MemoryScope = input.scope ?? ((current?.scope as MemoryScope | undefined) ?? "node");
    const memory = await tx.nodeMemory.create({
      data: {
        id: randomUUID(),
        userId: node.userId,
        nodeId: node.id,
        content: input.content.trim(),
        key,
        scope,
        scopeId: scope === "room" || scope === "project" ? (input.scopeId ?? (current?.scope === scope ? current.scopeId : null)) : null,
        pinned: input.pinned ?? current?.pinned ?? false,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (current && !(await supersede(tx, current, memory.id, now, {}))) throw new MemoryRefused("That memory changed meanwhile; read it again.", 409);
    return { memory, replaced: current, archived: await archiveBeyondLimit(tx, node.id, now) };
  });
}

/**
 * The owner edits a memory in Node: new words make a new revision that replaces it (the owner's edit wins,
 * pinned or not); a key, scope, pin or archive change applies in place. A replaced revision cannot be edited.
 */
export async function editAsOwner(prisma: PrismaClient, node: Owner, id: string, input: OwnerMemory): Promise<NodeMemory> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const row = await tx.nodeMemory.findFirst({ where: { id, nodeId: node.id, userId: node.userId } });
    if (!row) throw new MemoryRefused("That memory is not available.", 404);
    if (row.supersededById) throw new MemoryRefused("A newer revision replaced this memory: edit that one.", 409);
    const key = input.key === undefined ? row.key : cleanKey(input.key);
    const scope = input.scope ?? (row.scope as MemoryScope);
    const scopeId = scope === "room" || scope === "project" ? (input.scopeId !== undefined ? input.scopeId : row.scope === scope ? row.scopeId : null) : null;
    const pinned = input.pinned ?? row.pinned;
    const archivedAt = input.archived === undefined ? row.archivedAt : input.archived ? (row.archivedAt ?? now) : null;
    // Restored by the owner: used now, so it is not the next one archived.
    const lastUsedAt = input.archived === false && row.archivedAt ? now : row.lastUsedAt;
    const content = input.content?.trim();
    let saved: NodeMemory;
    if (content && content !== row.content) {
      saved = await tx.nodeMemory.create({
        data: { id: randomUUID(), userId: node.userId, nodeId: node.id, content, key, scope, scopeId, pinned, archivedAt, lastUsedAt, createdAt: now, updatedAt: now },
      });
      if (!(await supersede(tx, row, saved.id, now, {}))) throw new MemoryRefused("That memory changed meanwhile; read it again.", 409);
    } else {
      saved = await tx.nodeMemory.update({ where: { id: row.id }, data: { key, scope, scopeId, pinned, archivedAt, lastUsedAt, updatedAt: now } });
    }
    await archiveBeyondLimit(tx, node.id, now);
    return (await tx.nodeMemory.findUnique({ where: { id: saved.id } })) ?? saved;
  });
}

/** Deletes a memory of this node with its earlier revisions; false when it is not there. */
export async function forgetMemory(prisma: PrismaClient, node: Owner, id: string): Promise<boolean> {
  const row = await prisma.nodeMemory.findFirst({ where: { id, nodeId: node.id, userId: node.userId }, select: { id: true } });
  if (!row) return false;
  const ids = new Set([row.id]);
  let frontier = [row.id];
  // Revisions link old to new, so the history is found by walking back; a chain is short.
  for (let step = 0; frontier.length && step < 100; step += 1) {
    const older = await prisma.nodeMemory.findMany({ where: { supersededById: { in: frontier }, userId: node.userId }, select: { id: true } });
    frontier = older.map((item) => item.id).filter((item) => !ids.has(item));
    for (const item of frontier) ids.add(item);
  }
  await prisma.nodeMemory.deleteMany({ where: { id: { in: [...ids] }, userId: node.userId } });
  return true;
}

export type MemoryView = {
  id: string;
  content: string;
  key: string | null;
  scope: string;
  scopeId: string | null;
  /** The room's or the project's title, for a room or project memory. */
  scopeTitle: string | null;
  pinned: boolean;
  archived: boolean;
  archivedAt: string | null;
  /** The revision that replaced it (listed only with `history`). */
  supersededById: string | null;
  /** Who wrote it: the node (from its owner's words) or the owner in Node. */
  source: "node" | "owner";
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

/** The owner's view of a node's memories: live ones first (pinned, then newest), then archived; with `history`, replaced revisions too. */
export async function listMemories(prisma: PrismaClient, node: Owner, options: { history?: boolean } = {}): Promise<MemoryView[]> {
  const rows = await prisma.nodeMemory.findMany({
    where: { nodeId: node.id, userId: node.userId, ...(options.history ? {} : { supersededById: null }) },
    orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { pinned: "desc" }, { updatedAt: "desc" }],
  });
  const titles = await scopeTitles(prisma, node, rows);
  return rows.map((row) => memoryView(row, titles));
}

/** The titles of the rooms and projects these memories are scoped to, by id. */
export async function scopeTitles(prisma: PrismaClient, node: Owner, rows: readonly Pick<NodeMemory, "scope" | "scopeId">[]): Promise<Map<string, string>> {
  const rooms = [...new Set(rows.filter((row) => row.scope === "room" && row.scopeId).map((row) => row.scopeId!))];
  const projects = [...new Set(rows.filter((row) => row.scope === "project" && row.scopeId).map((row) => row.scopeId!))];
  const [roomRows, projectRows] = await Promise.all([
    rooms.length ? prisma.nodeRoom.findMany({ where: { id: { in: rooms } }, select: { id: true, title: true } }) : [],
    projects.length ? prisma.project.findMany({ where: { id: { in: projects }, userId: node.userId }, select: { id: true, name: true } }) : [],
  ]);
  return new Map<string, string>([...roomRows.map((row) => [row.id, row.title] as const), ...projectRows.map((row) => [row.id, row.name] as const)]);
}

export function memoryView(row: NodeMemory, titles: ReadonlyMap<string, string> = new Map()): MemoryView {
  return {
    id: row.id,
    content: row.content,
    key: row.key,
    scope: row.scope,
    scopeId: row.scopeId,
    scopeTitle: row.scopeId ? (titles.get(row.scopeId) ?? null) : null,
    pinned: row.pinned,
    archived: Boolean(row.archivedAt),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    supersededById: row.supersededById,
    source: row.turnId ? "node" : "owner",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/** One memory given to the model and why: the turn's record keeps these (node/instructions.ts `selected`). */
export type SelectedMemory = { id: string; scope: string; key: string | null; pinned: boolean; rank: number; why: "pinned" | "owner" | "relevant" | "recent" };

/** One memory as the node reads it: its words, the key it can replace it by, and where it applies. */
export function memoryLine(row: Pick<NodeMemory, "content" | "key" | "pinned" | "scope">): string {
  const notes = [row.key ? `key “${row.key}”` : "", row.pinned ? "pinned" : "", row.scope === "room" ? "this conversation" : row.scope === "project" ? "this project" : ""].filter(Boolean);
  return `${row.content.replace(/\s+/g, " ").trim()}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

/** Full-text ranks of the memories a turn can read, for its words; only those that match. */
async function ranks(prisma: PrismaClient, node: Owner, roomId: string | null, projectId: string | null, query: string): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ id: string; rank: number }>>(Prisma.sql`
    SELECT m.id, ts_rank(m.doc, q.query, 1)::float8 AS rank
    FROM (
      SELECT id, setweight(to_tsvector('simple', coalesce(key, '')), 'A') || setweight(to_tsvector('simple', content), 'B') AS doc
      FROM node_memories
      WHERE user_id = ${node.userId} AND superseded_by_id IS NULL AND archived_at IS NULL
        AND (scope = 'owner' OR (scope = 'node' AND node_id = ${node.id}) OR (scope = 'room' AND scope_id = ${roomId}) OR (scope = 'project' AND scope_id = ${projectId}))
    ) m, (SELECT to_tsquery('simple', ${query}) AS query) q
    WHERE m.doc @@ q.query`);
  return new Map(rows.map((row) => [row.id, Number(row.rank) || 0]));
}

export type TurnMemories = { lines: string[]; selected: SelectedMemory[]; left: number };

/** The memories a turn is given (see the file's comment), each marked used. */
export async function memoriesForTurn(
  prisma: PrismaClient,
  input: { node: Owner; roomId: string | null; projectId: string | null; words: string; config: MemoryConfig; terms?: { max: number; prefixFrom: number }; now?: Date },
): Promise<TurnMemories> {
  const now = input.now ?? new Date();
  const rows = await prisma.nodeMemory.findMany({ where: { AND: [visibleTo(input.node, input.roomId, input.projectId), { supersededById: null, archivedAt: null }] }, orderBy: { updatedAt: "desc" }, take: 2_000 });
  if (!rows.length) return { lines: [], selected: [], left: 0 };
  const chosen: Array<{ row: NodeMemory; line: string; rank: number; why: SelectedMemory["why"] }> = [];
  let bytes = 0;
  const always = rows.filter((row) => row.pinned || row.scope === "owner").sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.getTime() - a.updatedAt.getTime());
  for (const row of always) {
    const line = memoryLine(row);
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + size > input.config.alwaysBytes) continue;
    chosen.push({ row, line, rank: 0, why: row.pinned ? "pinned" : "owner" });
    bytes += size;
  }
  const query = tsQuery(queryTerms(input.words, input.terms?.max ?? 16), input.terms?.prefixFrom ?? 6);
  const found = query ? await ranks(prisma, input.node, input.roomId, input.projectId, query) : new Map<string, number>();
  const best = Math.max(0, ...found.values());
  const taken = new Set(chosen.map((item) => item.row.id));
  const rest = rows
    .filter((row) => !taken.has(row.id))
    .map((row) => ({ row, rank: found.get(row.id) ?? 0 }))
    .filter((item) => input.config.minRank <= 0 || (best > 0 && item.rank / best >= input.config.minRank))
    .sort((a, b) => b.rank - a.rank || b.row.updatedAt.getTime() - a.row.updatedAt.getTime());
  const budget = input.config.budgetTokens * 4;
  // Each line goes in as "- <memory>" and a line break.
  let chars = chosen.reduce((sum, item) => sum + item.line.length + 3, 0);
  for (const item of rest) {
    const line = memoryLine(item.row);
    if (chars + line.length + 3 > budget) continue;
    chosen.push({ row: item.row, line, rank: item.rank, why: item.rank > 0 ? "relevant" : "recent" });
    chars += line.length + 3;
  }
  if (chosen.length) await prisma.nodeMemory.updateMany({ where: { id: { in: chosen.map((item) => item.row.id) } }, data: { lastUsedAt: now } });
  return {
    lines: chosen.map((item) => item.line),
    selected: chosen.map((item) => ({ id: item.row.id, scope: item.row.scope, key: item.row.key, pinned: item.row.pinned, rank: Math.round(item.rank * 10_000) / 10_000, why: item.why })),
    left: rows.length - chosen.length,
  };
}
