import assert from "node:assert/strict";
import test from "node:test";
import { checkGit, GuardError } from "./guard.js";

const run = (line: string, delivery: "local" | "commit" | "push", sandboxed = false) => checkGit(["git", ...line.split(" ")], { delivery, sandboxed });

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

test("No limits: any branch, force-push, deletes, history rewrites and config are the person's call", () => {
  for (const line of ["push origin main", "push --force origin main", "push origin :old-branch", "push --delete origin x", "push --mirror", "push origin +HEAD:production", "branch -D main", "remote add upstream https://github.com/o/r.git", "remote set-url origin git@github.com:o/r.git", "config core.hooksPath .hooks", "filter-branch --tree-filter x HEAD", "update-ref -d refs/heads/x", "worktree add ../other", "-C sub status", "-c core.sshCommand=x fetch", "lfs pull"]) {
    assert.doesNotThrow(() => run(line, "push"), line);
  }
  assert.equal(run("push --force origin main", "push").action, "push");
});

test("in the sandbox, only config that would start a program outside it is refused", () => {
  assert.throws(() => run("config core.hooksPath .hooks", "push", true), /sandbox/);
  assert.throws(() => run("config --add filter.x.clean cat", "push", true), /sandbox/);
  assert.throws(() => run("-c core.sshCommand=evil fetch", "push", true), /sandbox/);
  for (const line of ["config user.email a@b.c", "config --get core.hooksPath", "remote add upstream https://github.com/o/r.git", "push --force origin main", "branch -D x"]) {
    assert.doesNotThrow(() => run(line, "push", true), line);
  }
});
