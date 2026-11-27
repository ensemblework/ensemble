/**
 * Cursor's sub-agent chats (#272, docs/41 §7). cursor-agent saves each sub-agent its task tool starts as a chat of
 * its own, `chats/<workspace>/<child>/store.db` in its config folder, whose metadata names the chat that started it
 * and the root of the tree (`subagentInfo.parentAgentId`, `rootParentAgentId`). The sub-agent's transcript sits in
 * the parent's, `projects/<workspace>/agent-transcripts/<parent>/subagents/<child>.jsonl` in Cursor's data folder.
 * Cursor itself deletes neither with the parent.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** At most this many chats are read for their parent; a folder with more is read this far. */
const MAX_CHATS = 5000;

/** cursor-agent's config folder (cursor-config `paths.js`, 2026.09 to 2026.11), which holds its terminal chats and its ACP sessions. */
export function cursorConfigDir(): string {
  const configured = process.env.CURSOR_CONFIG_DIR;
  if (configured?.trim()) return configured;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg?.trim() ? join(xdg, "cursor") : join(homedir(), ".cursor");
}

/** cursor-agent's data folder (2026.11), which holds each workspace's `projects/<workspace>/agent-transcripts`. */
export function cursorDataDir(): string {
  const configured = process.env.CURSOR_DATA_DIR;
  return configured?.trim() ? configured : join(homedir(), ".cursor");
}

async function folders(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name); }
  catch { return []; }
}

async function files(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name); }
  catch { return []; }
}

/** The parent and root a chat's metadata names: `meta` row "0" of its `store.db`, its JSON as UTF-8 written in hex. */
export function cursorChatParent(hex: unknown): { parent: string; root: string } | null {
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  try {
    const meta = JSON.parse(Buffer.from(hex, "hex").toString("utf8")) as { subagentInfo?: { parentAgentId?: unknown; rootParentAgentId?: unknown } } | null;
    const info = meta?.subagentInfo;
    if (!info || typeof info.parentAgentId !== "string" || !info.parentAgentId) return null;
    return { parent: info.parentAgentId, root: typeof info.rootParentAgentId === "string" && info.rootParentAgentId ? info.rootParentAgentId : info.parentAgentId };
  } catch {
    return null;
  }
}

type Sqlite = typeof import("node:sqlite");
let sqlite: Promise<Sqlite | null> | undefined;
/** Node's own SQLite (22.13 and later, as the CLI and desktop carry it); null on an older Node, which then finds sub-agents by their transcripts only. */
const openSqlite = () => (sqlite ??= import("node:sqlite").catch(() => null));

/** The parent a chat's `store.db` names, read without writing to it; null for a chat that is not a sub-agent's, or cannot be read. */
async function storeParent(path: string): Promise<{ parent: string; root: string } | null> {
  const module = await openSqlite();
  if (!module) return null;
  let db: InstanceType<Sqlite["DatabaseSync"]> | undefined;
  try {
    db = new module.DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("0") as { value?: unknown } | undefined;
    return cursorChatParent(row?.value);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/** A sub-agent chat of a session: where it is (`workspace` under `chats/`, null when only its transcript was found) and its id. */
export type CursorChild = { workspace: string | null; id: string };

/**
 * Every chat a Cursor session started, at any depth: chats whose metadata names it, or a chat found here, as
 * their parent or root, and the sub-agents named in their transcripts' `subagents/` folders.
 */
export async function cursorSubAgents(sessionId: string, chats = join(cursorConfigDir(), "chats"), projects = join(cursorDataDir(), "projects")): Promise<CursorChild[]> {
  const links: Array<{ workspace: string | null; id: string; parent: string; root: string }> = [];
  let read = 0;
  for (const workspace of await folders(chats)) {
    for (const id of await folders(join(chats, workspace))) {
      if (!uuid.test(id) || id === sessionId) continue;
      if (++read > MAX_CHATS) break;
      const link = await storeParent(join(chats, workspace, id, "store.db"));
      if (link) links.push({ workspace, id, ...link });
    }
  }
  for (const workspace of await folders(projects)) {
    const transcripts = join(projects, workspace, "agent-transcripts");
    for (const parent of await folders(transcripts)) {
      if (!uuid.test(parent)) continue;
      for (const name of await files(join(transcripts, parent, "subagents"))) {
        const id = name.replace(/\.jsonl$/, "");
        if (uuid.test(id) && id !== sessionId) links.push({ workspace: null, id, parent, root: parent });
      }
    }
  }
  const tree = new Set([sessionId]);
  const found = new Map<string, CursorChild>();
  for (let grew = true; grew;) {
    grew = false;
    for (const link of links) {
      if (!tree.has(link.parent) && !tree.has(link.root)) continue;
      const known = found.get(link.id);
      if (!known || (!known.workspace && link.workspace)) found.set(link.id, { workspace: link.workspace, id: link.id });
      if (!tree.has(link.id)) { tree.add(link.id); grew = true; }
    }
  }
  return [...found.values()];
}
