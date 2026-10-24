import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { ghSandboxRefusal, pushRemoteArg, runBranchName, runTrustedGit, trustedPushRefusal } from "./git-gate.js";
import { pushWithSignIn } from "./publish.js";

const job = "11111111-2222-4333-8444-555555555555";

test("a run's own branch name is namespaced to the job", () => {
  assert.equal(runBranchName(job, "Fix the flaky test!"), `ensemble/${job}/fix-the-flaky-test`);
});

test("Ensemble runs any push the agent asks for, except options that start a program here", () => {
  assert.equal(trustedPushRefusal(["--force", "origin", "main"]), null);
  assert.equal(trustedPushRefusal(["origin", ":old"]), null);
  assert.match(trustedPushRefusal(["--receive-pack=evil", "origin", "main"]) ?? "", /starts a program/);
  assert.match(trustedPushRefusal(["--exec", "evil", "origin"]) ?? "", /starts a program/);
  assert.equal(pushRemoteArg(["-u", "--force", "upstream", "HEAD:main"]), "upstream");
  assert.equal(pushRemoteArg(["-o", "ci.skip", "origin", "x"]), "origin");
  assert.equal(pushRemoteArg(["--force"]), null);
  assert.equal(ghSandboxRefusal(["gh", "pr", "merge", "12", "--merge"]), null);
  assert.match(ghSandboxRefusal(["gh", "extension", "install", "x/y"]) ?? "", /sandbox/);
});

test("a push to any branch, including main and a force-push, really runs with the run's git", async () => {
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
    const push = (rest: string[]) => pushWithSignIn({ prisma: {} as PrismaClient, userId: "", job: { repoUrl: remote, continueFromJobId: null, externalRoot: null }, root: work, rest, sandboxed: false });
    const first = await push(["origin", "HEAD:main"]);
    assert.equal(first.exitCode, 0, first.output);
    await writeFile(join(work, "a.txt"), "rewritten\n");
    sh(work, "commit", "--quiet", "--amend", "-am", "rewritten");
    assert.notEqual((await push(["origin", "HEAD:main"])).exitCode, 0, "without --force git itself refuses a rewrite");
    const forced = await push(["--force", "origin", "HEAD:main"]);
    assert.equal(forced.exitCode, 0, forced.output);
    assert.equal(sh(dir, "--git-dir", remote, "log", "-1", "--format=%s", "main").trim(), "rewritten");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
