/**
 * The MCP servers an agent on this computer loads by itself, besides the Ensemble server a turn gives it:
 * GitHub Copilot CLI's from every source it reads (`copilot mcp list --json`: the person's
 * `~/.copilot/mcp-config.json`, a trusted folder's `.mcp.json`, installed plugins, its built-in ones), and
 * Codex's (`codex mcp list --json`, from its `config.toml`). A turn that must have Ensemble's tools only
 * turns each of them off (agents.ts); in the owner's own node turn Copilot keeps them, and the node's judge
 * knows their tools by name (node-own-tools.ts). Listing takes Copilot a few seconds, so a listing is kept
 * for ten minutes per program and folder (one for every fresh temporary folder, where no folder's own
 * servers load), and read again as soon as the person's own settings change. When the agent cannot list
 * them (its listing fails or takes longer than 15 seconds), they are read from its settings file, which can
 * miss some (a plugin's, a folder's, a Codex inline table): such a list is never kept, and a turn someone
 * other than the person can steer does not run on it (agents.ts).
 *
 * In a turn someone other than the person can steer (`AgentTurnSpec.others`), Cursor's agent and the ACP
 * agents without a switch for it leave the person's servers out through folders of Ensemble's own: Cursor's
 * data folder with every server of the person's off (`cursorWithoutOwnMcp`), or a home for the agent with none
 * of the person's settings (`othersHome`, acp.ts), where the person's sign-in is reached in place (`linkSignIn`).
 */
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readlink, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative } from "node:path";
import { stateDir } from "../remote/store.js";

/** `readOnly`: the server says it only reads (GitHub's built-in server at its read-only address). */
export type AgentMcpServer = { name: string; source: string; readOnly: boolean };
/** The servers, and whether the agent listed them itself (`mcp list --json`), else they were read from its settings file. */
export type AgentMcpListing = { servers: AgentMcpServer[]; listed: boolean };

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; listing: Promise<AgentMcpListing> }>();

/** A listing's key: the program, the folder (one for every temporary folder) and when the person's settings files last changed. */
async function keyOf(program: string, bin: string, folder: string, settings: string[]): Promise<string> {
  const rel = relative(tmpdir(), folder);
  const place = rel && !rel.startsWith("..") && !isAbsolute(rel) ? "temp" : folder;
  const changed = await Promise.all(settings.map((file) => stat(file).then((info) => info.mtimeMs, () => 0)));
  return [program, bin, place, ...changed].join("\u0000");
}

/** What a program prints, or "" when it fails or takes longer than 15 seconds. */
function printed(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((done) => {
    let out = "";
    let probe: ReturnType<typeof spawn>;
    try {
      probe = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      return done("");
    }
    const timer = setTimeout(() => probe.kill(), 15_000);
    probe.stdout!.on("data", (chunk: Buffer) => void (out += chunk.toString("utf8")));
    probe.once("error", () => done(""));
    probe.once("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? out : "");
    });
  });
}

