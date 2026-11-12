/**
 * The agent session behind each assistant chat on this computer (docs/30 §8). One chat (its
 * conversation id, the turn's `session.key`) is one session of the person's own agent: Claude
 * Code's session, Codex's thread, Copilot's session or an ACP session. A new chat is a new
 * session. A session is reused only by the same agent. Where the agent keeps the instructions from
 * the first message (Copilot, Cursor's agent, the ACP agents), changed instructions do not start a new
 * session: the next message carries the lines that changed (`instructionsUpdate`); only instructions
 * that changed for the most part start a new one. A session that has run `ROTATE_MESSAGES` messages
 * starts over too, with the chat so far, as its history is re-sent on every request.
 *
 * Kept in `<state>/assistant-sessions.json`. Each session works in its own folder,
 * `<state>/assistant/<key>`, or its group's (a node's project folder, `folder` on the entry), since
 * some agents (Claude Code) find a session by the folder it began in and every agent's app groups its
 * sessions by folder. Sessions unused for 30 days (a node's: 7, `keepDays`) are dropped with their
 * folders and the agent's own history of them, and a session another one replaced is dropped at once.
 */
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SubscriptionProvider } from "@ensemble/shared-types";
import { stateDir } from "../remote/store.js";

export const SESSION_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;
const DAY_MS = 24 * 3600_000;
const KEEP_DAYS = 30;
/** A session that has carried this many messages of its chat starts over: every request re-sends its history. */
export const ROTATE_MESSAGES = 80;

/**
 * `next`: how many messages the chat has after the session's last turn; a turn that ran elsewhere
 * (another model or computer) moves the chat past it. `from`: where in the chat the session began.
 * `text`: the instructions it last had, to send only what changed. `folder`: its group's folder, when
 * not the chat's own. `keep`: days unused before it is dropped.
 */
/** `usage`: the session's token totals as its agent last reported them (Copilot reports the whole session's, not a turn's). */
/**
 * `prompts`: how many prompts the agent's own transcript held after Ensemble's last turn (session-touch.ts).
 * `retired`: earlier sessions of this chat that someone used outside Ensemble; they are no longer resumed,
 * and are deleted with the chat. `id` is empty when only those remain.
 */
type Entry = { agent: SubscriptionProvider; id: string; instructions: string; at: number; next?: number; from?: number; text?: string; folder?: string; keep?: number; usage?: SessionUsage; prompts?: number; retired?: string[] };
export type SessionUsage = { in: number; out: number };
type Store = Record<string, Entry>;

const file = () => join(stateDir(), "assistant-sessions.json");
export const sessionFolder = (key: string) => join(stateDir(), "assistant", key);
const keepMs = (entry: Pick<Entry, "keep">) => (entry.keep ?? KEEP_DAYS) * DAY_MS;

/** A short fingerprint of the instructions a session began with. */
export const instructionsHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

