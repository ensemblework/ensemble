/**
 * Page roles in a room's shared space (docs/35 §12.14; ensemble-node design C7, extension §17.2 and §17.3):
 *
 *   - A contract: the interface where two people's work meets. A change to it reaches every affected person
 *     once, privately, from their own lead: what changed, which of their open tasks it touches, and an offer
 *     to adapt. Nothing changes without them. Affected: its watchers, and the people whose open tasks on the
 *     board link it. Changes are seen in page edits; commits touching linked files are not watched yet.
 *   - The decisions log: a page a decision enters only when a person confirms it (✅ on a room message, or a
 *     reply “log this”). A decision that replaces one already logged links it.
 *
 * Code writes the log in the confirming person's own role; no model decides what is logged.
 */
import type { FastifyInstance } from "fastify";
import type { NodeMessage, NodeRoom, NodeRoomPage, Prisma, PrismaClient } from "@prisma/client";
import { markdownToNodes, PageDocument } from "@ensemble/shared-types";
import { sseHub } from "../lib/sse.js";
import { truncateText } from "../lib/text.js";
import { runInScope, type RequestScope } from "../sharing/context.js";
import { publishTo } from "./events.js";
import { addEvents, onWatchedPageEdited, type NewEvent } from "./room-events.js";
import { followedPage, linkedSpace, roleIn, RoomSpaceError } from "./room-space.js";
import { personIn, postMessage, roomPeople } from "./store.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const PAGE_ROLES = ["watched", "contract", "decisions"] as const;
export type PageRole = (typeof PAGE_ROLES)[number];

const nameOf = (row: { name: string | null; email: string } | null | undefined): string => row?.name?.trim() || row?.email.split("@")[0] || "Someone";
const canEdit = (role: string | null) => role === "owner" || role === "editor";

async function spaceOwnerOf(db: Db, spaceId: string): Promise<string | null> {
  const row = await db.user.findUnique({ where: { id: spaceId }, select: { id: true, ownerId: true } });
  return row ? (row.ownerId ?? row.id) : null;
}

/** The scope a person's own write in a space runs in: their role there, attributed to them. */
async function scopeOf(db: Db, accountId: string, spaceId: string): Promise<RequestScope | null> {
  const role = await roleIn(accountId, spaceId);
  if (!canEdit(role)) return null;
  const owner = await spaceOwnerOf(db, spaceId);
  return { spaceId, accountId, access: role === "owner" ? { kind: "owner" } : { kind: "member", role: "editor", ownerId: owner ?? spaceId } };
}

async function textOfPage(db: Db, spaceId: string, pageId: string): Promise<{ text: string; revision: number; title: string } | null> {
  const page = await db.taskPage.findFirst({ where: { id: pageId, userId: spaceId, deletedAt: null }, select: { content: true, revision: true, title: true, notesSnapshot: true } });
  if (!page) return null;
  const { pageText } = await import("../pages/markdown.js");
  const parsed = PageDocument.safeParse(page.content);
  return { text: pageText(parsed.success ? parsed.data : null, page.notesSnapshot ?? ""), revision: page.revision, title: page.title || "Untitled" };
}

/**
 * A person who can edit the room's space gives one of its pages a role: `contract` (its changes reach the
 * people whose work uses it), `decisions` (the room's decisions log; one per room), or back to `watched`.
 * Every change of role needs edit rights and says so in the room; following a page is `watchPage`.
 */