/** The JSON a listing printed, after any warning lines before it. */
function listed(text: string): unknown {
  const start = text.search(/^[[{]/m);
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

/** A listing kept for ten minutes; one read from a settings file is dropped once it is known, so the next turn lists again. */
function remembered(key: string, read: () => Promise<AgentMcpListing>): Promise<AgentMcpListing> {
  const known = cache.get(key);
  if (known && Date.now() - known.at < CACHE_MS) return known.listing;
  const listing = read().catch(() => ({ servers: [], listed: false }));
  cache.set(key, { at: Date.now(), listing });
  void listing.then((found) => {
    if (!found.listed && cache.get(key)?.listing === listing) cache.delete(key);
  });
  return listing;
}

/** Copilot's MCP servers for a turn in `folder`, enabled ones only; from its own config file when it cannot list them. */
export async function copilotMcpServers(bin: string, folder: string, env: NodeJS.ProcessEnv): Promise<AgentMcpListing> {
  const home = env.COPILOT_HOME || join(env.HOME || homedir(), ".copilot");
  return remembered(await keyOf("copilot", bin, folder, ["mcp-config.json", "config.json", "settings.json"].map((name) => join(home, name))), async () => {
    const found = listed(await printed(bin, ["mcp", "list", "--json"], folder, env)) as { mcpServers?: Record<string, { source?: unknown; enabled?: unknown; url?: unknown }> } | null;
    if (found?.mcpServers && typeof found.mcpServers === "object") {
      const servers = Object.entries(found.mcpServers)
        .filter(([, server]) => server?.enabled !== false)
        .map(([name, server]) => {
          const source = typeof server?.source === "string" ? server.source : "user";
          return { name, source, readOnly: source === "builtin" && typeof server?.url === "string" && /\/readonly\/?$/.test(server.url) };
        });
      return { servers, listed: true };
    }
    const own = JSON.parse(await readFile(join(home, "mcp-config.json"), "utf8").catch(() => "{}")) as { mcpServers?: Record<string, unknown> };
    return { servers: Object.keys(own.mcpServers ?? {}).map((name) => ({ name, source: "user", readOnly: false })), listed: false };
  });
}

/** Codex's MCP servers for a turn in `folder`; from its `config.toml` when it cannot list them. */
export async function codexMcpServers(bin: string, folder: string, env: NodeJS.ProcessEnv): Promise<AgentMcpListing> {
  const home = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  return remembered(await keyOf("codex", bin, folder, [join(home, "config.toml")]), async () => {
    const found = listed(await printed(bin, ["mcp", "list", "--json"], folder, env));
    if (Array.isArray(found)) {
      const servers = found
        .filter((server): server is { name: string; enabled?: unknown } => typeof (server as { name?: unknown })?.name === "string")
        .filter((server) => server.enabled !== false)
        .map((server) => ({ name: server.name, source: "user", readOnly: false }));
      return { servers, listed: true };
    }
    const text = await readFile(join(home, "config.toml"), "utf8").catch(() => "");
    const names = [...text.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm)].map((match) => match[1] ?? match[2]!);
    return { servers: [...new Set(names)].map((name) => ({ name, source: "user", readOnly: false })), listed: false };
  });
}

/** Tests: list again. */
export function forgetMcpServersForTests(): void {
  cache.clear();
}

/**
 * Ensemble's home for an agent in a turn someone other than the person can steer (acp.ts `othersHome`): a folder in
 * Ensemble's state folder with none of the person's settings, so none of their MCP servers. Kept across turns, so a
 * chat's session there goes on.
 */
export function othersHome(agent: string): string {
  return join(stateDir(), "agents", agent, "home");
}

/** The variables that make a program take `home` as the home folder (Windows programs read `USERPROFILE`). */
export function homeVariables(home: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  return platform === "win32" ? { HOME: home, USERPROFILE: home } : { HOME: home };
}

/**
 * The person's sign-in at `target`, reached at `link` in Ensemble's home for an agent: a link, never a copy, so a
 * token the agent renews is saved where it was. Nothing when they have none there (or the link cannot be made).
 */
export async function linkSignIn(target: string, link: string): Promise<void> {
  const kind = await stat(target).then((info) => (info.isDirectory() ? "junction" : "file"), () => null);
  if (!kind) return;
  await mkdir(dirname(link), { recursive: true, mode: 0o700 });
  if ((await readlink(link).catch(() => null)) === target) return;
  const there = await lstat(link).catch(() => null);
  if (there) await (there.isSymbolicLink() ? unlink(link) : rm(link, { recursive: true, force: true }));
  await symlink(target, link, kind).catch(() => undefined);
}

/** JSON as settings files hold it, comments and trailing commas allowed; null when it is not even that. */
function settingsJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Strings are matched first, so a `//` or a comma inside one stays.
    const bare = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, string: string | undefined) => string ?? "");
    try {
      return JSON.parse(bare.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (match, string: string | undefined, close: string | undefined) => string ?? close ?? match));
    } catch {
      return null;
    }
  }
}

/** Cursor's agent's folder name for a project (cursor `workspace-paths`): its path with each run of other characters one dash. */
export const cursorProjectSlug = (folder: string): string => folder.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");

/** The folder Cursor's agent takes as a project: the nearest one up from `folder` with a `.git` (the file system's root aside), else `folder`. */
function cursorProjectRoot(folder: string): string {
  const root = parse(folder).root;
  for (let at = folder; ; ) {
    if (existsSync(join(at, ".git"))) return at;
    const up = dirname(at);
    if (up === at || up === root) return folder;
    at = up;
  }
}

/**
 * Cursor's agent with none of the person's own MCP servers (a turn someone else can steer, agents.ts): its data folder
 * (`CURSOR_DATA_DIR`), where it keeps per project which servers are approved and which are off, is Ensemble's own, and
 * every server in the person's `~/.cursor/mcp.json` is off there for the turn's folder. A folder's own servers stay out,
 * waiting for an approval Ensemble's data folder never has. One of theirs named `ensemble` (their own Ensemble
 * connection) cannot be turned off without the turn's server of that name, which Cursor puts in its place. Null when
 * their `mcp.json` cannot be read: the turn does not run.
 */
export async function cursorWithoutOwnMcp(folder: string): Promise<{ CURSOR_DATA_DIR: string } | null> {
  const text = await readFile(join(homedir(), ".cursor", "mcp.json"), "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? "" : null));
  if (text === null) return null;
  const config = text.trim() ? settingsJson(text) : {};
  const servers = config && typeof config === "object" && !Array.isArray(config) ? (config as { mcpServers?: unknown }).mcpServers : null;
  if (servers === null || (servers !== undefined && (typeof servers !== "object" || Array.isArray(servers)))) return null;
  const off = Object.keys((servers ?? {}) as Record<string, unknown>).filter((name) => name !== "ensemble");
  const data = join(stateDir(), "agents", "cursor-agent", "data");
  // Cursor names the project after the folder it was given, which a symlinked temporary folder may reach as its real path.
  const roots = new Set([folder, await realpath(folder).catch(() => folder)].map(cursorProjectRoot));
  for (const root of roots) {
    const project = join(data, "projects", cursorProjectSlug(root));
    await mkdir(project, { recursive: true, mode: 0o700 });
    await writeFile(join(project, "mcp-disabled.json"), JSON.stringify(off), { mode: 0o600 });
  }
  return { CURSOR_DATA_DIR: data };
}
