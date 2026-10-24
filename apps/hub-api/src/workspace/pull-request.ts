/**
 * A code run that ends in a pull request (docs/24 §5.1). The run works in its own clone (of a GitHub
 * URL, or of a folder shared as a repository) on a branch made from the freshly fetched base. When
 * it ends with commits, Ensemble, never the agent, pushes that branch to the GitHub origin read
 * before the agent ran, opens the pull request into the base, and merges it when the person says
 * so on Needs me (`merge: "ask"`), when its checks pass (`"auto"`), or never.
 *
 * The base must be one this computer allows (`pullRequestBases`, set only here) and never main,
 * master, production, testing-live or the repository's default branch. The push is fast-forward
 * only, of the run's own branch, with the computer's own GitHub sign-in.
 */
import { PullRequestPlan, pullRequestBaseRefusal, pullRequestHeadRefusal, type PullRequestPlan as Plan } from "@ensemble/shared-types";
import { appendLedger } from "../lib/ledger.js";
import { githubRepoOf } from "../lib/code-commit.js";
import { GITHUB_AUTH_HINT, githubApiToken, githubCloneAuth } from "../lib/git-auth.js";
import { createPull, defaultBranch, mergePull, openPullFor, waitForChecks, type GitHubFetch, type GitHubRepo } from "../lib/github-pulls.js";
import { loadSettings as loadRemoteSettings } from "../remote/store.js";
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

/** `https://github.com/owner/repo(.git)` with nothing else (no user, query or port), as one canonical URL. */
export function githubHttps(url: string): string | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
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
  bases: () => string[];
  ledger: typeof appendLedger;
  auth: (ctx: JobContext, remote: string) => Promise<{ env: Record<string, string>; config: string[] }>;
};

const live: Deps = {
  git: runTrustedGit,
  fetch: (url, init) => fetch(url, init),
  token: (ctx) => githubApiToken(ctx.prisma, ctx.userId),
  ask: askPerson,
  bases: () => loadRemoteSettings().pullRequestBases,
  ledger: appendLedger,
  auth: (ctx, remote) => githubCloneAuth(ctx.prisma, ctx.userId, remote),
};

export type PreparedPullRequest = { remote: string; repo: GitHubRepo; branch: string; baseSha: string };

/**
 * Before the agent runs: the GitHub origin, the base checks (this computer's list, the repository's
 * default branch), and the run's branch made from the base as GitHub has it now.
 */
