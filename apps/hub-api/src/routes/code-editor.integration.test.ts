/**
 * The Code tab editor's routes against a real repository and Postgres (docs/16 §1–§2): the versions of
 * a file, accepting changes without touching the file, a save that refuses to overwrite a file changed
 * on disk and keeps its line endings, restoring the run's version, progress, the folder, "go to file"
 * and find in files. Skips when the database is down.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { ZodError } from "zod";
import { prisma } from "../lib/prisma.js";
import "../types.js";
import { codeRoutes } from "./code.js";

const MODULES = "code,diagrams,metrics,runs,skills,workspace";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// macOS's tmpdir() is under /private/var, which the folder rules refuse; /tmp is allowed.
const scratch = process.env.TMPDIR && /^\/(private\/)?tmp\//.test(process.env.TMPDIR) ? process.env.TMPDIR : "/tmp";
const base = realpathSync(mkdtempSync(join(scratch, "ensemble-code-editor-")));
test.after(() => rmSync(base, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
}

function snapshot(repo: string): string {
  const index = join(base, `index-${randomBytes(4).toString("hex")}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync("git", ["read-tree", "HEAD"], { cwd: repo, env });
  execFileSync("git", ["add", "-A"], { cwd: repo, env, stdio: "ignore" });
  return execFileSync("git", ["write-tree"], { cwd: repo, env, encoding: "utf8" }).trim();
}

const START = "export const name = 'old';\nexport const kept = true;\n// end\n";
const AGENT = "export const name = 'new';\nexport const kept = true;\n// end\n";

async function build(userId: string): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1 } as unknown as Redis);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map((issue) => issue.message).join("; ") });
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(statusCode).send({ error: (error as Error).message });
  });
  app.addHook("onRequest", async (request) => {
    request.userId = userId;
    request.authVia = "session";
    request.modules = MODULES;
  });
  await app.register(codeRoutes);
  return app;
}

test("the editor's routes: versions, accept, a guarded save that keeps line endings, restore, progress, folder, files and search", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  process.env.ENSEMBLE_WORKSPACE_ROOT = base;
  const repo = join(base, "runs", "job");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q");
  writeFileSync(join(repo, "src", "name.ts"), START);
  writeFileSync(join(repo, "win.txt"), "one\r\ntwo\r\n");
  writeFileSync(join(repo, ".env"), "TOKEN=1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "start");
  const initialHead = git(repo, "rev-parse", "HEAD").trim();
  const startTree = snapshot(repo);
  writeFileSync(join(repo, "src", "name.ts"), AGENT);
  writeFileSync(join(repo, "src", "added.ts"), "export const fresh = 1;\n");
  const endTree = snapshot(repo);

  const user = await prisma.user.create({ data: { email: `code-editor-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Editor" } });
  const task = await prisma.task.create({ data: { userId: user.id, title: "Rename the export", createdBy: "me", status: "todo" } });
  const job = await prisma.workspaceJob.create({ data: { userId: user.id, taskId: task.id, executionMode: "sandbox", model: "test", repoPath: repo } as never });
  const review = await prisma.codeReview.create({
    data: { userId: user.id, jobId: job.id, repoPath: repo, initialHead, startTree, endTree, agentPaths: ["src/name.ts", "src/added.ts"], expiresAt: new Date(Date.now() + 86_400_000) },
  });
  const app = await build(user.id);
  const get = async (url: string) => {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
    return res.json() as Record<string, unknown>;
  };
  const q = (extra: Record<string, string>) => new URLSearchParams({ review: review.id, ...extra }).toString();
  try {
    // The three versions, and what it is compared against.
    const versions = await get(`/api/code/versions?${q({ path: "src/name.ts" })}`);
    assert.equal(versions.start, START);
    assert.equal(versions.agent, AGENT);
    assert.equal(versions.original, START);
    assert.equal(versions.current, AGENT);
    const hash = versions.hash as string;
    assert.match(hash, /^[0-9a-f]{40}$/);
    const fresh = await get(`/api/code/versions?${q({ path: "src/added.ts" })}`);
    assert.deepEqual(fresh.exists, { start: false, agent: true, current: true });

    // Progress: two of the agent's changes, none decided yet.
    let progress = await get(`/api/code/progress?${q({})}`);
    assert.equal(progress.total, 2);
    assert.equal(progress.pending, 2);

    // Accept: the file on disk does not change; it is now compared against the accepted text.
    const accepted = await app.inject({ method: "POST", url: "/api/code/accept-content", payload: { review: review.id, path: "src/name.ts", content: AGENT } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(readFileSync(join(repo, "src", "name.ts"), "utf8"), AGENT);
    assert.equal((await get(`/api/code/versions?${q({ path: "src/name.ts" })}`)).original, AGENT);
    progress = await get(`/api/code/progress?${q({})}`);
    assert.equal(progress.pending, 1, "one change left to decide");

    // A save that names the version it read; a stale one is refused, nothing is written.
    const edited = AGENT.replace("// end", "// end, checked");
    const saved = await app.inject({ method: "PUT", url: "/api/code/file", payload: { review: review.id, path: "src/name.ts", content: edited, expectedHash: hash } });
    assert.equal(saved.statusCode, 200, saved.body);
    const stale = await app.inject({ method: "PUT", url: "/api/code/file", payload: { review: review.id, path: "src/name.ts", content: "lost", expectedHash: hash } });
    assert.equal(stale.statusCode, 409);
    assert.equal((stale.json() as { conflict: boolean }).conflict, true);
    assert.equal(readFileSync(join(repo, "src", "name.ts"), "utf8"), edited);

    // The file's own line endings are kept.
    const win = await get(`/api/code/versions?${q({ path: "win.txt" })}`);
    assert.equal(win.current, "one\ntwo\n");
    assert.equal(win.eol, "crlf");
    await app.inject({ method: "PUT", url: "/api/code/file", payload: { review: review.id, path: "win.txt", content: "one\ntwo\nthree\n" } });
    assert.equal(readFileSync(join(repo, "win.txt"), "utf8"), "one\r\ntwo\r\nthree\r\n");

    // Restore the run's version: your edit and the accepted state for that file are dropped.
    const restored = await app.inject({ method: "POST", url: "/api/code/restore", payload: { review: review.id, path: "src/name.ts" } });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(readFileSync(join(repo, "src", "name.ts"), "utf8"), AGENT);
    assert.equal((await get(`/api/code/versions?${q({ path: "src/name.ts" })}`)).original, START);

    // The folder, without git's own files; secrets files are flagged.
    const tree = await get(`/api/code/tree?${q({ path: "" })}`);
    const names = (tree.entries as Array<{ name: string; secret: boolean }>).map((entry) => `${entry.name}${entry.secret ? "*" : ""}`);
    assert.ok(names.includes("src"));
    assert.ok(names.includes(".env*"));
    assert.equal(names.includes(".git"), false);
    const files = await get(`/api/code/files?${q({})}`);
    assert.ok((files.files as string[]).includes("src/added.ts"), "new files are listed too");
    const found = await get(`/api/code/search?${q({ q: "KEPT" })}`);
    assert.deepEqual((found.results as Array<{ path: string; line: number }>).map((row) => [row.path, row.line]), [["src/name.ts", 2]]);
    const exact = await get(`/api/code/search?${q({ q: "KEPT", case: "1" })}`);
    assert.equal((exact.results as unknown[]).length, 0);

    // Git's own files are never opened or written.
    assert.equal((await app.inject({ method: "GET", url: `/api/code/versions?${q({ path: ".git/config" })}` })).statusCode, 403);
    assert.equal((await app.inject({ method: "PUT", url: "/api/code/file", payload: { review: review.id, path: ".git/hooks/pre-commit", content: "x" } })).statusCode, 403);
  } finally {
    await app.close();
    await prisma.codeReviewDecision.deleteMany({ where: { reviewId: review.id } });
    await prisma.codeReview.deleteMany({ where: { userId: user.id } });
    await prisma.workspaceJob.deleteMany({ where: { userId: user.id } });
    await prisma.auditLedger.deleteMany({ where: { userId: user.id } });
    await prisma.task.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});

test("commit exactly the ticked files with hooks off, open a pull request, and keep the run's snapshots pinned until they expire", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  process.env.ENSEMBLE_WORKSPACE_ROOT = base;
  const { encrypt } = await import("../lib/secrets.js");
  const { pinReviewSnapshots, unpinReviewSnapshots } = await import("../lib/code-commit.js");
  const repo = join(base, "runs", "commit-job");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "notes.md"), "notes\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "start");
  git(repo, "checkout", "-q", "-b", "ensemble/feature");
  git(repo, "remote", "add", "origin", "https://github.com/acme/app.git");
  const initialHead = git(repo, "rev-parse", "HEAD").trim();
  // Your work before the run: notes.md, not committed.
  writeFileSync(join(repo, "notes.md"), "notes, mine\n");
  const startTree = snapshot(repo);
  // The run: edits a.txt, adds b.txt.
  writeFileSync(join(repo, "a.txt"), "a, by the agent\n");
  writeFileSync(join(repo, "b.txt"), "b\n");
  const endTree = snapshot(repo);
  // A hook that would leave a mark if it ran.
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  for (const hook of ["pre-commit", "commit-msg", "post-commit"]) writeFileSync(join(repo, ".git", "hooks", hook), `#!/bin/sh\ntouch "${join(repo, `hooked-${hook}`)}"\n`, { mode: 0o755 });
  // Something else you staged stays staged.
  git(repo, "add", "notes.md");

  const user = await prisma.user.create({ data: { email: `code-commit-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: "Committer" } });
  const task = await prisma.task.create({ data: { userId: user.id, title: "Agent work", createdBy: "me", status: "todo" } });
  const job = await prisma.workspaceJob.create({ data: { userId: user.id, taskId: task.id, executionMode: "sandbox", model: "claude-sonnet", repoPath: repo, summary: "The agent's report." } as never });
  const review = await prisma.codeReview.create({
    data: { userId: user.id, jobId: job.id, repoPath: repo, initialHead, startTree, endTree, agentPaths: ["a.txt", "b.txt"], expiresAt: new Date(Date.now() - 1000) },
  });
  await prisma.modelCredential.create({ data: { userId: user.id, provider: "github_git", secret: encrypt("ghs_testtoken") } });
  const app = await build(user.id);
  const realFetch = globalThis.fetch;
  const sent: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.github.com/")) return realFetch(input, init);
    sent.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ html_url: "https://github.com/acme/app/pull/7", number: 7 }), { status: 201 });
  }) as typeof fetch;
  try {
    const plan = (await app.inject({ method: "GET", url: `/api/code/commit-plan?review=${review.id}` })).json() as { run: string[]; before: string[]; branch: string; github: unknown; proposal: string };
    assert.deepEqual(plan.run, ["a.txt", "b.txt"]);
    assert.deepEqual(plan.before, ["notes.md"]);
    assert.deepEqual(plan.github, { owner: "acme", repo: "app" });
    assert.equal(plan.proposal, "The agent's report.");

    const committed = await app.inject({ method: "POST", url: "/api/code/commit-paths", payload: { review: review.id, paths: ["a.txt", "b.txt"], message: "Use the agent's change\n\nCo-authored-by: Ensemble agent <agent@ensemble.local>" } });
    assert.equal(committed.statusCode, 200, committed.body);
    const commit = (committed.json() as { commit: string }).commit;
    assert.equal(git(repo, "rev-parse", "HEAD").trim(), commit);
    assert.deepEqual(git(repo, "show", "--name-only", "--format=", commit).trim().split("\n").sort(), ["a.txt", "b.txt"]);
    assert.match(git(repo, "log", "-1", "--format=%B"), /Co-authored-by: Ensemble agent/);
    assert.match(git(repo, "status", "--porcelain"), /^M  notes\.md/m, "what you staged before stays staged, uncommitted");
    for (const hook of ["pre-commit", "commit-msg", "post-commit"]) assert.equal(execFileSync("ls", [repo]).toString().includes(`hooked-${hook}`), false, `${hook} did not run`);
    assert.equal((await app.inject({ method: "POST", url: "/api/code/commit-paths", payload: { review: review.id, paths: [".git/config"], message: "x" } })).statusCode, 403);

    const opened = await app.inject({ method: "POST", url: "/api/code/pull-request", payload: { review: review.id, title: "Use the agent's change", body: "Why.", base: "main", draft: true } });
    assert.equal(opened.statusCode, 200, opened.body);
    assert.deepEqual(opened.json(), { ok: true, url: "https://github.com/acme/app/pull/7", number: 7 });
    assert.equal(sent[0]!.url, "https://api.github.com/repos/acme/app/pulls");
    assert.deepEqual(sent[0]!.body, { title: "Use the agent's change", body: "Why.", head: "ensemble/feature", base: "main", draft: true });
    assert.equal(sent[0]!.auth, "Bearer ghs_testtoken");

    // Snapshots pinned under refs/ensemble/review, then unpinned when the review expires.
    const pinned = await pinReviewSnapshots(repo, user.id, job.id, { start: startTree, end: endTree });
    assert.equal(git(repo, "rev-parse", `refs/ensemble/review/${job.id}/start^{tree}`).trim(), startTree);
    assert.equal(git(repo, "rev-parse", `refs/ensemble/review/${job.id}/end`).trim(), pinned.end);
    const { runRetention } = await import("../jobs/retention.js");
    await runRetention(app as never, user.id, { deletedDays: 30, completedDays: 30 });
    const after = await prisma.codeReview.findUnique({ where: { id: review.id } });
    assert.ok(after?.expiredAt, "the expired review is marked");
    assert.equal(execFileSync("git", ["for-each-ref", "refs/ensemble/review"], { cwd: repo, encoding: "utf8" }).trim(), "", "and its snapshots unpinned");
    await unpinReviewSnapshots(repo, user.id, job.id);
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
    await prisma.modelCredential.deleteMany({ where: { userId: user.id } });
    await prisma.codeReview.deleteMany({ where: { userId: user.id } });
    await prisma.workspaceJob.deleteMany({ where: { userId: user.id } });
    await prisma.auditLedger.deleteMany({ where: { userId: user.id } });
    await prisma.task.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});
