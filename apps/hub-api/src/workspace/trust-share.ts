/**
 * Folder trust, shared with the person's other AI tools on this computer (doc 24 §5.8).
 *
 * A folder trusted in Ensemble is marked trusted in Claude Code, Codex, GitHub Copilot CLI,
 * Cursor's agent and Gemini CLI too, in the same files their apps and CLIs read, so a task
 * Ensemble hands to one of them does not stop at that tool's own "Do you trust this folder?".
 * Ensemble removes only the marks it added: a folder the person trusted in a tool directly
 * stays trusted there. A tool that is not installed (no config folder) is left alone, and a
 * file Ensemble cannot read is never rewritten.
 *
 * On by default, per computer; off removes every mark Ensemble added. The list of marks and
 * the switch live beside `remote.json`, with a copy of each file from before Ensemble's first
 * and latest change.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { stateDir } from "../remote/store.js";
import { workspaceRoot } from "./guard.js";
import { PATH_RULE_SOURCE, PATH_RULE_TOOL } from "./trust.js";

export type TrustTool = "claude" | "codex" | "copilot" | "cursor" | "gemini";

export const TRUST_TOOLS: Array<{ id: TrustTool; name: string }> = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "copilot", name: "GitHub Copilot CLI" },
  { id: "cursor", name: "Cursor" },
  { id: "gemini", name: "Gemini CLI" },
];

/** What a change did to one tool's file. `already`: the tool trusted the folder before Ensemble did. */
type Change = { text: string | null; already: boolean; was?: string | null };

// ── the files, one function each (pure, so they are tested without a home folder) ──────────────

/** `~/.claude.json`: `projects[folder].hasTrustDialogAccepted`, read by the Claude Code CLI and the Claude app. */
export function claudeTrust(text: string, folder: string, on: boolean): Change {
  const data = JSON.parse(text) as { projects?: Record<string, Record<string, unknown>> };
  const key = claudeKey(folder);
  const project = data.projects?.[key];
  if (on) {
    if (project?.hasTrustDialogAccepted === true) return { text: null, already: true };
    data.projects = { ...(data.projects ?? {}), [key]: { ...(project ?? {}), hasTrustDialogAccepted: true } };
    return { text: `${JSON.stringify(data, null, 2)}\n`, already: false };
  }
  if (project?.hasTrustDialogAccepted !== true) return { text: null, already: false };
  // The entry also holds Claude Code's own history for the folder, so it stays; only the trust goes.
  project.hasTrustDialogAccepted = false;
  return { text: `${JSON.stringify(data, null, 2)}\n`, already: false };
}

/** Claude Code keys Windows folders with forward slashes. */
function claudeKey(folder: string): string {
  return /^[A-Za-z]:\\/.test(folder) ? folder.replace(/\\/g, "/") : folder;
}

