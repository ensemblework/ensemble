/**
 * A code run that ends in a pull request (docs/24 §5.1). The run works on a branch made from the
 * freshly fetched base (any branch the person names; empty: the repository's default branch), in its
 * own clone or in a folder worked in place. When it ends with commits, Ensemble pushes that branch to
 * the repository's GitHub origin with the computer's own sign-in, opens the pull request into the base
 * (or reuses the one the agent opened), and merges it when the person says so on Needs me
 * (`merge: "ask"`), when its checks pass (`"auto"`), or never.
 */
import { PullRequestPlan, pullRequestHeadRefusal, type PullRequestPlan as Plan } from "@ensemble/shared-types";
import { appendLedger } from "../lib/ledger.js";
import { githubRepoOf } from "../lib/code-commit.js";
import { GITHUB_AUTH_HINT, githubApiToken, githubCloneAuth } from "../lib/git-auth.js";
import { createPull, defaultBranch, mergePull, openPullFor, waitForChecks, type GitHubFetch, type GitHubRepo } from "../lib/github-pulls.js";
import { runBranchName, runTrustedGit } from "./git-gate.js";
import { GuardError } from "./guard.js";
import { jobRemote } from "./publish.js";
import { askPerson, type JobContext } from "./tools.js";

export function pullRequestOf(context: unknown): Plan | null {
  const value = typeof context === "object" && context !== null ? (context as { pullRequest?: unknown }).pullRequest : undefined;
  if (value === undefined || value === null) return null;
  const parsed = PullRequestPlan.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A GitHub remote as one canonical `https://github.com/owner/repo.git` URL: https (no user, query or
 * port) or SSH (`git@github.com:owner/repo`, `ssh://git@github.com/owner/repo`).
 */
export function githubHttps(url: string): string | null {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9-][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim()) ??
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}.git` : null;
}

/** A branch the run's pull request may come from. */
export function headRefusal(branch: string, base: string): string | null {
  return pullRequestHeadRefusal(branch, base);
}

export type PullRequestDeps = Deps;
type Deps = {
  git: typeof runTrustedGit;
  fetch: GitHubFetch;
  token: (ctx: JobContext) => Promise<string | null>;
  ask: typeof askPerson;
  ledger: typeof appendLedger;
  auth: (ctx: JobContext, remote: string) => Promise<{ env: Record<string, string>; config: string[] }>;
};

const live: Deps = {
  git: runTrustedGit,
  fetch: (url, init) => fetch(url, init),
  token: (ctx) => githubApiToken(ctx.prisma, ctx.userId),
  ask: askPerson,
  ledger: appendLedger,
  auth: (ctx, remote) => githubCloneAuth(ctx.prisma, ctx.userId, remote),
};

export type PreparedPullRequest = { remote: string; repo: GitHubRepo; branch: string; base: string; baseSha: string };

/** Before the agent runs: the GitHub origin, the base, and the run's branch made from the base as GitHub has it now. */
export async function preparePullRequest(ctx: JobContext, plan: Plan, deps: Deps = live): Promise<PreparedPullRequest> {
  const job = ctx.job;
  if (!ctx.network) throw new GuardError("A pull request needs the internet for this run. Turn it on, or pick another git choice.");
  const source = job.externalRoot ? ctx.root : ((await jobRemote(ctx.prisma, job))?.trim() ?? "");
  // A folder on this computer (worked in place, or the repository folder a clone came from): its own GitHub origin.
  const origin = source.startsWith("/") ? (await deps.git({ userId: ctx.userId, cwd: source, args: ["config", "--get", "remote.origin.url"] })).output.trim() : source;
  const remote = githubHttps(origin);
  const repo = remote ? githubRepoOf(remote) : null;
  if (!remote || !repo) throw new GuardError("This repository has no GitHub origin, so there is nowhere to open a pull request.");
  const token = await deps.token(ctx);
  if (!token) throw new GuardError(GITHUB_AUTH_HINT);
  const base = plan.base || (await defaultBranch(deps.fetch, token, repo));
  if (!base) throw new GuardError(`Could not read ${repo.owner}/${repo.repo}'s default branch from GitHub. Name the branch the pull request goes into.`);
  const auth = await deps.auth(ctx, remote);
  const baseRef = `refs/ensemble/pr-base/${job.id}`;
  const fetched = await deps.git({ userId: ctx.userId, cwd: ctx.root, args: ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${base}:${baseRef}`], credentialEnv: auth.env, credentialConfig: auth.config, timeoutMs: 300_000 });
  if (fetched.exitCode !== 0) throw new GuardError(`Could not fetch ${base} from ${repo.owner}/${repo.repo}: ${fetched.output.trim().slice(-300)}`);
  // Run again, or a follow-up: carry on with the earlier run's branch and its commits, if it is here.
  const earlier = job.continueFromJobId ? (await ctx.prisma.workspaceJob.findUnique({ where: { id: job.continueFromJobId }, select: { branch: true } }))?.branch?.trim() : "";
  const kept = earlier && !headRefusal(earlier, base) && (await deps.git({ userId: ctx.userId, cwd: ctx.root, args: ["rev-parse", "--verify", "--quiet", `refs/heads/${earlier}`] })).exitCode === 0 ? earlier : "";
  const branch = kept || (job.createBranch && job.branch ? job.branch : runBranchName(job.id, ctx.taskTitle));
  const head = headRefusal(branch, base);
  if (head) throw new GuardError(head);
  const made = await deps.git({ userId: ctx.userId, cwd: ctx.root, args: kept ? ["checkout", "--quiet", branch] : ["checkout", "--quiet", "-B", branch, baseRef] });
  if (made.exitCode !== 0) throw new GuardError(`Could not ${kept ? "switch to" : "make"} branch ${branch}${kept ? "" : ` from ${base}`}: ${made.output.trim().slice(-300)}`);
  const sha = (await deps.git({ userId: ctx.userId, cwd: ctx.root, args: kept ? ["merge-base", "HEAD", baseRef] : ["rev-parse", baseRef] })).output.trim();
  await ctx.event("pull_request_branch", { branch, base, baseSha: sha, repo: `${repo.owner}/${repo.repo}` });
  return { remote, repo, branch, base, baseSha: sha };
}

/**
 * After a successful run: push, open, then merge as the plan says. Returns what happened, in words,
 * for the run's summary. Refusals and failures throw with the reason; the work stays in the clone.
 */
export async function publishPullRequest(ctx: JobContext, plan: Plan, prepared: PreparedPullRequest, input: { title: string; summary: string }, deps: Deps = live): Promise<string> {
  const { remote, repo, branch, base, baseSha } = prepared;
  const where = `${repo.owner}/${repo.repo}`;
  const ahead = Number((await deps.git({ userId: ctx.userId, cwd: ctx.root, args: ["rev-list", "--count", `${baseSha}..HEAD`] })).output.trim()) || 0;
  if (!ahead) return `No commits on ${branch}, so no pull request was opened.`;
  const current = (await deps.git({ userId: ctx.userId, cwd: ctx.root, args: ["rev-parse", "--abbrev-ref", "HEAD"] })).output.trim();
  if (current !== branch) return `The run ended on ${current || "no branch"}, not ${branch}, so Ensemble did not push ${branch} or open a pull request from it.`;
  const sha = (await deps.git({ userId: ctx.userId, cwd: ctx.root, args: ["rev-parse", "HEAD"] })).output.trim();
  const token = await deps.token(ctx);
  if (!token) throw new GuardError(GITHUB_AUTH_HINT);
  await ctx.progress(`Pushing ${branch} to ${where}`);
  const auth = await deps.auth(ctx, remote);
  // No "+": a branch that moved on GitHub since (someone else's commits) is not overwritten.
  const pushed = await deps.git({ userId: ctx.userId, cwd: ctx.root, args: ["push", "--porcelain", remote, `HEAD:refs/heads/${branch}`], credentialEnv: auth.env, credentialConfig: auth.config, timeoutMs: 300_000 });
  if (pushed.exitCode !== 0) throw new GuardError(`GitHub refused the push of ${branch}: ${pushed.output.trim().slice(-400)}`);
  const body = [input.summary.trim(), "", `Opened by Ensemble from task “${input.title}”.`].join("\n").slice(0, 60_000);
  let opened = await openPullFor(deps.fetch, token, repo, branch, base);
  if (!opened) {
    try {
      opened = await createPull(deps.fetch, token, repo, { head: branch, base, title: input.title.slice(0, 250) || branch, body });
    } catch (error) {
      // The agent opened and merged it itself, or the work is already in the base.
      if (error instanceof Error && /No commits between|already exists/i.test(error.message)) return `${branch} has nothing new for ${base} (already merged, or a pull request is already open). No new pull request was opened.`;
      throw error;
    }
  }
  await ctx.event("pull_request", { url: opened.url, number: opened.number, base, head: branch, state: "open" });
  await deps.ledger({ userId: ctx.userId, actor: "agent", action: "workspace.pull_request", taskId: ctx.job.taskId, payload: { jobId: ctx.job.id, repo: where, number: opened.number, base, head: branch } });
  const openedText = `Opened pull request #${opened.number} from ${branch} into ${base}: ${opened.url}`;
  if (plan.merge === "never") return openedText;
  if (plan.merge === "ask") {
    const answer = await deps.ask(ctx, { event: "permission", toolName: "Merge pull request", title: `Merge pull request #${opened.number} into ${base}? ${input.title}`.slice(0, 200), command: opened.url });
    if (answer.decision !== "allow") return `${openedText}\nLeft open: you did not approve the merge.`;
  }
  await ctx.progress(`Waiting for the checks on #${opened.number}`);
  const checks = await waitForChecks(deps.fetch, token, repo, sha, { signal: ctx.signal });
  if (checks.state === "failure") return `${openedText}\nNot merged: checks failed (${checks.failed.slice(0, 5).join(", ")}).`;
  if (checks.state === "pending") return `${openedText}\nNot merged: the checks did not finish within 30 minutes. Merge it on GitHub when they pass.`;
  const merged = await mergePull(deps.fetch, token, repo, opened.number, sha);
  await ctx.event("pull_request", { url: opened.url, number: opened.number, base, head: branch, state: merged.merged ? "merged" : "open", message: merged.message.slice(0, 300) });
  if (!merged.merged) return `${openedText}\nNot merged: ${merged.message}`;
  await deps.ledger({ userId: ctx.userId, actor: "agent", action: "workspace.pull_request_merged", taskId: ctx.job.taskId, payload: { jobId: ctx.job.id, repo: where, number: opened.number, base, head: branch, sha } });
  return `Opened and merged pull request #${opened.number} from ${branch} into ${base}: ${opened.url}`;
}
