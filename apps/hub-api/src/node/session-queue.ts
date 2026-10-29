/**
 * Ensemble Node's view of the agent sessions it manages (docs/35 §8.9): a session's state, the run on its
 * computer and its queue in order, as the session card shows them (`data.session` on the session's run
 * cards) and the session routes return them; and the record of what was done to a session
 * (`node_session_events`: queued, steered, replaced, stopped, reordered, taken out, a question answered,
 * a watchdog attention), from the node's tools, its owner's card or the watchdog. The node's work board
 * reads that record, so the node always knows what its owner did on the card.
 */
import type { NodeSessionEvent, Prisma, PrismaClient } from "@prisma/client";
import { ENGINE_LABELS, isCodeEngine } from "@ensemble/shared-types";
import { liveOrder, resolveSession, runsOfSession, type AgentSession, type SessionRun, type SessionScope } from "../workspace/sessions.js";
import { announce } from "./store.js";

export type SessionState = "working" | "waiting" | "queued" | "idle";
export type QueueItem = { jobId: string; title: string; prompt: string | null; position: number };
export type RunningItem = { jobId: string; title: string; prompt: string | null; status: string };

/** A session as its routes return it (`GET /api/node/sessions/:id`, without `runs`). */
export type SessionSnapshot = {
  id: string;
  /** The node that manages it (the node of its first node run); null when none does yet. */
  nodeId: string | null;
  status: SessionState;
  /** The agent's id (claude-code, copilot-cli, …). */
  agent: string;
  agentName: string;
  /** The model its latest run asked for; null: the agent's own default. */
  model: string | null;
  computer: string | null;
  folder: string;
  /** The current message: the run on the computer, or the session's first run while it waits to start. */
  running: RunningItem | null;
  /** The messages queued after it, in the order they start. */
  queue: QueueItem[];
};

const ON_COMPUTER = new Set(["claimed", "running", "waiting_approval", "stopping"]);
const scopeOf = (accountId: string): SessionScope => ({ space: accountId, runner: null });

/** The node that manages each session: the node of the session's first node run. Sessions no node manages are missing. */
export async function sessionOwners(prisma: PrismaClient, accountId: string, sessionIds: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (!sessionIds.length) return owners;
  const rows = await prisma.nodeRun.findMany({
    where: { userId: accountId, OR: [{ sessionId: { in: sessionIds } }, { sessionId: null, jobId: { in: sessionIds } }] },
    orderBy: { createdAt: "asc" },
    select: { sessionId: true, jobId: true, nodeId: true },
  });
  for (const row of rows) {
    const id = row.sessionId ?? row.jobId;
    if (!owners.has(id)) owners.set(id, row.nodeId);
  }
  return owners;
}

/** What the node or its owner asked each run to do (`node_runs.prompt`). */
async function promptsOf(prisma: PrismaClient, jobIds: string[]): Promise<Map<string, string | null>> {
  if (!jobIds.length) return new Map();
  const rows = await prisma.nodeRun.findMany({ where: { jobId: { in: jobIds } }, select: { jobId: true, prompt: true } });
  return new Map(rows.map((row) => [row.jobId, row.prompt]));
}

/** The session's state from its live runs in order: on the computer (working or waiting on Needs me), queued, or idle. */
export function sessionState(order: ReadonlyArray<Pick<SessionRun, "status">>): SessionState {
  const first = order[0];
  if (!first) return "idle";
  if (first.status === "waiting_approval") return "waiting";
  return ON_COMPUTER.has(first.status) ? "working" : "queued";
}

export type SessionView = { session: AgentSession; runs: SessionRun[]; snapshot: SessionSnapshot };

/** A session of the account (by its id or any run in it), with its runs and its snapshot. Null when it is not theirs. */
export async function sessionSnapshot(prisma: PrismaClient, accountId: string, id: string): Promise<SessionView | null> {
  const session = await resolveSession(prisma, scopeOf(accountId), id);
  if (!session) return null;
  const runs = await runsOfSession(prisma, scopeOf(accountId), session.id);
  const order = liveOrder(runs, session.id);
  const prompts = await promptsOf(prisma, order.map((row) => row.id));
  const head = order[0];
  const current = head && (ON_COMPUTER.has(head.status) || head.id === session.id) ? head : null;
  const queued = order.filter((row) => row.status === "queued" && row.id !== current?.id);
  const owner = (await sessionOwners(prisma, accountId, [session.id])).get(session.id) ?? null;
  return {
    session,
    runs,
    snapshot: {
      id: session.id,
      nodeId: owner,
      status: sessionState(order),
      agent: session.agent,
      agentName: session.agentName,
      model: session.model && session.model !== "default" ? session.model : null,
      computer: session.computer,
      folder: session.folder,
      running: current ? { jobId: current.id, title: current.title, prompt: prompts.get(current.id) ?? null, status: current.status } : null,
      queue: queued.map((row, index) => ({ jobId: row.id, title: row.title, prompt: prompts.get(row.id) ?? null, position: index + 1 })),
    },
  };
}

