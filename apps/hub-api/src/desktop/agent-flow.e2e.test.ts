/**
 * The desktop agent flow end to end, through the sidecar's HTTP API on PGlite.
 *
 * A stub model runtime stands in for agent-runtime at AGENT_RUNTIME_URL and
 * answers /api/chat/tools from a script picked by the task title. Nothing
 * here talks to a real model or the network.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootSidecar, git, makeSourceRepo, prepareAccount, sleep, startStubRuntime, type Sidecar } from "./e2e-harness.js";

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

type Job = { id: string; status: string; reviewId?: string | null; error?: string | null; branch: string };

async function newTask(side: Sidecar, title: string): Promise<string> {
  const created = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.task.id;
}

async function assign(side: Sidecar, input: Record<string, unknown>) {
  return side.api<{ jobId?: string; error?: string; code?: string }>("/api/agent/assign", {
    json: { kind: "code", provider: "openai", model: "stub-model", ...input },
  });
}

async function job(side: Sidecar, id: string): Promise<Job & { log?: string }> {
  const read = await side.api<{ job: Job; log: string }>(`/api/agent/jobs/${id}`);
  return { ...read.body.job, log: read.body.log };
}

const waitStatus = (side: Sidecar, id: string, statuses: string[], timeoutMs = 60_000) =>
  until(`job ${id} → ${statuses.join("/")}`, async () => {
    const row = await job(side, id);
    if (["failed", "blocked"].includes(row.status) && !statuses.includes(row.status)) throw new Error(`job ${row.status}: ${row.error}`);
    return statuses.includes(row.status) ? row : null;
  }, timeoutMs);

type Decision = { id: string; event: string; toolName: string; sessionId: string | null; detail: { options?: string[] } };
const pendingFor = (side: Sidecar, jobId: string) =>
  until(`a Needs me card for ${jobId}`, async () => {
    const rows = await side.api<{ decisions: Decision[] }>("/api/decisions");
    return rows.body.decisions.find((row) => row.sessionId === jobId);
  });

test("assign → Needs me → answer → review → accept → push, plus cancel, outside paths, unattended trust and restart", { timeout: 600_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-agent-flow-"));
  mkdirSync(join(root, "workspace"), { recursive: true });
  const stub = await startStubRuntime();
  const source = makeSourceRepo(root);
  let side = await bootSidecar(root, stub.url);
  t.after(async () => {
    await side.stop("SIGKILL");
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });
  try {
    await prepareAccount(side);

    // ── the main path ────────────────────────────────────────────────────
    const editTask = await newTask(side, "[edit] Change the greeting");
    const assigned = await assign(side, { taskId: editTask, repoUrl: source, delivery: "commit", askBeforePublish: false });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    const editId = assigned.body.jobId!;

    await waitStatus(side, editId, ["waiting_approval"]);
    const question = await pendingFor(side, editId);
    assert.equal(question.event, "question");
    assert.deepEqual(question.detail.options, ["world", "there"]);
    const answered = await side.api(`/api/decisions/${question.id}/decide`, { json: { decision: "allow", reason: "world" } });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));

    const done = await waitStatus(side, editId, ["succeeded"]);
    assert.ok(done.reviewId, "a finished code job with changes has a review");
    assert.match(done.branch, new RegExp(`^ensemble/${editId}/`));

    const review = await side.api<{ files: Array<{ path: string }>; review: { canPush: boolean; completedAt: string | null } }>(`/api/code/source?review=${done.reviewId}`);
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.deepEqual(review.body.files.map((file) => file.path), ["hello.txt"]);
    const diff = await side.api<{ diff: { hunks: Array<{ lines: Array<{ type: string; text: string }> }> } }>(
      `/api/code/diff?review=${done.reviewId}&path=hello.txt`,
    );
    const added = diff.body.diff.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.type === "add").map((line) => line.text);
    assert.deepEqual(added, ["hello, world"], "the answer from Needs me reached the model and the file");

    const events = await side.api<{ events: Array<{ kind: string; data: { command?: string; tail?: string } }> }>(`/api/agent/jobs/${editId}`);
    const cat = events.body.events.find((event) => event.kind === "command" && event.data.command === "cat hello.txt");
    assert.match(cat?.data.tail ?? "", /hello, world/);

    const accepted = await side.api<{ commit: string; branch: string; pushable: boolean }>(`/api/code/reviews/${done.reviewId}/accept`, { json: {} });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.ok(accepted.body.commit);
    assert.equal(accepted.body.pushable, true);
    assert.equal(git(source, "rev-parse", "--verify", "--quiet", "main"), git(source, "rev-parse", "HEAD"), "the source repository is untouched before push");

    const pushed = await side.api<{ branch: string }>(`/api/code/reviews/${done.reviewId}/push`, { json: {} });
    assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
    assert.equal(git(source, "rev-parse", `refs/heads/${accepted.body.branch}`), accepted.body.commit);
    assert.equal(git(source, "show", `${accepted.body.branch}:hello.txt`), "hello, world");
    assert.equal(git(source, "show", "main:hello.txt"), "hello", "main is never pushed");

    // ── an outside path can be allowed for this run, never "always" ──────
    const outsideTask = await newTask(side, "[outside] Peek at /etc");
    const outside = await assign(side, { taskId: outsideTask, delivery: "local" });
    assert.equal(outside.status, 201, JSON.stringify(outside.body));
    const outsideId = outside.body.jobId!;
    const ask = await pendingFor(side, outsideId);
    assert.equal(ask.toolName, "outside");
    const always = await side.api<{ error: string }>(`/api/decisions/${ask.id}/decide`, { json: { decision: "allow", scope: "always" } });
    assert.equal(always.status, 400, "an outside path is never turned into a trusted folder");
    const trusted = await side.api<{ folders: Array<{ path: string }> }>("/api/workspace/trust");
    assert.deepEqual(trusted.body.folders, []);
    const forRun = await side.api(`/api/decisions/${ask.id}/decide`, { json: { decision: "allow", scope: "session" } });
    assert.equal(forRun.status, 200, JSON.stringify(forRun.body));
    await waitStatus(side, outsideId, ["succeeded"]);
    assert.deepEqual((await side.api<{ folders: unknown[] }>("/api/workspace/trust")).body.folders, []);

    // ── unattended on an untrusted folder is refused at assignment ──────
    const folder = join(root, "project");
    mkdirSync(folder);
    const unattendedTask = await newTask(side, "[edit] Unattended elsewhere");
    const refused = await assign(side, { taskId: unattendedTask, folder, unattended: true, trust: "none", accessMode: "read-write" });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "UNATTENDED_REQUIRES_TRUST");

    // ── cancel a running job ────────────────────────────────────────────
    const cancelTask = await newTask(side, "[slow] Cancel me");
    const cancel = await assign(side, { taskId: cancelTask });
    const cancelId = cancel.body.jobId!;
    await until("the cancel job's first model call", async () => (stub.calls.get("[slow] Cancel me") ?? 0) > 0);
    const stopped = await side.api(`/api/agent/jobs/${cancelId}/stop`, { json: {} });
    assert.equal(stopped.status, 204);
    await waitStatus(side, cancelId, ["cancelled"]);

    // ── quit mid-run, then crash mid-run: interrupted, never re-run ─────
    const quitTitle = "[slow] Interrupted by quit";
    const quitTask = await newTask(side, quitTitle);
    const quitId = (await assign(side, { taskId: quitTask })).body.jobId!;
    await until("the quit job's first model call", async () => (stub.calls.get(quitTitle) ?? 0) > 0);
    await side.stop("SIGTERM");
    side = await bootSidecar(root, stub.url);
    const afterQuit = await job(side, quitId);
    assert.equal(afterQuit.status, "interrupted", afterQuit.error ?? "");

    const crashTitle = "[slow] Interrupted by crash";
    const crashTask = await newTask(side, crashTitle);
    const crashId = (await assign(side, { taskId: crashTask })).body.jobId!;
    await until("the crash job's first model call", async () => (stub.calls.get(crashTitle) ?? 0) > 0);
    await side.stop("SIGKILL");
    side = await bootSidecar(root, stub.url);
    assert.equal((await job(side, crashId)).status, "interrupted");

    const before = { quit: stub.calls.get(quitTitle), crash: stub.calls.get(crashTitle) };
    await sleep(4000);
    assert.deepEqual({ quit: stub.calls.get(quitTitle), crash: stub.calls.get(crashTitle) }, before, "nothing re-runs on its own");
    assert.equal((await job(side, quitId)).status, "interrupted");

    stub.fast.add(quitTitle);
    const again = await side.api<{ jobId: string }>(`/api/agent/jobs/${quitId}/retry`, { json: {} });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.notEqual(again.body.jobId, quitId);
    await waitStatus(side, again.body.jobId, ["succeeded"]);
    assert.equal((await job(side, quitId)).status, "interrupted", "Run again makes a new job; the old one stays as it was");
  } catch (error) {
    console.error(side.logs().slice(-6000));
    throw error;
  }
});
