/**
 * The computer's git worktrees for parallel work (ensemble-node docs/design B13), against a real repository:
 * a build's worktree on its own branch, the same worktree again for its check, a detached snapshot, what is
 * refused, and removing only what loses nothing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { prepareWorktree, removeWorktrees, worktreePath } from "./worktrees.js";

const home = realpathSync(mkdtempSync(join(homedir(), ".ensemble-worktrees-test-")));
after(() => rmSync(home, { recursive: true, force: true }));
const workspace = join(home, "workspace");
mkdirSync(workspace, { recursive: true });
const userId = "local";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Mira", "-c", "user.email=mira@example.test", ...args], { stdio: "pipe" }).toString().trim();

function repository(name: string, commit = true): string {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  if (commit) {
    writeFileSync(join(repo, "README.md"), "app\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "first");
  }
  return repo;
}

test("a build's worktree is made on its branch from the folder's last commit; its check gets the same one; a snapshot has no branch", async () => {
  const repo = repository("app");
  const build = await prepareWorktree({ userId, folder: repo, workspace, spec: { name: "app-m1-s1", branch: "live-testing-m1/s1" } });
  assert.equal(build.made, true);
  assert.equal(build.path, worktreePath(realpathSync(workspace), "app-m1-s1"));
  assert.equal(build.branch, "live-testing-m1/s1");
  assert.equal(build.gitDir, realpathSync(join(repo, ".git")), "commits land in the repository's own git folder");
  assert.equal(git(build.path, "rev-parse", "HEAD"), git(repo, "rev-parse", "HEAD"));
  assert.equal(git(build.path, "symbolic-ref", "--short", "HEAD"), "live-testing-m1/s1");
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "main", "the folder itself stays on its branch");

  const check = await prepareWorktree({ userId, folder: repo, workspace, spec: { name: "app-m1-s1", branch: "live-testing-m1/s1", reuse: true } });
  assert.deepEqual({ ...check, made: true }, build, "the check works in the build's worktree");
  assert.equal(check.made, false);

  const snapshot = await prepareWorktree({ userId, folder: repo, workspace, spec: { name: "app-m1-s2", detached: true } });
  assert.equal(snapshot.branch, null);
  assert.throws(() => git(snapshot.path, "symbolic-ref", "-q", "HEAD"), "detached");
  assert.match(git(repo, "worktree", "list"), /app-m1-s2/);
});

test("nothing is made where it cannot be: no repository, no commit, a folder in the way, a snapshot that is gone", async () => {
  const plain = join(home, "plain");
  mkdirSync(plain);
  await assert.rejects(prepareWorktree({ userId, folder: plain, workspace, spec: { name: "plain-m1-s1", branch: "ensemble/m1/s1" } }), /not a git repository/);
  const inside = join(repository("outer"), "web");
  mkdirSync(inside);
  await assert.rejects(prepareWorktree({ userId, folder: inside, workspace, spec: { name: "web-m1-s1", branch: "ensemble/m1/s1" } }), /not a git repository/, "a folder inside a repository is not one");
  const empty = repository("empty", false);
  await assert.rejects(prepareWorktree({ userId, folder: empty, workspace, spec: { name: "empty-m1-s1", branch: "ensemble/m1/s1" } }), /no commit yet/);
  const repo = repository("other");
  mkdirSync(worktreePath(workspace, "other-m1-s1"), { recursive: true });
  await assert.rejects(prepareWorktree({ userId, folder: repo, workspace, spec: { name: "other-m1-s1", branch: "ensemble/m1/s1" } }), /is in the way/);
  await assert.rejects(prepareWorktree({ userId, folder: repo, workspace, spec: { name: "other-m1-s9", detached: true, reuse: true } }), /is gone, and its changes were only there/);
});

test("after the integration, worktrees go only when nothing is lost: clean, and kept on a branch or already in the folder", async () => {
  const repo = repository("site");
  const merged = await prepareWorktree({ userId, folder: repo, workspace, spec: { name: "site-m2-s1", branch: "ensemble/m2/s1" } });
  writeFileSync(join(merged.path, "dark.css"), "body{}\n");
  git(merged.path, "add", ".");
  git(merged.path, "commit", "-q", "-m", "dark mode");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge dark", "ensemble/m2/s1");
  const dirty = await prepareWorktree({ userId, folder: repo, workspace, spec: { name: "site-m2-s2", branch: "ensemble/m2/s2" } });
  writeFileSync(join(dirty.path, "search.ts"), "export {};\n");
  const unmerged = await prepareWorktree({ userId, folder: repo, workspace, spec: { name: "site-m2-s3", detached: true } });
  writeFileSync(join(unmerged.path, "nav.ts"), "export {};\n");
  git(unmerged.path, "add", ".");
  git(unmerged.path, "commit", "-q", "-m", "nav");
  const applied = await prepareWorktree({ userId, folder: repo, workspace, spec: { name: "site-m2-s4", detached: true } });

  const removed = await removeWorktrees({ userId, folder: repo, workspace, names: ["site-m2-s1", "site-m2-s2", "site-m2-s3", "site-m2-s4", "site-m2-missing"] });
  assert.deepEqual(removed, ["site-m2-s1", "site-m2-s4"]);
  assert.equal(git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/ensemble/m2/s1").length > 0, true, "its branch keeps the work");
  const left = git(repo, "worktree", "list");
  assert.match(left, /site-m2-s2/, "uncommitted changes stay");
  assert.match(left, /site-m2-s3/, "a detached commit not in the folder stays");
  assert.doesNotMatch(left, /site-m2-s4/);
  assert.equal(applied.branch, null);
});
