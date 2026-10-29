/**
 * Git worktrees for parallel work in one repository (ensemble-node docs/design B13; docs/25 §4.12). An
 * Ensemble Node build works in its own worktree of a folder this computer shares, on a local branch named
 * by its mission (detached, for a snapshot), and its check works in that same worktree. Made with
 * Ensemble's own git (hooks off), from the folder's last commit, as `<workspace>/worktrees/<name>`, the
 * same way a run's separate copy is made (folder-claims.ts). A worktree is not a security boundary: the
 * run may write the repository's own git folder, which every worktree shares, so its commits land.
 *
 * Removed only when nothing would be lost: clean, and its work on a branch or already in the folder.
 */
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { MissionSpec } from "../remote/contract.js";
import { runTrustedGit } from "./git-gate.js";
import { GuardError } from "./guard.js";
import { DANGEROUS_GIT_CONFIG } from "./tools.js";

export type WorktreeRequest = NonNullable<MissionSpec["worktree"]>;
export type MadeWorktree = { path: string; branch: string | null; gitDir: string; made: boolean };

export function worktreePath(workspace: string, name: string): string {
  return join(workspace, "worktrees", name);
}

const git = (userId: string, cwd: string, args: string[], timeoutMs = 60_000) => runTrustedGit({ userId, cwd, args, timeoutMs });

/** The repository's own git folder, shared by all its worktrees. */
async function commonDir(userId: string, folder: string): Promise<string | null> {
  const found = await git(userId, folder, ["rev-parse", "--git-common-dir"]).catch(() => null);
  if (!found || found.exitCode !== 0) return null;
  const dir = found.output.trim().split("\n").pop() ?? "";
  if (!dir) return null;
  return realpath(isAbsolute(dir) ? dir : resolve(folder, dir)).catch(() => null);
}

/** A repository a worktree may be made of: its own top folder, with a commit and a config that starts nothing. */
async function usableRepository(userId: string, folder: string): Promise<{ gitDir: string }> {
  const gitDir = await commonDir(userId, folder);
  const top = gitDir ? await git(userId, folder, ["rev-parse", "--show-toplevel"]) : null;
  const real = top?.exitCode === 0 ? await realpath(top.output.trim()).catch(() => "") : "";
  if (!gitDir || real !== folder) throw new GuardError("The folder is not a git repository, so it has no worktrees.");
  const config = await readFile(join(gitDir, "config"), "utf8").catch(() => null);
  if (config === null || DANGEROUS_GIT_CONFIG.test(config) || /^\s*\[include/im.test(config)) throw new GuardError("The repository's git settings could start programs, so Ensemble makes no worktree of it.");
  const head = await git(userId, folder, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head.exitCode !== 0) throw new GuardError("The repository has no commit yet, so a worktree cannot be made from it.");
  return { gitDir };
}

async function currentBranch(userId: string, path: string): Promise<string | null> {
  const branch = await git(userId, path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return branch.exitCode === 0 ? branch.output.trim() || null : null;
}

/**
 * `git worktree add` with Ensemble's own git (hooks off): on a new branch from the folder's last commit
 * (`create`), on an existing branch, or detached at the last commit (no branch). Also used for a run's
 * separate copy of a folder another run is changing (folder-claims.ts).
 */
export async function addWorktree(input: { userId: string; folder: string; path: string; branch: string | null; create: boolean }): Promise<void> {
  const args = !input.branch ? ["worktree", "add", "--detach", input.path, "HEAD"] : input.create ? ["worktree", "add", "-b", input.branch, input.path, "HEAD"] : ["worktree", "add", input.path, input.branch];
  const made = await git(input.userId, input.folder, args, 120_000);
  if (made.exitCode !== 0) throw new GuardError(`git worktree add failed: ${made.output.trim().split("\n").pop() || "no reason given"}`);
}

/**
 * The worktree a run works in: the one already made (a check of the build, a repair), or a new one of
 * `folder` from its last commit, on the mission's branch (made, or taken as it is when it exists) or
 * detached. A snapshot that is gone cannot be checked again: its work was only there.
 */
export async function prepareWorktree(input: { userId: string; folder: string; workspace: string; spec: WorktreeRequest }): Promise<MadeWorktree> {
  const { userId, spec } = input;
  const folder = await realpath(input.folder);
  const { gitDir } = await usableRepository(userId, folder);
  const path = worktreePath(input.workspace, spec.name);
  const there = await lstat(path).catch(() => null);
  if (there) {
    if (there.isSymbolicLink() || !there.isDirectory()) throw new GuardError(`${path} is in the way: it is not a folder Ensemble made.`);
    if ((await commonDir(userId, path)) !== gitDir) throw new GuardError(`${path} is in the way: it is not a worktree of this repository.`);
    return { path: await realpath(path), branch: await currentBranch(userId, path), gitDir, made: false };
  }
  if (spec.reuse && (spec.detached || !spec.branch)) throw new GuardError(`The build's copy “${spec.name}” is gone, and its changes were only there.`);
  await mkdir(join(input.workspace, "worktrees"), { recursive: true });
  // A worktree removed by hand leaves an entry that keeps its branch checked out.
  await git(userId, folder, ["worktree", "prune"]);
  const branch = spec.detached ? null : (spec.branch ?? null);
  const exists = branch ? (await git(userId, folder, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).exitCode === 0 : false;
  await addWorktree({ userId, folder, path, branch, create: !exists });
  return { path: await realpath(path), branch, gitDir, made: true };
}

/**
 * After an integration run succeeded: removes the worktrees it brought in, each only when clean and when
 * nothing would be lost (a branch keeps its commits; a detached one must already be in the folder's
 * history). Never forced. Returns the names removed.
 */
export async function removeWorktrees(input: { userId: string; folder: string; workspace: string; names: readonly string[] }): Promise<string[]> {
  const { userId } = input;
  const folder = await realpath(input.folder).catch(() => null);
  const gitDir = folder ? await commonDir(userId, folder) : null;
  if (!folder || !gitDir) return [];
  const removed: string[] = [];
  for (const name of input.names) {
    const path = worktreePath(input.workspace, name);
    const there = await lstat(path).catch(() => null);
    if (!there?.isDirectory() || there.isSymbolicLink() || (await commonDir(userId, path)) !== gitDir) continue;
    const status = await git(userId, path, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.exitCode !== 0 || status.output.trim()) continue;
    if (!(await currentBranch(userId, path))) {
      const head = await git(userId, path, ["rev-parse", "HEAD"]);
      if (head.exitCode !== 0 || (await git(userId, folder, ["merge-base", "--is-ancestor", head.output.trim(), "HEAD"])).exitCode !== 0) continue;
    }
    if ((await git(userId, folder, ["worktree", "remove", path])).exitCode === 0) removed.push(name);
  }
  return removed;
}
