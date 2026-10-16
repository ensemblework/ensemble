/**
 * Tasks Ensemble opens in an agent's own app or window on this computer: the Claude app's Code
 * tab, Codex in the ChatGPT app, Cursor, or VS Code's Copilot agent (docs/30_ENGINES.md "In the
 * agent's own app").
 *
 * Each vendor lets another app fill in a prompt and open a folder, never send it: the person
 * presses Send there. The prompt carries a marker; the agent's hooks report the session that
 * saw it, and from then on that session's permission prompts and questions reach Needs me.
 * Sessions the person starts on their own are never routed (unless Settings says every session).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHandoff, PrismaClient } from "@prisma/client";
import type { Normalized, Source } from "../lib/decisions.js";
import { within } from "./guard.js";
import { hostExecutable } from "./policy.js";

export type HandoffApp = "claude" | "codex" | "cursor" | "vscode" | "claude-cli" | "codex-cli" | "cursor-cli" | "copilot-cli";

export const HANDOFF_APPS: Record<HandoffApp, { name: string; source: Source }> = {
  claude: { name: "Claude", source: "claude" },
  codex: { name: "Codex", source: "codex" },
  cursor: { name: "Cursor", source: "cursor" },
  vscode: { name: "VS Code", source: "copilot" },
  // The command-line tools, opened in a terminal window: for a computer with no app, or by choice.
  "claude-cli": { name: "Claude Code", source: "claude" },
  "codex-cli": { name: "Codex", source: "codex" },
  "cursor-cli": { name: "Cursor's agent", source: "cursor" },
  "copilot-cli": { name: "Copilot CLI", source: "copilot" },
};

/** The command line each tool starts an interactive session with, working on its first prompt at once. */
const CLI_ARGS: Record<Extract<HandoffApp, `${string}-cli`>, (prompt: string) => string[]> = {
  "claude-cli": (prompt) => [prompt],
  "codex-cli": (prompt) => [prompt],
  "cursor-cli": (prompt) => [prompt],
  "copilot-cli": (prompt) => ["-i", prompt],
};

export function isCliHandoff(app: HandoffApp): app is Extract<HandoffApp, `${string}-cli`> {
  return app.endsWith("-cli");
}

const MARKER = /\bens-[0-9a-f]{10}\b/;

export function newMarker(): string {
  return `ens-${randomBytes(5).toString("hex")}`;
}

/** The prompt the person sends from the agent's app: the task, then the marker that links the session. */
export function handoffPrompt(input: { title: string; description?: string | null; instructions?: string | null; marker: string }, limit = 12_000): string {
  const body = [input.title.trim(), input.description?.trim(), input.instructions?.trim() ? `Instructions: ${input.instructions.trim()}` : null]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  const tail = `\n\n(Ensemble task ${input.marker}. Permission prompts and questions in this session also reach Ensemble's Needs me; answer them here or there.)`;
  return `${body.length > limit ? `${body.slice(0, limit)}…` : body}${tail}`;
}

export type HandoffOpen = { url: string | null; commands: string[][]; terminal?: { folder: string; program: string; args: string[] } };

/**
 * How each app is opened with the folder and the prompt. Claude's link opens its Code tab on the
 * folder (it asks the person to confirm the folder); Codex's opens a new thread in the ChatGPT
 * app; Cursor's prompt link has no folder, so the folder opens first; VS Code opens a window on
 * the folder and its agent chat with the prompt.
 */
export function handoffOpen(app: HandoffApp, folder: string, prompt: string, program = ""): HandoffOpen {
  const q = encodeURIComponent;
  if (isCliHandoff(app)) return { url: null, commands: [], terminal: { folder, program, args: CLI_ARGS[app](prompt) } };
  switch (app) {
    case "claude":
      return { url: `claude://code/new?folder=${q(folder)}&q=${q(prompt)}`, commands: [] };
    case "codex":
      return { url: `codex://new?path=${q(folder)}&prompt=${q(prompt)}`, commands: [] };
    case "cursor":
      return { url: `cursor://anysphere.cursor-deeplink/prompt?text=${q(prompt)}`, commands: [["cursor", folder]] };
    case "vscode":
      return { url: null, commands: [["code", "-n", folder], ["code", "chat", "-r", "-m", "agent", prompt]] };
  }
}

/** The editors' own command-line launchers, inside the app on macOS when the person never put them on PATH. */
const MAC_LAUNCHERS: Record<string, string[]> = {
  code: ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", join(homedir(), "Applications", "Visual Studio Code.app", "Contents", "Resources", "app", "bin", "code")],
  cursor: ["/Applications/Cursor.app/Contents/Resources/app/bin/cursor", join(homedir(), "Applications", "Cursor.app", "Contents", "Resources", "app", "bin", "cursor")],
};

