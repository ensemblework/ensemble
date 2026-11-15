/**
 * How Ensemble's agent sessions show in each agent's own app (docs/41 §3). The agents name a session
 * after its first message, which for Ensemble is its instructions, and group nothing by Ensemble's
 * projects on their own:
 *
 * - Titles: Claude Code and GitHub Copilot CLI take `--name` for a new session; Codex names a thread with
 *   `thread/name/set`; Copilot over ACP (a task's session) takes its own `/rename` (`nameCopilotSession`).
 *   The other ACP agents and Cursor's agent take no name: a new session's first message has its title
 *   alone on the first line (`titledPrompt`). A chat is named after the chat, a task's session after the task.
 * - Codex projects: an Ensemble project is a project of Codex's app-server (`project/create`), found again
 *   by Ensemble's id in its metadata, and a task's thread starts in it (`thread/start` `projectId`). The
 *   ChatGPT app's sidebar shows only the projects in its own file, `.codex-global-state.json` in Codex's
 *   home, which the app reads when it starts and writes back whole while it runs. So Ensemble adds the
 *   project there, with Ensemble's threads in it, only while the app is closed, and owes it until then
 *   (`<state>/codex-app-projects.json`). Deleting the Ensemble project takes it out the same way, then
 *   out of Codex (`removeCodexAppProjects`).
 * - Claude's desktop app lists in its Code tab only sessions it has a record for, in the profile it runs
 *   on: `Claude` (signed in with a Claude account) or `Claude-3p` (on a gateway or a cloud provider), each
 *   with `claude-code-sessions/<account>/<org>/local_<id>.json`. A new session of Ensemble's gets the
 *   record the app keeps for a Claude Code session it imported, and loses it when Ensemble deletes it. The
 *   running app writes back records of sessions it loaded, so Ensemble removes them again until it has done so
 *   with the app closed (`<state>/claude-app-deletions.json`).
 *
 * Every step is best effort: an app that cannot take it leaves the session as it was, never the turn failed.
 */
