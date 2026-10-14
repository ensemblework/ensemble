/**
 * Committing exactly what the person ticked, and opening a pull request (docs/16 §3).
 *
 * A commit is built in a throwaway index: start from HEAD, put in the ticked files exactly as they are
 * on disk (stored with `hash-object --no-filters`, so no filter program of the repository runs), and
 * nothing else that happens to be staged. Hooks never run. HEAD moves only if it is still where it was.
 */
import { randomBytes } from "node:crypto";
import { lstat, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError, insideRepo } from "./git.js";
import { writeBlob } from "./code-versions.js";
import { runTrustedGit } from "../workspace/git-gate.js";

const PR_TEMPLATES = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "PULL_REQUEST_TEMPLATE.md", "pull_request_template.md"];

async function trusted(repo: string, userId: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const result = await runTrustedGit({ userId, cwd: repo, args, credentialEnv: env });
  if (result.exitCode !== 0) throw new GitError(`git ${args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? ""} failed: ${result.output.trim().slice(-400)}`, 409);
  return result.output.trim();
}

/** The repository's default branch, from origin's HEAD (e.g. `main`), or null when it is not known. */
export async function defaultBranch(repo: string, userId: string): Promise<string | null> {
  const result = await runTrustedGit({ userId, cwd: repo, args: ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"] });
  if (result.exitCode !== 0) return null;
  return result.output.trim().replace(/^origin\//, "") || null;
}

/** The repository's pull request template, if it has one (at most 20 KB). */
export async function pullRequestTemplate(repo: string): Promise<string | null> {
  for (const path of PR_TEMPLATES) {
    const text = await readFile(insideRepo(repo, path), "utf8").catch(() => null);
    if (text !== null) return text.slice(0, 20_000);
  }
  return null;
}

export type CommitInput = { paths: string[]; message: string; author?: string | null; sign?: boolean };

/** Commits exactly `paths` as they are on disk; returns the new commit and the branch it is on. */
export async function commitPaths(repo: string, userId: string, input: CommitInput): Promise<{ commit: string; branch: string }> {
  if (!input.paths.length) throw new GitError("Tick at least one file to commit.");
  if (!input.message.trim()) throw new GitError("Write a commit message.");
  const head = await runTrustedGit({ userId, cwd: repo, args: ["rev-parse", "--verify", "--quiet", "HEAD"] });
  const parent = head.exitCode === 0 ? head.output.trim() : null;
  const branch = (await runTrustedGit({ userId, cwd: repo, args: ["symbolic-ref", "--quiet", "--short", "HEAD"] })).output.trim();
  if (!branch) throw new GitError("This checkout is not on a branch. Switch to one before committing.");
  const index = join(tmpdir(), `ensemble-commit-${randomBytes(8).toString("hex")}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    if (parent) await trusted(repo, userId, ["read-tree", parent], env);
    else await trusted(repo, userId, ["read-tree", "--empty"], env);
    for (const path of [...new Set(input.paths)]) {
      const full = insideRepo(repo, path);
      if (path.split("/").some((part) => part.toLowerCase().replace(/[. ]+$/, "") === ".git")) throw new GitError("Git's own files are not committed.", 403);
      const info = await lstat(full).catch(() => null);
      if (!info) {
        await trusted(repo, userId, ["update-index", "--force-remove", "--", path], env);
        continue;
      }
      const bytes = info.isSymbolicLink() ? Buffer.from(await readlink(full), "utf8") : await readFile(full);
      const sha = await writeBlob(repo, bytes);
      const mode = info.isSymbolicLink() ? "120000" : info.mode & 0o111 ? "100755" : "100644";
      await trusted(repo, userId, ["update-index", "--add", "--cacheinfo", `${mode},${sha},${path}`], env);
    }
    const tree = (await trusted(repo, userId, ["write-tree"], env)).split("\n").pop()!.trim();
    const identity = input.author?.match(/^(.+?)\s*<(.+)>$/);
    const config = identity ? ["-c", `user.name=${identity[1]}`, "-c", `user.email=${identity[2]}`] : [];
    const commit = (await trusted(repo, userId, [...config, "commit-tree", tree, ...(parent ? ["-p", parent] : []), ...(input.sign ? ["-S"] : []), "-m", input.message])).split("\n").pop()!.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new GitError("The commit could not be made.", 409);
    // Only if HEAD is still where it was: a commit made meanwhile elsewhere is never lost.
    await trusted(repo, userId, ["update-ref", "-m", "ensemble: commit", `refs/heads/${branch}`, commit, parent ?? "0".repeat(40)]);
    // The real index now agrees with HEAD for these files; anything else staged stays staged.
    await runTrustedGit({ userId, cwd: repo, args: ["reset", "-q", "HEAD", "--", ...input.paths] });
    return { commit, branch };
  } finally {
    await rm(index, { force: true });
  }
}

/** owner/repo from a GitHub remote URL (https or ssh), or null. */
export function githubRepoOf(remote: string): { owner: string; repo: string } | null {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

/** Opens a pull request on GitHub for `head` into `base`. */
export async function openPullRequest(input: { token: string; owner: string; repo: string; head: string; base: string; title: string; body: string; draft: boolean }): Promise<{ url: string; number: number }> {
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "Ensemble" },
    body: JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base, draft: input.draft }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!response) throw new GitError("GitHub could not be reached.", 502);
  const body = (await response.json().catch(() => ({}))) as { html_url?: string; number?: number; message?: string; errors?: Array<{ message?: string }> };
  if (!response.ok || !body.html_url) {
    const detail = body.errors?.map((error) => error.message).filter(Boolean).join("; ") || body.message || `HTTP ${response.status}`;
    throw new GitError(`GitHub did not open the pull request: ${detail}`, response.status === 422 ? 409 : 502);
  }
  return { url: body.html_url, number: body.number ?? 0 };
}

const reviewRef = (jobId: string, side: "start" | "end") => `refs/ensemble/review/${jobId}/${side}`;

/**
 * Keeps a run's two snapshots for its review's 14 days (docs/16 §2): each tree is wrapped in a commit
 * of its own (no parent) and pinned under `refs/ensemble/review/<job>/{start,end}`, so git's garbage
 * collection cannot take them. The daily sweep unpins them when the review expires.
 */
export async function pinReviewSnapshots(repo: string, userId: string, jobId: string, trees: { start: string; end: string }): Promise<{ start: string; end: string }> {
  const identity = ["-c", "user.name=Ensemble", "-c", "user.email=review@ensemble.local"];
  const commitOf = async (tree: string, side: "start" | "end") =>
    (await trusted(repo, userId, [...identity, "commit-tree", tree, "-m", `Ensemble review snapshot: ${side} of job ${jobId}`])).split("\n").pop()!.trim();
  const start = await commitOf(trees.start, "start");
  const end = await commitOf(trees.end, "end");
  await trusted(repo, userId, ["update-ref", "-m", "ensemble: review snapshot", reviewRef(jobId, "start"), start]);
  await trusted(repo, userId, ["update-ref", "-m", "ensemble: review snapshot", reviewRef(jobId, "end"), end]);
  return { start, end };
}

export async function unpinReviewSnapshots(repo: string, userId: string, jobId: string): Promise<void> {
  for (const side of ["start", "end"] as const) await runTrustedGit({ userId, cwd: repo, args: ["update-ref", "-d", reviewRef(jobId, side)] }).catch(() => undefined);
}
