/**
 * Status cards (docs/35 §12): one per person per room, built by code from their missions for the room,
 * the tasks assigned to them in the room's shared space, their presence and the away status they set,
 * at the detail they choose (nothing, titles or details). A lead answers status questions from its
 * owner's card; `@leads status` posts every person's card at once, without a model turn.
 */
import type { FastifyInstance } from "fastify";
import type { NodeMessage, NodeRoom, Prisma, PrismaClient } from "@prisma/client";
import { openedSpace } from "../lib/auth.js";
import { sseHub } from "../lib/sse.js";
import { truncateText } from "../lib/text.js";
import { nodeChannel } from "./events.js";
import { missionEnded } from "./missions-core.js";
import { ledger } from "./plans.js";
import { postMessage } from "./store.js";
import { awayNow, prefsOf, publicTrust, trustFor, type Detail } from "./trust.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** A person counts as online with Node open, or after writing in the last few minutes. */
const ACTIVE_MS = 5 * 60_000;
/** Missions that ended this recently still show, with how they ended. */
const RECENT_MS = 3 * 86_400_000;
const OPEN_TASK = ["proposed", "todo", "in_progress", "blocked", "waiting_approval"] as const;

export type Presence = "online" | "away" | "offline";

export type StatusCard = {
  accountId: string;
  name: string;
  handle: string;
  lead: { nodeId: string; handle: string; name: string } | null;
  presence: Presence;
  away: { until: string | null; note: string | null } | null;
  /** How much this card shows to whoever reads it. */
  detail: Detail;
  /** The person asks to be asked before their status is shared: the card shows presence only. */
  asks: boolean;
  missions: Array<{ title: string; status: string; requirements?: Array<{ text: string; status: string }>; steps?: { done: number; total: number } }>;
  tasks: Array<{ title: string; status: string; due?: string | null }>;
};

/** Online: an open Node stream on this server, or a message written in the last few minutes. */
export async function online(db: Db, accountId: string): Promise<boolean> {
  if (sseHub.listeners(nodeChannel(accountId)) > 0) return true;
  const recent = await db.nodeMessage.findFirst({ where: { userId: accountId, authorKind: "human", createdAt: { gte: new Date(Date.now() - ACTIVE_MS) } }, select: { id: true } });
  return Boolean(recent);
}

/** Who reads a card: one person (the API, a private `@leads status`), or the whole room. */
export type CardView = { viewerId: string } | { room: true };

/** The room's bound shared space (C4 binds it), when the readers can all open it. */
async function boundSpace(db: Db, room: NodeRoom, readers: readonly string[]): Promise<string | null> {
  const spaceId = (room.settings as { spaceId?: unknown } | null)?.spaceId;
  if (typeof spaceId !== "string" || !spaceId) return null;
  for (const reader of readers) if (!(await openedSpace(reader, spaceId))) return null;
  return spaceId;
}