async function read(): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(file(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

async function write(store: Store): Promise<void> {
  const path = file();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(store), { mode: 0o600 });
  await rename(temporary, path);
}

/** What a turn may resume: the session, and the instructions it last had (an agent that keeps the first message's). */
export type Found = { id: string; text: string | null; usage?: SessionUsage; prompts?: number };

/**
 * The session to resume for this chat: the same agent, where the chat was when it last ran, and not
 * past `ROTATE_MESSAGES`. `perTurn`: the agent takes the instructions with every turn (Claude Code's
 * system prompt, Codex's base instructions). For the others, a session whose instructions the store
 * has as text is resumed with an update (`instructionsUpdate`); an older entry with only a hash, on a
 * changed hash, is not.
 */
export function findSession(key: string, agent: SubscriptionProvider, instructions: string, perTurn = false, position?: number): Promise<Found | null> {
  return serial(async () => {
    const entry = (await read())[key];
    if (!entry || !entry.id || entry.agent !== agent || Date.now() - entry.at >= keepMs(entry)) return null;
    // The chat moved on without this session (a turn on another model or computer): it would miss those messages.
    if (position !== undefined && entry.next !== undefined && entry.next !== position) return null;
    if (position !== undefined && position - (entry.from ?? 0) >= ROTATE_MESSAGES) return null;
    if (!perTurn && entry.instructions !== instructionsHash(instructions) && entry.text === undefined) return null;
    return { id: entry.id, text: perTurn ? null : (entry.text ?? null), ...(entry.usage ? { usage: entry.usage } : {}), ...(entry.prompts !== undefined ? { prompts: entry.prompts } : {}) };
  });
}

/** The line a message carries when the session's instructions changed; also what most-changed looks like. */
export const UPDATE_HEAD = "(Ensemble updated your standing instructions since this conversation began.";
const MAX_SHARE = 0.5;

/**
 * What to tell a resumed session whose instructions changed: the lines that are new and those that no
 * longer apply. Empty when nothing changed; null when most of them changed (a new session is better).
 */
export function instructionsUpdate(before: string, now: string): string | null {
  if (before === now) return "";
  const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
  const old = new Set(lines(before));
  const current = lines(now);
  const kept = new Set(current);
  const added = current.filter((line) => !old.has(line));
  const gone = [...old].filter((line) => !kept.has(line));
  if (!added.length && !gone.length) return "";
  const changed = added.join("").length + gone.join("").length;
  if (changed > MAX_SHARE * Math.max(1, now.length)) return null;
  return [
    `${UPDATE_HEAD} They still hold, with these changes.)`,
    added.length ? `Now part of them:\n${added.join("\n")}` : "",
    gone.length ? `No longer part of them:\n${gone.map((line) => (line.length > 160 ? `${line.slice(0, 159)}…` : line)).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** `retire`: the session this one replaces was used outside Ensemble: kept, unresumed, until the chat is deleted. */
export type SaveOptions = { next?: number; folder?: string; keepDays?: number; perTurn?: boolean; usage?: SessionUsage | null; prompts?: number | null; retire?: string };

/**
 * Remembers the chat's session after a turn, and drops sessions unused for their keeping days, and the
 * one this session replaced: the agent's own history of each too (its app no longer lists it), then
 * its folder when it is the chat's own.
 */
export async function saveSession(key: string, agent: SubscriptionProvider, id: string, instructions: string, options: SaveOptions | number = {}): Promise<void> {
  const opts: SaveOptions = typeof options === "number" ? { next: options } : options;
  const dropped = await serial(async () => {
    const store = await read();
    const now = Date.now();
    const old: Array<[string, Entry]> = [];
    for (const [other, entry] of Object.entries(store)) {
      if (other !== key && now - entry.at >= keepMs(entry)) {
        delete store[other];
        old.push([other, entry]);
      }
    }
    const before = store[key];
    const sameAgent = before?.agent === agent;
    const retiring = Boolean(before && sameAgent && opts.retire && before.id === opts.retire);
    // Another session took the chat's place: the old one would only clutter the agent's app (one used outside
    // Ensemble stays, unresumed, until the chat goes). Earlier retired sessions move to the new entry; on
    // another agent they go with the old one.
    if (before && !sameAgent) old.push([key, before]);
    else if (before && before.id && before.id !== id && !retiring) old.push([key, { ...before, retired: undefined }]);
    const retired = sameAgent ? [...(before?.retired ?? []), ...(retiring ? [before!.id] : [])].filter((one) => one && one !== id) : [];
    const continued = before && before.id === id;
    const from = continued ? before.from : opts.next === undefined ? undefined : Math.max(0, opts.next - 2);
    store[key] = {
      agent,
      id,
      instructions: instructionsHash(instructions),
      at: now,
      ...(opts.next === undefined ? {} : { next: opts.next }),
      ...(from === undefined ? {} : { from }),
      // An agent that keeps the first message's instructions: the text, to send only what changes.
      ...(opts.perTurn ? {} : { text: instructions }),
      ...(opts.folder ? { folder: opts.folder } : {}),
      ...(opts.keepDays ? { keep: opts.keepDays } : {}),
      ...(opts.usage ? { usage: opts.usage } : {}),
      ...(typeof opts.prompts === "number" ? { prompts: opts.prompts } : {}),
      ...(retired.length ? { retired } : {}),
    };
    await write(store);
    return old;
  });
  // After the turn's own write, and never failing it: an agent that cannot delete keeps its history.
  if (dropped.length) void dropNative(dropped);
}

type Drop = (agent: SubscriptionProvider, id: string, folder: string) => Promise<unknown>;
let dropForTests: Drop | null = null;
/** Tests see which sessions would be deleted from the agent, without the agent. */
export function setNativeDropForTests(drop: Drop | null): void {
  dropForTests = drop;
}

async function dropNative(entries: Array<[string, Entry]>): Promise<void> {
  const { deleteNativeSession } = dropForTests ? { deleteNativeSession: dropForTests } : await import("../workspace/engines/delete-session.js");
  for (const [key, entry] of entries) {
    for (const id of [entry.id, ...(entry.retired ?? [])]) if (id) await deleteNativeSession(entry.agent, id, entry.folder ?? sessionFolder(key)).catch(() => undefined);
    // A group's folder (a node's project) is shared: only a chat's own folder goes with it.
    if (!entry.folder) await rm(sessionFolder(key), { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * A one-off turn's own session (a quick call: triage, a summary, a title), deleted from the agent once the turn
 * is over, so the person's Copilot, Cursor or ACP agent does not fill up with them. Never fails the turn.
 * `folder`: where the turn ran, deleted after the session: Gemini CLI, OpenCode and Grok find a session by the
 * folder it began in, so the deletion runs there.
 */
export function dropOneOff(agent: SubscriptionProvider, id: string, folder?: string): void {
  void (async () => {
    const { deleteNativeSession } = dropForTests ? { deleteNativeSession: dropForTests } : await import("../workspace/engines/delete-session.js");
    await deleteNativeSession(agent, id, folder ?? tmpdir()).catch(() => undefined);
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  })().catch(() => undefined);
}

/**
 * Deletes a chat's session now, because the person deleted the chat: Ensemble's entry for it, the
 * agent's own history of it, and the chat's folder (never a group's). True when this computer had one.
 */
export async function dropSession(key: string): Promise<boolean> {
  if (!SESSION_KEY.test(key)) return false;
  const entry = await serial(async () => {
    const store = await read();
    const found = store[key];
    if (!found) return null;
    delete store[key];
    await write(store);
    return found;
  });
  if (entry) await dropNative([[key, entry]]);
  else await rm(sessionFolder(key), { recursive: true, force: true }).catch(() => undefined);
  return Boolean(entry);
}

/** Forgets a chat's session (it could not be reopened); its retired sessions stay listed for deletion with the chat. */
export function forgetSession(key: string): Promise<void> {
  return serial(async () => {
    const store = await read();
    const entry = store[key];
    if (!entry) return;
    if (entry.retired?.length) store[key] = { ...entry, id: "" };
    else delete store[key];
    await write(store);
  });
}