export async function setPageRole(app: FastifyInstance, room: NodeRoom, accountId: string, pageId: string, role: PageRole): Promise<void> {
  const prisma = app.prisma;
  const page = await followedPage(app, room, accountId, pageId);
  if (!canEdit(await roleIn(accountId, page.spaceId))) throw new RoomSpaceError("Only people who can edit the room's space change its pages' roles. To follow a page, watch it.", 403);
  const current = await textOfPage(prisma, page.spaceId, page.pageId);
  if (!current) throw new RoomSpaceError("That page is not in the room's space.", 404);
  const before = (await prisma.nodeRoomPage.findUnique({ where: { roomId_pageId: { roomId: room.id, pageId: page.pageId } }, select: { role: true } }))?.role ?? "watched";
  await prisma.$transaction(async (tx) => {
    if (role === "decisions") {
      // One decisions log per room: the old one is only watched now.
      await tx.nodeRoomPage.updateMany({ where: { roomId: room.id, role: "decisions", pageId: { not: page.pageId } }, data: { role: "watched" } });
    }
    await tx.nodeRoomPage.upsert({
      where: { roomId_pageId: { roomId: room.id, pageId: page.pageId } },
      create: { roomId: room.id, spaceId: page.spaceId, pageId: page.pageId, role, createdBy: accountId, watchers: role === "contract" ? [accountId] : [], seenRevision: current.revision, seenText: current.text },
      update: { role, seenRevision: current.revision, seenText: current.text },
    });
  });
  if (role !== before) {
    const who = nameOf(await prisma.user.findUnique({ where: { id: accountId }, select: { name: true, email: true } }));
    const was = before === "contract" ? "a contract" : "this room's decisions log";
    await postMessage(prisma, {
      roomId: room.id,
      userId: accountId,
      authorKind: "system",
      kind: "status",
      body:
        role === "contract"
          ? `${who} marked “${current.title}” as a contract: when it changes, the people whose work uses it hear from their leads.`
          : role === "decisions"
            ? `${who} made “${current.title}” this room's decisions log: decisions enter it when someone confirms them (✅, or a reply “log this”).`
            : `${who} made “${current.title}” an ordinary page again: it is no longer ${was}.`,
      data: { pageRole: { pageId: page.pageId, spaceId: page.spaceId, role, ...(role === "watched" ? { was: before } : {}) } },
    });
  }
  publishTo(await roomPeople(prisma, room.id), "node.room", { roomId: room.id });
}

// ── contracts ───────────────────────────────────────────────────────────────────────────────

/** Lines added and removed between two versions of a page's text, a few of each. */
export function textDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
  const old = lines(before);
  const now = lines(after);
  const had = new Set(old);
  const has = new Set(now);
  return {
    added: now.filter((line) => !had.has(line)).slice(0, 6).map((line) => truncateText(line, 160)),
    removed: old.filter((line) => !has.has(line)).slice(0, 6).map((line) => truncateText(line, 160)),
  };
}

/**
 * A contract page changed: each affected person (its watchers, and whoever's open tasks on the board link
 * it) gets one event with what changed and their tasks it touches. The editor hears nothing of their own edit.
 */
async function contractEdited(app: FastifyInstance, page: Pick<NodeRoomPage, "roomId" | "spaceId" | "pageId" | "role" | "watchers">, edit: { revision: number; editorAccountId: string | null; editorNodeId: string | null }): Promise<void> {
  if (page.role !== "contract") return;
  const prisma = app.prisma;
  const row = await prisma.nodeRoomPage.findUnique({ where: { roomId_pageId: { roomId: page.roomId, pageId: page.pageId } } });
  const current = await textOfPage(prisma, page.spaceId, page.pageId);
  if (!row || !current) return;
  const diff = textDiff(row.seenText ?? "", current.text);
  // Only the latest reader moves it on: a second scan of the same edit finds nothing new.
  const moved = await prisma.nodeRoomPage.updateMany({ where: { id: row.id, seenRevision: row.seenRevision }, data: { seenRevision: current.revision, seenText: current.text } });
  if (!moved.count || (!diff.added.length && !diff.removed.length)) return;
  const owner = await spaceOwnerOf(prisma, page.spaceId);
  const editor = edit.editorAccountId ?? owner;
  const people = new Set(await roomPeople(prisma, page.roomId));
  // Open tasks on the board that link the contract (its id on their page, description or notes).
  const linking = await prisma.task.findMany({
    where: { userId: page.spaceId, deletedAt: null, status: { notIn: ["done", "dropped"] }, OR: [{ description: { contains: page.pageId } }, { notes: { contains: page.pageId } }] },
    select: { id: true, title: true, owner: true, assigneeAccountId: true },
    take: 200,
  });
  const pagesLinking = await prisma.taskPage.findMany({ where: { userId: page.spaceId, deletedAt: null, taskId: { not: null } }, select: { taskId: true, content: true }, take: 500 });
  const linked = new Set(pagesLinking.filter((row) => JSON.stringify(row.content ?? {}).includes(page.pageId)).map((row) => row.taskId!));
  const tasks = [...linking, ...(linked.size ? await prisma.task.findMany({ where: { id: { in: [...linked] }, userId: page.spaceId, deletedAt: null, status: { notIn: ["done", "dropped"] } }, select: { id: true, title: true, owner: true, assigneeAccountId: true } }) : [])];
  const byPerson = new Map<string, Array<{ taskId: string; title: string }>>();
  for (const task of tasks) {
    if (task.owner !== "me") continue;
    const holder = task.assigneeAccountId ?? owner;
    if (!holder) continue;
    const list = byPerson.get(holder) ?? [];
    if (!list.some((row) => row.taskId === task.id)) list.push({ taskId: task.id, title: task.title });
    byPerson.set(holder, list);
  }
  const affected = new Set([...row.watchers, ...byPerson.keys()]);
  const events: NewEvent[] = [];
  for (const person of affected) {
    if (!people.has(person) || person === editor) continue;
    if (!(await roleIn(person, page.spaceId))) continue;
    events.push({
      roomId: page.roomId,
      userId: person,
      kind: "contract_changed",
      spaceId: page.spaceId,
      subjectKind: "page",
      subjectId: page.pageId,
      title: current.title,
      actorAccountId: editor,
      actorNodeId: edit.editorNodeId,
      data: { revision: current.revision, diff, tasks: byPerson.get(person) ?? [] },
      dedupeKey: `contract:${page.pageId}:${current.revision}`,
    });
  }
  await addEvents(prisma, events);
}

