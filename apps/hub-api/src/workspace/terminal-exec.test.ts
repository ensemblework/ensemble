/**
 * The terminal's rules, shared by the terminal on this computer's page and the web terminal relayed
 * here (docs/16 §5), and the Code tab's file reads and writes, which follow links only inside the
 * repository and never open git's own files.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRepoFile, writeRepoFile } from "../lib/git.js";
import { prepareRun, resolveCd, scopeOf } from "./terminal-exec.js";

function folder(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "terminal-exec-")));
  mkdirSync(join(root, "src"));
  return root;
}

test("one allow-listed command in an allowed folder; destructive ones ask first; shells and chains are refused", async () => {
  const root = folder();
  const allowed = [root];
  const status = await prepareRun({ allowed, cwd: root, line: "git status", confirmed: false, commitAuthor: "", sandboxed: true });
  assert.equal(status.kind, "run");
  if (status.kind === "run") {
    assert.deepEqual(status.argv, ["git", "status"]);
    assert.ok(status.full.includes("core.hooksPath=/dev/null"), "git runs with the repository's hooks off");
  }
  const reset = await prepareRun({ allowed, cwd: root, line: "git reset --hard HEAD", confirmed: false, commitAuthor: "", sandboxed: true });
  assert.equal(reset.kind, "confirm");
  assert.equal((await prepareRun({ allowed, cwd: root, line: "git reset --hard HEAD", confirmed: true, commitAuthor: "", sandboxed: true })).kind, "run");
  for (const line of ["ls; rm -rf /", "cat a | sh", "echo $(id)", "sudo ls", "ssh example.com", "bash -c 'id'"]) {
    await assert.rejects(prepareRun({ allowed, cwd: root, line, confirmed: true, commitAuthor: "", sandboxed: true }), Error, line);
  }
  await assert.rejects(prepareRun({ allowed, cwd: tmpdir(), line: "ls", confirmed: false, commitAuthor: "", sandboxed: true }), /outside/);
});

test("cd stays inside the allowed folders, and an absolute path may only move to another of them", async () => {
  const root = folder();
  const other = folder();
  const allowed = [root, other];
  assert.deepEqual(await resolveCd(allowed, root, "src"), { cwd: join(root, "src"), scope: root });
  assert.deepEqual(await resolveCd(allowed, join(root, "src"), ""), { cwd: root, scope: root }, "cd alone goes to the folder's top");
  assert.deepEqual(await resolveCd(allowed, root, other), { cwd: other, scope: other });
  await assert.rejects(resolveCd(allowed, root, "../.."));
  await assert.rejects(resolveCd(allowed, root, "/etc"), /outside/);
  assert.equal(scopeOf(allowed, join(other, "x")), other);
});

test("the Code tab reads and writes inside the repository only: no links out, no git internals, no huge files", async () => {
  const repo = folder();
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "src", "a.ts"), "a\n");
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  symlinkSync(join(outside, "secret.txt"), join(repo, "notes.txt"));
  symlinkSync(outside, join(repo, "elsewhere"));
  symlinkSync("src/a.ts", join(repo, "alias.ts"));
  assert.equal(await readRepoFile(repo, "src/a.ts"), "a\n");
  assert.equal(await readRepoFile(repo, "alias.ts"), "a\n", "a link inside the repository is followed");
  await assert.rejects(readRepoFile(repo, "notes.txt"), /outside the repository/);
  await assert.rejects(writeRepoFile(repo, "notes.txt", "x"), /outside the repository/);
  await assert.rejects(writeRepoFile(repo, "elsewhere/new.txt", "x"), /outside the repository/);
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "secret\n", "nothing outside was written");
  await assert.rejects(readRepoFile(repo, ".git/config"), /Git's own files/);
  await assert.rejects(writeRepoFile(repo, ".GIT/hooks/pre-commit", "x"), /Git's own files/);
  await assert.rejects(readRepoFile(repo, "../outside.txt"), /outside the repository/);
  writeFileSync(join(repo, "big.txt"), Buffer.alloc(5 * 1024 * 1024 + 1, 97));
  await assert.rejects(readRepoFile(repo, "big.txt"), /5 MB/);
  await writeRepoFile(repo, "src/new.ts", "n\n");
  assert.equal(readFileSync(join(repo, "src", "new.ts"), "utf8"), "n\n");
});