export async function preparePullRequest(ctx: JobContext, plan: Plan, deps: Deps = live): Promise<PreparedPullRequest> {
  const job = ctx.job;
  if (!ctx.network) throw new GuardError("A pull request needs the internet for this run. Turn it on, or pick another git choice.");
  if (job.externalRoot) throw new GuardError("A pull request needs the run in its own clone. Pick a repository, or a folder shared as a repository (`ensemble folders add <path> --repo`).");
  const refusal = pullRequestBaseRefusal(plan.base, deps.bases());
  if (refusal) throw new GuardError(refusal);
  const source = (await jobRemote(ctx.prisma, job))?.trim() ?? "";
  // A repository folder on this computer: its own GitHub origin, read here, before the agent runs.
  const origin = source.startsWith("/") ? (await deps.git({ userId: ctx.userId, cwd: source, args: ["config", "--get", "remote.origin.url"] })).output.trim() : source;
  const remote = githubHttps(origin);
  const repo = remote ? githubRepoOf(remote) : null;
  if (!remote || !repo) throw new GuardError("This repository has no GitHub origin over https, so there is nowhere to open a pull request.");
  const token = await deps.token(ctx);
  if (!token) throw new GuardError(GITHUB_AUTH_HINT);
  if ((await defaultBranch(deps.fetch, token, repo)) === plan.base) throw new GuardError(`${plan.base} is ${repo.owner}/${repo.repo}'s default branch: a run never opens a pull request into it.`);
  const auth = await deps.auth(ctx, remote);
  const baseRef = `refs/ensemble/pr-base/${job.id}`;
  const fetched = await deps.git({ userId: ctx.userId, cwd: ctx.root, args: ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${plan.base}:${baseRef}`], credentialEnv: auth.env, credentialConfig: auth.config, timeoutMs: 300_000 });
  if (fetched.exitCode !== 0) throw new GuardError(`Could not fetch ${plan.base} from ${repo.owner}/${repo.repo}: ${fetched.output.trim().slice(-300)}`);
  // Run again, or a follow-up: carry on with the earlier run's branch and its commits, if it is here.
  const earlier = job.continueFromJobId ? (await ctx.prisma.workspaceJob.findUnique({ where: { id: job.continueFromJobId }, select: { branch: true } }))?.branch?.trim() : "";
  const kept = earlier && !headRefusal(earlier, plan.base) && (await deps.git({ userId: ctx.userId, cwd: ctx.root, args: ["rev-parse", "--verify", "--quiet", `refs/heads/${earlier}`] })).exitCode === 0 ? earlier : "";
  const branch = kept || (job.createBranch && job.branch ? job.branch : runBranchName(job.id, ctx.taskTitle));
  const head = headRefusal(branch, plan.base);
  if (head) throw new GuardError(head);
  const made = await deps.git({ userId: ctx.userId, cwd: ctx.root, args: kept ? ["checkout", "--quiet", branch] : ["checkout", "--quiet", "-B", branch, baseRef] });
  if (made.exitCode !== 0) throw new GuardError(`Could not ${kept ? "switch to" : "make"} branch ${branch}${kept ? "" : ` from ${plan.base}`}: ${made.output.trim().slice(-300)}`);
  const sha = (await deps.git({ userId: ctx.userId, cwd: ctx.root, args: kept ? ["merge-base", "HEAD", baseRef] : ["rev-parse", baseRef] })).output.trim();
  await ctx.event("pull_request_branch", { branch, base: plan.base, baseSha: sha, repo: `${repo.owner}/${repo.repo}` });
  return { remote, repo, branch, baseSha: sha };
}

/**
 * After a successful run: push, open, then merge as the plan says. Returns what happened, in words,
 * for the run's summary. Refusals and failures throw with the reason; the work stays in the clone.
 */
export async function publishPullRequest(ctx: JobContext, plan: Plan, prepared: PreparedPullRequest, input: { title: string; summary: string }, deps: Deps = live): Promise<string> {
  const { remote, repo, branch, baseSha } = prepared;
  const where = `${repo.owner}/${repo.repo}`;
  const ahead = Number((await deps.git({ userId: ctx.userId, cwd: ctx.root, args: ["rev-list", "--count", `${baseSha}..HEAD`] })).output.trim()) || 0;
  if (!ahead) return `No commits on ${branch}, so no pull request was opened.`;
  const current = (await deps.git({ userId: ctx.userId, cwd: ctx.root, args: ["rev-parse", "--abbrev-ref", "HEAD"] })).output.trim();
  if (current !== branch) throw new GuardError(`The run ended on ${current || "no branch"}, not ${branch}: nothing was pushed.`);
  const sha = (await deps.git({ userId: ctx.userId, cwd: ctx.root, args: ["rev-parse", "HEAD"] })).output.trim();
  const token = await deps.token(ctx);
  if (!token) throw new GuardError(GITHUB_AUTH_HINT);
  await ctx.progress(`Pushing ${branch} to ${where}`);
  const auth = await deps.auth(ctx, remote);
  // No "+": fast-forward only. A branch that moved on GitHub is refused, never overwritten.
  const pushed = await deps.git({ userId: ctx.userId, cwd: ctx.root, args: ["push", "--porcelain", remote, `HEAD:refs/heads/${branch}`], credentialEnv: auth.env, credentialConfig: auth.config, timeoutMs: 300_000 });
  if (pushed.exitCode !== 0) throw new GuardError(`GitHub refused the push of ${branch}: ${pushed.output.trim().slice(-400)}`);
  const body = [input.summary.trim(), "", `Opened by Ensemble from task “${input.title}”.`].join("\n").slice(0, 60_000);
  const opened = (await openPullFor(deps.fetch, token, repo, branch, plan.base)) ?? (await createPull(deps.fetch, token, repo, { head: branch, base: plan.base, title: input.title.slice(0, 250) || branch, body }));
  await ctx.event("pull_request", { url: opened.url, number: opened.number, base: plan.base, head: branch, state: "open" });
  await deps.ledger({ userId: ctx.userId, actor: "agent", action: "workspace.pull_request", taskId: ctx.job.taskId, payload: { jobId: ctx.job.id, repo: where, number: opened.number, base: plan.base, head: branch } });
  const openedText = `Opened pull request #${opened.number} from ${branch} into ${plan.base}: ${opened.url}`;
  if (plan.merge === "never") return openedText;
  if (plan.merge === "ask") {
    const answer = await deps.ask(ctx, { event: "permission", toolName: "Merge pull request", title: `Merge pull request #${opened.number} into ${plan.base}? ${input.title}`.slice(0, 200), command: opened.url });
    if (answer.decision !== "allow") return `${openedText}\nLeft open: you did not approve the merge.`;
  }
  await ctx.progress(`Waiting for the checks on #${opened.number}`);
  const checks = await waitForChecks(deps.fetch, token, repo, sha, { signal: ctx.signal });
  if (checks.state === "failure") return `${openedText}\nNot merged: checks failed (${checks.failed.slice(0, 5).join(", ")}).`;
  if (checks.state === "pending") return `${openedText}\nNot merged: the checks did not finish within 30 minutes. Merge it on GitHub when they pass.`;
  const merged = await mergePull(deps.fetch, token, repo, opened.number, sha);
  await ctx.event("pull_request", { url: opened.url, number: opened.number, base: plan.base, head: branch, state: merged.merged ? "merged" : "open", message: merged.message.slice(0, 300) });
  if (!merged.merged) return `${openedText}\nNot merged: ${merged.message}`;
  await deps.ledger({ userId: ctx.userId, actor: "agent", action: "workspace.pull_request_merged", taskId: ctx.job.taskId, payload: { jobId: ctx.job.id, repo: where, number: opened.number, base: plan.base, head: branch, sha } });
  return `Opened and merged pull request #${opened.number} from ${branch} into ${plan.base}: ${opened.url}`;
}
