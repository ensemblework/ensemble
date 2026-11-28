/**
 * The terminal's rules, shared by the terminal on this computer's page and the web terminal relayed
 * here (docs/16 §5), and the Code tab's file reads and writes, which follow links only inside the
 * repository and never open git's own files.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  const status = await prepareRun({ allowed, cwd: root, line: "git status", confirmed: false, sandboxed: true });
  assert.equal(status.kind, "run");
  if (status.kind === "run") {
    assert.deepEqual(status.argv, ["git", "status"]);
    assert.ok(status.full.includes("core.hooksPath=/dev/null"), "git runs with the repository's hooks off");
  }
  const reset = await prepareRun({ allowed, cwd: root, line: "git reset --hard HEAD", confirmed: false, sandboxed: true });
  assert.equal(reset.kind, "confirm");
  assert.equal((await prepareRun({ allowed, cwd: root, line: "git reset --hard HEAD", confirmed: true, sandboxed: true })).kind, "run");
  for (const line of ["ls; rm -rf /", "cat a | sh", "echo $(id)", "sudo ls", "ssh example.com", "bash -c 'id'"]) {
    await assert.rejects(prepareRun({ allowed, cwd: root, line, confirmed: true, sandboxed: true }), Error, line);
  }
  // A system folder is refused with the reason Open a folder gives.
  await assert.rejects(prepareRun({ allowed, cwd: "/etc", line: "ls", confirmed: false, sandboxed: true }), /holds the operating system/);
});

test("cd moves within the allowed folders, and to any other folder Open a folder accepts, each its own scope", async () => {
  const root = folder();
  const other = folder();
  const allowed = [root, other];
  assert.deepEqual(await resolveCd(allowed, root, "src"), { cwd: join(root, "src"), scope: root });
  assert.deepEqual(await resolveCd(allowed, join(root, "src"), ""), { cwd: root, scope: root }, "cd alone goes to the folder's top");
  assert.deepEqual(await resolveCd(allowed, root, other), { cwd: other, scope: other });
  assert.equal(scopeOf(allowed, join(other, "x")), other);

  // A folder that is not one of the terminal's roots: open, confined to itself.
  const loose = folder();
  assert.deepEqual(await resolveCd([root], root, loose), { cwd: loose, scope: loose });
  assert.deepEqual(await resolveCd([root], loose, "src"), { cwd: join(loose, "src"), scope: join(loose, "src") }, "a folder inside it is its own scope too");
  const run = await prepareRun({ allowed: [root], cwd: loose, line: "ls", confirmed: false, sandboxed: true });
  assert.equal(run.kind === "run" ? run.scope : null, loose);

  // What Open a folder refuses, the terminal refuses: system folders, the disk, the home folder itself, dot-folders in it.
  await assert.rejects(resolveCd(allowed, root, "/etc"), /holds the operating system/);
  await assert.rejects(resolveCd(allowed, root, "/"), /too broad/);
  await assert.rejects(resolveCd(allowed, root, homedir()), /too broad/);
  await assert.rejects(resolveCd(allowed, root, join(homedir(), ".ssh")));
  // A link named directly is refused, like in Open a folder; choose the real folder.
  const link = join(loose, "elsewhere");
  symlinkSync(other, link);
  await assert.rejects(resolveCd([root], loose, link), /link/);
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