let watching = false;
/** Contracts follow their page edits through the room's events (node/room-events.ts). */
export function watchRoomPages(): void {
  if (watching) return;
  watching = true;
  onWatchedPageEdited((app, page, edit) => contractEdited(app, page, edit));
}

// ── the decisions log ───────────────────────────────────────────────────────────────────────

const decisionText = (message: Pick<NodeMessage, "body">): string =>
  truncateText(
    message.body
      .replace(/^\s*shall i log:?\s*/i, "")
      .replace(/\?\s*$/, "")
      .trim(),
    500,
  );

/** The room's decisions log page, made on first use by the person confirming (in their own role). */
async function decisionsPage(app: FastifyInstance, room: NodeRoom, spaceId: string, scope: RequestScope): Promise<string> {
  const prisma = app.prisma;
  const marked = await prisma.nodeRoomPage.findFirst({ where: { roomId: room.id, spaceId, role: "decisions" } });
  if (marked && (await prisma.taskPage.findFirst({ where: { id: marked.pageId, userId: spaceId, deletedAt: null }, select: { id: true } }))) return marked.pageId;
  const { createStandalonePage } = await import("../pages/store.js");
  const { markdownPage } = await import("../assistant/tools/pages.js");
  const page = await runInScope(scope, () =>
    prisma.$transaction((tx) => createStandalonePage(tx, spaceId, { title: `Decisions — ${room.title}`, content: markdownPage("Decisions this room confirmed, newest last."), sourceFileId: null })),
  );
  sseHub.publish(spaceId, { event: "page", data: { id: page.id, action: "create" } });
  await prisma.nodeRoomPage.upsert({
    where: { roomId_pageId: { roomId: room.id, pageId: page.id } },
    create: { roomId: room.id, spaceId, pageId: page.id, role: "decisions", createdBy: scope.accountId },
    update: { role: "decisions" },
  });
  return page.id;
}

async function privateLine(app: FastifyInstance, roomId: string, accountId: string, body: string): Promise<void> {
  await postMessage(app.prisma, { roomId, userId: accountId, authorKind: "system", kind: "status", body, visibleTo: [accountId] });
}

/**
 * A person confirms a room message as a decision (✅ on it, or a reply “log this”): it is written to the
 * decisions log in their own role, once. If the message replies to a logged decision, or says it replaces
 * one (“replaces #12”), the new entry links the old.
 */
