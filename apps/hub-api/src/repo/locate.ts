import type { PrismaClient } from "@prisma/client";
import { getAccount } from "../connectors/accounts.js";
import { env } from "../config.js";
import { allowedRepo, discoverRepos, git } from "../lib/git.js";
import { githubToken } from "../lib/git-auth.js";
import { loadSettings } from "../lib/settings.js";
import { usableCodeRoots } from "../lib/code-folders.js";
import { expandHome } from "../workspace/guard.js";
import { cleanRemote, ensureMirror, mirrorAuth, overviewViaGitHub } from "./mirror.js";
import { buildOverview, readBounded, RepoReadError, type RepoOverview } from "./read.js";

/** owner/name from a remote URL. Userinfo (tokens) is never returned. */
export function remoteSlug(url: string): string | null {
  const trimmed = url.trim();
  const match = trimmed.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

async function originSlug(root: string): Promise<string | null> {
  try {
    const url = (await git(root, ["remote", "get-url", "origin"])).trim();
    return remoteSlug(url);
  } catch {
    return null;
  }
}

export async function allowedRoots(prisma: PrismaClient, userId: string): Promise<string[]> {
  const settings = await loadSettings(prisma, userId);
  const [jobs, reviews] = await Promise.all([
    prisma.workspaceJob.findMany({ where: { userId }, select: { repoPath: true }, distinct: ["repoPath"] }),
    prisma.codeReview.findMany({ where: { userId }, select: { repoPath: true }, distinct: ["repoPath"] }),
  ]);
  return [expandHome(env.ENSEMBLE_WORKSPACE_ROOT), ...(await usableCodeRoots(settings)), ...jobs.map((job) => job.repoPath), ...reviews.map((review) => review.repoPath)].filter(
    (path): path is string => Boolean(path),
  );
}

/** The local checkout for this person's repo row, or an error. Absolute paths stay on the server. */
export async function locateCheckout(prisma: PrismaClient, userId: string, repoId: string): Promise<{ fullName: string; root: string }> {
  const row = await prisma.repo.findFirst({ where: { id: repoId, userId, deletedAt: null }, select: { fullName: true } });
  if (!row) throw new RepoReadError("That repo is not on your account.", 404);
  const roots = await allowedRoots(prisma, userId);
  let checkouts: string[] = [];
  try {
    checkouts = await discoverRepos(roots);
  } catch {
    checkouts = [];
  }
  const wanted = row.fullName.toLowerCase();
  for (const candidate of checkouts) {
    let root = candidate;
    try {
      root = await allowedRepo(candidate, roots);
    } catch {
      continue;
    }
    const slug = await originSlug(root);
    if (slug && slug.toLowerCase() === wanted) return { fullName: row.fullName, root };
  }
  throw new RepoReadError("No local checkout of that repo is in your allowed folders.", 404);
}

async function accessToken(prisma: PrismaClient, userId: string): Promise<string | null> {
  const saved = await githubToken(prisma, userId);
  if (saved) return saved;
  const account = await getAccount(userId, "github");
  return account?.accessToken ?? null;
}

export interface ResolvedRepo {
  fullName: string;
  root: string;
  via: "checkout" | "mirror" | "github";
  cached: boolean;
}

/** Local checkout when one is allowed. Otherwise a cached shallow mirror. GitHub is the last resort. */
export async function resolveRepo(prisma: PrismaClient, userId: string, repoId: string): Promise<ResolvedRepo> {
  const row = await prisma.repo.findFirst({ where: { id: repoId, userId, deletedAt: null }, select: { fullName: true, url: true } });
  if (!row) throw new RepoReadError("That repo is not on your account.", 404);
  try {
    const located = await locateCheckout(prisma, userId, repoId);
    return { fullName: located.fullName, root: located.root, via: "checkout", cached: false };
  } catch (error) {
    if (!(error instanceof RepoReadError) || /not on your account/i.test(error.message)) throw error;
  }
  const remote = cleanRemote(row.url, row.fullName);
  const auth = await mirrorAuth(prisma, userId, remote);
  const mirror = await ensureMirror({ userId, fullName: row.fullName, remote, auth });
  return { fullName: row.fullName, root: mirror.root, via: "mirror", cached: mirror.cached };
}

export async function overviewFor(prisma: PrismaClient, userId: string, repoId: string): Promise<{ fullName: string; via: string; cached: boolean } & RepoOverview> {
  const row = await prisma.repo.findFirst({ where: { id: repoId, userId, deletedAt: null }, select: { fullName: true, url: true } });
  if (!row) throw new RepoReadError("That repo is not on your account.", 404);
  try {
    const located = await locateCheckout(prisma, userId, repoId);
    return { fullName: located.fullName, via: "checkout", cached: false, ...(await buildOverview(located.root)) };
  } catch (error) {
    if (!(error instanceof RepoReadError) || /not on your account/i.test(error.message)) throw error;
  }
  const remote = cleanRemote(row.url, row.fullName);
  try {
    const auth = await mirrorAuth(prisma, userId, remote);
    const mirror = await ensureMirror({ userId, fullName: row.fullName, remote, auth });
    return { fullName: row.fullName, via: "mirror", cached: mirror.cached, ...(await buildOverview(mirror.root)) };
  } catch (error) {
    if (!(error instanceof RepoReadError)) throw error;
    if (/private|too long|larger than/i.test(error.message)) throw error;
    if (!/github\.com/i.test(remote)) throw error;
    try {
      const overview = await overviewViaGitHub({ fullName: row.fullName, token: await accessToken(prisma, userId) });
      return { fullName: row.fullName, via: "github", cached: false, ...overview };
    } catch (fallback) {
      if (fallback instanceof RepoReadError) throw fallback;
      throw error;
    }
  }
}

export async function fileFor(prisma: PrismaClient, userId: string, repoId: string, path: string) {
  const resolved = await resolveRepo(prisma, userId, repoId);
  if (!resolved.root) throw new RepoReadError("That file is not available from the remote summary. Open a checkout to read it.", 404);
  const file = await readBounded(resolved.root, path);
  return { fullName: resolved.fullName, via: resolved.via, ...file };
}
