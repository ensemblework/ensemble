import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

// publish.ts pulls in the API config. A unit run has no .env; the value is never connected to.
process.env.DATABASE_URL ??= "postgresql://ensemble:ensemble@127.0.0.1:1/ensemble_unit";
const { pushWithSignIn } = await import("./publish.js");

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

