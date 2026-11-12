/**
 * Inline "Ask Ensemble" on an AI plan (docs/30 §8). Each page, task, project, deliverable or meeting
 * notes keeps one short-lived session of the person's own agent for each person who asks there. Asking
 * again on that page continues it: asks there are answered one after another in the order they were
 * made (`askInLine`), so an ask made while another is answering waits for it, and 30 minutes after the last answer the session is deleted
 * from the computer that ran it: the agent's own history and its folder, the way a deleted chat's
 * session goes (`dropChatSessions`). The 30 minutes are fixed; only the tier is a setting
 * (`assistant.askTier`). A computer that cannot delete on request yet drops it on its own a day later
 * (`ASK_KEEP_DAYS`).
 *
 * The pending sessions are kept per account in the preference `assistant.ask-sessions`, and the
 * scheduler's minute tick sweeps them (`sweepAskSessions`), so a restart does not forget one.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { dropChatSessions } from "./delete-chat.js";

const ASKS = "assistant.ask-sessions";
/** From the last answer until the session is deleted. */
export const ASK_IDLE_MS = 30 * 60_000;
/** An ask that never reported back (the server restarted while it answered): its session goes this long after it began. */
export const ASK_STUCK_MS = 2 * 3600_000;
/** What a computer without on-request deletion keeps the session for. */
export const ASK_KEEP_DAYS = 1;
const MAX_KEPT = 300;

/** `since`: when the page's current session took its first ask. */
type AskRecord = { kind: string; id: string; started: number; answered?: number; since?: number };
type Asks = Record<string, AskRecord>;

/** The page's session for this person: stable, and not the page's id (the agent's app shows it as a folder name). */
export function askSessionKey(actor: string, kind: string, id: string): string {
  const label = kind.replace(/[^a-z]/g, "").slice(0, 16) || "page";
  return `ask-${label}-${createHash("sha256").update(`${actor}\n${kind}\n${id}`).digest("hex").slice(0, 32)}`;
}

async function read(app: FastifyInstance, userId: string): Promise<Asks> {
  const row = await app.prisma.preference.findUnique({ where: { userId_key: { userId, key: ASKS } } });
  const value = row && !row.deletedAt ? row.value : null;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Asks) : {};
}

async function write(app: FastifyInstance, userId: string, asks: Asks): Promise<void> {
  const kept = Object.entries(asks)
    .sort(([, a], [, b]) => (b.answered ?? b.started) - (a.answered ?? a.started))
    .slice(0, MAX_KEPT);
  const value = Object.fromEntries(kept) as unknown as Prisma.InputJsonValue;
  await app.prisma.preference.upsert({
    where: { userId_key: { userId, key: ASKS } },
    create: { userId, key: ASKS, value, source: "system" },
    update: { value, deletedAt: null },
  });
}

/** One change at a time, so an ask that starts and the sweep do not undo each other. */
let queue: Promise<unknown> = Promise.resolve();
function change<T>(app: FastifyInstance, userId: string, edit: (asks: Asks) => T): Promise<T> {
  const next = queue.then(async () => {
    const asks = await read(app, userId);
    const result = edit(asks);
    await write(app, userId, asks);
    return result;
  });
  queue = next.catch(() => undefined);
  return next;
}

/** An ask began in this session: it stays at least until this one is answered. */
export function askStarted(app: FastifyInstance, userId: string, key: string, page: { kind: string; id: string }, now = Date.now()): Promise<void> {
  return change(app, userId, (asks) => {
    asks[key] = { ...asks[key], kind: page.kind, id: page.id, started: now, since: asks[key]?.since ?? now };
  });
}

/** The ask was answered (or failed): the 30 minutes start again from now. */
export function askAnswered(app: FastifyInstance, userId: string, key: string, now = Date.now()): Promise<void> {
  return change(app, userId, (asks) => {
    const record = asks[key];
    if (record) asks[key] = { ...record, answered: Math.max(now, record.started) };
  });
}

const HISTORY_ASKS = 8;
const HISTORY_CHARS = 12_000;

/**
 * The earlier asks and answers of the page's current session, oldest first: what a new session of the
 * agent is given when the page's one is gone (the person deleted it in the agent's app), so a follow-up
 * on the page still knows what came before. Empty for the session's first ask.
 */
