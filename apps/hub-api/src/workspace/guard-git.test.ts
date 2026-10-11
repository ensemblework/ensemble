import assert from "node:assert/strict";
import test from "node:test";
import { checkGit, GuardError } from "./guard.js";

const agent = (delivery: "local" | "commit" | "push") => ({ delivery, who: "agent" as const });
const run = (line: string, delivery: "local" | "commit" | "push") => checkGit(["git", ...line.split(" ")], agent(delivery));

test("Local only refuses every git command that creates or rewrites commits", () => {
  for (const line of ["commit -m x", "merge feature", "cherry-pick abc", "revert abc", "am patch.mbox", "rebase main", "rebase --continue", "tag v1", "notes add -m x", "pull", "pull origin main"]) {
    assert.throws(() => run(line, "local"), GuardError, line);
  }
});

test("Local only still allows reading, staging, and stopping an operation in progress", () => {
  for (const line of ["status", "diff", "add .", "stash", "checkout -b scratch", "merge --abort", "rebase --abort", "cherry-pick --quit", "merge --ff-only origin/main", "merge --no-commit feature", "cherry-pick -n abc", "tag", "tag -l", "notes list", "pull --ff-only", "fetch origin"]) {
    assert.doesNotThrow(() => run(line, "local"), line);
  }
});

test("Commit counts merges and rebases as commits and refuses push", () => {
  assert.equal(run("commit -m x", "commit").action, "commit");
  assert.equal(run("merge feature", "commit").action, "commit");
  assert.equal(run("rebase main", "commit").action, "commit");
  assert.equal(run("tag v1", "commit").action, "commit");
  assert.equal(run("pull", "commit").action, "network");
  assert.throws(() => run("push origin HEAD", "commit"), /may not push/);
});

test("the refusal names the setting so the model can finish without it", () => {
  assert.throws(() => run("rebase main", "local"), /Local only/);
  assert.throws(() => run("pull", "local"), /git fetch, or git pull --ff-only/);
});