import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, readlink, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Text as one line: control characters and runs of white space become one space. */
export function oneLine(text: string | null | undefined): string {
  return (text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

/** A session's title in an agent's list: one line, at most 80 characters (never half of an emoji). */
export function sessionTitle(text: string | null | undefined): string | null {
  const line = oneLine(text);
  if (!line) return null;
  const characters = Array.from(line);
  return characters.length > 80 ? `${characters.slice(0, 79).join("").trimEnd()}…` : line;
}

/** A title GitHub Copilot takes as a session's name: it refuses one with a double quote, and fails the whole run for it. */
export function copilotSessionName(text: string | null | undefined): string | null {
  return sessionTitle(text)?.replace(/"/g, "'") ?? null;
}

/**
 * A new session's first message for an agent that names the session after it and takes no name of its
 * own: the title alone on the first line. A task's brief opens with its title as a heading, which
 * becomes that line. A title that starts the way an agent reads a command or a file reference (`/help`,
 * `!ls`, `@notes.md`) is left out: as the message's start it would run as one.
 */
export function titledPrompt(title: string | null | undefined, prompt: string): string {
  const line = oneLine(title);
  if (!line || /^[/!@?\\]/.test(line)) return prompt;
  const first = prompt.split("\n", 1)[0] ?? "";
  if (oneLine(first.replace(/^#{1,6}[ \t]+/, "")) === line) return line + prompt.slice(first.length);
  return `${line}\n\n${prompt}`;
}

/**
 * Names a new GitHub Copilot session over ACP with Copilot's own `/rename <name>`, sent as a prompt:
 * Copilot runs it without a model turn or a message in the session, and keeps the name as one the
 * person gave (`user_named`), so its first message does not rename it. Only when the session's
 * command palette (`available_commands_update`) lists `rename`, since a Copilot without it would take
 * the line as a prompt. True when Copilot confirmed the name (`session_info_update`, read by the caller).
 */
export async function nameCopilotSession(rpc: Rpc, input: { sessionId: string; name: string | null; commands: readonly string[] | null; confirmed: () => boolean }): Promise<boolean> {
  if (!input.name || !input.commands?.includes("rename")) return false;
  await rpc.request("session/prompt", { sessionId: input.sessionId, prompt: [{ type: "text", text: `/rename ${input.name}` }] }).catch(() => undefined);
  return input.confirmed();
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
export type CodexProjectRow = { id: string; name: string; roots?: Array<{ path: string }>; metadata?: Record<string, string> };

const samePath = (a: string, b: string) => resolve(a).replace(/[\\/]+$/, "") === resolve(b).replace(/[\\/]+$/, "");

/** Every project of Codex's app-server, a page at a time (at most 2,000). */
export async function listCodexProjects(server: Rpc): Promise<CodexProjectRow[]> {
  const rows: CodexProjectRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const listed = (await server.request("project/list", { limit: 100, ...(cursor ? { cursor } : {}) })) as { data?: CodexProjectRow[]; nextCursor?: unknown };
    rows.push(...(listed.data ?? []));
    cursor = typeof listed.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : null;
    if (!cursor) break;
  }
  return rows;
}

/**
 * The Codex project for an Ensemble project: the one carrying Ensemble's id, else the one for its folder,
 * else a new one. Renamed with the Ensemble project. Null when this Codex has no projects (older than its
 * app-server projects) or refuses: the thread then starts outside any project, as before.
 */
export async function codexProject(server: Rpc, project: { id: string; name: string; folder: string }, options: Pick<SidebarOptions, "state"> = {}): Promise<string | null> {
  try {
    const rows = await listCodexProjects(server);
    const ours = rows.find((row) => row.metadata?.ensembleProjectId === project.id) ?? rows.find((row) => (row.roots ?? []).some((root) => samePath(root.path, project.folder)));
    if (ours) {
      if (ours.metadata?.ensembleProjectId === project.id && ours.name !== project.name) {
        await server.request("project/update", { projectId: ours.id, name: project.name }).catch(() => undefined);
      }
      return ours.id;
    }
    // Codex keeps a key with the project it made after that project is deleted. A key freed by Ensemble's own
    // deletion (the Ensemble project went to Trash and came back) gives way to the next one; a key freed by
    // the person removing the project in the ChatGPT app does not, so that project stays removed and the
    // thread starts outside any project.
    const freed = await deletedByEnsemble(project.id, options);
    for (let generation = 1; generation <= freed + 1; generation += 1) {
      const created = (await server
        .request("project/create", {
          name: project.name,
          roots: [{ path: project.folder }],
          metadata: { ensembleProjectId: project.id },
          idempotencyKey: generation === 1 ? `ensemble-project:${project.id}` : `ensemble-project:${project.id}:${generation}`,
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.message.startsWith("idempotency key refers to deleted project:")) return null;
          throw error;
        })) as { project?: { id?: string } } | null;
      if (created) return created.project?.id ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Names a Codex thread; an older Codex without names keeps its own. */
export async function nameCodexThread(server: Rpc, threadId: string, title: string | null): Promise<void> {
  if (!title) return;
  await server.request("thread/name/set", { threadId, name: title }).catch(() => undefined);
}


/** The threads Ensemble started in a Codex project, newest first (at most 100): those to file in the sidebar's project. */
export async function codexProjectThreads(server: Rpc, projectId: string): Promise<string[]> {
  try {
    const listed = (await server.request("thread/list", { projectId, archived: false, useStateDbOnly: true, limit: 100 })) as { data?: Array<{ id?: unknown }> };
    return (listed.data ?? []).flatMap((thread) => (typeof thread.id === "string" ? [thread.id] : []));
  } catch {
    return [];
  }
}

/** Where on this computer the apps keep their data; tests point it elsewhere. */
export type Place = { home?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv };
const placeOf = (where: Place = {}): Required<Place> => ({ home: where.home ?? homedir(), platform: where.platform ?? process.platform, env: where.env ?? process.env });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const names = (dir: string) => readdir(dir).catch(() => [] as string[]);
const isDir = (path: string) => stat(path).then((info) => info.isDirectory(), () => false);
const exists = (path: string) => lstat(path).then(() => true, () => false);
const modified = (path: string) => stat(path).then((info) => info.mtimeMs, () => 0);
const newestOf = <T>(items: Array<{ item: T; at: number }>): T | null => (items.length ? items.reduce((best, next) => (next.at > best.at ? next : best)).item : null);

/** Runs work one piece at a time, in the order it was handed in; a failed piece does not stop the next. */
function queued(): <T>(work: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return (work) => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
}

/** Replaces a file whole (a temporary file renamed over it), so whoever reads it gets the old one or the new one. */
async function replaceFile(path: string, text: string, mode?: number): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.ensemble-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, text, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      // Windows refuses a rename over a file another program holds open for a moment.
      if (attempt < 5 && ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        await new Promise((done) => setTimeout(done, 100 * attempt));
        continue;
      }
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

async function readObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    // Missing, being written, or not JSON: left alone.
    return null;
  }
}

const SESSIONS = "claude-code-sessions";
/** The organization the Claude app files sessions under on a gateway or a cloud provider (third-party mode). */
const LOCAL_ORG = "00000000-0000-4000-8000-000000000001";
/** The Claude app's Microsoft Store packages on Windows. */
const CLAUDE_PACKAGES = ["Claude_pzs8sxrjxfjjc", "AnthropicPBC.Claude_fnn82j28hfe8t"];
const RECORD = /^local_[\w-]+\.json$/;

/** The folders the Claude app keeps its profiles in on each platform. */
function claudeAppData({ home, platform, env }: Required<Place>): string[] {
  if (platform === "darwin") return [join(home, "Library", "Application Support")];
  if (platform === "win32") {
    const roaming = env.APPDATA || join(home, "AppData", "Roaming");
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    // Third-party mode keeps its profile in the local folder; a Microsoft Store build keeps its own copy of both.
    return [roaming, local, ...CLAUDE_PACKAGES.flatMap((name) => ["Roaming", "Local"].map((part) => join(local, "Packages", name, "LocalCache", part)))];
  }
  return [env.XDG_CONFIG_HOME || join(home, ".config")];
}

/**
 * The Claude app's profiles on this computer: `Claude` (signed in with a Claude account), `Claude-3p` (on a
 * gateway or a cloud provider, "third-party" mode), and any other folder of the app's with Chromium's
 * `Preferences` or a Code tab list in it.
 */
export async function claudeDesktopProfiles(where: Place = {}): Promise<string[]> {
  const at = placeOf(where);
  const found: string[] = [];
  const consider = async (folder: string) => {
    if (!found.includes(folder) && ((await isDir(join(folder, SESSIONS))) || (await exists(join(folder, "Preferences"))))) found.push(folder);
  };
  for (const root of claudeAppData(at)) {
    for (const name of await names(root)) {
      if (!/^claude(?:[- ].*)?$/i.test(name)) continue;
      await consider(join(root, name));
      // Windows: a Microsoft Store build's data moved out of its package, one folder per package.
      if (at.platform === "win32" && /^claude-data$/i.test(name)) for (const inner of await names(join(root, name))) await consider(join(root, name, inner));
    }
  }
  return found;
}

/** When the app last ran on a profile: Chromium and the app rewrite these there all the time, and Ensemble none of them. */
const profileUsedAt = async (profile: string) => Math.max(...(await Promise.all([profile, join(profile, "Preferences"), join(profile, "config.json")].map(modified))));

type OrgFolder = { dir: string; org: string };

/** A profile's Code tab lists: one per Claude account (or install) and organization. */
async function orgFolders(profile: string): Promise<OrgFolder[]> {
  const root = join(profile, SESSIONS);
  const out: OrgFolder[] = [];
  for (const account of (await names(root)).filter((name) => UUID.test(name))) {
    for (const org of (await names(join(root, account))).filter((name) => UUID.test(name))) {
      if (await isDir(join(root, account, org))) out.push({ dir: join(root, account, org), org });
    }
  }
  return out;
}

/** A list's session records, newest first. */
async function recordFiles(dir: string): Promise<Array<{ path: string; at: number }>> {
  const paths = (await names(dir)).filter((name) => RECORD.test(name)).map((name) => join(dir, name));
  return (await Promise.all(paths.map(async (path) => ({ path, at: await modified(path) })))).sort((a, b) => b.at - a.at);
}

/**
 * When the app last wrote in a list: its own files there, and its newest record that is not one Ensemble
 * filed and the app has not saved since (`filedBy`), so Ensemble's own records never pick the list.
 */
async function orgUsedAt(folder: OrgFolder): Promise<number> {
  const own = (await names(folder.dir)).filter((name) => !RECORD.test(name) && !name.startsWith(".")).map((name) => join(folder.dir, name));
  const newest = Math.max(0, ...(await Promise.all([join(folder.dir, "..", `${folder.org}.profile-origin.json`), ...own].map(modified))));
  for (const record of await recordFiles(folder.dir)) {
    if (record.at <= newest) break;
    if ((await readObject(record.path))?.filedBy !== "ensemble") return record.at;
  }
  return newest;
}

/**
 * The list the Claude app's Code tab shows now: in the profile the app ran on last, the list of the account
 * and organization it wrote to last. In third-party mode the app files sessions under its install id
 * (`ant-did`) and its local organization, so that list is known before the app made it; a Claude
 * account's is not. Null when there is none.
 */
export async function claudeCodeTabFolder(where: Place = {}): Promise<string | null> {
  const profiles = await claudeDesktopProfiles(where);
  const profile = newestOf(await Promise.all(profiles.map(async (item) => ({ item, at: await profileUsedAt(item) }))));
  if (!profile) return null;
  const folders = await orgFolders(profile);
  if (folders.length === 1) return folders[0]!.dir;
  if (folders.length > 1) return newestOf(await Promise.all(folders.map(async (item) => ({ item, at: await orgUsedAt(item) }))))!.dir;
  if (!/-3p$/i.test(profile)) return null;
  const installId = await readFile(join(profile, "ant-did"), "utf8").then((text) => Buffer.from(text.trim(), "base64").toString("utf8").trim(), () => "");
  return UUID.test(installId) ? join(profile, SESSIONS, installId.toLowerCase(), LOCAL_ORG) : null;
}

/**
 * The Code tab's record of a Claude Code session the app did not start: what the app keeps when it
 * imports one itself (`claude://resume?session=<id>`), named after the transcript it points at.
 */
export function claudeCodeTabRecord(input: { cliSessionId: string; cwd: string; title: string; model?: string | null; now: number }): Record<string, unknown> {
  return {
    sessionId: `local_${input.cliSessionId}`,
    cliSessionId: input.cliSessionId,
    cwd: input.cwd,
    originCwd: input.cwd,
    createdAt: input.now,
    lastActivityAt: input.now,
    indexedAt: input.now,
    isArchived: false,
    title: input.title,
    ...(input.model ? { model: input.model } : {}),
    sessionPermissionUpdates: [],
    alwaysAllowedReasons: [],
    // Begun outside the app, in Claude Code's own transcript: the app tells Claude so when the person goes on there.
    adoptedFromOtherSurface: true,
    fromCliTranscript: true,
    // Dropped when the app saves the record itself; until then it is not the app's own activity (`orgUsedAt`).
    filedBy: "ensemble",
  };
}

/**
 * Lists a new Claude Code session of Ensemble's in the Claude app's Code tab. Returns the record's file, or
 * null when nothing was added (no Claude app, a Code tab never used on a Claude account, already listed).
 * The app reads its list when it starts and when it opens a window, so a running app shows it from then.
 */
export async function addClaudeDesktopSession(input: { cliSessionId: string; cwd: string; title: string | null; model?: string | null; now?: number } & Place): Promise<string | null> {
  if (!input.title || !UUID.test(input.cliSessionId)) return null;
  try {
    const folder = await claudeCodeTabFolder(input);
    if (!folder) return null;
    const file = join(folder, `local_${input.cliSessionId}.json`);
    if (await exists(file)) return null;
    for (const record of await recordFiles(folder)) if ((await readObject(record.path))?.cliSessionId === input.cliSessionId) return null;
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await replaceFile(file, JSON.stringify(claudeCodeTabRecord({ cliSessionId: input.cliSessionId, cwd: input.cwd, title: input.title, model: input.model, now: input.now ?? Date.now() })), 0o600);
    return file;
  } catch {
    return null;
  }
}

/**
 * The Claude Code sessions Ensemble deleted, by id: when, and when their records were removed with the Claude
 * app closed (`settledAt`). The app keeps its Code tab list in memory, loaded from the records when it
 * starts, and writes a session's record again from that copy whenever it saves the session, without reading
 * the file first. So a record removed while the app runs can come back until the app closes; removed while it
 * is closed, it cannot.
 */
type Deleted = { at: number; settledAt?: number };
export type DeletionOptions = Place & {
  /** Ensemble's record of the sessions it deleted; default `<state>/claude-app-deletions.json`. */
  state?: string;
  /** Whether the Claude app is open; default `claudeAppOpen`. */
  appOpen?: () => Promise<boolean>;
  now?: number;
  /** How long to wait before trying again while the app is open; null: not again. */
  retryMs?: number | null;
};
/** `settled`: removed with the app closed; `owed`: the app is open, so again in 2 minutes; `nothing`: nothing deleted. */
export type DeletionResult = "settled" | "owed" | "nothing";
const DELETED_KEEP_MS = 30 * 86_400_000;
let claudeRetry: NodeJS.Timeout | null = null;
const serialClaude = queued();

async function deletionsPath(options: DeletionOptions): Promise<string> {
  if (options.state) return options.state;
  const { stateDir } = await import("../../remote/store.js");
  return join(stateDir(), "claude-app-deletions.json");
}

async function readDeletions(path: string): Promise<Record<string, Deleted>> {
  const data = (await readObject(path)) ?? {};
  const out: Record<string, Deleted> = {};
  for (const [id, entry] of Object.entries(data)) {
    const value = entry as Partial<Deleted> | null;
    if (!value || typeof value !== "object" || typeof value.at !== "number") continue;
    out[id] = typeof value.settledAt === "number" ? { at: value.at, settledAt: value.settledAt } : { at: value.at };
  }
  return out;
}

async function writeDeletions(path: string, store: Record<string, Deleted>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await replaceFile(path, JSON.stringify(store), 0o600);
}

/** Removes every Code tab record of these sessions, in every profile and list. */
async function removeRecords(ids: Set<string>, where: Place): Promise<void> {
  for (const profile of await claudeDesktopProfiles(where)) {
    for (const folder of await orgFolders(profile)) {
      for (const record of await recordFiles(folder.dir)) {
        const id = (await readObject(record.path))?.cliSessionId;
        if (typeof id === "string" && ids.has(id)) await unlink(record.path).catch(() => undefined);
      }
    }
  }
}

function armClaudeRetry(options: DeletionOptions): void {
  const wait = options.retryMs === undefined ? RETRY_MS : options.retryMs;
  if (wait === null || claudeRetry) return;
  claudeRetry = setTimeout(() => {
    claudeRetry = null;
    void syncClaudeAppDeletions(options).catch(() => undefined);
  }, wait);
  claudeRetry.unref();
}

/**
 * Removes the Code tab records of the Claude Code sessions Ensemble deleted in the last 30 days, wherever the
 * app wrote them back. A deletion is settled once its records were removed with the app closed before and
 * after; until then this runs again every 2 minutes. Runs when the runtime starts and after each deletion.
 */
export function syncClaudeAppDeletions(options: DeletionOptions = {}): Promise<DeletionResult> {
  return serialClaude(async () => {
    const path = await deletionsPath(options);
    const now = options.now ?? Date.now();
    const store = await readDeletions(path);
    let changed = false;
    for (const [id, entry] of Object.entries(store)) {
      if (now - entry.at <= DELETED_KEEP_MS) continue;
      delete store[id];
      changed = true;
    }
    const ids = Object.keys(store);
    const owed = ids.filter((id) => store[id]!.settledAt === undefined);
    const appOpen = options.appOpen ?? (() => claudeAppOpen(options));
    const before = owed.length ? await appOpen() : false;
    // Settled ones too, in case the app was open unseen and wrote one back.
    if (ids.length) await removeRecords(new Set(ids), options);
    let result: DeletionResult = "nothing";
    if (owed.length) {
      // The app may have started while the records were being removed, and loaded one of them.
      if (!before && !(await appOpen())) {
        for (const id of owed) store[id]!.settledAt = now;
        changed = true;
        result = "settled";
      } else {
        armClaudeRetry(options);
        result = "owed";
      }
    }
    if (changed) await writeDeletions(path, store);
    return result;
  });
}

/**
 * Removes the Code tab records of a Claude Code session Ensemble deleted, from every profile and list, and
 * remembers the deletion so a record the running app writes back goes too (`syncClaudeAppDeletions`).
 * Nothing is remembered on a computer without the Claude app.
 */
export async function removeClaudeDesktopSessions(cliSessionId: string, options: DeletionOptions = {}): Promise<DeletionResult> {
  if (!(await claudeDesktopProfiles(options)).length) return "nothing";
  const path = await deletionsPath(options);
  await serialClaude(async () => {
    const store = await readDeletions(path);
    store[cliSessionId] = { at: options.now ?? Date.now() };
    await writeDeletions(path, store);
  });
  return syncClaudeAppDeletions(options);
}

/** Codex's home, with its sign-in, threads and the ChatGPT app's sidebar: `CODEX_HOME`, else `.codex` in the home folder. */
export function codexHome(where: Place = {}): string {
  const at = placeOf(where);
  const set = at.env.CODEX_HOME?.trim();
  return set ? resolve(set) : join(at.home, ".codex");
}

const SIDEBAR = ".codex-global-state.json";

/**
 * The ChatGPT app's own data folders (`Codex`, and `Codex (<build>)` for its other builds), where Chromium
 * keeps its single-instance lock; on Windows also a Microsoft Store build's copy of its roaming folder.
 */
async function codexAppFolders(at: Required<Place>): Promise<string[]> {
  const appData = at.platform === "darwin" ? join(at.home, "Library", "Application Support") : at.platform === "win32" ? at.env.APPDATA || join(at.home, "AppData", "Roaming") : at.env.XDG_CONFIG_HOME || join(at.home, ".config");
  const roots = [appData];
  if (at.platform === "win32") {
    const packages = join(at.env.LOCALAPPDATA || join(at.home, "AppData", "Local"), "Packages");
    for (const name of (await names(packages)).filter((entry) => /^openai\./i.test(entry))) roots.push(join(packages, name, "LocalCache", "Roaming"));
  }
  const named: string[] = [];
  for (const root of roots) for (const name of await names(root)) if (/^codex(?: \(.+\))?$/i.test(name)) named.push(join(root, name));
  const explicit = at.env.CODEX_ELECTRON_USER_DATA_PATH?.trim();
  return explicit ? [resolve(explicit), ...named] : named;
}

/** An app among this computer's processes, on macOS and Windows; null when the list cannot be read, and elsewhere. */
function appProcess(platform: NodeJS.Platform, mac: RegExp, windows: RegExp): Promise<boolean | null> {
  const [program, args, pattern] = platform === "darwin" ? (["ps", ["-axo", "comm="], mac] as const) : platform === "win32" ? (["tasklist", ["/FO", "CSV", "/NH"], windows] as const) : ([null, [], null] as const);
  if (!program) return Promise.resolve(null);
  return new Promise((done) => {
    const child = spawn(program, [...args], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    const timer = setTimeout(() => child.kill(), 5_000);
    child.stdout.on("data", (chunk: Buffer) => void (out += chunk.toString("utf8")));
    child.once("error", () => done(null));
    child.once("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? pattern.test(out) : null);
    });
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Chromium's single-instance lock in an app's data folder: `SingletonLock`, a link to `<host>-<pid>`, on
 * macOS and Linux; `lockfile`, which Windows deletes when the app closes. Held while it names a running
 * process, or when it cannot be read.
 */
async function heldLock(folder: string, platform: NodeJS.Platform): Promise<boolean> {
  if (platform === "win32") return exists(join(folder, "lockfile"));
  const lock = join(folder, "SingletonLock");
  if (!(await exists(lock))) return false;
  const pid = Number(/-(\d+)$/.exec(await readlink(lock).catch(() => ""))?.[1] ?? Number.NaN);
  return !Number.isSafeInteger(pid) || pid <= 0 || alive(pid);
}

/**
 * Whether the ChatGPT app is open on this computer: Chromium's single-instance lock in its data folder,
 * else the app among the computer's processes (macOS, Windows). `processes: false` leaves the process
 * list out (tests).
 */
export async function codexAppOpen(where: Place & { processes?: boolean } = {}): Promise<boolean> {
  const at = placeOf(where);
  for (const folder of await codexAppFolders(at)) if (await heldLock(folder, at.platform)) return true;
  return where.processes === false ? false : (await appProcess(at.platform, /\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)$/m, /^"(?:ChatGPT|Codex)\.exe"/im)) === true;
}

/**
 * Whether the Claude app is open on this computer: the app among the computer's processes on macOS and
 * Windows (it keeps no Chromium lock in its profiles there), else a held single-instance lock in one of its
 * profiles. On Windows Claude Code is `claude.exe` too, so a running Claude Code counts as the app, and
 * whatever waits for the app to close waits for it as well.
 */
export async function claudeAppOpen(where: Place & { processes?: boolean } = {}): Promise<boolean> {
  const at = placeOf(where);
  for (const profile of await claudeDesktopProfiles(where)) if (await heldLock(profile, at.platform)) return true;
  return where.processes === false ? false : (await appProcess(at.platform, /\/Claude\.app\/Contents\/MacOS\/Claude$/m, /^"claude\.exe"/im)) === true;
}

/**
 * A Codex project Ensemble files in the ChatGPT app's sidebar, by its app-server id: its name and folder,
 * the threads still to file, and what was filed (`filedAt`, `filedName`). `removed`: the person removed it
 * in the app, or deleted its Ensemble project, and it is never filed again. `deleting`: its Ensemble project
 * was deleted, and it is still to leave the sidebar, then Codex. `deletedFor`: the Ensemble project whose
 * deletion removed it, so that project may get a new Codex project if it comes back (`codexProject`).
 */
type Owed = { name: string; folder: string; threads: string[]; filedAt?: number; filedName?: string; removed?: boolean; deleting?: boolean; deletedFor?: string };
type OwedStore = Record<string, Owed>;
export type SidebarOptions = Place & {
  /** Ensemble's record of what it owes the sidebar; default `<state>/codex-app-projects.json`. */
  state?: string;
  appOpen?: () => Promise<boolean>;
  now?: number;
  /** How long to wait before trying again while the app is open; null: not again. */
  retryMs?: number | null;
  /** Deletes projects from Codex (`project/delete`), one already gone counting as deleted; default: this computer's Codex. */
  deleteProjects?: (ids: string[]) => Promise<void>;
};
/** `filed`: the sidebar got a project or threads; `removed`: a project left the sidebar or Codex; `owed`: something waits for the app to close. */
export type SidebarResult = "filed" | "removed" | "owed" | "nothing";

const RETRY_MS = 2 * 60_000;
const MAX_OWED_THREADS = 200;
let retry: NodeJS.Timeout | null = null;
const serial = queued();

async function owedPath(options: SidebarOptions): Promise<string> {
  if (options.state) return options.state;
  const { stateDir } = await import("../../remote/store.js");
  return join(stateDir(), "codex-app-projects.json");
}

const owedNow = (entry: Owed) => !entry.removed && (!entry.filedAt || entry.threads.length > 0 || entry.filedName !== entry.name);
const isObject = (value: unknown) => value === undefined || (typeof value === "object" && value !== null && !Array.isArray(value));
/** Every part of the app's file Ensemble reads or changes is absent or has the shape the app writes; otherwise the file is left alone. */
const sidebarShaped = (state: Record<string, unknown>) =>
  ["local-projects", "thread-project-assignments", "thread-project-membership-host-ids", "app-server-pending-project-deletions-by-host", "app-server-project-id-by-legacy-project-id-by-host"].every((key) => isObject(state[key])) &&
  ["project-order", "pinned-project-ids", "projectless-thread-ids"].every((key) => state[key] === undefined || Array.isArray(state[key]));
const objectAt = (state: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = state[key];
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
};
const listAt = (state: Record<string, unknown>, key: string): string[] => (Array.isArray(state[key]) ? (state[key] as unknown[]).filter((item): item is string => typeof item === "string") : []);
/** The app-server projects the app shows under the person's own local project (theirs for the same folder): app-server id to local id. */
const mappedIds = (state: Record<string, unknown>, projects: Record<string, unknown>) =>
  new Map(Object.values(objectAt(state, "app-server-project-id-by-legacy-project-id-by-host")).flatMap((byLegacy) => (byLegacy && typeof byLegacy === "object" ? Object.entries(byLegacy as Record<string, unknown>).flatMap(([legacy, server]) => (typeof server === "string" && Object.hasOwn(projects, legacy) ? [[server, legacy] as const] : [])) : [])));
/** The id the sidebar shows an app-server project under: its own, or the person's own project's; null when it is not shown. */
function shownIn(state: Record<string, unknown>): (serverId: string) => string | null {
  const projects = objectAt(state, "local-projects");
  const mapped = mappedIds(state, projects);
  return (serverId) => mapped.get(serverId) ?? (Object.hasOwn(projects, serverId) ? serverId : null);
}

/**
 * Applies what is owed to the app's state: a project the app does not show gets an entry (its id is the
 * app-server id, which the app finds as its own), at the end of the order; a project shown under the
 * person's own id (theirs for the same folder) keeps it; a name Ensemble gave is renamed with the project
 * unless the person renamed it in the app; a thread with no project and not set apart as projectless joins it.
 * A project the person removed (gone after Ensemble filed it, or waiting to be deleted) is left removed.
 */
function applyOwed(state: Record<string, unknown>, owed: Array<[string, Owed]>, now: number): boolean {
  const projects = objectAt(state, "local-projects");
  const order = listAt(state, "project-order");
  const assignments = objectAt(state, "thread-project-assignments");
  const hosts = objectAt(state, "thread-project-membership-host-ids");
  const projectless = new Set(listAt(state, "projectless-thread-ids"));
  const deleting = new Set(Object.values(objectAt(state, "app-server-pending-project-deletions-by-host")).flatMap((byProject) => (byProject && typeof byProject === "object" ? Object.entries(byProject as Record<string, { projectId?: unknown }>).flatMap(([local, row]) => [local, String(row?.projectId ?? "")]) : [])));
  const mapped = mappedIds(state, projects);
  let changed = false;
  for (const [serverId, entry] of owed) {
    const id = mapped.get(serverId) ?? serverId;
    const shown = projects[id] as { name?: unknown } | undefined;
    if (deleting.has(id) || deleting.has(serverId) || (entry.filedAt && !shown)) {
      entry.removed = true;
      entry.threads = [];
      continue;
    }
    if (!shown) {
      projects[id] = { id, name: entry.name, rootPaths: [entry.folder], createdAt: now, updatedAt: now };
      if (!order.includes(id)) order.push(id);
      changed = true;
    } else if (id === serverId && entry.filedName !== undefined && entry.filedName !== entry.name && shown.name === entry.filedName) {
      projects[id] = { ...(shown as Record<string, unknown>), name: entry.name, updatedAt: now };
      changed = true;
    }
    // Settled either way: the name Ensemble gave, or the person's own (renamed in the app, or their own project).
    entry.filedName = entry.name;
    for (const thread of entry.threads) {
      if (Object.hasOwn(assignments, thread) || projectless.has(thread)) continue;
      assignments[thread] = { projectKind: "local", projectId: id };
      hosts[thread] = "local";
      changed = true;
    }
    entry.threads = [];
    entry.filedAt ??= now;
  }
  if (changed) Object.assign(state, { "local-projects": projects, "project-order": order, "thread-project-assignments": assignments, "thread-project-membership-host-ids": hosts });
  return changed;
}

/**
 * Takes projects out of the app's state the way the app does when the person removes one: out of
 * `local-projects`, `project-order` and `pinned-project-ids`, with their threads moved from
 * `thread-project-assignments` to `projectless-thread-ids`. Everything else in the file stays.
 */
function applyRemovals(state: Record<string, unknown>, ids: string[]): boolean {
  const projects = objectAt(state, "local-projects");
  const gone = new Set(ids.filter((id) => Object.hasOwn(projects, id)));
  if (!gone.size) return false;
  for (const id of gone) delete projects[id];
  state["local-projects"] = projects;
  for (const key of ["project-order", "pinned-project-ids"]) if (Array.isArray(state[key])) state[key] = listAt(state, key).filter((id) => !gone.has(id));
  const assignments = objectAt(state, "thread-project-assignments");
  const projectless = listAt(state, "projectless-thread-ids");
  let moved = false;
  for (const [thread, assignment] of Object.entries(assignments)) {
    const row = assignment as { projectKind?: unknown; projectId?: unknown } | null;
    if (row?.projectKind !== "local" || typeof row.projectId !== "string" || !gone.has(row.projectId)) continue;
    delete assignments[thread];
    if (!projectless.includes(thread)) projectless.push(thread);
    moved = true;
  }
  if (moved) Object.assign(state, { "thread-project-assignments": assignments, "projectless-thread-ids": projectless });
  return true;
}

/** Projects out of Codex through this computer's own Codex (delete-session.ts). */
const deleteWithCodex = async (ids: string[]) => (await import("./delete-session.js")).deleteCodexProjects(ids);

/**
 * Does what Ensemble owes the ChatGPT app's sidebar while the app is closed: files projects and threads,
 * and takes out the projects of deleted Ensemble projects. While it is open, tries again every few
 * minutes. Never touches a file it cannot read whole. A deleted project's Codex project goes once the
 * sidebar does not show it, never before: the app imports again, when it next starts, an entry whose
 * project Codex no longer has.
 */
export function syncCodexAppProjects(options: SidebarOptions = {}): Promise<SidebarResult> {
  return serial(async () => {
    const path = await owedPath(options);
    const store = ((await readObject(path)) ?? {}) as OwedStore;
    const entries = Object.entries(store).filter(([, entry]) => entry && typeof entry === "object");
    const owed = entries.filter(([, entry]) => owedNow(entry));
    const deleting = entries.filter(([, entry]) => entry.deleting === true);
    if (!owed.length && !deleting.length) return "nothing";
    // No sidebar file: the ChatGPT app has not run here yet, and shows nothing.
    const sidebar = join(codexHome(options), SIDEBAR);
    const hasSidebar = await exists(sidebar);
    if (!hasSidebar && !deleting.length) return "nothing";
    const open = options.appOpen ?? (() => codexAppOpen(options));
    const later = (): SidebarResult => {
      const wait = options.retryMs === undefined ? RETRY_MS : options.retryMs;
      if (wait !== null && !retry) {
        retry = setTimeout(() => {
          retry = null;
          void syncCodexAppProjects(options).catch(() => undefined);
        }, wait);
        retry.unref();
      }
      return "owed";
    };
    let filed = false;
    let removed = false;
    let waits = false;
    let shownAs = (_serverId: string): string | null => null;
    if (hasSidebar) {
      const closed = !(await open());
      const state = await readObject(sidebar);
      if (!state || !sidebarShaped(state)) return closed ? "owed" : later();
      if (closed) {
        filed = applyOwed(state, owed, options.now ?? Date.now());
        const before = shownIn(state);
        removed = applyRemovals(state, deleting.map(([id]) => id).filter((id) => before(id) === id));
        if (filed || removed) {
          // Checked again just before writing: the app writes the whole file back while it runs.
          if (await open()) return later();
          const text = JSON.stringify(state);
          await replaceFile(sidebar, text);
          await replaceFile(`${sidebar}.bak`, text).catch(() => undefined);
        }
      } else waits = owed.length > 0;
      shownAs = shownIn(state);
    }
    // Out of the sidebar, or never in it: the project goes from Codex too. One the app shows as the person's own stays.
    const gone: string[] = [];
    for (const [id, entry] of deleting) {
      const shown = shownAs(id);
      if (shown === null) gone.push(id);
      else if (shown !== id) delete entry.deleting;
      else waits = true;
    }
    if (gone.length) {
      try {
        await (options.deleteProjects ?? deleteWithCodex)(gone);
        for (const id of gone) delete store[id]!.deleting;
        removed = true;
      } catch {
        waits = true;
      }
    }
    await mkdir(dirname(path), { recursive: true });
    await replaceFile(path, JSON.stringify(store), 0o600);
    if (waits) return later();
    return filed ? "filed" : removed ? "removed" : "nothing";
  });
}

/**
 * Files a Codex project of Ensemble's, with a thread it started there, in the ChatGPT app's sidebar (now, or
 * once the app is closed). `earlier` lists the project's other threads, asked only until it is filed.
 */
export async function fileCodexAppProject(project: { id: string; name: string; folder: string; thread: string }, options: SidebarOptions & { earlier?: () => Promise<string[]> } = {}): Promise<SidebarResult> {
  // No sidebar file: the ChatGPT app has not run here, and nothing is kept for it.
  if (!(await exists(join(codexHome(options), SIDEBAR)))) return "nothing";
  await serial(async () => {
    const path = await owedPath(options);
    const store = ((await readObject(path)) ?? {}) as OwedStore;
    const entry: Owed = store[project.id] ?? { name: project.name, folder: project.folder, threads: [] };
    if (entry.removed) return;
    const earlier = !entry.filedAt && options.earlier ? await options.earlier().catch(() => [] as string[]) : [];
    store[project.id] = { ...entry, name: project.name, folder: project.folder, threads: [...new Set([...entry.threads, project.thread, ...earlier])].slice(0, MAX_OWED_THREADS) };
    await mkdir(dirname(path), { recursive: true });
    await replaceFile(path, JSON.stringify(store), 0o600);
  });
  return syncCodexAppProjects(options);
}

/** How many Codex projects Ensemble itself removed for an Ensemble project (`deletedFor`): the keys it freed. */
async function deletedByEnsemble(projectId: string, options: Pick<SidebarOptions, "state">): Promise<number> {
  const store = ((await readObject(await owedPath(options).catch(() => "")).catch(() => null)) ?? {}) as OwedStore;
  return Object.values(store).filter((entry) => entry && typeof entry === "object" && entry.deletedFor === projectId).length;
}

/**
 * The Codex projects Ensemble made for an Ensemble project that was deleted: each leaves the ChatGPT app's
 * sidebar while the app is closed (owed until then), its threads set apart as projectless, and then leaves
 * Codex (`project/delete`, which leaves those threads in no project). None is filed again. `owed`: one is
 * still in the sidebar of an open app, or Codex could not delete it yet.
 */
export async function removeCodexAppProjects(ids: string[], options: SidebarOptions = {}, deletedFor?: string): Promise<"removed" | "owed" | "nothing"> {
  if (!ids.length) return "nothing";
  const path = await owedPath(options);
  await serial(async () => {
    const store = ((await readObject(path)) ?? {}) as OwedStore;
    for (const id of ids) store[id] = { ...(store[id] ?? { name: "", folder: "" }), threads: [], removed: true, deleting: true, ...(deletedFor ? { deletedFor } : {}) };
    await mkdir(dirname(path), { recursive: true });
    await replaceFile(path, JSON.stringify(store), 0o600);
  });
  await syncCodexAppProjects(options);
  const store = ((await readObject(path)) ?? {}) as OwedStore;
  return ids.some((id) => store[id]?.deleting) ? "owed" : "removed";
}

/** Tests: no retry left waiting. */
export function stopCodexAppRetryForTests(): void {
  if (retry) clearTimeout(retry);
  retry = null;
}

/** Tests: no Claude app retry left waiting. */
export function stopClaudeAppRetryForTests(): void {
  if (claudeRetry) clearTimeout(claudeRetry);
  claudeRetry = null;
}
