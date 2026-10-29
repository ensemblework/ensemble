/**
 * The agent session behind each assistant chat on this computer (docs/30 §8). One chat (its
 * conversation id, the turn's `session.key`) is one session of the person's own agent: Claude
 * Code's session, Codex's thread, Copilot's session or an ACP session. A new chat is a new
 * session. A session is reused only by the same agent and, where the agent keeps the instructions
 * from the first message, with the same instructions; otherwise the next turn starts a new one with
 * the chat so far.
 *
 * Kept in `<state>/assistant-sessions.json`. Each session works in its own folder,
 * `<state>/assistant/<key>`, since some agents (Claude Code) find a session by the folder it began
 * in. Sessions unused for 30 days are dropped with their folders.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SubscriptionProvider } from "@ensemble/shared-types";
import { stateDir } from "../remote/store.js";

export const SESSION_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;
const KEEP_MS = 30 * 24 * 3600_000;

/** `next`: how many messages the chat has after the session's last turn; a turn that ran elsewhere (another model or computer) moves the chat past it. */
type Entry = { agent: SubscriptionProvider; id: string; instructions: string; at: number; next?: number };
type Store = Record<string, Entry>;

const file = () => join(stateDir(), "assistant-sessions.json");
export const sessionFolder = (key: string) => join(stateDir(), "assistant", key);

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

/**
 * The session to resume for this chat: the same agent and, for an agent that keeps the instructions
 * from a session's first message, the same instructions. `perTurn`: the agent takes the
 * instructions with every turn (Claude Code's system prompt, Codex's base instructions), so changed
 * ones need no new session.
 */
export function findSession(key: string, agent: SubscriptionProvider, instructions: string, perTurn = false, position?: number): Promise<string | null> {
  return serial(async () => {
    const entry = (await read())[key];
    if (!entry || entry.agent !== agent || Date.now() - entry.at >= KEEP_MS) return null;
    if (!perTurn && entry.instructions !== instructionsHash(instructions)) return null;
    // The chat moved on without this session (a turn on another model or computer): it would miss those messages.
    if (position !== undefined && entry.next !== undefined && entry.next !== position) return null;
    return entry.id;
  });
}

/** Remembers the chat's session after a turn, and drops sessions unused for 30 days. */
export function saveSession(key: string, agent: SubscriptionProvider, id: string, instructions: string, next?: number): Promise<void> {
  return serial(async () => {
    const store = await read();
    const now = Date.now();
    for (const [other, entry] of Object.entries(store)) {
      if (other !== key && now - entry.at >= KEEP_MS) {
        delete store[other];
        await rm(sessionFolder(other), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    store[key] = { agent, id, instructions: instructionsHash(instructions), at: now, ...(next === undefined ? {} : { next }) };
    await write(store);
  });
}

/** Forgets a chat's session (it could not be reopened). */
export function forgetSession(key: string): Promise<void> {
  return serial(async () => {
    const store = await read();
    if (!(key in store)) return;
    delete store[key];
    await write(store);
  });
}