export async function confirmDecision(app: FastifyInstance, message: NodeMessage, accountId: string): Promise<void> {
  const prisma = app.prisma;
  const room = await prisma.nodeRoom.findUnique({ where: { id: message.roomId } });
  if (!room || room.archivedAt || room.kind !== "room") return;
  if (message.visibleTo.length || message.kind !== "text" || (message.data as { deleted?: unknown } | null)?.deleted) return;
  if (!(await personIn(prisma, room.id, accountId))) return;
  if (await prisma.nodeRoomDecision.findUnique({ where: { roomId_messageId: { roomId: room.id, messageId: message.id } } })) return;
  const spaceId = await linkedSpace(app, room);
  if (!spaceId) return privateLine(app, room.id, accountId, "This room has no shared space to keep its decisions log in. Link one first.");
  const scope = await scopeOf(prisma, accountId, spaceId);
  if (!scope) return privateLine(app, room.id, accountId, "Only people who can edit the room's space log decisions in it.");
  const text = decisionText(message);
  if (!text) return;
  const pageId = await decisionsPage(app, room, spaceId, scope);
  // What it replaces: the logged decision it replies to, or one it names (“replaces #12”).
  const replyTo = (message.data as { replyTo?: { id?: unknown } } | null)?.replyTo?.id;
  const named = /(?:replaces|supersedes)\s+#(\d+)/i.exec(message.body)?.[1];
  const target = typeof replyTo === "string" ? replyTo : named ? (await prisma.nodeMessage.findFirst({ where: { roomId: room.id, seq: Number(named) }, select: { id: true } }))?.id : null;
  const old = target ? await prisma.nodeRoomDecision.findUnique({ where: { roomId_messageId: { roomId: room.id, messageId: target } } }) : null;
  const users = await prisma.user.findMany({ where: { id: { in: [message.userId, accountId, ...(old ? [old.saidBy] : [])] } }, select: { id: true, name: true, email: true } });
  const name = (id: string) => nameOf(users.find((row) => row.id === id));
  const day = new Date().toISOString().slice(0, 10);
  const entry =
    `- **${day}** — ${text} (${name(message.userId)} in “${room.title}”, #${message.seq}; confirmed by ${name(accountId)})` +
    (old ? `. Replaces the decision of ${old.createdAt.toISOString().slice(0, 10)}: “${truncateText(old.text, 200)}”` : "");
  const decision = await prisma.nodeRoomDecision
    .create({ data: { roomId: room.id, spaceId, pageId, messageId: message.id, text, saidBy: message.userId, loggedBy: accountId, supersedesId: old?.id ?? null } })
    .catch((error: unknown) => {
      // Confirmed twice at once: the first wins.
      if ((error as { code?: string }).code === "P2002") return null;
      throw error;
    });
  if (!decision) return;
  const { writePageContent } = await import("../pages/store.js");
  await runInScope(scope, () =>
    prisma.$transaction((tx) =>
      writePageContent(tx, spaceId, { pageId }, (current) => ({ content: { type: "doc", content: [...(current.content?.content ?? []), ...markdownToNodes(entry)] } as PageDocument })),
    ),
  );
  sseHub.publish(spaceId, { event: "page", data: { id: pageId, action: "save" } });
  await postMessage(prisma, {
    roomId: room.id,
    userId: accountId,
    authorKind: "system",
    kind: "status",
    body: `${name(accountId)} logged a decision: “${truncateText(text, 300)}”${old ? " It replaces an earlier one." : ""}`,
    data: { type: "decision_logged", decisionId: decision.id, messageId: message.id, pageId, spaceId, text, ...(old ? { supersedes: { decisionId: old.id, messageId: old.messageId } } : {}) },
  });
}

/** The room's logged decisions, newest first, for people who can open its space. */
export async function roomDecisions(app: FastifyInstance, room: NodeRoom, viewerId: string) {
  const prisma = app.prisma;
  const spaceId = await linkedSpace(app, room);
  if (!spaceId || !(await roleIn(viewerId, spaceId))) return [];
  const rows = await prisma.nodeRoomDecision.findMany({ where: { roomId: room.id, spaceId }, orderBy: { createdAt: "desc" }, take: 200 });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => [row.saidBy, row.loggedBy]))] } }, select: { id: true, name: true, email: true } });
  const name = (id: string) => nameOf(users.find((row) => row.id === id));
  const replaced = new Set(rows.map((row) => row.supersedesId).filter(Boolean));
  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    messageId: row.messageId,
    pageId: row.pageId,
    saidBy: { accountId: row.saidBy, name: name(row.saidBy) },
    loggedBy: { accountId: row.loggedBy, name: name(row.loggedBy) },
    supersedesId: row.supersedesId,
    replaced: replaced.has(row.id),
    at: row.createdAt.toISOString(),
  }));
}
