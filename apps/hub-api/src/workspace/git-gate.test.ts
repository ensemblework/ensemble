import assert from "node:assert/strict";
import test from "node:test";
import { ghSandboxRefusal, pushRemoteArg, runBranchName, runTrustedGit, trustedPushRefusal } from "./git-gate.js";

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
