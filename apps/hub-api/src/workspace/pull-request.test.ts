/**
 * A run that ends in a pull request (docs/24 §5.1), with git and GitHub replaced: any base, where the
 * branch starts, and what happens after the run for each merge choice. Nothing here reaches GitHub or reads a credential.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceJob } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://none:none@127.0.0.1:1/ensemble_desktop";
const { preparePullRequest, publishPullRequest, pullRequestOf, githubHttps } = await import("./pull-request.js");
const { withPullRequest, Assign } = await import("./assign.js");
type Deps = import("./pull-request.js").PullRequestDeps;
type Ctx = Parameters<typeof preparePullRequest>[0];

const REPO = "https://github.com/acme/widgets.git";

function ctx(job: Partial<WorkspaceJob> = {}, over: Partial<Ctx> = {}): Ctx & { events: Array<{ kind: string; data: Record<string, unknown> }> } {
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  return {
    job: { id: "job-1", taskId: "task-1", repoUrl: REPO, externalRoot: null, continueFromJobId: null, createBranch: false, branch: "", ...job } as WorkspaceJob,
    root: "/work/run",
    network: true,
    userId: "user-1",
    taskTitle: "Add a greeting",
    prisma: {} as never,
    signal: new AbortController().signal,
    event: async (kind: string, data: Record<string, unknown>) => {
      events.push({ kind, data });
    },
    progress: async () => undefined,
    events,
    ...over,
  } as unknown as Ctx & { events: typeof events };
}

type GitCall = { cwd: string; args: string[] };

function fakes(over: { checks?: string; defaultBranch?: string; existingPull?: boolean; ahead?: number; ask?: "allow" | "deny" } = {}) {
  const git: GitCall[] = [];
  const api: Array<{ method: string; url: string; body?: unknown }> = [];
  const asked: string[] = [];
  const deps: Deps = {
    git: async (input) => {
      git.push({ cwd: input.cwd, args: input.args });
      const [sub, ...rest] = input.args;
      const ok = (output = "") => ({ exitCode: 0, output });
      if (sub === "config") return ok("https://github.com/acme/widgets.git\n");
      if (sub === "rev-list") return ok(`${over.ahead ?? 2}\n`);
      if (sub === "rev-parse" && rest[0] === "--verify") return { exitCode: 1, output: "" };
      if (sub === "rev-parse" && rest[0] === "--abbrev-ref") return ok("feature-a\n");
      if (sub === "rev-parse" && rest[0] === "HEAD") return ok("headsha\n");
      if (sub === "rev-parse") return ok("basesha\n");
      return ok();
    },
    fetch: async (url, init) => {
      const method = init.method ?? "GET";
      api.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
      if (method === "GET" && url.endsWith("/repos/acme/widgets")) return json(200, { default_branch: over.defaultBranch ?? "main" });
      if (method === "GET" && url.includes("/pulls?")) return json(200, over.existingPull ? [{ html_url: "https://github.com/acme/widgets/pull/7", number: 7 }] : []);
      if (method === "POST" && url.endsWith("/pulls")) return json(201, { html_url: "https://github.com/acme/widgets/pull/12", number: 12 });
      if (url.includes("/check-runs")) return json(200, { check_runs: [{ name: "Web testing checks", status: "completed", conclusion: over.checks ?? "success" }] });
      if (url.endsWith("/status")) return json(200, { statuses: [] });
      if (method === "PUT" && url.endsWith("/merge")) return json(200, { merged: true, message: "Pull Request successfully merged" });
      return json(404, {});
    },
    token: async () => "token",
    ask: async (_ctx, input) => {
      asked.push(input.title);
      return { decision: over.ask ?? "allow", answer: null };
    },
    ledger: async () => undefined,
    auth: async () => ({ env: {}, config: [] }),
  };
  return { deps, git, api, asked };
}

test("the plan is read from the job's context; a GitHub remote over https or SSH is one repository", () => {
  assert.deepEqual(pullRequestOf({ outsideAccess: "read", pullRequest: { base: "testing", merge: "auto" } }), { base: "testing", merge: "auto" });
  assert.equal(pullRequestOf({ outsideAccess: "read" }), null);
  assert.equal(pullRequestOf({ pullRequest: { base: "../x" } }), null);
  assert.equal(githubHttps("https://github.com/acme/widgets"), REPO);
  assert.equal(githubHttps("https://user:secret@github.com/acme/widgets.git"), null);
  assert.equal(githubHttps("git@github.com:acme/widgets.git"), REPO);
  assert.equal(githubHttps("https://gitlab.com/acme/widgets.git"), null);
});

test("an assignment that ends in a pull request goes into any branch, and is refused only where it cannot work", () => {
  const base = { taskId: "00000000-0000-4000-8000-000000000000", kind: "code" as const, repoUrl: "acme/widgets" };
  const named = withPullRequest(Assign.parse({ ...base, branch: "feature-a", delivery: "push", pullRequest: { base: "testing" } }));
  assert.equal(named.branchMode, "new");
  assert.equal(named.branch, "feature-a");
  assert.equal(named.delivery, "push", "the agent may push too");
  assert.equal(named.pullRequest?.merge, "ask", "asking before a merge is the default");
  for (const into of ["main", "master", "production", "testing-live", ""]) {
    assert.doesNotThrow(() => withPullRequest(Assign.parse({ ...base, branch: "feature-a", pullRequest: { base: into } })), into);
  }
  assert.doesNotThrow(() => withPullRequest(Assign.parse({ ...base, branch: "production", pullRequest: { base: "testing" } })));
  assert.doesNotThrow(() => withPullRequest(Assign.parse({ ...base, repoUrl: undefined, folder: "/work/notes", pullRequest: { base: "testing" } })), "a folder worked in place");
  assert.throws(() => withPullRequest(Assign.parse({ ...base, branch: "testing", pullRequest: { base: "testing" } })), /into itself/);
  assert.throws(() => withPullRequest(Assign.parse({ ...base, kind: "research", pullRequest: { base: "testing" } })), /code task/);
  assert.throws(() => withPullRequest(Assign.parse({ ...base, chat: true, pullRequest: { base: "testing" } })), /chat/);
});

test("before the run: the base is checked here and on GitHub, and the branch starts from the base as GitHub has it", async () => {
  const { deps, git } = fakes();
  const run = ctx({ createBranch: true, branch: "feature-a" });
  const prepared = await preparePullRequest(run, { base: "testing", merge: "ask" }, deps);
  assert.deepEqual(prepared, { remote: REPO, repo: { owner: "acme", repo: "widgets" }, branch: "feature-a", base: "testing", baseSha: "basesha" });
  const fetched = git.find((call) => call.args[0] === "fetch")!;
  assert.deepEqual(fetched.args.slice(-2), [REPO, "+refs/heads/testing:refs/ensemble/pr-base/job-1"]);
  assert.deepEqual(git.find((call) => call.args[0] === "checkout")!.args, ["checkout", "--quiet", "-B", "feature-a", "refs/ensemble/pr-base/job-1"]);
  // A repository folder on this computer: its own GitHub origin, read before the agent runs.
  const local = fakes();
  const fromFolder = await preparePullRequest(ctx({ repoUrl: "/work/widgets" }), { base: "testing", merge: "never" }, local.deps);
  assert.equal(fromFolder.remote, REPO);
  assert.match(fromFolder.branch, /^ensemble\/job-1\//, "no name given: the run's own branch");
  assert.deepEqual(local.git[0], { cwd: "/work/widgets", args: ["config", "--get", "remote.origin.url"] });

  // Any base, the default branch included; empty: the default branch, read from GitHub.
  const intoMain = await preparePullRequest(ctx({ createBranch: true, branch: "feature-a" }), { base: "main", merge: "ask" }, fakes().deps);
  assert.equal(intoMain.base, "main");
  const defaulted = fakes({ defaultBranch: "trunk" });
  assert.equal((await preparePullRequest(ctx({ createBranch: true, branch: "feature-a" }), { base: "", merge: "ask" }, defaulted.deps)).base, "trunk");
  assert.deepEqual(defaulted.git.find((call) => call.args[0] === "fetch")!.args.slice(-1), ["+refs/heads/trunk:refs/ensemble/pr-base/job-1"]);
  // A folder worked in place: its own origin, read in that folder.
  const inPlace = fakes();
  const fromPlace = await preparePullRequest(ctx({ externalRoot: "/work/widgets", repoUrl: null }, { root: "/work/widgets" } as Partial<Ctx>), { base: "testing", merge: "ask" }, inPlace.deps);
  assert.equal(fromPlace.remote, REPO);
  assert.deepEqual(inPlace.git[0], { cwd: "/work/widgets", args: ["config", "--get", "remote.origin.url"] });
  await assert.rejects(preparePullRequest(ctx({}, { network: false } as Partial<Ctx>), { base: "testing", merge: "ask" }, fakes().deps), /needs the internet/);
  await assert.rejects(preparePullRequest(ctx({ repoUrl: "https://gitlab.com/acme/widgets.git" }), { base: "testing", merge: "ask" }, fakes().deps), /no GitHub origin/);
});

const prepared = { remote: REPO, repo: { owner: "acme", repo: "widgets" }, branch: "feature-a", base: "testing", baseSha: "basesha" };
const input = { title: "Add a greeting", summary: "Added greeting.txt." };

test("after the run: push fast-forward only, open, ask on Needs me, wait for checks, merge", async () => {
  const { deps, git, api, asked } = fakes();
  const run = ctx();
  const note = await publishPullRequest(run, { base: "testing", merge: "ask" }, prepared, input, deps);
  const push = git.find((call) => call.args[0] === "push")!;
  assert.deepEqual(push.args, ["push", "--porcelain", REPO, "HEAD:refs/heads/feature-a"], "no + and no --force: fast-forward only");
  const opened = api.find((call) => call.method === "POST")!;
  assert.deepEqual({ head: (opened.body as { head: string }).head, base: (opened.body as { base: string }).base }, { head: "feature-a", base: "testing" });
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /Merge pull request #12 into testing\?/);
  const merge = api.find((call) => call.method === "PUT")!;
  assert.deepEqual(merge.body, { merge_method: "merge", sha: "headsha" }, "merged only if the head is still what was checked");
  assert.match(note, /Opened and merged pull request #12 from feature-a into testing/);
  assert.deepEqual(run.events.map((event) => event.data.state), ["open", "merged"]);
});

test("the person says no, checks fail, never merge, nothing to publish, an open pull request already there", async () => {
  const denied = fakes({ ask: "deny" });
  assert.match(await publishPullRequest(ctx(), { base: "testing", merge: "ask" }, prepared, input, denied.deps), /Left open: you did not approve the merge/);
  assert.ok(!denied.api.some((call) => call.method === "PUT"));

  const failing = fakes({ checks: "failure" });
  assert.match(await publishPullRequest(ctx(), { base: "testing", merge: "auto" }, prepared, input, failing.deps), /Not merged: checks failed \(Web testing checks\)/);
  assert.equal(failing.asked.length, 0, "auto never asks");
  assert.ok(!failing.api.some((call) => call.method === "PUT"));

  const never = fakes();
  assert.match(await publishPullRequest(ctx(), { base: "testing", merge: "never" }, prepared, input, never.deps), /^Opened pull request #12/);
  assert.ok(!never.api.some((call) => call.method === "PUT"));

  const empty = fakes({ ahead: 0 });
  assert.match(await publishPullRequest(ctx(), { base: "testing", merge: "auto" }, prepared, input, empty.deps), /No commits on feature-a/);
  assert.ok(!empty.git.some((call) => call.args[0] === "push"));

  const existing = fakes({ existingPull: true });
  assert.match(await publishPullRequest(ctx(), { base: "testing", merge: "never" }, prepared, input, existing.deps), /#7/);
  assert.ok(!existing.api.some((call) => call.method === "POST"), "the open pull request for the branch is reused");
});