/** One person's card as `view` may see it. */
export async function statusCard(db: Db, room: NodeRoom, accountId: string, view: CardView): Promise<StatusCard | null> {
  const members = await db.nodeRoomMember.findMany({ where: { roomId: room.id, userId: accountId }, include: { node: { select: { id: true, name: true } } } });
  const person = members.find((row) => !row.nodeId);
  if (!person) return null;
  const people = (await db.nodeRoomMember.findMany({ where: { roomId: room.id, nodeId: null }, select: { userId: true } })).map((row) => row.userId);
  const user = await db.user.findUnique({ where: { id: accountId }, select: { name: true, email: true } });
  const prefs = prefsOf(person);
  const self = "viewerId" in view && view.viewerId === accountId;
  const trust = self ? null : "viewerId" in view ? trustFor(prefs, view.viewerId) : publicTrust(prefs, people.filter((id) => id !== accountId), null);
  const asks = trust?.status === "ask";
  const detail: Detail = self ? "details" : asks ? "nothing" : trust!.statusDetail;
  const away = awayNow(prefs);
  const lead = members.find((row) => row.nodeId && row.representative);
  const card: StatusCard = {
    accountId,
    name: user?.name?.trim() || user?.email.split("@")[0] || "Someone",
    handle: person.handle,
    lead: lead?.node ? { nodeId: lead.node.id, handle: lead.handle, name: lead.node.name } : null,
    presence: away ? "away" : (await online(db, accountId)) ? "online" : "offline",
    away: away ? { until: away.until, note: away.note } : null,
    detail,
    asks,
    missions: [],
    tasks: [],
  };
  if (detail === "nothing") return card;
  const missions = await db.nodeMission.findMany({
    where: {
      userId: accountId,
      AND: [
        { OR: [{ originRoomId: room.id }, { deliverTo: { path: ["roomId"], equals: room.id } }] },
        { OR: [{ status: { in: ["draft", "running", "reporting"] } }, { endedAt: { gte: new Date(Date.now() - RECENT_MS) } }] },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { steps: { select: { status: true, outcome: true, requirementIds: true, kind: true, attempts: true, id: true, after: true, verifies: true } } },
  });
  card.missions = missions.map((mission) => {
    const title = truncateText((mission.goal ?? "").trim() || "Work for this room", 160);
    const status = mission.status === "draft" ? "starting" : mission.status;
    if (detail !== "details") return { title, status };
    const requirements = ledger(
      (Array.isArray(mission.requirements) ? mission.requirements : []) as never,
      (Array.isArray(mission.deferred) ? mission.deferred : []) as never,
      mission.steps as never,
      missionEnded(mission.status),
    ).map((row) => ({ text: truncateText(row.text, 200), status: row.status }));
    return { title, status, requirements, steps: { done: mission.steps.filter((row) => row.status === "done").length, total: mission.steps.length } };
  });
  const spaceId = await boundSpace(db, room, "viewerId" in view ? [view.viewerId] : people);
  if (spaceId) {
    const tasks = await db.task.findMany({
      where: { userId: spaceId, assigneeAccountId: accountId, deletedAt: null, status: { in: [...OPEN_TASK] } },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { title: true, status: true, due: true },
    });
    card.tasks = tasks.map((row) => ({ title: truncateText(row.title, 160), status: row.status.replace(/_/g, " "), ...(detail === "details" ? { due: row.due?.toISOString().slice(0, 10) ?? null } : {}) }));
  }
  return card;
}

/** Every person's card in the room, as `view` may see them. */
export async function statusCards(db: Db, room: NodeRoom, view: CardView): Promise<StatusCard[]> {
  const people = await db.nodeRoomMember.findMany({ where: { roomId: room.id, nodeId: null }, orderBy: { joinedAt: "asc" }, select: { userId: true } });
  const cards = await Promise.all(people.map((row) => statusCard(db, room, row.userId, view)));
  return cards.filter((card): card is StatusCard => Boolean(card));
}

const presenceText = (card: StatusCard): string => {
  if (card.away) return `away${card.away.until ? ` until ${card.away.until.slice(11, 16)} UTC` : ""}${card.away.note ? `: ${card.away.note}` : ""}`;
  return card.presence;
};

/** The card as text: what a lead reads, and the fallback for the card message. */
export function cardText(card: StatusCard): string {
  const lines = [`${card.name} (${presenceText(card)})${card.lead ? `, lead @${card.lead.handle}` : ""}`];
  if (card.asks) lines.push("  - Asks to be asked before sharing status.");
  else if (card.detail === "nothing") lines.push("  - Shares no status here.");
  else if (!card.missions.length && !card.tasks.length) lines.push("  - Nothing in progress for this room.");
  for (const mission of card.missions) {
    const steps = mission.steps ? `, ${mission.steps.done}/${mission.steps.total} steps done` : "";
    lines.push(`  - ${mission.title} (${mission.status.replace(/_/g, " ")}${steps})`);
    for (const row of mission.requirements ?? []) lines.push(`    - ${row.text}: ${row.status.replace(/_/g, " ")}`);
  }
  for (const task of card.tasks) lines.push(`  - Task: ${task.title} (${task.status}${task.due ? `, due ${task.due}` : ""})`);
  return lines.join("\n");
}

/**
 * `@leads status`: one card message with every person's status, built by code. In public it shows what
 * everyone in the room may see; asked privately (My crew), what the asker may see, to the asker only.
 */
export async function postStatusCards(app: FastifyInstance, room: NodeRoom, message: NodeMessage): Promise<void> {
  const prisma = app.prisma;
  const visibleTo = message.visibleTo.length ? [message.userId] : [];
  const cards = await statusCards(prisma, room, visibleTo.length ? { viewerId: message.userId } : { room: true });
  await postMessage(prisma, {
    roomId: room.id,
    userId: message.userId,
    authorKind: "system",
    kind: "status",
    body: ["Status", ...cards.map(cardText)].join("\n"),
    data: { type: "status_cards", cards, replyTo: { id: message.id, seq: message.seq } } as unknown as Record<string, unknown>,
    visibleTo,
  });
}
