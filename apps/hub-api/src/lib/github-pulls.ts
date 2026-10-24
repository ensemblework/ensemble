/**
 * The GitHub REST calls a run's pull request needs (docs/24 §5.1): the repository's default branch,
 * an open pull request for a branch, the checks on a commit, and the merge. The token is the
 * person's own GitHub sign-in on this computer (`githubApiToken`); it never leaves this process.
 */
import { GitError } from "./git.js";

export type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>;
export type GitHubRepo = { owner: string; repo: string };

const API = "https://api.github.com";

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "Ensemble" };
}

async function call<T>(fetcher: GitHubFetch, token: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetcher(`${API}${path}`, { ...init, headers: headers(token), signal: init.signal ?? AbortSignal.timeout(20_000) }).catch(() => null);
  if (!response) throw new GitError("GitHub could not be reached.", 502);
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
}

const repoPath = (repo: GitHubRepo) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;

export async function defaultBranch(fetcher: GitHubFetch, token: string, repo: GitHubRepo): Promise<string | null> {
  const { status, body } = await call<{ default_branch?: string }>(fetcher, token, repoPath(repo));
  return status === 200 && typeof body.default_branch === "string" ? body.default_branch : null;
}

/** The open pull request from `head` (a branch of the same repository), if any. */
export async function openPullFor(fetcher: GitHubFetch, token: string, repo: GitHubRepo, head: string, base: string): Promise<{ url: string; number: number } | null> {
  const query = new URLSearchParams({ state: "open", head: `${repo.owner}:${head}`, base });
  const { status, body } = await call<Array<{ html_url?: string; number?: number }>>(fetcher, token, `${repoPath(repo)}/pulls?${query}`);
  const first = status === 200 && Array.isArray(body) ? body[0] : undefined;
  return first?.html_url && typeof first.number === "number" ? { url: first.html_url, number: first.number } : null;
}

export type ChecksState = { state: "pending" | "success" | "failure"; failed: string[]; total: number };

/** Opens a pull request from `head` into `base`. */
export async function createPull(fetcher: GitHubFetch, token: string, repo: GitHubRepo, input: { head: string; base: string; title: string; body: string }): Promise<{ url: string; number: number }> {
  const { status, body } = await call<{ html_url?: string; number?: number; message?: string; errors?: Array<{ message?: string }> }>(fetcher, token, `${repoPath(repo)}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base, draft: false }),
  });
  if (status === 201 && body.html_url && typeof body.number === "number") return { url: body.html_url, number: body.number };
  const detail = body.errors?.map((error) => error.message).filter(Boolean).join("; ") || body.message || `HTTP ${status}`;
  throw new GitError(`GitHub did not open the pull request: ${detail}`, status === 422 ? 409 : 502);
}

/**
 * The checks on a commit, as GitHub's merge box sees them: every check run and every commit status.
 * Failure if any failed (skipped and neutral are fine), pending while any is still running.
 */
export async function checksOn(fetcher: GitHubFetch, token: string, repo: GitHubRepo, sha: string): Promise<ChecksState> {
  const runs = await call<{ check_runs?: Array<{ name?: string; status?: string; conclusion?: string | null }> }>(fetcher, token, `${repoPath(repo)}/commits/${sha}/check-runs?per_page=100`);
  const statuses = await call<{ statuses?: Array<{ context?: string; state?: string }> }>(fetcher, token, `${repoPath(repo)}/commits/${sha}/status`);
  const failed: string[] = [];
  let pending = false;
  let total = 0;
  for (const run of runs.body.check_runs ?? []) {
    total += 1;
    if (run.status !== "completed") pending = true;
    else if (!["success", "skipped", "neutral"].includes(run.conclusion ?? "")) failed.push(run.name ?? "a check");
  }
  for (const status of statuses.body.statuses ?? []) {
    total += 1;
    if (status.state === "pending") pending = true;
    else if (status.state !== "success") failed.push(status.context ?? "a status");
  }
  return { state: failed.length ? "failure" : pending ? "pending" : "success", failed, total };
}

/**
 * Waits for a commit's checks: success, failure, or "pending" after `timeoutMs`. Checks that have not
 * started yet are given `settleMs` to appear before an empty list counts as done.
 */
export async function waitForChecks(
  fetcher: GitHubFetch,
  token: string,
  repo: GitHubRepo,
  sha: string,
  options: { timeoutMs?: number; intervalMs?: number; settleMs?: number; signal?: AbortSignal; onWait?: (state: ChecksState) => Promise<void> | void } = {},
): Promise<ChecksState> {
  const started = Date.now();
  const timeout = options.timeoutMs ?? 30 * 60_000;
  const interval = options.intervalMs ?? 20_000;
  const settle = options.settleMs ?? 60_000;
  for (;;) {
    const state = await checksOn(fetcher, token, repo, sha);
    if (state.state === "failure") return state;
    if (state.state === "success" && (state.total > 0 || Date.now() - started >= settle)) return state;
    if (Date.now() - started >= timeout) return { ...state, state: "pending" };
    await options.onWait?.(state);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Stopped", "AbortError"));
      }, { once: true });
    });
  }
}

/** Merges a pull request with a merge commit, only if its head is still `sha`. */
export async function mergePull(fetcher: GitHubFetch, token: string, repo: GitHubRepo, number: number, sha: string): Promise<{ merged: boolean; message: string }> {
  const { status, body } = await call<{ merged?: boolean; message?: string }>(fetcher, token, `${repoPath(repo)}/pulls/${number}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: "merge", sha }),
  });
  if (status === 200 && body.merged) return { merged: true, message: body.message ?? "Merged." };
  return { merged: false, message: body.message ?? `GitHub answered ${status}.` };
}
