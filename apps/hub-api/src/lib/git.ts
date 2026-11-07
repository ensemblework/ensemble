/**
 * Git for the Code tab — review hunks, source control, and Actions.
 *
 * Every call runs the trusted host git (hostExecutable, never a repo-local
 * binary) with an explicit cwd, and every path is resolved and re-checked to
 * sit inside the repository before it is read or written.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { zipSync } from "fflate";
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

/**
 * A remote reduced to the name people know it by: `owner/repo` for a hosted remote, the folder name for
 * a local one. Never the URL itself, which can carry a sign-in.
 */
export function remoteName(url: string): string | null {
  const clean = url.trim().replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  if (!clean) return null;
  const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(clean);
  const hosted = scp !== null || /^[a-z][a-z0-9+.-]*:\/\//i.test(clean);
  let path = scp?.[1] ?? clean;
  if (!scp && hosted) {
    try {
      path = new URL(clean).pathname;
    } catch {
      return null;
    }
  }
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return null;
  const file = /^file:/i.test(clean);
  return (hosted && !file ? parts.slice(-2).join("/") : parts.at(-1)!).slice(0, 200);
}

const LABEL_FILE_MAX = 64 * 1024;

async function readSmall(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > LABEL_FILE_MAX) return null;
  return readFile(path, "utf8").catch(() => null);
}

/**
 * What the Code tab shows next to a checkout: its branch, its origin's name and when it was last used.
 * Read from git's own files, so no git process starts and none of the repository's configuration runs.
 */