async function launcher(name: string): Promise<string> {
  const found = await onPath(name);
  if (found) return found;
  const bundled = process.platform === "darwin" ? MAC_LAUNCHERS[name]?.find((path) => existsSync(path)) : undefined;
  if (bundled) return bundled;
  throw new Error(`${name} was not found on this computer.`);
}

/** Single-quoted for a POSIX shell: everything literal, newlines included. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Single-quoted for PowerShell. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The script a terminal runs: go to the folder, start the tool with its prompt. Nothing is interpolated by a shell. */
export function terminalScript(platform: NodeJS.Platform, terminal: NonNullable<HandoffOpen["terminal"]>): string {
  if (platform === "win32") return `Set-Location -LiteralPath ${psQuote(terminal.folder)}; & ${[terminal.program, ...terminal.args].map(psQuote).join(" ")}`;
  return `#!/bin/sh\ncd ${shQuote(terminal.folder)} || exit 1\nexec ${[terminal.program, ...terminal.args].map(shQuote).join(" ")}\n`;
}

const LINUX_TERMINALS: Array<[string, (script: string) => string[]]> = [
  ["x-terminal-emulator", (script) => ["-e", script]],
  ["gnome-terminal", (script) => ["--", script]],
  ["konsole", (script) => ["-e", script]],
  ["xfce4-terminal", (script) => ["-x", script]],
  ["kitty", (script) => [script]],
  ["alacritty", (script) => ["-e", script]],
  ["xterm", (script) => ["-e", script]],
];

/** Opens a terminal window running the tool: Terminal on macOS, the first terminal found on Linux, PowerShell on Windows. */
async function openTerminal(terminal: NonNullable<HandoffOpen["terminal"]>, run: (command: string, args: string[]) => Promise<void>): Promise<void> {
  if (process.platform === "win32") {
    const encoded = Buffer.from(terminalScript("win32", terminal), "utf16le").toString("base64");
    await run("cmd.exe", ["/c", "start", "Ensemble", "powershell.exe", "-NoExit", "-EncodedCommand", encoded]);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "ensemble-handoff-"));
  const script = join(dir, process.platform === "darwin" ? "task.command" : "task.sh");
  await writeFile(script, terminalScript(process.platform, terminal), { mode: 0o700 });
  if (process.platform === "darwin") {
    await run("/usr/bin/open", [script]);
    return;
  }
  for (const [name, args] of LINUX_TERMINALS) {
    const found = await onPath(name);
    if (found) return run(found, args(script));
  }
  throw new Error("No terminal program was found on this computer.");
}

/** Opens a link with the system's own handler (the runtime runs on the person's computer). */
export async function openLink(link: HandoffOpen, run: (command: string, args: string[]) => Promise<void> = start): Promise<void> {
  if (link.terminal) return openTerminal(link.terminal, run);
  for (const [name, ...args] of link.commands) await run(await launcher(name!), args);
  if (!link.url) return;
  if (process.platform === "darwin") await run("/usr/bin/open", [link.url]);
  else if (process.platform === "win32") await run("rundll32.exe", ["url.dll,FileProtocolHandler", link.url]);
  else await run(await hostExecutable("xdg-open"), [link.url]);
}

function start(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      // Give a window a moment, so the folder is open before the prompt link arrives.
      setTimeout(resolve, 800);
    });
  });
}

// ── what is installed ─────────────────────────────────────────────────────────────────────────

export type AgentPresence = { id: HandoffApp | "copilot"; name: string; app: boolean; cli: string | null };

async function onPath(name: string): Promise<string | null> {
  return hostExecutable(name).catch(() => null);
}

function anyExists(paths: string[]): boolean {
  return paths.some((path) => existsSync(path));
}

/** The Codex the ChatGPT app ships (`codex-package.json` names its entry point), when there is no `codex` on PATH. */
export function bundledCodex(platform = process.platform, home = homedir(), env = process.env): string | null {
  if (platform === "darwin") {
    for (const app of ["/Applications/ChatGPT.app", join(home, "Applications", "ChatGPT.app"), "/Applications/Codex.app"]) {
      const bin = join(app, "Contents", "Resources", "codex-cli", "bin", "codex");
      if (existsSync(bin)) return bin;
    }
    return null;
  }
  if (platform === "win32") {
    // The app copies its codex.exe here; the copy inside WindowsApps cannot be run directly.
    const base = join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "OpenAI", "Codex", "bin");
    try {
      for (const entry of readdirSync(base)) {
        const exe = join(base, entry, "codex.exe");
        if (existsSync(exe)) return exe;
      }
    } catch {
      return null;
    }
    return null;
  }
  return existsSync("/usr/lib/chatgpt/resources/codex") ? "/usr/lib/chatgpt/resources/codex" : null;
}

