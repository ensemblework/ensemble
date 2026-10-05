import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkGit, GuardError } from "./guard.js";
import { fastForwardPushArgs, isOwnRunBranch, isRunBranch, pushRefused, runBranchName, runTrustedGit } from "./git-gate.js";

const job = "11111111-2222-4333-8444-555555555555";

test("a run branch is namespaced to the job and push is fast-forward only", () => {
  const branch = runBranchName(job, "Fix the flaky test!");
  assert.equal(branch, `ensemble/${job}/fix-the-flaky-test`);
  assert.equal(isOwnRunBranch(branch, job), true);
  assert.equal(isRunBranch(branch), true);
  assert.equal(isOwnRunBranch("main", job), false);
  assert.equal(pushRefused(branch, job, false), null);
  assert.match(pushRefused("main", job, false) ?? "", /own branch/);
  const earlier = "ensemble/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/kept";
  assert.equal(pushRefused(earlier, job, false) !== null, true);
  assert.equal(pushRefused(earlier, job, true), null);
  assert.throws(() => fastForwardPushArgs("main", "origin"), /not a run branch/);
  assert.throws(() => fastForwardPushArgs(branch, "--receive-pack=evil"), /option/);
});

test("the app push really runs, lands on the run branch, and a non-fast-forward is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ensemble-push-"));
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString();
  try {
    const remote = join(dir, "remote.git");
    const work = join(dir, "work");
    sh(dir, "init", "--bare", "--quiet", remote);
    sh(dir, "clone", "--quiet", remote, work);
    await writeFile(join(work, "a.txt"), "one\n");
    sh(work, "add", "a.txt");
    sh(work, "commit", "--quiet", "-m", "one");
    const branch = runBranchName(job, "push test");
    const first = await runTrustedGit({ cwd: work, args: fastForwardPushArgs(branch, remote) });
    assert.equal(first.exitCode, 0, first.output);
    assert.equal(sh(remote, "for-each-ref", "--format=%(refname)").trim(), `refs/heads/${branch}`);

    await writeFile(join(work, "a.txt"), "rewritten\n");
    sh(work, "commit", "--quiet", "--amend", "-am", "rewritten");
    const rewritten = await runTrustedGit({ cwd: work, args: fastForwardPushArgs(branch, remote) });
    assert.notEqual(rewritten.exitCode, 0, "a rewritten history must not replace the remote branch");
    assert.match(rewritten.output, /rejected|non-fast-forward|fetch first/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the agent cannot name a worktree or push a branch that is not its own", () => {
  assert.throws(() => checkGit(["git", "worktree", "add", "../elsewhere"], { delivery: "push", who: "agent", runBranch: `ensemble/${job}/task` }), /worktree/);
  assert.doesNotThrow(() => checkGit(["git", "worktree", "list"], { delivery: "local", who: "agent" }));
  assert.throws(
    () => checkGit(["git", "push", "origin", "main"], { delivery: "push", who: "agent", runBranch: `ensemble/${job}/task` }),
    (error: unknown) => error instanceof GuardError && /only push/.test(error.message),
  );
  assert.throws(
    () => checkGit(["git", "push", "--force", "origin", `ensemble/${job}/task`], { delivery: "push", who: "agent", runBranch: `ensemble/${job}/task` }),
    /Force-push/,
  );
  const allowed = checkGit(["git", "push", "origin", "HEAD"], { delivery: "push", who: "agent", runBranch: `ensemble/${job}/task` });
  assert.equal(allowed.action, "push");
});

test("app git redacts a token that was placed only in its own environment", async () => {
  const result = await runTrustedGit({
    cwd: process.cwd(),
    args: ["--version"],
    credentialEnv: { ENSEMBLE_GIT_TOKEN: "ghp_should_not_appear_123456" },
  });
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /git version/);
  assert.doesNotMatch(result.output, /ghp_should_not_appear/);
});
