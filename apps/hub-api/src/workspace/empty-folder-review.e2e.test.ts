/**
 * A code task with no repository and no folder used to come back as 409.
 *
 * prepareFolder ran `git init` and stopped, so the branch had no commit.
 * Review then called git commands that need HEAD, and any non-zero git exit
 * on that route is a 409. An existing checkout must not gain a commit from
 * preparation, and a real merge conflict must still be a 409.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootSidecar, prepareAccount, sleep, startStubRuntime, type Sidecar } from "../desktop/e2e-harness.js";

async function until<T>(what: string, probe: () => Promise<T | undefined | null | false>, timeoutMs = 60_000): Promise<T> {
  const started = Date.now();
  let last: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

type Job = { id: string; status: string; reviewId?: string | null; error?: string | null; folder?: string; branch: string };

function gitAt(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function gitAllowFail(cwd: string, args: string[]): { code: number; output: string } {
  try {
    return { code: 0, output: gitAt(cwd, args) };
  } catch (error) {
    const failed = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    const text = (value: Buffer | string | undefined) => (value === undefined ? "" : Buffer.isBuffer(value) ? value.toString("utf8") : value);
    return { code: failed.status ?? 1, output: `${text(failed.stdout)}${text(failed.stderr)}`.trim() };
  }
}

function fingerprint(repo: string) {
  return {
    head: gitAt(repo, ["rev-parse", "HEAD"]),
    count: gitAt(repo, ["rev-list", "--count", "HEAD"]),
    status: gitAt(repo, ["status", "--porcelain=v1"]),
    config: createHash("sha256").update(readFileSync(join(repo, ".git", "config"))).digest("hex"),
  };
}

function makeUserRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  gitAt(dir, ["init", "--quiet"]);
  writeFileSync(join(dir, "README"), "user work\n");
  gitAt(dir, ["add", "README"]);
  gitAt(dir, ["commit", "--quiet", "-m", "user commit"]);
  return dir;
}

async function newTask(side: Sidecar, title: string): Promise<string> {
  const created = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.task.id;
}

async function assign(side: Sidecar, input: Record<string, unknown>) {
  return side.api<{ jobId?: string; error?: string }>("/api/agent/assign", {
    json: { kind: "code", provider: "openai", model: "stub-model", sandbox: false, delivery: "local", ...input },
  });
}

async function readJob(side: Sidecar, id: string): Promise<Job> {
  const read = await side.api<{ job: Job }>(`/api/agent/jobs/${id}`);
  return read.body.job;
}

const waitStatus = (side: Sidecar, id: string, statuses: string[]) =>
  until(`job ${id} → ${statuses.join("/")}`, async () => {
    const row = await readJob(side, id);
    if (["failed", "blocked"].includes(row.status) && !statuses.includes(row.status)) throw new Error(`job ${row.status}: ${row.error}`);
    return statuses.includes(row.status) ? row : null;
  });


// macOS tmpdir() is under /private/var, which the workspace guard refuses.
// /tmp resolves to /private/tmp, which it allows.
function scratchRoot(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

test("a code task with no repo or folder can be reviewed, an existing repo stays untouched, and a real conflict is still 409", { timeout: 300_000 }, async (t) => {
  const root = mkdtempSync(join(scratchRoot(), "ensemble-empty-review-"));
  mkdirSync(join(root, "workspace"), { recursive: true });
  const stub = await startStubRuntime();
  const side = await bootSidecar(root, stub.url);
  t.after(async () => {
    await side.stop("SIGKILL");
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  await prepareAccount(side);

  const userRepo = makeUserRepo(join(root, "user-repo"));
  const before = fingerprint(userRepo);
  const leaveTask = await newTask(side, "Leave the user repo alone");
  const left = await assign(side, { taskId: leaveTask, folder: userRepo, accessMode: "read-write" });
  assert.equal(left.status, 201, JSON.stringify(left.body));
  await waitStatus(side, left.body.jobId!, ["succeeded"]);
  assert.deepEqual(fingerprint(userRepo), before, "preparing a task must not commit to or rewrite an existing repository");

  const freshTask = await newTask(side, "[fresh] Leave a note");
  const fresh = await assign(side, { taskId: freshTask });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
  const freshId = fresh.body.jobId!;
  const done = await waitStatus(side, freshId, ["succeeded"]);
  assert.ok(done.reviewId, `a folder with no repo should still produce a review (status ${done.status}: ${done.error ?? ""})`);

  const source = await side.api<{
    repo: string;
    branch: string;
    files: Array<{ path: string }>;
  }>(`/api/code/source?review=${done.reviewId}`);
  assert.equal(source.status, 200, `opening the review must not be 409: ${JSON.stringify(source.body)}`);
  assert.deepEqual(
    source.body.files.map((file) => file.path),
    ["note.txt"],
  );
  const diff = await side.api(`/api/code/diff?review=${done.reviewId}&path=note.txt&untracked=true`);
  assert.equal(diff.status, 200, `the diff must not be 409: ${JSON.stringify(diff.body)}`);

  const repo = source.body.repo;
  assert.equal(gitAt(repo, ["rev-list", "--count", "HEAD"]), "1", "the fresh folder has one empty base commit, not an unborn HEAD");
  assert.equal(gitAt(repo, ["log", "-1", "--format=%s"]), "Initial empty commit");
  assert.equal(gitAt(repo, ["log", "-1", "--format=%an <%ae>"]), "Ensemble Agent <agent@ensemble.local>");
  const base = gitAt(repo, ["rev-parse", "HEAD"]);

  const againTask = await newTask(side, "Continue in the same folder");
  const again = await assign(side, { taskId: againTask, continueFromJobId: freshId });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  await waitStatus(side, again.body.jobId!, ["succeeded"]);
  assert.equal(gitAt(repo, ["rev-parse", "HEAD"]), base, "running prepareFolder again must not add another commit");
  assert.equal(gitAt(repo, ["rev-list", "--count", "HEAD"]), "1");

  const accepted = await side.api<{ commit: string | null; error?: string }>(`/api/code/reviews/${done.reviewId}/accept`, { json: {} });
  assert.equal(accepted.status, 200, `accepting the review must not be 409: ${JSON.stringify(accepted.body)}`);
  assert.ok(accepted.body.commit);
  assert.equal(gitAt(repo, ["rev-list", "--count", "HEAD"]), "2");
  assert.equal(gitAt(repo, ["show", "HEAD:note.txt"]), "hello from a folder with no repo");

  const conflictTask = await newTask(side, "[fresh] Conflict note");
  const conflict = await assign(side, { taskId: conflictTask });
  assert.equal(conflict.status, 201, JSON.stringify(conflict.body));
  const conflictedJob = await waitStatus(side, conflict.body.jobId!, ["succeeded"]);
  assert.ok(conflictedJob.reviewId);
  const conflictSource = await side.api<{ repo: string; branch: string }>(`/api/code/source?review=${conflictedJob.reviewId}`);
  assert.equal(conflictSource.status, 200, JSON.stringify(conflictSource.body));
  const conflictRepo = conflictSource.body.repo;
  const branch = conflictSource.body.branch;
  writeFileSync(join(conflictRepo, "other.txt"), "base\n");
  gitAt(conflictRepo, ["add", "other.txt"]);
  gitAt(conflictRepo, ["commit", "--quiet", "-m", "base"]);
  gitAt(conflictRepo, ["checkout", "-b", "side"]);
  writeFileSync(join(conflictRepo, "other.txt"), "side\n");
  gitAt(conflictRepo, ["add", "other.txt"]);
  gitAt(conflictRepo, ["commit", "--quiet", "-m", "side"]);
  gitAt(conflictRepo, ["checkout", branch]);
  writeFileSync(join(conflictRepo, "other.txt"), "ours\n");
  gitAt(conflictRepo, ["add", "other.txt"]);
  gitAt(conflictRepo, ["commit", "--quiet", "-m", "ours"]);
  const merged = gitAllowFail(conflictRepo, ["merge", "side"]);
  assert.notEqual(merged.code, 0, merged.output);
  assert.match(merged.output, /CONFLICT/);

  const refused = await side.api<{ error?: string }>(`/api/code/reviews/${conflictedJob.reviewId}/accept`, { json: {} });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error ?? "", /conflict|unmerged|failed/i);

  assert.deepEqual(fingerprint(userRepo), before, "the user repository is still untouched after the other reviews");
});

function hasHead(cwd: string): boolean {
  try {
    gitAt(cwd, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

test("an unborn Ensemble folder gets the empty commit, and signing stays off when git is told to sign", { timeout: 300_000 }, async (t) => {
  const root = mkdtempSync(join(scratchRoot(), "ensemble-unborn-review-"));
  mkdirSync(join(root, "workspace"), { recursive: true });
  // GIT_CONFIG_GLOBAL points at this file. Agent children do not receive that
  // variable (it is stripped), so the same text is also the agent's HOME gitconfig,
  // which is the config git actually reads. commit.gpgsign=true plus a program
  // that fails means dropping -c commit.gpgsign=false fails this test.
  const gitconfig = join(root, "sign.gitconfig");
  const signing = "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /bin/false\n";
  writeFileSync(gitconfig, signing);
  const stub = await startStubRuntime();
  const side = await bootSidecar(root, stub.url, { GIT_CONFIG_GLOBAL: gitconfig });
  t.after(async () => {
    await side.stop("SIGKILL");
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, "workspace", ".cache", "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".gitconfig"), signing);

  await prepareAccount(side);

  const userRepo = makeUserRepo(join(root, "user-repo"));
  const before = fingerprint(userRepo);
  const leaveTask = await newTask(side, "Leave the committed repo alone");
  const left = await assign(side, { taskId: leaveTask, folder: userRepo, accessMode: "read-write" });
  assert.equal(left.status, 201, JSON.stringify(left.body));
  await waitStatus(side, left.body.jobId!, ["succeeded"]);
  assert.deepEqual(fingerprint(userRepo), before, "a repository that already has commits is not given an empty commit");

  const unborn = join(root, "user-unborn");
  mkdirSync(unborn);
  gitAt(unborn, ["init", "--quiet"]);
  writeFileSync(join(unborn, "notes.txt"), "mine\n");
  const unbornTask = await newTask(side, "Leave the attached unborn repo alone");
  const attached = await assign(side, { taskId: unbornTask, folder: unborn, accessMode: "read-write" });
  assert.equal(attached.status, 201, JSON.stringify(attached.body));
  await waitStatus(side, attached.body.jobId!, ["succeeded"]);
  assert.equal(hasHead(unborn), false, "a user-attached repo with no commit stays unborn");
  assert.equal(readFileSync(join(unborn, "notes.txt"), "utf8"), "mine\n");

  const freshTask = await newTask(side, "[fresh] Leave a note");
  const fresh = await assign(side, { taskId: freshTask });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
  const freshId = fresh.body.jobId!;
  const done = await waitStatus(side, freshId, ["succeeded"]);
  assert.ok(done.reviewId);
  const source = await side.api<{ repo: string }>(`/api/code/source?review=${done.reviewId}`);
  assert.equal(source.status, 200, JSON.stringify(source.body));
  const repo = source.body.repo;
  assert.equal(gitAt(repo, ["log", "-1", "--format=%s"]), "Initial empty commit");
  assert.equal(gitAt(repo, ["log", "-1", "--format=%an <%ae>"]), "Ensemble Agent <agent@ensemble.local>");
  assert.equal(gitAt(repo, ["log", "-1", "--format=%G?"]), "N", "the base commit is unsigned even when commit.gpgsign is true");

  const branch = gitAt(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  gitAt(repo, ["update-ref", "-d", `refs/heads/${branch}`]);
  assert.equal(hasHead(repo), false, "the folder is back to the pre-fix unborn state");

  const againTask = await newTask(side, "Continue the unborn folder");
  const again = await assign(side, { taskId: againTask, continueFromJobId: freshId });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  await waitStatus(side, again.body.jobId!, ["succeeded"]);
  assert.equal(gitAt(repo, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(gitAt(repo, ["log", "-1", "--format=%s"]), "Initial empty commit");
  assert.equal(gitAt(repo, ["log", "-1", "--format=%an <%ae>"]), "Ensemble Agent <agent@ensemble.local>");
  assert.equal(gitAt(repo, ["log", "-1", "--format=%G?"]), "N");
  const repaired = gitAt(repo, ["rev-parse", "HEAD"]);

  const thirdTask = await newTask(side, "Continue once HEAD exists");
  const third = await assign(side, { taskId: thirdTask, continueFromJobId: again.body.jobId });
  assert.equal(third.status, 201, JSON.stringify(third.body));
  await waitStatus(side, third.body.jobId!, ["succeeded"]);
  assert.equal(gitAt(repo, ["rev-parse", "HEAD"]), repaired, "a folder that already has a commit does not gain another empty one");
  assert.deepEqual(fingerprint(userRepo), before);
  assert.equal(hasHead(unborn), false);
});