export async function askHistory(app: FastifyInstance, userId: string, key: string, page: { kind: string; id: string; actor: string | null }): Promise<string> {
  const record = (await read(app, userId))[key];
  if (!record?.since) return "";
  const rows = await app.prisma.pageDiscussion.findMany({
    where: { userId, pageKind: page.kind, pageId: page.id, authorKind: "ensemble", authorAccountId: page.actor, deletedAt: null, status: "open", error: null, conversationId: { not: null }, createdAt: { gte: new Date(record.since) } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_ASKS,
    select: { conversationId: true, body: true },
  });
  if (!rows.length) return "";
  const asked = await app.prisma.assistantMessage.findMany({
    where: { conversationId: { in: rows.map((row) => row.conversationId!) }, role: "user" },
    orderBy: { createdAt: "asc" },
    select: { conversationId: true, content: true },
  });
  const question = new Map<string, string>();
  for (const message of asked) if (!question.has(message.conversationId)) question.set(message.conversationId, message.content);
  const turns = rows
    .reverse()
    .map((row) => {
      const answer = typeof (row.body as { text?: unknown } | null)?.text === "string" ? ((row.body as { text: string }).text).trim() : "";
      const q = question.get(row.conversationId!)?.trim() ?? "";
      return q && answer ? `Person: ${q}\n\nYou: ${answer}` : "";
    })
    .filter(Boolean);
  let text = turns.join("\n\n");
  if (text.length > HISTORY_CHARS) text = `…${text.slice(text.length - HISTORY_CHARS)}`;
  return text ? `Earlier asks on this page, oldest first:\n\n${text}` : "";
}

/** Whether a session is done with: 30 minutes past its last answer and no ask since, or an ask that never came back. */
export function askExpired(record: AskRecord, now = Date.now()): boolean {
  const waiting = record.answered === undefined || record.answered < record.started;
  if (waiting) return now - record.started >= ASK_STUCK_MS;
  return now - record.answered! >= ASK_IDLE_MS;
}

type Drop = (app: FastifyInstance, userId: string, key: string) => Promise<void>;

/** Asks waiting on each page, per person: the newest place in line. */
const lines = new Map<string, Promise<void>>();

/**
 * A place in line for an ask on one page by one person (`key`), taken as the request arrives. Asks there
 * are answered one after another in the order they were made, never two at once and never one ahead of
 * an earlier one: they share the page's agent session, and each may build on the answer before it.
 * `ready` resolves when every earlier ask has left; `leave` must be called once this ask is answered
 * (or gave up), whether or not its turn came.
 */
export function askInLine(key: string): { waiting: boolean; ready: Promise<void>; leave: () => void } {
  const before = lines.get(key);
  let done!: () => void;
  const mine = new Promise<void>((resolve) => (done = resolve));
  const through = (before ?? Promise.resolve()).then(() => mine);
  lines.set(key, through);
  return {
    waiting: Boolean(before),
    ready: before ?? Promise.resolve(),
    leave: () => {
      done();
      void through.then(() => {
        if (lines.get(key) === through) lines.delete(key);
      });
    },
  };
}

let sweeping = false;

/** Deletes every ask session whose time is up, from every account (the scheduler's minute tick). */
export async function sweepAskSessions(app: FastifyInstance, now = Date.now(), drop: Drop = dropChatSessions): Promise<number> {
  if (sweeping) return 0;
  sweeping = true;
  try {
    return await sweep(app, now, drop);
  } finally {
    sweeping = false;
  }
}

async function sweep(app: FastifyInstance, now: number, drop: Drop): Promise<number> {
  const rows = await app.prisma.preference.findMany({ where: { key: ASKS, deletedAt: null }, select: { userId: true, value: true } });
  let dropped = 0;
  for (const row of rows) {
    const value = row.value && typeof row.value === "object" && !Array.isArray(row.value) ? (row.value as Asks) : {};
    if (!Object.values(value).some((record) => askExpired(record, now))) continue;
    // Decided again inside the queue: an ask that just began on the page keeps its session.
    const due = await change(app, row.userId, (asks) => {
      const keys = Object.keys(asks).filter((key) => askExpired(asks[key]!, now));
      for (const key of keys) delete asks[key];
      return keys;
    });
    for (const key of due) {
      dropped += 1;
      await drop(app, row.userId, key).catch((error: unknown) => app.log.warn({ err: error }, "Could not delete an Ask Ensemble session"));
    }
  }
  return dropped;
}
