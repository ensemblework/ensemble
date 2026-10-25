/**
 * What an agent changed in its run folder, file by file: the diff between the folder's tree at the
 * start and at the end, with each file's status and line counts. A repository the agent cloned into
 * the folder is not a change of its own (git records it as one "gitlink" entry); what the agent then
 * changed inside it is, relative to that clone's own HEAD.
 */
import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";

export type ChangedFile = {
  path: string;
  status: "added" | "modified" | "deleted";
  added: number;
  removed: number;
  /** Not text (git's numstat shows "-"). */
  binary?: boolean;
};

/** Runs git with these arguments in `cwd` (a folder inside the run folder), as Ensemble's sandboxed git. */
export type GitRunner = (args: string[], cwd: string) => Promise<{ exitCode: number; output: string }>;

export const MAX_CHANGED_FILES = 200;
const GITLINK = "160000";

function statusOf(letter: string): ChangedFile["status"] {
  return letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
}

/** `git diff --raw -z`: `:old new oldsha newsha S\0path\0` per entry. */
export function parseRaw(text: string): Array<{ path: string; status: string; oldMode: string; newMode: string }> {
  const parts = text.split("\0");
  const rows: Array<{ path: string; status: string; oldMode: string; newMode: string }> = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const meta = parts[index]!.replace(/^\n/, "");
    const path = parts[index + 1]!;
    const match = /^:(\d{6}) (\d{6}) \S+ \S+ ([A-Z])/.exec(meta);
    if (!match || !path) continue;
    rows.push({ oldMode: match[1]!, newMode: match[2]!, status: match[3]!, path });
  }
  return rows;
}

/** `git diff --numstat -z`: `added\tremoved\tpath\0` ("-" for binary files). */
export function parseNumstat(text: string): Map<string, { added: number; removed: number; binary: boolean }> {
  const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (const entry of text.split("\0")) {
    const line = entry.replace(/^\n/, "");
    const [added, removed, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    const binary = added === "-" && removed === "-";
    counts.set(path, { added: Number(added) || 0, removed: Number(removed) || 0, binary });
  }
  return counts;
}

/** `git status --porcelain=v1 -z`: `XY path\0` per entry. */
export function parseStatus(text: string): Array<{ path: string; code: string }> {
  return text
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) }));
}

const COUNT_BYTES = 1024 * 1024;

/** Lines in an untracked file: a regular file only (not a link, pipe or device), its first megabyte. */
export async function lineCount(path: string): Promise<{ lines: number; binary: boolean }> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { lines: 0, binary: false };
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(info.size, COUNT_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.subarray(0, 8000).includes(0)) return { lines: 0, binary: true };
      const text = bytes.toString("utf8");
      return { lines: text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0, binary: false };
    } finally {
      await handle.close();
    }
  } catch {
    return { lines: 0, binary: false };
  }
}

/**
 * Git settings in a repository's own config that run a program when git reads its files (filters,
 * diff and merge drivers, fsmonitor, includes). A cloned repository with any of them is not read.
 */
const RUNS_PROGRAMS = /^\s*\[\s*(filter|diff|merge|include|includeif)\b|^\s*(fsmonitor|hookspath|sshcommand|askpass|helper|pager|editor|textconv|clean|smudge|process|driver|uploadpack|receivepack)\s*=/im;

export async function runsPrograms(repo: string): Promise<boolean> {
  try {
    return RUNS_PROGRAMS.test(await readFile(join(repo, ".git", "config"), "utf8"));
  } catch {
    // No readable config (a .git file, say): do not run git there.
    return true;
  }
}

/** Files changed inside a repository the run cloned or made: relative to its own HEAD, untracked files included. */
async function changesInNested(git: GitRunner, root: string, dir: string, room: number): Promise<ChangedFile[]> {
  const absolute = join(root, dir);
  if (await runsPrograms(absolute)) return [];
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], absolute);
  if (status.exitCode !== 0) return [];
  const entries = parseStatus(status.output).slice(0, room);
  if (!entries.length) return [];
  const tracked = await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", "HEAD"], absolute);
  const counts = tracked.exitCode === 0 ? parseNumstat(tracked.output) : new Map<string, { added: number; removed: number; binary: boolean }>();
  const files: ChangedFile[] = [];
  for (const entry of entries) {
    // A repository inside the clone is the clone's business, not a file.
    if (entry.path.endsWith("/")) continue;
    const untracked = entry.code === "??";
    const deleted = entry.code.includes("D");
    const count = counts.get(entry.path);
    const local = untracked && !count ? await lineCount(join(absolute, entry.path)) : null;
    files.push({
      path: `${dir}/${entry.path}`,
      status: untracked || entry.code.includes("A") ? "added" : deleted ? "deleted" : "modified",
      added: count?.added ?? local?.lines ?? 0,
      removed: count?.removed ?? 0,
      ...((count?.binary ?? local?.binary) ? { binary: true } : {}),
    });
  }
  return files;
}

/**
 * The run's changes between two snapshots of its folder. Cloned repositories are skipped as entries;
 * the agent's own changes inside them are listed with the repository's folder in front. `nested` names
 * the repositories that appeared or changed during the run.
 */
export async function agentChanges(git: GitRunner, root: string, startTree: string, endTree: string): Promise<{ files: ChangedFile[]; nested: string[] }> {
  // No rename detection: a rename is a deletion and an addition, one path per entry.
  const raw = await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--raw", "-z", startTree, endTree], root);
  const numstat = await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", startTree, endTree], root);
  if (raw.exitCode !== 0) return { files: [], nested: [] };
  const counts = parseNumstat(numstat.output);
  const files: ChangedFile[] = [];
  const nested: string[] = [];
  for (const row of parseRaw(raw.output)) {
    if (row.newMode === GITLINK) {
      nested.push(row.path);
      continue;
    }
    // A repository that was there at the start and is gone now: not file changes either.
    if (row.oldMode === GITLINK) continue;
    if (files.length >= MAX_CHANGED_FILES) break;
    const count = counts.get(row.path);
    files.push({ path: row.path, status: statusOf(row.status), added: count?.added ?? 0, removed: count?.removed ?? 0, ...(count?.binary ? { binary: true } : {}) });
  }
  for (const dir of nested) {
    if (files.length >= MAX_CHANGED_FILES) break;
    files.push(...(await changesInNested(git, root, dir, MAX_CHANGED_FILES - files.length)));
  }
  return { files, nested };
}
