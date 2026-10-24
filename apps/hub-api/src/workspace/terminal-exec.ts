/**
 * The terminal's rules, shared by the terminal on this computer's own page (`routes/terminal.ts`) and
 * the web terminal relayed to this computer (`remote/terminal.ts`, docs/16 §5): which folders it may
 * use, how `cd` moves, and what one command line may run. One allow-listed argv at a time, git hardened,
 * destructive commands confirmed, run under the OS sandbox where there is one, never in a shell.
 */
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { loadSettings } from "../lib/settings.js";
import { blockedReason, checkGit, checkProgram, gitHardening, GuardError, jailPath, parseCommand, sandboxAvailable, within, workspaceRoot } from "./guard.js";

/** The workspace, the terminal's own folders (`settings.terminal.roots`, never Code's), and the folders tasks ran in outside it. */
export async function terminalRoots(prisma: PrismaClient, userId: string): Promise<string[]> {
  const settings = await loadSettings(prisma, userId);
  const jobs = await prisma.workspaceJob.findMany({ where: { userId, externalRoot: { not: null } }, select: { externalRoot: true }, distinct: ["externalRoot"] });
  const candidates = [...settings.terminal.roots, ...jobs.map((job) => job.externalRoot!)];
  const allowed = [await workspaceRoot()];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || blockedReason(candidate)) continue;
    if (await stat(candidate).then((info) => info.isDirectory()).catch(() => false)) allowed.push(candidate);
  }
  return [...new Set(allowed)];
}

/** The deepest allowed folder that holds `path`, or null. */
export function scopeOf(allowed: string[], path: string): string | null {
  return allowed.filter((root) => within(root, path)).sort((a, b) => b.length - a.length)[0] ?? null;
}

/** Resolves `cd`: relative paths stay in the current scope; absolute ones may jump to another allowed root. */
export async function resolveCd(allowed: string[], cwd: string, path: string): Promise<{ cwd: string; scope: string }> {
  const scope = scopeOf(allowed, cwd);
  if (!scope) throw new GuardError("That folder is outside what the terminal may use.");
  const target = path.trim() === "" || path.trim() === "~" ? scope : path.trim();
  if (isAbsolute(target)) {
    const next = scopeOf(allowed, resolve(target));
    if (!next) throw new GuardError(`${target} is outside the folders the terminal may use.`);
    const real = await jailPath(next, resolve(target), true);
    if (!(await stat(real)).isDirectory()) throw new GuardError("That is not a folder.");
    return { cwd: real, scope: next };
  }
  const real = await jailPath(scope, resolve(cwd, target), true);
  if (!(await stat(real)).isDirectory()) throw new GuardError("That is not a folder.");
  return { cwd: real, scope };
}

export const DESTRUCTIVE: Array<[RegExp, string]> = [
  [/^git reset .*--hard/, "This throws away uncommitted changes."],
  [/^git clean\b/, "This deletes untracked files."],
  [/^git push .*--force-with-lease/, "This rewrites the remote branch."],
  [/^git branch .*(-D|--delete)/, "This deletes a branch."],
  [/^git checkout -- /, "This discards changes in those files."],
  [/^git restore (?!--staged)/, "This discards changes in those files."],
  [/^rm .*-[a-zA-Z]*r/, "This deletes folders recursively."],
];

export type PreparedRun =
  | { kind: "confirm"; message: string }
  | { kind: "run"; argv: string[]; full: string[]; cwd: string; scope: string; sandboxed: boolean };

/**
 * One command line, checked: the folder, the program against the allow-list, git's own rules and
 * hardening, and a confirmation for destructive commands. Throws GuardError with the reason when refused.
 */
export async function prepareRun(input: { allowed: string[]; cwd: string; line: string; confirmed: boolean; commitAuthor: string; sandboxed?: boolean }): Promise<PreparedRun> {
  const scope = scopeOf(input.allowed, input.cwd);
  if (!scope) throw new GuardError("That folder is outside what the terminal may use.");
  const cwd = await jailPath(scope, input.cwd, true);
  const line = input.line.trim();
  const argv = parseCommand(line);
  const sandboxed = input.sandboxed ?? process.platform === "darwin";
  const program = checkProgram(argv, { who: "human", sandboxed, network: true });
  let full = argv;
  if (program === "git") {
    checkGit(argv, { delivery: "push" });
    full = ["git", ...gitHardening(true, input.commitAuthor), ...argv.slice(1)];
  }
  const warning = DESTRUCTIVE.find(([pattern]) => pattern.test(line))?.[1];
  if (warning && !input.confirmed) return { kind: "confirm", message: warning };
  return { kind: "run", argv, full, cwd, scope, sandboxed };
}

/** The web terminal runs under the OS sandbox wherever this computer has one; the local page keeps its macOS-only rule. */
export function webTerminalSandboxed(): boolean {
  return sandboxAvailable();
}
