/**
 * How Ensemble's agent sessions show in each agent's own app (docs/30, In the agents' own apps). The
 * agents name a session after its first message, which for Ensemble is its instructions, and group
 * nothing by Ensemble's projects on their own:
 *
 * - Titles: Claude Code and GitHub Copilot CLI take `--name` for a new session; Codex names a thread with
 *   `thread/name/set`. A chat is named after the chat, a task's session after the task.
 * - Codex projects: an Ensemble project is a project of Codex's app-server (`project/create`, the list
 *   the ChatGPT app's Codex sidebar shows), found again by Ensemble's id in its metadata, and a task's
 *   thread starts in it (`thread/start` `projectId`).
 * - Claude's desktop app lists in its Code tab only sessions it has an entry for
 *   (`claude-code-sessions/<account>/<org>/local_<id>.json`, which points at Claude Code's transcript by
 *   `cliSessionId`). A new session of Ensemble's gets one, copied from the newest entry there so it has
 *   the fields that app writes, and loses it when Ensemble deletes the session. Nothing is added for
 *   someone who never used the Code tab: there is no account to file it under.
 *
 * Every step is best effort: an app that cannot take it leaves the session as it was, never the turn failed.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** A session's title in an agent's list: one line, at most 80 characters. */
export function sessionTitle(text: string | null | undefined): string | null {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

const helpCache = new Map<string, Promise<boolean>>();

/** Whether a program's help lists a flag (an option an older version lacks), asked once per program. */
export function helpHas(bin: string, args: string[], flag: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  const key = `${bin}\u0000${args.join(" ")}\u0000${flag}`;
  let known = helpCache.get(key);
  if (!known) {
    known = new Promise<boolean>((done) => {
      const probe = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, ...(env ? { env } : {}) });
      let out = "";
      const timer = setTimeout(() => probe.kill(), 15_000);
      probe.stdout.on("data", (chunk: Buffer) => void (out += chunk.toString("utf8")));
      probe.once("error", () => done(false));
      probe.once("close", () => {
        clearTimeout(timer);
        done(new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, "\\-")}\\b`, "m").test(out));
      });
    });
    helpCache.set(key, known);
  }
  return known;
}

/** Tests: probes run again. */
export function forgetHelpForTests(): void {
  helpCache.clear();
}

type Rpc = { request: (method: string, params?: unknown) => Promise<unknown> };
type CodexProjectRow = { id: string; name: string; roots?: Array<{ path: string }>; metadata?: Record<string, string> };

const samePath = (a: string, b: string) => resolve(a).replace(/[\\/]+$/, "") === resolve(b).replace(/[\\/]+$/, "");

/**
 * The Codex project for an Ensemble project: the one carrying Ensemble's id, else the one for its folder,
 * else a new one. Renamed with the Ensemble project. Null when this Codex has no projects (older than its
 * app-server projects) or refuses: the thread then starts outside any project, as before.
 */
export async function codexProject(server: Rpc, project: { id: string; name: string; folder: string }): Promise<string | null> {
  try {
    const listed = (await server.request("project/list", { limit: 200 })) as { data?: CodexProjectRow[] };
    const rows = listed.data ?? [];
    const ours = rows.find((row) => row.metadata?.ensembleProjectId === project.id) ?? rows.find((row) => (row.roots ?? []).some((root) => samePath(root.path, project.folder)));
    if (ours) {
      if (ours.metadata?.ensembleProjectId === project.id && ours.name !== project.name) {
        await server.request("project/update", { projectId: ours.id, name: project.name }).catch(() => undefined);
      }
      return ours.id;
    }
    const created = (await server.request("project/create", {
      name: project.name,
      roots: [{ path: project.folder }],
      metadata: { ensembleProjectId: project.id },
      idempotencyKey: `ensemble-project:${project.id}`,
    })) as { project?: { id?: string } };
    return created.project?.id ?? null;
  } catch {
    return null;
  }
}

/** Names a Codex thread; an older Codex without names keeps its own. */
export async function nameCodexThread(server: Rpc, threadId: string, title: string | null): Promise<void> {
  if (!title) return;
  await server.request("thread/name/set", { threadId, name: title }).catch(() => undefined);
}

/** Where Claude's desktop app keeps its Code tab's entries; null where there is no such app. */
export function claudeDesktopSessionsDir(home = homedir(), platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude-code-sessions");
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude-code-sessions");
  return null;
}

type DesktopEntry = { file: string; mtime: number; data: Record<string, unknown> };

/** Every entry under `<root>/<account>/<org>/local_*.json` that reads as JSON. */
async function desktopEntries(root: string): Promise<DesktopEntry[]> {
  const out: DesktopEntry[] = [];
  const dirs = async (path: string) => (await readdir(path, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
  for (const account of await dirs(root)) {
    for (const org of await dirs(account)) {
      for (const name of await readdir(org).catch(() => [] as string[])) {
        if (!/^local_[\w-]+\.json$/.test(name)) continue;
        const file = join(org, name);
        try {
          const [info, text] = await Promise.all([stat(file), readFile(file, "utf8")]);
          const data = JSON.parse(text) as unknown;
          if (data && typeof data === "object" && !Array.isArray(data)) out.push({ file, mtime: info.mtimeMs, data: data as Record<string, unknown> });
        } catch {
          // A file the app is writing, or not an entry: left alone.
        }
      }
    }
  }
  return out;
}

/** Fields of a template entry that belong to its own session (a worktree, granted permissions), not to the app. */
const OWN_FIELDS = ["branch", "worktreePath", "worktreeName", "sourceBranch", "alwaysAllowedReasons", "sessionPermissionUpdates", "completedTurns", "lastFocusedAt"];

/**
 * Lists a Claude Code session of Ensemble's in Claude's desktop app (its Code tab), filed with the app's
 * newest entry. Returns the entry's file, or null when nothing was added (no app, never used, already listed).
 */
export async function addClaudeDesktopSession(input: { cliSessionId: string; cwd: string; title: string | null; model?: string | null; root?: string | null; now?: number }): Promise<string | null> {
  const root = input.root === undefined ? claudeDesktopSessionsDir() : input.root;
  if (!root || !input.title) return null;
  try {
    const entries = await desktopEntries(root);
    if (!entries.length) return null;
    if (entries.some((entry) => entry.data.cliSessionId === input.cliSessionId)) return null;
    const template = entries.reduce((best, entry) => (entry.mtime > best.mtime ? entry : best));
    const now = input.now ?? Date.now();
    const sessionId = `local_${randomUUID()}`;
    const base = Object.fromEntries(Object.entries(template.data).filter(([key]) => !OWN_FIELDS.includes(key)));
    const data: Record<string, unknown> = {
      ...base,
      sessionId,
      cliSessionId: input.cliSessionId,
      cwd: input.cwd,
      originCwd: input.cwd,
      createdAt: now,
      lastActivityAt: now,
      ...(input.model ? { model: input.model } : {}),
      isArchived: false,
      title: input.title,
      ...("completedTurns" in template.data ? { completedTurns: 1 } : {}),
      ...("alwaysAllowedReasons" in template.data ? { alwaysAllowedReasons: [] } : {}),
      ...("sessionPermissionUpdates" in template.data ? { sessionPermissionUpdates: [] } : {}),
    };
    const file = join(template.file, "..", `${sessionId}.json`);
    const temporary = `${file}.ensemble-${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(temporary, file);
    return file;
  } catch {
    return null;
  }
}

/** Removes the desktop app's entries for a Claude Code session Ensemble deleted. */
export async function removeClaudeDesktopSessions(cliSessionId: string, root: string | null = claudeDesktopSessionsDir()): Promise<number> {
  if (!root) return 0;
  let removed = 0;
  for (const entry of await desktopEntries(root).catch(() => [] as DesktopEntry[])) {
    if (entry.data.cliSessionId !== cliSessionId) continue;
    await unlink(entry.file).then(() => (removed += 1), () => undefined);
  }
  return removed;
}
