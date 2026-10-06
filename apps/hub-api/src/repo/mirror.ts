/**
 * A link-only repo has no checkout on this machine. The overview still comes
 * from files, not from a prompt-sized dump of GitHub: a shallow partial clone
 * in the app cache, refreshed on a timer or when HEAD moves. The GitHub API
 * is only the fallback when git cannot run.
 *
 * Tokens never go in the remote URL and never go in an error string.
 */
import { execFile } from "node:child_process";
import { requireHostAccess } from "../lib/hosted-access.js";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";
import { githubCloneAuth } from "../lib/git-auth.js";
import { cacheDir } from "../workspace/guard.js";
import { buildOverview, type RepoOverview } from "./read.js";
import { RepoReadError } from "./read.js";

const exec = promisify(execFile);
const TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 25_000;
const MAX_BYTES = 200 * 1024 * 1024;
const fetches = new Map<string, Promise<MirrorHit>>();

export interface GitAuth {
  config: string[];
  env: Record<string, string>;
  missing: boolean;
}

export type GitRunner = (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number }) => Promise<string>;

export interface MirrorHit {
  root: string;
  head: string;
  cached: boolean;
  refreshed: boolean;
}

interface MirrorRequest {
  userId: string;
  fullName: string;
  remote: string;
  ttlMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  now?: number;
  run?: GitRunner;
  auth?: GitAuth;
  cacheRoot?: string;
}

/** Drop userinfo so a saved URL cannot carry a token into git or a log line. */
export function cleanRemote(url: string | null | undefined, fullName: string): string {
  const fallback = `https://github.com/${fullName}.git`;
  const trimmed = url?.trim() ?? "";
  if (!trimmed) return fallback;
  // A filesystem path is a local remote. Leave it alone.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "file:") return trimmed;
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return fallback;
  }
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 80) || "repo";
}

async function defaultRun(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number }): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const err = error as { killed?: boolean; signal?: string; stderr?: string; message?: string; code?: string };
    if (err.killed || err.signal === "SIGKILL") {
      throw new RepoReadError("The repository took too long to fetch.", 504);
    }
    const stderr = typeof err.stderr === "string" ? err.stderr : "";
    const detail = `${stderr}\n${err.message ?? ""}`;
    if (/authentication|could not read username|403|401|repository not found|terminal prompts disabled/i.test(detail)) {
      throw new RepoReadError("That repository is private or not visible, and Ensemble has no usable GitHub credentials for it.", 403);
    }
    if (err.code === "ENOENT") throw new RepoReadError("git is not available on this machine.", 503);
    throw new RepoReadError("Could not fetch that repository.", 502);
  }
}

async function dirBytes(root: string, cap: number): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    if (total > cap) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (total > cap) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        try {
          total += (await stat(full)).size;
        } catch {
          /* a file can vanish mid-walk */
        }
      }
    }
  };
  await walk(root);
  return total;
}

async function readMeta(path: string): Promise<{ fetchedAt: number; head: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { fetchedAt?: number; head?: string };
    if (typeof parsed.fetchedAt !== "number" || typeof parsed.head !== "string") return null;
    return { fetchedAt: parsed.fetchedAt, head: parsed.head };
  } catch {
    return null;
  }
}

/**
 * Shallow partial clone under the app cache, one folder per person and repo.
 * A fresh cache hit does not talk to the network.
 */
export async function ensureMirror(request: MirrorRequest): Promise<MirrorHit> {
  await requireHostAccess(request.userId, "Repository cloning");
  const remote = cleanRemote(request.remote, request.fullName);
  const rootParent = join(request.cacheRoot ?? (await cacheDir()), "repo-mirrors", safeSegment(request.userId), safeSegment(request.fullName));
  const checkout = join(rootParent, "checkout");
  const metaPath = join(rootParent, "meta.json");
  const pending = fetches.get(checkout);
  if (pending) return pending;
  const work = openMirror(request, remote, checkout, metaPath);
  fetches.set(checkout, work);
  try {
    return await work;
  } finally {
    fetches.delete(checkout);
  }
}

