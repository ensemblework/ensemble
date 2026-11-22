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
 * Kept in `<state>/assistant-sessions.json`. Each session works in its own folder, named after its
 * chat (`<state>/assistant/<title-slug>-<short id>`, `dir` on the entry; `<state>/assistant/<key>` for
 * a chat whose session began before chats were named), or its group's (a node's project folder, `folder`
 * on the entry), since some agents (Claude Code, Gemini CLI, OpenCode, Grok Build) find a session by the
 * folder it began in and every agent's app groups its sessions by folder. So a chat's folder takes a new
 * name only while no session of the chat began there (`chatFolder`). Sessions unused for 30 days (a
 * node's: 7, `keepDays`) are dropped with their folders and the agent's own history of them, and a
 * session another one replaced is dropped at once. A turn notes its session before the agent has the
 * message (`takeSession`), so when this computer restarts mid-turn, the turn goes on in that session.
 *
 * Grok Build, Kimi Code and Mistral Vibe keep a session in their home folder, and a turn someone other than the
 * person can steer runs them in Ensemble's home for them (`othersHome`): a session goes on only in the home it
 * was made in (`home` on the entry). A turn in the other home starts a new session there, and the earlier one is
 * kept with the chat's retired sessions, to be deleted with the chat from whichever home holds it.
 */
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
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
 * not the chat's own. `keep`: days unused before it is dropped. `dir`: the chat's own folder in
 * `<state>/assistant`, when not its key.
 */
/** `usage`: the session's token totals as its agent last reported them (Copilot reports the whole session's, not a turn's). */
/**
 * `prompts`: how many prompts the agent's own transcript held after Ensemble's last turn (session-touch.ts).
 * `retired`: earlier sessions of this chat that could not be reopened though the agent still has them (before
 * 0.8.0, also those someone used outside Ensemble; now what they said there is brought in and the session goes
 * on, subscriptions/outside.ts); they are no longer resumed, and are deleted with the chat. `id` is empty when
 * only those remain, or when the chat has a folder and no session yet.
 * `taking`: the session a turn here began in, noted before the agent had the message (`takeSession`) and replaced
 * when the turn ends; left only when this computer's runtime stopped mid-turn (`lookSession`).
 */
type Entry = { agent: SubscriptionProvider; id: string; instructions: string; at: number; next?: number; from?: number; text?: string; folder?: string; keep?: number; usage?: SessionUsage; prompts?: number; retired?: string[]; dir?: string; home?: SessionHome; taking?: Taking };
/** `position`: the turn's place in the chat; `text`: the instructions it began with, for an agent that keeps the first message's; `home`: where it was made. */
type Taking = { agent: SubscriptionProvider; id: string; position?: number; at: number; instructions: string; text?: string; home?: SessionHome };
export type SessionUsage = { in: number; out: number };
/** The home a session was made in, for an agent that keeps sessions there: the person's own, or Ensemble's for turns others can steer. */
export type SessionHome = "own" | "others";
type Store = Record<string, Entry>;

const file = () => join(stateDir(), "assistant-sessions.json");
export const sessionFolder = (key: string) => join(stateDir(), "assistant", key);
/** The name of the chat's own folder: the one named for it (a plain name, never a path), else its key. */
const dirOf = (key: string, entry?: Pick<Entry, "dir">) => (entry?.dir && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(entry.dir) ? entry.dir : key);
const ownFolder = (key: string, entry?: Pick<Entry, "dir">) => join(stateDir(), "assistant", dirOf(key, entry));
const keepMs = (entry: Pick<Entry, "keep">) => (entry.keep ?? KEEP_DAYS) * DAY_MS;
/**
 * When the chat last used a session here: its last turn's end, or a turn's start noted since (`takeSession`), which
 * may run in a new session while the entry still has the expired one's time. The entry's own time stays its last
 * turn's, so a turn that takes its note back leaves an expired session as old as it was.
 */
const usedAt = (entry: Pick<Entry, "at" | "taking">) => Math.max(entry.at, entry.taking?.at ?? 0);

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

function withoutTaking(entry: Entry): Entry {
  const { taking: _taking, ...rest } = entry;
  return rest;
}

/**
 * What a turn may resume: the session, and the instructions it last had (an agent that keeps the first message's).
 * `home`: where it was made, when the store knows (an entry from before homes were kept has none).
 */
export type Found = { id: string; text: string | null; usage?: SessionUsage; prompts?: number; home?: SessionHome };

/**
 * The session to resume for this chat: the same agent, the chat not past where it left it, and not
 * past `ROTATE_MESSAGES`. `perTurn`: the agent takes the instructions with every turn (Claude Code's
 * system prompt, Codex's base instructions). For the others, a session whose instructions the store
 * has as text is resumed with an update (`instructionsUpdate`); an older entry with only a hash, on a
 * changed hash, is not.
 */
export async function findSession(key: string, agent: SubscriptionProvider, instructions: string, perTurn = false, position?: number): Promise<Found | null> {
  return (await lookSession(key, agent, instructions, perTurn, position)).found;
}

/**
 * Why the chat's session of this agent is not resumed (workspace/engines/session-restart.ts): unused for its
 * keeping days (`expired`), the chat moved on without it (`moved`), past `ROTATE_MESSAGES` (`rotated`), an
 * older entry's instructions changed (`instructions`), or it was made in the other home (`audience`: the turn
 * is one someone else can steer and the session the person's own, or the other way round). A session ahead of
 * the chat is resumed: it took an exchange the chat keeps as failed (the agent answered, and the turn failed
 * after), so it misses nothing.
 */
export type Declined = "expired" | "moved" | "rotated" | "instructions" | "audience";

/**
 * The chat's session as a turn here left it when this computer's runtime stopped mid-turn (it restarted, `taking`):
 * nothing after was saved, so the session that took that turn, past its message, is the one the turn's continuation
 * and the chat's next turn go on in. How many prompts it holds is not known, so nothing in it is brought in as said
 * in the agent's own app (outside.ts).
 */
function cutOff(entry: Entry, taking: Taking): Entry {
  const rest = withoutTaking(entry);
  const same = taking.id === rest.id && taking.agent === rest.agent;
  return {
    ...rest,
    agent: taking.agent,
    id: taking.id,
    instructions: taking.instructions,
    at: taking.at,
    next: taking.position === undefined ? rest.next : taking.position + 2,
    from: same ? rest.from : taking.position,
    text: taking.text,
    usage: same ? rest.usage : undefined,
    prompts: undefined,
    // The home the session that took the turn was made in; unknown for a note from before homes were kept.
    home: taking.home ?? (same ? rest.home : undefined),
  };
}

/**
 * `findSession`, and why the chat's session of this agent is not resumed when it has one. `followUp`: another
 * message of the turn at `position` (`resume: "only"`), which only the session that took that turn may take.
 * `home`: the home the turn runs the agent in, for an agent that keeps sessions there; a session made in the
 * other is not resumed, and is named (`retire`) to keep with the chat's retired sessions.
 */
export function lookSession(key: string, agent: SubscriptionProvider, instructions: string, perTurn = false, position?: number, followUp = false, home?: SessionHome): Promise<{ found: Found | null; declined?: Declined; retire?: string }> {
  return serial(async () => {
    const stored = (await read())[key];
    const entry = stored?.taking ? cutOff(stored, stored.taking) : stored;
    if (!entry || !entry.id || entry.agent !== agent) return { found: null };
    if (home && entry.home && entry.home !== home) return { found: null, declined: "audience", retire: entry.id };
    if (Date.now() - entry.at >= keepMs(entry)) return { found: null, declined: "expired" };
    // The chat moved on without this session (a turn on another model or computer): it would miss those messages.
    if (position !== undefined && entry.next !== undefined && position > entry.next) return { found: null, declined: "moved" };
    // A session that did not take the turn (its turn ran elsewhere, or could not keep its session) would miss it.
    if (followUp && position !== undefined && entry.next !== position + 2) return { found: null, declined: "moved" };
    if (position !== undefined && position - (entry.from ?? 0) >= ROTATE_MESSAGES) return { found: null, declined: "rotated" };
    if (!perTurn && entry.instructions !== instructionsHash(instructions) && entry.text === undefined) return { found: null, declined: "instructions" };
    return { found: { id: entry.id, text: perTurn ? null : (entry.text ?? null), ...(entry.usage ? { usage: entry.usage } : {}), ...(entry.prompts !== undefined ? { prompts: entry.prompts } : {}), ...(entry.home ? { home: entry.home } : {}) } };
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

/**
 * `retire`: the session this one replaces is kept, unresumed, until the chat is deleted (one made in the other home).
 * `dir`: the chat's own folder the turn ran in (`chatFolder`). `home`: the home the session was made in.
 */
export type SaveOptions = { next?: number; folder?: string; keepDays?: number; perTurn?: boolean; usage?: SessionUsage | null; prompts?: number | null; retire?: string; dir?: string; home?: SessionHome };

/**
 * Remembers the chat's session after a turn, and drops sessions unused for their keeping days, and the
 * one this session replaced: the agent's own history of each too (its app no longer lists it). A chat
 * unused for its keeping days goes with its own folder; one whose session was replaced goes on there.
 */
export async function saveSession(key: string, agent: SubscriptionProvider, id: string, instructions: string, options: SaveOptions | number = {}): Promise<void> {
  const opts: SaveOptions = typeof options === "number" ? { next: options } : options;
  const dropped = await serial(async () => {
    const store = await read();
    const now = Date.now();
    const old: Array<[string, Entry, boolean]> = [];
    for (const [other, entry] of Object.entries(store)) {
      if (other !== key && now - usedAt(entry) >= keepMs(entry)) {
        delete store[other];
        old.push([other, entry, true]);
      }
    }
    const stored = store[key];
    const taking = stored?.taking;
    const before = stored ? withoutTaking(stored) : undefined;
    const sameAgent = before?.agent === agent;
    const retiring = Boolean(before && sameAgent && opts.retire && before.id === opts.retire);
    // Another session took the chat's place: the old one would only clutter the agent's app (one used outside
    // Ensemble stays, unresumed, until the chat goes). Earlier retired sessions move to the new entry; on
    // another agent they go with the old one. An entry with no session yet (`chatFolder`) only names the folder.
    if (before && !sameAgent && (before.id || before.retired?.length)) old.push([key, before, false]);
    else if (before && before.id && before.id !== id && !retiring) old.push([key, { ...before, retired: undefined }, false]);
    // The session a turn here was cut off in, when another one goes on in its place, goes the same way.
    if (before && taking && taking.id !== id && taking.id !== before.id) old.push([key, { ...before, agent: taking.agent, id: taking.id, retired: undefined }, false]);
    const retired = sameAgent ? [...(before?.retired ?? []), ...(retiring ? [before!.id] : [])].filter((one) => one && one !== id) : [];
    const continued = before && before.id === id;
    const from = continued ? before.from : opts.next === undefined ? undefined : Math.max(0, opts.next - 2);
    const dir = opts.folder ? undefined : (opts.dir ?? before?.dir);
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
      ...(dir && dir !== key ? { dir } : {}),
      ...(opts.home ? { home: opts.home } : {}),
    };
    await write(store);
    return old;
  });
  // After the turn's own write, and never failing it: an agent that cannot delete keeps its history.
  if (dropped.length) void dropNative(dropped);
}

/**
 * Notes how many prompts the chat's session holds after a turn that failed or was stopped there (`saveSession`
 * notes them after one that answered): a message the agent took before then is in the session all the same, and
 * the next turn reads only what comes after it (outside.ts). Null: the count is not known, so the next turn
 * brings nothing in. Only while the chat still has that session. The chat's position there stays where it was,
 * unless `next` moves it: a stopped turn's message and its "Stopped." stay in the chat (a failed one's do not).
 */
export function notePrompts(key: string, id: string, prompts: number | null, next?: number): Promise<void> {
  return serial(async () => {
    const store = await read();
    const entry = store[key];
    if (!entry?.id || entry.id !== id || (entry.prompts === (prompts ?? undefined) && (next === undefined || entry.next === next))) return;
    const { prompts: _before, ...rest } = entry;
    store[key] = { ...(typeof prompts === "number" ? { ...rest, prompts } : rest), ...(next === undefined ? {} : { next }) };
    await write(store);
  });
}

/**
 * Notes, before the agent has the message, the session a turn at `position` goes on in (resumed, or new with the id
 * the agent takes or says as it starts). A runtime that stops mid-turn (this computer restarts) saves nothing after, so
 * this note is what tells the turn's continuation (`resume: "only"`) and the chat's next turn which session took it
 * (`lookSession`). The turn's end replaces it (`saveSession`); one that fails or is stopped here takes it back
 * (`untakeSession`), and the chat's session stays as it was.
 */
export function takeSession(key: string, agent: SubscriptionProvider, id: string, instructions: string, options: { position?: number; perTurn?: boolean; folder?: string; keepDays?: number; home?: SessionHome } = {}): Promise<void> {
  return serial(async () => {
    const store = await read();
    const now = Date.now();
    const taking: Taking = { agent, id, ...(options.position === undefined ? {} : { position: options.position }), at: now, instructions: instructionsHash(instructions), ...(options.perTurn ? {} : { text: instructions }), ...(options.home ? { home: options.home } : {}) };
    store[key] = { ...(store[key] ?? { agent, id: "", instructions: "", at: now, ...(options.folder ? { folder: options.folder } : {}), ...(options.keepDays ? { keep: options.keepDays } : {}) }), taking };
    await write(store);
  });
}

/** The turn that noted `id` (`takeSession`) ended here without saving it: the chat's session stays as it was. */
export function untakeSession(key: string, id: string): Promise<void> {
  return serial(async () => {
    const store = await read();
    const entry = store[key];
    if (!entry || entry.taking?.id !== id) return;
    store[key] = withoutTaking(entry);
    await write(store);
  });
}

type Drop = (agent: SubscriptionProvider, id: string, folder: string) => Promise<unknown>;
let dropForTests: Drop | null = null;
/** Tests see which sessions would be deleted from the agent, without the agent. */
export function setNativeDropForTests(drop: Drop | null): void {
  dropForTests = drop;
}

/** `chat`: the whole chat is dropped (deleted, or unused for its keeping days), not only a session it replaced. */
async function dropNative(entries: Array<[string, Entry, boolean]>): Promise<void> {
  const { deleteNativeSession } = dropForTests ? { deleteNativeSession: dropForTests } : await import("../workspace/engines/delete-session.js");
  for (const [key, entry, chat] of entries) {
    const folder = entry.folder ?? ownFolder(key, entry);
    for (const id of [entry.id, ...(entry.retired ?? [])]) if (id) await deleteNativeSession(entry.agent, id, folder).catch(() => undefined);
    // A whole chat that goes takes the session a turn of it was cut off in too (`takeSession`).
    if (chat && entry.taking && entry.taking.id !== entry.id) await deleteNativeSession(entry.taking.agent, entry.taking.id, folder).catch(() => undefined);
    // A group's folder (a node's project) is shared, and a chat that goes on works in its own: only a dropped chat's own folder goes.
    if (chat && !entry.folder) await rm(ownFolder(key, entry), { recursive: true, force: true }).catch(() => undefined);
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
  if (entry) await dropNative([[key, entry, true]]);
  else await rm(sessionFolder(key), { recursive: true, force: true }).catch(() => undefined);
  return Boolean(entry);
}

/**
 * Forgets a chat's session that could not be reopened. Unless the agent said it no longer has it (`gone`), it
 * joins the chat's retired sessions: not resumed, and deleted from the agent with the chat (a thread the
 * ChatGPT app held open, a refusal that may pass). Earlier retired sessions stay listed either way, and the
 * chat's folder stays its own.
 */
export function forgetSession(key: string, options: { gone?: boolean } = {}): Promise<void> {
  return serial(async () => {
    const store = await read();
    const found = store[key];
    if (!found) return;
    const taking = found.taking;
    const entry = withoutTaking(found);
    // A turn here was cut off in another session than the chat's (`lookSession`): that one could not be reopened.
    if (taking && taking.id !== entry.id) {
      const retired = [...(entry.retired ?? []), ...(options.gone || taking.agent !== entry.agent ? [] : [taking.id])].filter((id, index, all) => id && all.indexOf(id) === index);
      store[key] = { ...entry, ...(retired.length ? { retired } : {}) };
      await write(store);
      return;
    }
    const retired = [...(entry.retired ?? []), ...(entry.id && !options.gone ? [entry.id] : [])].filter((id, index, all) => id && all.indexOf(id) === index);
    if (retired.length || entry.dir) store[key] = { ...entry, id: "", ...(retired.length ? { retired } : {}) };
    else delete store[key];
    await write(store);
  });
}

/**
 * A chat folder's name: the chat's title as a slug, then the start of its key (an ask's: of its hash), or
 * all of the key (`whole`) when that name is taken.
 */
export function chatFolderName(key: string, title?: string | null, whole = false): string {
  const slug = (title ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const cut = slug.length > 40 ? slug.slice(0, 41).replace(/-[^-]*$/, "") || slug.slice(0, 40) : slug;
  const id = (whole ? key : key.replace(/^(?:[a-z]+-)+(?=[0-9a-f]{16,}$)/i, "")).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return `${cut.replace(/-+$/, "") || "chat"}-${whole ? id : id.slice(0, 8)}`;
}

const present = (path: string) => lstat(path).then(() => true, () => false);

/**
 * The chat's own folder for its next turn, and its name to keep with the session (`saveSession` `dir`).
 * A chat whose session began in its folder (or one set aside to delete with it) keeps that folder, as the
 * agent finds the session there. A chat without one gets a folder named after its title, kept in the store
 * at once so a turn that fails leaves no stray folder; a folder it already has takes the new name, since no
 * session of the chat began there and the chat's turns run one at a time.
 */
export function chatFolder(key: string, chat: { agent: SubscriptionProvider; title?: string | null; keepDays?: number }): Promise<{ folder: string; dir: string }> {
  return serial(async () => {
    const store = await read();
    const entry = store[key];
    if (entry && (entry.id || entry.retired?.length || entry.folder || entry.taking)) return { folder: ownFolder(key, entry), dir: dirOf(key, entry) };
    const root = join(stateDir(), "assistant");
    const current = ownFolder(key, entry);
    const others = new Set(Object.entries(store).flatMap(([other, row]) => (other === key || row.folder ? [] : [row.dir ?? other])));
    let dir = chatFolderName(key, chat.title);
    if (join(root, dir) !== current && (others.has(dir) || (await present(join(root, dir))))) dir = chatFolderName(key, chat.title, true);
    if (join(root, dir) !== current && (await present(current))) dir = await rename(current, join(root, dir)).then(() => dir, () => dirOf(key, entry));
    const keep = chat.keepDays ?? entry?.keep;
    store[key] = { agent: chat.agent, id: "", instructions: "", at: Date.now(), ...(dir === key ? {} : { dir }), ...(keep ? { keep } : {}) };
    await write(store);
    return { folder: join(root, dir), dir };
  });
}