/** The session as its run cards carry it (`data.session`): `agent` is the name shown, as on the run card. */
export function cardSession(snapshot: SessionSnapshot): Record<string, unknown> {
  const label = isCodeEngine(snapshot.agent) ? ENGINE_LABELS[snapshot.agent] : snapshot.agentName;
  return { ...snapshot, agent: label, agentId: snapshot.agent, updatedAt: new Date().toISOString() };
}

/** JSON with object keys sorted: the database keeps JSON keys in its own order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : item,
  );
}

const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
/** A session snapshot compared without its timestamp: only a real change is written. */
const withoutStamp = (value: unknown) => (value && typeof value === "object" ? { ...(value as Record<string, unknown>), updatedAt: null } : value);

/**
 * Merges `patch` into a card's data in one statement (`data || patch`), so writers of other fields
 * (the run watcher's status, the device's evidence) are never overwritten, then tells the room.
 * Nothing is written when the card already says it.
 */
export async function patchCard(prisma: PrismaClient, messageId: string, patch: Record<string, unknown>): Promise<boolean> {
  const card = await prisma.nodeMessage.findUnique({ where: { id: messageId }, select: { data: true } });
  if (!card) return false;
  const data = (card.data ?? {}) as Record<string, unknown>;
  const fresh = Object.entries(patch).filter(([key, value]) => (key === "session" ? !same(withoutStamp(data.session), withoutStamp(value)) : !same(data[key], value)));
  if (!fresh.length) return false;
  const changed = await prisma.$executeRaw`UPDATE node_messages SET data = data || ${JSON.stringify(Object.fromEntries(fresh))}::jsonb WHERE id = ${messageId}`;
  if (!changed) return false;
  const next = await prisma.nodeMessage.findUnique({ where: { id: messageId } });
  if (next) await announce(prisma, next, "node.message.updated");
  return true;
}

/**
 * Brings `data.session` up to date on the session's run cards: those whose runs have not ended, and its
 * newest one. Called after every action on the session and by the run watcher as runs go.
 */
export async function refreshSessionCards(prisma: PrismaClient, accountId: string, sessionId: string): Promise<SessionSnapshot | null> {
  const view = await sessionSnapshot(prisma, accountId, sessionId);
  if (!view) return null;
  const root = view.session.id;
  const runs = await prisma.nodeRun.findMany({
    where: { userId: accountId, OR: [{ sessionId: root }, { sessionId: null, jobId: root }] },
    orderBy: { createdAt: "desc" },
    select: { messageId: true, reportedAt: true },
    take: 200,
  });
  const cards = new Set(runs.filter((row, index) => row.messageId && (index === 0 || !row.reportedAt)).map((row) => row.messageId!));
  const data = cardSession(view.snapshot);
  for (const messageId of cards) await patchCard(prisma, messageId, { session: data });
  return view.snapshot;
}

export type SessionAction = "queue" | "steer" | "replace" | "stop" | "reorder" | "cancel" | "answer" | "attention" | "adopt";
export type SessionActor = "owner" | "node" | "watchdog";
export type SessionVia = "chat" | "card" | "watchdog";

/** Records what was done to a session, for the node's work board. */
export async function recordSessionEvent(
  prisma: PrismaClient,
  event: { userId: string; nodeId: string; sessionId: string; jobId?: string | null; action: SessionAction; actor: SessionActor; via: SessionVia; detail?: Record<string, unknown> },
): Promise<void> {
  await prisma.nodeSessionEvent.create({
    data: {
      userId: event.userId,
      nodeId: event.nodeId,
      sessionId: event.sessionId,
      jobId: event.jobId ?? null,
      action: event.action,
      actor: event.actor,
      via: event.via,
      detail: (event.detail ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/** What was done to a node's sessions, newest first: for its work board ("your owner steered … from the card"). */
export async function sessionEvents(prisma: PrismaClient, nodeId: string, options: { since?: Date; sessionId?: string; limit?: number } = {}): Promise<NodeSessionEvent[]> {
  return prisma.nodeSessionEvent.findMany({
    where: { nodeId, ...(options.sessionId ? { sessionId: options.sessionId } : {}), ...(options.since ? { createdAt: { gt: options.since } } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(options.limit ?? 50, 200)),
  });
}

/** One line per event, for a node's work board. */
export function sessionEventLine(event: Pick<NodeSessionEvent, "action" | "actor" | "via" | "detail" | "createdAt">): string {
  const who = event.actor === "owner" ? "Your owner" : event.actor === "watchdog" ? "The watchdog" : "You";
  const from = event.via === "card" ? " from the session card" : "";
  const detail = (event.detail ?? {}) as { title?: string; note?: string; source?: string };
  const what: Record<string, string> = {
    queue: `queued “${detail.title ?? "a message"}”`,
    steer: `steered the run going on${detail.title ? ` (“${detail.title}”)` : ""}`,
    replace: `replaced what the session was doing with “${detail.title ?? "a new message"}”`,
    stop: "stopped the session",
    reorder: "reordered the session's queue",
    cancel: `took “${detail.title ?? "a message"}” out of the queue`,
    answer: `answered the agent's question from ${detail.source ?? "the mission"}`,
    attention: `raised: ${detail.note ?? "attention"}`,
    adopt: "took the session over",
  };
  return `${who} ${what[event.action] ?? event.action}${from} (${event.createdAt.toISOString()}).`;
}