const CODEX_HEADER = /^\s*\[\s*projects\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*(?:#.*)?$/;
const CODEX_TRUST = /^\s*trust_level\s*=\s*["']([^"']*)["']\s*(?:#.*)?$/;

/** `~/.codex/config.toml`: `[projects."<folder>"] trust_level = "trusted"`, read by the Codex CLI, IDE extension and app. */
export function codexTrust(text: string, folder: string, on: boolean, was: string | null = null): Change {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => {
    const match = CODEX_HEADER.exec(line);
    if (!match) return false;
    const key = match[1] !== undefined ? match[1].replace(/\\(["\\])/g, "$1") : match[2];
    return key === folder;
  });
  let end = lines.length;
  if (start >= 0) {
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^\s*\[/.test(lines[index]!)) {
        end = index;
        break;
      }
    }
  }
  const trustLine = start >= 0 ? lines.slice(start + 1, end).findIndex((line) => CODEX_TRUST.test(line)) : -1;
  const at = trustLine >= 0 ? start + 1 + trustLine : -1;
  const current = at >= 0 ? CODEX_TRUST.exec(lines[at]!)![1]! : null;
  if (on) {
    if (current === "trusted") return { text: null, already: true };
    if (at >= 0) lines[at] = 'trust_level = "trusted"';
    else if (start >= 0) lines.splice(start + 1, 0, 'trust_level = "trusted"');
    else {
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      if (lines.length) lines.push("");
      lines.push(`[projects.${tomlKey(folder)}]`, 'trust_level = "trusted"', "");
    }
    return { text: lines.join("\n"), already: false, was: current };
  }
  if (current !== "trusted") return { text: null, already: false };
  if (was) {
    lines[at] = `trust_level = "${was}"`;
    return { text: lines.join("\n"), already: false };
  }
  lines.splice(at, 1);
  end -= 1;
  // A table Ensemble added holds only the trust line; drop it whole, with the blank line before it.
  if (lines.slice(start + 1, end).every((line) => !line.trim() || line.trim().startsWith("#"))) {
    const from = start > 0 && lines[start - 1] === "" ? start - 1 : start;
    lines.splice(from, end - from);
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
  }
  return { text: lines.join("\n"), already: false };
}

function tomlKey(folder: string): string {
  // A literal string keeps Windows backslashes readable; a basic string when the path has a quote.
  if (!folder.includes("'") && !/[\n\r]/.test(folder)) return `'${folder}'`;
  return `"${folder.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `~/.copilot/config.json`: the `trustedFolders` list. The file starts with comment lines, kept as they are. */
export function copilotTrust(text: string, folder: string, on: boolean): Change {
  const lines = text.split("\n");
  let body = 0;
  while (body < lines.length && (lines[body]!.trim().startsWith("//") || !lines[body]!.trim())) body += 1;
  const header = lines.slice(0, body).join("\n");
  const data = JSON.parse(lines.slice(body).join("\n")) as { trustedFolders?: unknown };
  const list = Array.isArray(data.trustedFolders) ? data.trustedFolders.filter((item): item is string => typeof item === "string") : [];
  if (on) {
    if (list.includes(folder)) return { text: null, already: true };
    data.trustedFolders = [...list, folder];
  } else {
    if (!list.includes(folder)) return { text: null, already: false };
    data.trustedFolders = list.filter((item) => item !== folder);
  }
  return { text: `${header ? `${header}\n` : ""}${JSON.stringify(data, null, 2)}\n`, already: false };
}

/** `~/.gemini/trustedFolders.json`: `{ "<folder>": "TRUST_FOLDER" }`. */
export function geminiTrust(text: string, folder: string, on: boolean, was: string | null = null): Change {
  const data = (text.trim() ? JSON.parse(text) : {}) as Record<string, unknown>;
  const current = typeof data[folder] === "string" ? (data[folder] as string) : null;
  if (on) {
    if (current === "TRUST_FOLDER") return { text: null, already: true };
    data[folder] = "TRUST_FOLDER";
    return { text: `${JSON.stringify(data, null, 2)}\n`, already: false, was: current };
  }
  if (current !== "TRUST_FOLDER") return { text: null, already: false };
  if (was) data[folder] = was;
  else delete data[folder];
  return { text: `${JSON.stringify(data, null, 2)}\n`, already: false };
}

/** Cursor's agent keeps one folder per workspace under `~/.cursor/projects`, named after the path. */
export function cursorSlug(folder: string): string {
  return folder.replace(/^[/\\]+/, "").replace(/[^A-Za-z0-9]/g, "-");
}

// ── where each tool keeps it ──────────────────────────────────────────────────────────────────

export type ToolHomes = { home: string; env: NodeJS.ProcessEnv };

function toolFile(tool: TrustTool, { home, env }: ToolHomes): { file: string; needs: string } {
  switch (tool) {
    case "claude": {
      const file = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");
      return { file, needs: file };
    }
    case "codex": {
      const dir = env.CODEX_HOME || join(home, ".codex");
      return { file: join(dir, "config.toml"), needs: dir };
    }
    case "copilot": {
      const file = join(env.COPILOT_HOME || join(home, ".copilot"), "config.json");
      return { file, needs: file };
    }
    case "cursor": {
      const dir = join(home, ".cursor", "projects");
      return { file: dir, needs: dir };
    }
    case "gemini": {
      const dir = join(home, ".gemini");
      return { file: env.GEMINI_CLI_TRUSTED_FOLDERS_PATH || join(dir, "trustedFolders.json"), needs: dir };
    }
  }
}

/** The tools found on this computer (their config folder exists). */
export function installedTrustTools(homes: ToolHomes = defaultHomes()): TrustTool[] {
  return TRUST_TOOLS.map((tool) => tool.id).filter((tool) => existsSync(toolFile(tool, homes).needs));
}

function defaultHomes(): ToolHomes {
  return { home: homedir(), env: process.env };
}

// ── the switch and the marks Ensemble added ───────────────────────────────────────────────────

export type TrustMark = { folder: string; tool: TrustTool; was?: string | null };
export type SharedTrustState = { version: 1; enabled: boolean; marks: TrustMark[] };

function statePath(): string {
  return join(stateDir(), "shared-trust.json");
}

export async function loadSharedTrust(path = statePath()): Promise<SharedTrustState> {
  try {
    const saved = JSON.parse(await readFile(path, "utf8")) as Partial<SharedTrustState>;
    return {
      version: 1,
      enabled: saved.enabled !== false,
      marks: Array.isArray(saved.marks) ? saved.marks.filter((mark) => typeof mark?.folder === "string" && TRUST_TOOLS.some((tool) => tool.id === mark.tool)) : [],
    };
  } catch {
    return { version: 1, enabled: true, marks: [] };
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const mode = await stat(path).then((info) => info.mode & 0o777).catch(() => 0o600);
  const temp = `${path}.ensemble-${process.pid}.tmp`;
  await writeFile(temp, text, { mode });
  await rename(temp, path);
}

/**
 * Claude Code saves `~/.claude.json` under a `proper-lockfile` lock (a `<file>.lock` folder, stale
 * after 10 seconds) and re-reads before it writes; Ensemble takes the same lock for its change.
 */
async function withFileLock<T>(file: string, work: () => Promise<T>): Promise<T | null> {
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then((info) => Date.now() - info.mtimeMs).catch(() => 0);
      if (age > 10_000) await rm(lock, { recursive: true, force: true });
      else await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    try {
      return await work();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  // Still held after five seconds: try again at the next change.
  return null;
}

/** A copy of the tool's file from before Ensemble first changed it, and from before the latest change. */
async function backup(tool: TrustTool, file: string, dir: string): Promise<void> {
  if (!existsSync(file)) return;
  await mkdir(dir, { recursive: true });
  const first = join(dir, `${tool}.first`);
  if (!existsSync(first)) await copyFile(file, first);
  await copyFile(file, join(dir, `${tool}.latest`));
}

/** Marks or unmarks one folder in one tool. Returns what to remember, or null when nothing was Ensemble's doing. */
export async function setToolTrust(
  tool: TrustTool,
  folder: string,
  on: boolean,
  options: { homes?: ToolHomes; backups?: string; was?: string | null } = {},
): Promise<{ changed: boolean; already: boolean; was?: string | null }> {
  const homes = options.homes ?? defaultHomes();
  const backups = options.backups ?? join(stateDir(), "trust-backups");
  const { file, needs } = toolFile(tool, homes);
  if (!existsSync(needs)) return { changed: false, already: false };
  if (tool === "cursor") {
    const marker = join(file, cursorSlug(folder), ".workspace-trusted");
    const current = await readFile(marker, "utf8").then((text) => JSON.parse(text) as { workspacePath?: string }).catch(() => null);
    if (on) {
      if (current) return { changed: false, already: true };
      await writeAtomic(marker, `${JSON.stringify({ trustedAt: new Date().toISOString(), workspacePath: folder, trustMethod: "cli-flag" }, null, 2)}\n`);
      return { changed: true, already: false };
    }
    if (current?.workspacePath !== folder) return { changed: false, already: false };
    await rm(marker, { force: true });
    return { changed: true, already: false };
  }
  const edit = () => editToolFile(tool, file, folder, on, backups, options.was ?? null);
  return (tool === "claude" ? await withFileLock(file, edit) : await edit()) ?? { changed: false, already: false };
}

async function editToolFile(
  tool: Exclude<TrustTool, "cursor">,
  file: string,
  folder: string,
  on: boolean,
  backups: string,
  was: string | null,
): Promise<{ changed: boolean; already: boolean; was?: string | null }> {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? "" : null));
  if (text === null) return { changed: false, already: false };
  // Claude Code and Copilot write their file on first start; without one there is nothing to add to.
  if (!text.trim() && (tool === "claude" || tool === "copilot")) return { changed: false, already: false };
  let change: Change;
  try {
    change =
      tool === "claude"
        ? claudeTrust(text, folder, on)
        : tool === "codex"
          ? codexTrust(text, folder, on, was)
          : tool === "copilot"
            ? copilotTrust(text, folder, on)
            : geminiTrust(text, folder, on, was);
  } catch {
    // A file Ensemble cannot read is the tool's to fix; it is never rewritten.
    return { changed: false, already: false };
  }
  if (change.text === null) return { changed: false, already: change.already };
  await backup(tool, file, backups);
  await writeAtomic(file, change.text);
  return { changed: true, already: false, was: change.was ?? null };
}

// ── keeping them in step ──────────────────────────────────────────────────────────────────────

/** Folders trusted on this computer for good: the workspace, and every saved trust rule. */
async function trustedHere(prisma: PrismaClient): Promise<string[]> {
  const rules = await prisma.decisionRule.findMany({
    where: { source: PATH_RULE_SOURCE, toolName: PATH_RULE_TOOL, decision: "allow", sessionId: null },
    select: { pattern: true },
  });
  return [...new Set([await workspaceRoot(), ...rules.map((rule) => rule.pattern)])];
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Brings the other tools in line with Ensemble: marks each trusted folder where it is not marked
 * yet, and removes Ensemble's own marks for folders no longer trusted (or all of them when the
 * switch is off). Runs one at a time. Only in the runtime on the person's computer.
 */
export function syncSharedTrust(
  prisma: PrismaClient,
  options: { homes?: ToolHomes; state?: string; backups?: string; force?: boolean } = {},
): Promise<SharedTrustState | null> {
  const run = async (): Promise<SharedTrustState | null> => {
    if (!options.force && process.env.ENSEMBLE_DESKTOP !== "1") return null;
    const path = options.state ?? statePath();
    const state = await loadSharedTrust(path);
    const wanted = state.enabled ? await trustedHere(prisma) : [];
    const tools = installedTrustTools(options.homes);
    const marks: TrustMark[] = [];
    for (const mark of state.marks) {
      if (wanted.includes(mark.folder)) {
        marks.push(mark);
        continue;
      }
      await setToolTrust(mark.tool, mark.folder, false, { homes: options.homes, backups: options.backups, was: mark.was ?? null }).catch(() => marks.push(mark));
    }
    for (const folder of wanted) {
      for (const tool of tools) {
        if (marks.some((mark) => mark.folder === folder && mark.tool === tool)) continue;
        const result = await setToolTrust(tool, folder, true, { homes: options.homes, backups: options.backups }).catch(() => null);
        if (result?.changed) marks.push({ folder, tool, ...(result.was ? { was: result.was } : {}) });
      }
    }
    const next: SharedTrustState = { version: 1, enabled: state.enabled, marks };
    await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

/** Turns sharing on or off for this computer, then brings the tools in line. */
export async function setSharedTrust(prisma: PrismaClient, enabled: boolean, options: { state?: string; homes?: ToolHomes; backups?: string; force?: boolean } = {}): Promise<SharedTrustState | null> {
  const path = options.state ?? statePath();
  const state = await loadSharedTrust(path);
  await writeAtomic(path, `${JSON.stringify({ ...state, enabled }, null, 2)}\n`);
  return syncSharedTrust(prisma, options);
}

/** After a trust change: in the background, never failing the request that made it. */
export function trustChanged(prisma: PrismaClient, log?: { warn: (object: unknown, message: string) => void }): void {
  void syncSharedTrust(prisma).catch((error: unknown) => log?.warn({ err: error }, "could not share folder trust with other AI tools"));
}
