/**
 * The MCP servers an agent on this computer loads by itself, besides the Ensemble server a turn gives it:
 * GitHub Copilot CLI's from every source it reads (`copilot mcp list --json`: the person's
 * `~/.copilot/mcp-config.json`, a trusted folder's `.mcp.json`, installed plugins, its built-in ones), and
 * Codex's (`codex mcp list --json`, from its `config.toml`). A turn that must have Ensemble's tools only
 * turns each of them off (agents.ts); in the owner's own node turn Copilot keeps them, and the node's judge
 * knows their tools by name (node-own-tools.ts). Listing takes Copilot a few seconds, so a listing is kept
 * for ten minutes per program and folder (one for every fresh temporary folder, where no folder's own
 * servers load), and read again as soon as the person's own settings change.
 */
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

/** `readOnly`: the server says it only reads (GitHub's built-in server at its read-only address). */
export type AgentMcpServer = { name: string; source: string; readOnly: boolean };

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; servers: Promise<AgentMcpServer[]> }>();

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

function remembered(key: string, read: () => Promise<AgentMcpServer[]>): Promise<AgentMcpServer[]> {
  const known = cache.get(key);
  if (known && Date.now() - known.at < CACHE_MS) return known.servers;
  const servers = read().catch(() => []);
  cache.set(key, { at: Date.now(), servers });
  return servers;
}

/** Copilot's MCP servers for a turn in `folder`, enabled ones only; from its own config file when it cannot list them. */
export async function copilotMcpServers(bin: string, folder: string, env: NodeJS.ProcessEnv): Promise<AgentMcpServer[]> {
  const home = env.COPILOT_HOME || join(env.HOME || homedir(), ".copilot");
  return remembered(await keyOf("copilot", bin, folder, ["mcp-config.json", "config.json", "settings.json"].map((name) => join(home, name))), async () => {
    const found = listed(await printed(bin, ["mcp", "list", "--json"], folder, env)) as { mcpServers?: Record<string, { source?: unknown; enabled?: unknown; url?: unknown }> } | null;
    if (found?.mcpServers && typeof found.mcpServers === "object") {
      return Object.entries(found.mcpServers)
        .filter(([, server]) => server?.enabled !== false)
        .map(([name, server]) => {
          const source = typeof server?.source === "string" ? server.source : "user";
          return { name, source, readOnly: source === "builtin" && typeof server?.url === "string" && /\/readonly\/?$/.test(server.url) };
        });
    }
    const own = JSON.parse(await readFile(join(home, "mcp-config.json"), "utf8").catch(() => "{}")) as { mcpServers?: Record<string, unknown> };
    return Object.keys(own.mcpServers ?? {}).map((name) => ({ name, source: "user", readOnly: false }));
  });
}

/** Codex's MCP servers for a turn in `folder`; from its `config.toml` when it cannot list them. */
export async function codexMcpServers(bin: string, folder: string, env: NodeJS.ProcessEnv): Promise<AgentMcpServer[]> {
  const home = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  return remembered(await keyOf("codex", bin, folder, [join(home, "config.toml")]), async () => {
    const found = listed(await printed(bin, ["mcp", "list", "--json"], folder, env));
    if (Array.isArray(found)) {
      return found
        .filter((server): server is { name: string; enabled?: unknown } => typeof (server as { name?: unknown })?.name === "string")
        .filter((server) => server.enabled !== false)
        .map((server) => ({ name: server.name, source: "user", readOnly: false }));
    }
    const text = await readFile(join(home, "config.toml"), "utf8").catch(() => "");
    const names = [...text.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm)].map((match) => match[1] ?? match[2]!);
    return [...new Set(names)].map((name) => ({ name, source: "user", readOnly: false }));
  });
}

/** Tests: list again. */
export function forgetMcpServersForTests(): void {
  cache.clear();
}