async function openMirror(request: MirrorRequest, remote: string, checkout: string, metaPath: string): Promise<MirrorHit> {
  const run = request.run ?? defaultRun;
  const timeout = request.timeoutMs ?? TIMEOUT_MS;
  const ttl = request.ttlMs ?? TTL_MS;
  const maxBytes = request.maxBytes ?? MAX_BYTES;
  const now = request.now ?? Date.now();
  const auth = request.auth ?? { config: [] as string[], env: { GIT_TERMINAL_PROMPT: "0" }, missing: false };
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...auth.env };
  const meta = await readMeta(metaPath);
  const fail = (error: unknown): never => {
    if (error instanceof RepoReadError) throw error;
    const err = error as { killed?: boolean; message?: string };
    const message = err.message ?? "";
    if (err.killed || /timed out|timeout/i.test(message)) throw new RepoReadError("The repository took too long to fetch.", 504);
    if (/authentication|could not read username|403|401|repository not found|terminal prompts disabled/i.test(message)) {
      throw new RepoReadError("That repository is private or not visible, and Ensemble has no usable GitHub credentials for it.", 403);
    }
    throw new RepoReadError("Could not fetch that repository.", 502);
  };
  let exists = false;
  try {
    exists = (await stat(join(checkout, ".git"))).isDirectory();
  } catch {
    exists = false;
  }
  if (exists && meta && now - meta.fetchedAt < ttl) {
    return { root: checkout, head: meta.head, cached: true, refreshed: false };
  }
  await mkdir(dirname(checkout), { recursive: true });
  const git = async (args: string[], cwd?: string) => {
    try {
      return await run(args, { cwd, env, timeout });
    } catch (error) {
      return fail(error);
    }
  };
  if (exists) {
    try {
      await git([...auth.config, "fetch", "--depth", "1", "origin"], checkout);
      await git([...auth.config, "reset", "--hard", "FETCH_HEAD"], checkout);
      const head = (await git(["rev-parse", "HEAD"], checkout)).trim();
      await writeFile(metaPath, JSON.stringify({ fetchedAt: now, head, fullName: request.fullName }));
      return { root: checkout, head, cached: true, refreshed: head !== meta?.head };
    } catch (error) {
      if (meta) return { root: checkout, head: meta.head, cached: true, refreshed: false };
      throw error;
    }
  }
  await rm(checkout, { recursive: true, force: true });
  const clone = ["clone", "--depth", "1", "--filter=blob:none", "--single-branch", remote, checkout];
  try {
    await git([...auth.config, ...clone]);
  } catch (error) {
    if (error instanceof RepoReadError && /private|too long|not available/.test(error.message)) throw error;
    try {
      await rm(checkout, { recursive: true, force: true });
      await git([...auth.config, "clone", "--depth", "1", "--single-branch", remote, checkout]);
    } catch (again) {
      await rm(checkout, { recursive: true, force: true });
      throw again;
    }
  }
  const bytes = await dirBytes(checkout, maxBytes);
  if (bytes > maxBytes) {
    await rm(checkout, { recursive: true, force: true });
    throw new RepoReadError("That repository is larger than the cache allows.", 413);
  }
  const head = (await git(["rev-parse", "HEAD"], checkout)).trim();
  await writeFile(metaPath, JSON.stringify({ fetchedAt: now, head, fullName: request.fullName }));
  return { root: checkout, head, cached: false, refreshed: true };
}

export async function mirrorAuth(prisma: PrismaClient, userId: string, remote: string): Promise<GitAuth> {
  return githubCloneAuth(prisma, userId, remote);
}

interface GitHubTree {
  tree?: Array<{ path?: string; type?: string }>;
  truncated?: boolean;
}

/** Same overview shape, built by downloading only the files the summary needs. */
export async function overviewViaGitHub(options: {
  fullName: string;
  token: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<RepoOverview> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Ensemble",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const call = async (path: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(`https://api.github.com${path}`, { headers, signal: controller.signal });
    } catch {
      throw new RepoReadError("GitHub could not be reached.", 502);
    } finally {
      clearTimeout(timer);
    }
  };
  const repo = await call(`/repos/${options.fullName}`);
  if (repo.status === 401 || repo.status === 403 || repo.status === 404) {
    throw new RepoReadError("That repository is private or not visible, and Ensemble has no usable GitHub credentials for it.", 403);
  }
  if (!repo.ok) throw new RepoReadError("Could not fetch that repository.", 502);
  const meta = (await repo.json()) as { default_branch?: string };
  const branch = meta.default_branch || "HEAD";
  const treeResponse = await call(`/repos/${options.fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (!treeResponse.ok) throw new RepoReadError("Could not list that repository.", 502);
  const tree = (await treeResponse.json()) as GitHubTree;
  const files = (tree.tree ?? []).filter((item) => item.type === "blob" && item.path).map((item) => item.path!);
  const rank = (path: string): number => {
    if (/^apps\/[^/]+\/(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(path)) return 0;
    if (/(^|\/)(readme\.md|schema\.prisma|docker-compose[^/]*\.ya?ml|pnpm-workspace\.yaml)$/i.test(path)) return 1;
    if (/(^|\/)routes?\.(ts|js|py)$/.test(path) || /\/routes\/[^/]+\.(ts|js)$/.test(path)) return 2;
    if (/(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|compose[^/]*\.ya?ml)$/.test(path)) return 3;
    if (/\/(migrations|sql)\/.+\.sql$/.test(path) || /(^|\/)(index|main|server|app)\.(ts|tsx|js|mjs|py|go|rs)$/.test(path)) return 4;
    return 9;
  };
  const wanted = files.filter((path) => rank(path) < 9).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 24);
  const scratch = join(tmpdir(), "ensemble-github-scratch", safeSegment(options.fullName));
  await mkdir(scratch, { recursive: true });
  const dir = await realpath(await mkdtemp(join(scratch, "read-")));
  try {
    const { writeFile: write } = await import("node:fs/promises");
    for (const path of files.slice(0, 200)) {
      const full = join(dir, ...path.split("/"));
      await mkdir(dirname(full), { recursive: true });
      try {
        await write(full, "", { flag: "wx" });
      } catch {
        /* already written */
      }
    }
    for (const path of wanted) {
      const response = await call(`/repos/${options.fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}`);
      if (!response.ok) continue;
      const payload = (await response.json()) as { content?: string; encoding?: string };
      if (payload.encoding !== "base64" || !payload.content) continue;
      const text = Buffer.from(payload.content, "base64").toString("utf8").slice(0, 64_000);
      const full = join(dir, ...path.split("/"));
      await mkdir(dirname(full), { recursive: true });
      await write(full, text);
    }
    return await buildOverview(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
