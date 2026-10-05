/**
 * Git for the Code tab — review hunks, source control, and Actions.
 *
 * Every call runs the trusted host git (hostExecutable, never a repo-local
 * binary) with an explicit cwd, and every path is resolved and re-checked to
 * sit inside the repository before it is read or written.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { hostExecutable, isWithin } from "../workspace/policy.js";
import { dropWhere, readLru, remember } from "./bounded.js";

export class GitError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export async function git(
  repo: string,
  args: string[],
  options: { input?: string; okCodes?: number[] } = {},
): Promise<string> {
  const bin = await hostExecutable("git");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      cwd: repo,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      if (code === 0 || options.okCodes?.includes(code ?? -1)) resolvePromise(stdout);
      else reject(new GitError(Buffer.concat(err).toString("utf8").trim().slice(0, 600) || `git exited ${code}`));
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Resolves a path the engineer asked for and refuses anything outside the allowed roots. */
export async function allowedRepo(candidate: string, roots: string[]): Promise<string> {
  if (!isAbsolute(candidate)) throw new GitError("Repository paths must be absolute.");
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new GitError("That folder does not exist.", 404);
  }
  const allowed = await Promise.all(roots.filter(Boolean).map((root) => realpath(root).catch(() => root)));
  if (!allowed.some((root) => isWithin(root, real, true))) {
    throw new GitError("That folder is outside the workspace and the folders Code can use (Settings).", 403);
  }
  const top = (await git(real, ["rev-parse", "--show-toplevel"])).trim();
  return top;
}

export function insideRepo(repo: string, path: string): string {
  const full = resolve(repo, path);
  if (!isWithin(repo, full)) throw new GitError("That file is outside the repository.", 403);
  return full;
}

const repoLists = new Map<string, { at: number; repos: string[] }>();
const REPO_LIST_TTL_MS = 20_000;
const REPO_LIST_MAX = 32;
/** A huge home folder must not hold Settings open. Return what was found. */
const REPO_WALK_BUDGET_MS = 350;

export async function discoverRepos(roots: string[], depth = 2): Promise<string[]> {
  const key = `${depth}\0${roots.filter(Boolean).sort().join("\0")}`;
  const now = Date.now();
  dropWhere(repoLists, (value) => now - value.at >= REPO_LIST_TTL_MS);
  const hit = readLru(repoLists, key);
  if (hit && now - hit.at < REPO_LIST_TTL_MS) return hit.repos;
  const found = new Set<string>();
  const deadline = Date.now() + REPO_WALK_BUDGET_MS;
  async function walk(dir: string, level: number): Promise<void> {
    if (Date.now() > deadline) return;
    try {
      const info = await stat(join(dir, ".git")).catch(() => null);
      if (info) {
        found.add(dir);
        return;
      }
      if (level >= depth) return;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          await walk(join(dir, entry.name), level + 1);
        }
      }
    } catch {
      // unreadable folders are skipped
    }
  }
  for (const root of roots.filter(Boolean)) await walk(root, 0);
  const repos = [...found].sort();
  remember(repoLists, key, { at: Date.now(), repos }, REPO_LIST_MAX);
  return repos;
}

// ── changes & hunks ───────────────────────────────────────────────────────

export interface ChangedFile {
  path: string;
  status: "A" | "M" | "D" | "R" | "U";
  added: number;
  removed: number;
  binary: boolean;
}

/** Diff the working tree against the index rather than a commit — what is not yet staged. */
export const INDEX = ":index";
const revArgs = (base: string): string[] => (base === INDEX ? [] : [base]);