/** Which agents' apps and command lines are on this computer. */
export async function agentPresence(platform = process.platform, home = homedir(), env = process.env): Promise<AgentPresence[]> {
  const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  const mac = (name: string) => [`/Applications/${name}.app`, join(home, "Applications", `${name}.app`)];
  const claudeApp =
    platform === "darwin" ? anyExists(mac("Claude")) : platform === "win32" ? anyExists([join(local, "AnthropicClaude"), join(local, "Programs", "Claude")]) : anyExists([join(home, ".config", "Claude")]);
  const codexApp = bundledCodex(platform, home, env) !== null;
  const cursorApp = platform === "darwin" ? anyExists(mac("Cursor")) : platform === "win32" ? anyExists([join(local, "Programs", "cursor", "Cursor.exe")]) : (await onPath("cursor")) !== null;
  const codeApp = platform === "darwin" ? anyExists(mac("Visual Studio Code")) : (await onPath("code")) !== null;
  return [
    { id: "claude", name: "Claude", app: claudeApp, cli: await onPath("claude") },
    { id: "codex", name: "Codex", app: codexApp, cli: await onPath("codex") },
    // Cursor's `cursor` launcher needs the app; its agent's command line is `cursor-agent`.
    { id: "cursor", name: "Cursor", app: cursorApp, cli: await onPath("cursor-agent") },
    { id: "vscode", name: "VS Code", app: codeApp, cli: await onPath("code") },
    { id: "copilot", name: "GitHub Copilot CLI", app: false, cli: await onPath("copilot") },
  ];
}

/** Where a task can be opened on this computer: each app found, and each command-line tool found (in a terminal). */
export function handoffTargets(agents: AgentPresence[], codexInApp: boolean): Array<{ id: HandoffApp; name: string; terminal: boolean }> {
  const has = (id: AgentPresence["id"], what: "app" | "cli") => agents.some((agent) => agent.id === id && (what === "app" ? agent.app : Boolean(agent.cli)));
  const targets: Array<{ id: HandoffApp; name: string; terminal: boolean }> = [];
  if (has("claude", "app")) targets.push({ id: "claude", name: "the Claude app", terminal: false });
  if (has("codex", "app")) targets.push({ id: "codex", name: "Codex (ChatGPT app)", terminal: false });
  if (has("cursor", "app")) targets.push({ id: "cursor", name: "Cursor", terminal: false });
  if (has("vscode", "app")) targets.push({ id: "vscode", name: "VS Code", terminal: false });
  if (has("claude", "cli")) targets.push({ id: "claude-cli", name: "Claude Code in a terminal", terminal: true });
  // The ChatGPT app's own codex runs in a terminal too.
  if (has("codex", "cli") || codexInApp) targets.push({ id: "codex-cli", name: "Codex in a terminal", terminal: true });
  if (has("cursor", "cli")) targets.push({ id: "cursor-cli", name: "Cursor's agent in a terminal", terminal: true });
  if (has("copilot", "cli")) targets.push({ id: "copilot-cli", name: "Copilot CLI in a terminal", terminal: true });
  return targets;
}

// ── which sessions are Ensemble's ─────────────────────────────────────────────────────────────

/**
 * The open hand-off a hook call belongs to, linking the agent's session the first time it is
 * seen: by the marker in its prompt, by a session already linked, or by working in the
 * hand-off's folder (for tools whose hooks never see the prompt).
 */
export async function handoffFor(
  prisma: Pick<PrismaClient, "agentHandoff">,
  userId: string,
  call: Pick<Normalized, "source" | "sessionId" | "cwd">,
  prompt: string | null = null,
): Promise<AgentHandoff | null> {
  const marker = prompt ? MARKER.exec(prompt)?.[0] : undefined;
  const open = await prisma.agentHandoff.findMany({ where: { userId, status: { in: ["open", "finished"] } }, orderBy: { createdAt: "desc" } });
  const found =
    (marker ? open.find((row) => row.marker === marker) : undefined) ??
    (call.sessionId ? open.find((row) => row.sessions.includes(call.sessionId!)) : undefined) ??
    null;
  if (found && call.sessionId && !found.sessions.includes(call.sessionId)) {
    return prisma.agentHandoff.update({ where: { id: found.id }, data: { sessions: { push: call.sessionId } } });
  }
  return found;
}