export async function repoLabelInfo(repo: string): Promise<{ branch: string | null; remote: string | null; at: string | null }> {
  let gitDir = join(repo, ".git");
  const dotGit = await stat(gitDir).catch(() => null);
  if (!dotGit) return { branch: null, remote: null, at: null };
  if (dotGit.isFile()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec((await readSmall(gitDir)) ?? "")?.[1]?.trim();
    if (!pointer) return { branch: null, remote: null, at: null };
    gitDir = resolve(repo, pointer);
  }
  const common = (await readSmall(join(gitDir, "commondir")))?.trim();
  const commonDir = common ? resolve(gitDir, common) : gitDir;
  const head = (await readSmall(join(gitDir, "HEAD"))) ?? "";
  const branch = /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim().slice(0, 200) ?? null;
  const config = (await readSmall(join(commonDir, "config"))) ?? "";
  let inOrigin = false;
  let url: string | null = null;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[\s*([^\]"\s]+)(?:\s+"([^"]*)")?\s*\]/.exec(line);
    if (section) {
      inOrigin = section[1]!.toLowerCase() === "remote" && section[2] === "origin";
      continue;
    }
    const value = inOrigin ? /^\s*url\s*=\s*(.+?)\s*$/i.exec(line)?.[1] : undefined;
    if (value) {
      url = value.replace(/^"(.*)"$/, "$1");
      break;
    }
  }
  const times = await Promise.all(["HEAD", "index", join("logs", "HEAD")].map((name) => stat(join(gitDir, name)).then((info) => info.mtimeMs).catch(() => 0)));
  const latest = Math.max(...times);
  return { branch, remote: url ? remoteName(url) : null, at: latest ? new Date(latest).toISOString() : null };
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

/** What the Code tab opens; larger files are refused before they are read. */
export const REPO_FILE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Where `path` really is: inside the repository after links are followed, never in git's own folder.
 * A link that leads out of the repository is refused, for reading and for writing; a new file is
 * placed by its folder's real path.
 */
async function realInside(repo: string, path: string, forWrite: boolean): Promise<string> {
  const full = insideRepo(repo, path);
  if (path.split(/[\\/]/).some((part) => part.toLowerCase().replace(/[. ]+$/, "") === ".git")) {
    throw new GitError("Git's own files are not opened here.", 403);
  }
  const realRepo = await realpath(repo);
  let target: string;
  try {
    target = await realpath(full);
  } catch (error) {
    if (!forWrite || (error as NodeJS.ErrnoException).code !== "ENOENT") throw new GitError("That file is not in the repository.", 404);
    target = join(await realpath(dirname(full)).catch(() => { throw new GitError("That folder is not in the repository.", 404); }), basename(full));
  }
  if (!isWithin(realRepo, target)) throw new GitError("That file is a link to somewhere outside the repository.", 403);
  return target;
}

export async function readRepoFile(repo: string, path: string): Promise<string> {
  const target = await realInside(repo, path, false);
  const info = await stat(target);
  if (!info.isFile()) throw new GitError("That is not a file.", 422);
  if (info.size > REPO_FILE_MAX_BYTES) throw new GitError("Files over 5 MB are not opened here.", 413);
  return readFile(target, "utf8");
}

export async function writeRepoFile(repo: string, path: string, content: string): Promise<void> {
  await writeRepoBytes(repo, path, Buffer.from(content, "utf8"));
}

/** The file's bytes, or null when it is not there (deleted). Same rules as `readRepoFile`. */
export async function readRepoBytes(repo: string, path: string): Promise<Buffer | null> {
  let target: string;
  try {
    target = await realInside(repo, path, false);
  } catch (error) {
    if (error instanceof GitError && error.statusCode === 404) return null;
    throw error;
  }
  const info = await stat(target);
  if (!info.isFile()) throw new GitError("That is not a file.", 422);
  if (info.size > REPO_FILE_MAX_BYTES) throw new GitError("Files over 5 MB are not opened here.", 413);
  return readFile(target);
}

export async function writeRepoBytes(repo: string, path: string, bytes: Buffer): Promise<void> {
  const target = await realInside(repo, path, true);
  const info = await stat(target).catch(() => null);
  if (info && !info.isFile()) throw new GitError("That is not a file.", 422);
  await writeFile(target, bytes);
}

export async function removeRepoFile(repo: string, path: string): Promise<void> {
  const target = await realInside(repo, path, true);
  await rm(target, { force: true });
}

/**
 * A new empty file or folder at `target` (absolute), with the folders it needs. The deepest folder that
 * is there already must really be somewhere `allowed` says (a link on the way cannot lead out), git's
 * own files are never made, and what is already there is never overwritten (409).
 */
async function createAt(target: string, kind: "file" | "folder", allowed: (real: string) => boolean): Promise<void> {
  if (target.split(/[\\/]/).some((part) => part.toLowerCase().replace(/[. ]+$/, "") === ".git")) throw new GitError("Git's own files are not made here.", 403);
  const name = basename(target);
  if (!name || name === "." || name === "..") throw new GitError("Give it a name.", 422);
  const missing: string[] = [];
  let existing = dirname(target);
  for (;;) {
    const real = await realpath(existing).catch(() => null);
    if (real) {
      existing = real;
      break;
    }
    missing.unshift(basename(existing));
    const up = dirname(existing);
    if (up === existing) throw new GitError("That folder does not exist.", 404);
    existing = up;
  }
  if (!allowed(existing)) throw new GitError("That place is outside the workspace and the folders Code can use (Settings).", 403);
  if (!(await stat(existing)).isDirectory()) throw new GitError("That is not a folder.", 422);
  const parent = join(existing, ...missing);
  if (missing.length) await mkdir(parent, { recursive: true });
  try {
    if (kind === "folder") await mkdir(join(parent, name));
    else await writeFile(join(parent, name), "", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new GitError(`${name} is already there.`, 409);
    throw error;
  }
}

/** A new empty file or folder in the repository, at a path from its top (`src/new.ts`). */
export async function createRepoEntry(repo: string, path: string, kind: "file" | "folder"): Promise<void> {
  const realRepo = await realpath(repo);
  await createAt(insideRepo(repo, path), kind, (real) => isWithin(realRepo, real, true));
}

/** A new empty file or folder at a full path the person typed, inside one of `roots` (the workspace, the folders Code can use). */
export async function createInRoots(roots: string[], absolute: string, kind: "file" | "folder"): Promise<string> {
  if (!isAbsolute(absolute)) throw new GitError("Type a full path, starting with / or ~/.", 422);
  const target = resolve(absolute);
  const allowed = (await Promise.all(roots.filter(Boolean).map((root) => realpath(root).catch(() => null)))).filter((root): root is string => Boolean(root));
  await createAt(target, kind, (real) => allowed.some((root) => isWithin(root, real, true)));
  return target;
}

const isGitName = (name: string) => name.toLowerCase().replace(/[. ]+$/, "") === ".git";
const cleanPath = (path: string) => path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

/**
 * The entry itself at `path` (a link is the link, not where it leads), inside the repository: its folder
 * must really be in the repository, and git's own files are never touched.
 */
async function entryInside(repo: string, path: string): Promise<string> {
  const clean = cleanPath(path);
  if (!clean) throw new GitError("Choose a file or folder.", 422);
  if (clean.split("/").some(isGitName)) throw new GitError("Git's own files are not changed here.", 403);
  const folder = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
  const parent = folder ? await realInside(repo, folder, false) : await realpath(repo);
  const full = join(parent, basename(clean));
  if (!(await lstat(full).catch(() => null))) throw new GitError("That is not in the repository any more.", 404);
  return full;
}

/** Renames or moves a file or folder inside the repository, as an explorer does. Nothing there already is overwritten (409). */
export async function moveRepoEntry(repo: string, from: string, to: string): Promise<void> {
  const source = await entryInside(repo, from);
  const clean = cleanPath(to);
  const name = basename(clean);
  if (!clean || !name || name === "." || name === "..") throw new GitError("Give it a name.", 422);
  if (clean.split("/").some(isGitName)) throw new GitError("Git's own files are not made here.", 403);
  const folder = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
  const parent = folder ? await realInside(repo, folder, false) : await realpath(repo);
  if (!(await stat(parent)).isDirectory()) throw new GitError("That is not a folder.", 422);
  const target = join(parent, name);
  if (target === source) return;
  if ((await lstat(source)).isDirectory() && (target + sep).startsWith(source + sep)) throw new GitError("A folder cannot go inside itself.", 422);
  // A case-only rename (readme.md → README.md) is the same entry on case-insensitive disks.
  const there = await lstat(target).catch(() => null);
  if (there && target.toLowerCase() !== source.toLowerCase()) throw new GitError(`${name} is already there.`, 409);
  await rename(source, target);
}

/** Deletes a file or a whole folder from the repository (never the repository itself, never git's own files). */
export async function deleteRepoEntry(repo: string, path: string): Promise<void> {
  const full = await entryInside(repo, path);
  const info = await lstat(full);
  await rm(full, { recursive: info.isDirectory(), force: true });
}

/** What a download from Code may weigh: one file, or a folder's files before they are zipped. */
export const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_MAX_FILES = 5000;

/**
 * A file's bytes, or a folder (or the whole repository, `path` empty) as a zip of the files git would
 * show: tracked and new ones, not ignored (no node_modules, no build output), and no files of keys or
 * secrets (`skip`). Over 20 MB is refused with 413 rather than cut short.
 */
export async function packRepoEntry(repo: string, path: string, skip: (path: string) => boolean = () => false): Promise<{ name: string; kind: "file" | "zip"; bytes: Uint8Array; files: number }> {
  const clean = cleanPath(path);
  const realRepo = await realpath(repo);
  const target = clean ? await realInside(repo, clean, false) : realRepo;
  const info = await stat(target);
  if (info.isFile()) {
    if (skip(clean)) throw new GitError("Files of keys or secrets are not downloaded from here.", 403);
    if (info.size > DOWNLOAD_MAX_BYTES) throw new GitError("Files over 20 MB are not downloaded from here.", 413);
    return { name: basename(target), kind: "file", bytes: await readFile(target), files: 1 };
  }
  if (!info.isDirectory()) throw new GitError("That is not a file or a folder.", 422);
  const raw = await git(repo, ["-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", clean || "."]);
  const paths = [...new Set(raw.split("\0").filter(Boolean))].filter((file) => !skip(file));
  if (paths.length > DOWNLOAD_MAX_FILES) throw new GitError(`That folder has more than ${DOWNLOAD_MAX_FILES.toLocaleString("en")} files; download a smaller one.`, 413);
  const root = basename(target);
  const entries: Record<string, Uint8Array> = {};
  let total = 0;
  for (const file of paths) {
    const full = await realInside(repo, file, false).catch(() => null);
    const fileInfo = full ? await stat(full).catch(() => null) : null;
    if (!full || !fileInfo?.isFile()) continue;
    total += fileInfo.size;
    if (total > DOWNLOAD_MAX_BYTES) throw new GitError("That is over 20 MB; download a smaller folder or one file.", 413);
    const inside = clean ? file.slice(clean.length).replace(/^\/+/, "") : file;
    entries[`${root}/${inside}`] = await readFile(full);
  }
  if (!Object.keys(entries).length) throw new GitError("There are no files to download there.", 404);
  return { name: `${root}.zip`, kind: "zip", bytes: zipSync(entries, { level: 6 }), files: Object.keys(entries).length };
}

export type RepoEntry = { name: string; kind: "dir" | "file" | "link"; size: number | null };

/**
 * One folder of the repository for the explorer: folders first, then files, by name; never `.git`.
 * A link is listed as a link and opened only where it really leads inside the repository.
 */
export async function listRepoFolder(repo: string, path: string, max = 2000): Promise<{ entries: RepoEntry[]; truncated: boolean }> {
  const target = path ? await realInside(repo, path, false) : await realpath(repo);
  if (!(await stat(target)).isDirectory()) throw new GitError("That is not a folder.", 422);
  const dirents = await readdir(target, { withFileTypes: true });
  const entries: RepoEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.toLowerCase().replace(/[. ]+$/, "") === ".git") continue;
    const full = join(target, dirent.name);
    if (dirent.isSymbolicLink()) {
      const real = await realpath(full).catch(() => null);
      const inside = real && isWithin(await realpath(repo), real);
      const info = inside ? await stat(real!).catch(() => null) : null;
      entries.push({ name: dirent.name, kind: info?.isDirectory() ? "dir" : info?.isFile() ? "file" : "link", size: info?.isFile() ? info.size : null });
      continue;
    }
    const size = dirent.isFile() ? await stat(full).then((info) => info.size, () => null) : null;
    entries.push({ name: dirent.name, kind: dirent.isDirectory() ? "dir" : "file", size });
  }
  entries.sort((a, b) => ((a.kind === "dir") === (b.kind === "dir") ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return { entries: entries.slice(0, max), truncated: entries.length > max };
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