export async function changedFiles(repo: string, base: string): Promise<ChangedFile[]> {
  const [numstat, names, untracked] = await Promise.all([
    git(repo, ["diff", "--numstat", "--no-renames", ...revArgs(base), "--"]),
    git(repo, ["diff", "--name-status", "--no-renames", ...revArgs(base), "--"]),
    git(repo, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const statuses = new Map<string, string>();
  for (const line of names.split("\n").filter(Boolean)) {
    const [status, ...rest] = line.split("\t");
    statuses.set(rest.join("\t"), status!.charAt(0));
  }
  const files: ChangedFile[] = numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...rest] = line.split("\t");
      const path = rest.join("\t");
      return {
        path,
        status: (statuses.get(path) ?? "M") as ChangedFile["status"],
        added: added === "-" ? 0 : Number(added),
        removed: removed === "-" ? 0 : Number(removed),
        binary: added === "-",
      };
    });
  for (const path of untracked.split("\n").filter(Boolean)) {
    if (files.some((file) => file.path === path)) continue;
    let added = 0;
    let binary = false;
    try {
      const content = await readFile(join(repo, path));
      binary = content.includes(0);
      added = binary ? 0 : content.toString("utf8").split("\n").length;
    } catch {
      binary = true;
    }
    files.push({ path, status: "U", added, removed: 0, binary });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export interface DiffLine {
  type: "context" | "add" | "del";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface Hunk {
  key: string;
  header: string;
  oldStart: number;
  newStart: number;
  added: number;
  removed: number;
  lines: DiffLine[];
  raw: string;
}

export interface FileDiff {
  path: string;
  fileHeader: string;
  hunks: Hunk[];
  isNew: boolean;
  binary: boolean;
}

export async function fileDiff(repo: string, base: string, path: string, untracked: boolean): Promise<FileDiff> {
  insideRepo(repo, path);
  const text = untracked
    ? await git(repo, ["diff", "--no-color", "--no-index", "-U3", "--", "/dev/null", path], { okCodes: [1] })
    : await git(repo, ["diff", "--no-color", "--no-renames", "-U3", ...revArgs(base), "--", path]);
  return parseDiff(path, text);
}

export function parseDiff(path: string, text: string): FileDiff {
  const lines = text.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  const fileHeader = (firstHunk < 0 ? lines : lines.slice(0, firstHunk)).join("\n");
  const binary = /Binary files/.test(fileHeader);
  const hunks: Hunk[] = [];
  if (firstHunk >= 0) {
    let current: Hunk | null = null;
    let oldNo = 0;
    let newNo = 0;
    const rawLines: string[] = [];
    const flush = () => {
      if (!current) return;
      current.raw = rawLines.join("\n");
      current.key = createHash("sha1").update(`${path}\n${current.raw}`).digest("hex").slice(0, 16);
      hunks.push(current);
      rawLines.length = 0;
    };
    for (const line of lines.slice(firstHunk)) {
      const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (header) {
        flush();
        oldNo = Number(header[1]);
        newNo = Number(header[2]);
        current = { key: "", header: line, oldStart: oldNo, newStart: newNo, added: 0, removed: 0, lines: [], raw: "" };
        rawLines.push(line);
        continue;
      }
      if (!current) continue;
      if (line.startsWith("\\")) {
        rawLines.push(line);
        continue;
      }
      if (line === "" && rawLines.length && line === lines[lines.length - 1]) continue;
      const mark = line.charAt(0);
      const body = line.slice(1);
      if (mark === "+") {
        current.lines.push({ type: "add", text: body, oldNo: null, newNo: newNo++ });
        current.added += 1;
      } else if (mark === "-") {
        current.lines.push({ type: "del", text: body, oldNo: oldNo++, newNo: null });
        current.removed += 1;
      } else {
        current.lines.push({ type: "context", text: body, oldNo: oldNo++, newNo: newNo++ });
      }
      rawLines.push(line);
    }
    flush();
  }
  return { path, fileHeader, hunks, isNew: /new file mode|--- \/dev\/null/.test(fileHeader), binary };
}

function patchFor(diff: FileDiff, hunk: Hunk): string {
  const header = diff.fileHeader
    .replace(/^diff --git a\/dev\/null /m, `diff --git a/${diff.path} `)
    .trimEnd();
  return `${header}\n${hunk.raw}\n`;
}

/** Puts the old lines of one hunk back on disk. */
export async function revertHunk(repo: string, diff: FileDiff, hunk: Hunk): Promise<void> {
  await git(repo, ["apply", "-R", "--recount", "--whitespace=nowarn", "-"], { input: patchFor(diff, hunk) });
}

/** Stages one hunk, leaving the rest of the file unstaged. */
export async function stageHunk(repo: string, diff: FileDiff, hunk: Hunk): Promise<void> {
  if (diff.isNew) {
    await git(repo, ["add", "--", diff.path]);
    return;
  }
  await git(repo, ["apply", "--cached", "--recount", "--whitespace=nowarn", "-"], { input: patchFor(diff, hunk) });
}

export async function readRepoFile(repo: string, path: string): Promise<string> {
  return readFile(insideRepo(repo, path), "utf8");
}

export async function writeRepoFile(repo: string, path: string, content: string): Promise<void> {
  await writeFile(insideRepo(repo, path), content, "utf8");
}

// ── source control ────────────────────────────────────────────────────────

export interface ScmEntry {
  path: string;
  index: string;
  worktree: string;
}

export async function status(repo: string) {
  const raw = await git(repo, ["status", "--porcelain=v1", "-b", "--untracked-files=all"]);
  const lines = raw.split("\n").filter(Boolean);
  const head = lines.shift() ?? "";
  const branchMatch = head.match(/^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.+)\])?/);
  const tracking = branchMatch?.[3] ?? "";
  const entries: ScmEntry[] = lines.map((line) => ({
    index: line.charAt(0),
    worktree: line.charAt(1),
    path: line.slice(3).replace(/^.* -> /, ""),
  }));
  const log = await git(repo, ["log", "-n", "15", "--pretty=format:%H%x1f%an%x1f%ar%x1f%s"], { okCodes: [128] }).catch(() => "");
  const remote = await git(repo, ["remote", "get-url", "origin"]).then((v) => v.trim()).catch(() => "");
  return {
    repo,
    name: relative(resolve(repo, ".."), repo),
    branch: branchMatch?.[1] ?? "HEAD",
    upstream: branchMatch?.[2] ?? null,
    ahead: Number(tracking.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(tracking.match(/behind (\d+)/)?.[1] ?? 0),
    staged: entries.filter((entry) => entry.index !== " " && entry.index !== "?"),
    unstaged: entries.filter((entry) => entry.worktree !== " " && entry.index !== "?"),
    untracked: entries.filter((entry) => entry.index === "?"),
    log: log
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, author, when, subject] = line.split("\x1f");
        return { sha: sha!, author: author!, when: when!, subject: subject! };
      }),
    remote,
    github: githubSlug(remote),
  };
}

export function githubSlug(remote: string): string | null {
  const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

export async function githubActions(slug: string, branch?: string) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { available: false as const, reason: "Set GITHUB_TOKEN to see Actions runs." };
  const url = new URL(`https://api.github.com/repos/${slug}/actions/runs`);
  url.searchParams.set("per_page", "10");
  if (branch) url.searchParams.set("branch", branch);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "ensemble" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return { available: false as const, reason: `GitHub answered ${response.status}.` };
  const body = (await response.json()) as {
    workflow_runs?: Array<{
      id: number;
      name: string;
      display_title: string;
      status: string;
      conclusion: string | null;
      head_branch: string;
      html_url: string;
      created_at: string;
      event: string;
    }>;
  };
  return {
    available: true as const,
    runs: (body.workflow_runs ?? []).map((run) => ({
      id: run.id,
      workflow: run.name,
      title: run.display_title,
      status: run.status,
      conclusion: run.conclusion,
      branch: run.head_branch,
      url: run.html_url,
      createdAt: run.created_at,
      event: run.event,
    })),
  };
}
