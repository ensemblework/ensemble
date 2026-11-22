/**
 * An assigned run's checks decide its task (docs/25 §4, docs/35 §8): a computer that runs them again
 * (`capabilities.runVerification`) sends what they showed with the run's end, and the web marks the task
 * done only when they passed. Failed: not done, with the failure on the task; not confirmed: finished,
 * not verified. The run's node is told the same, and a plan step ends with Ensemble's runs, not the
 * worker's word. A computer without the capability keeps the old behaviour. The computer is simulated
 * with its device key.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { postMessage } = await import("./store.js");
const { pollRuns } = await import("./runs.js");
const { completionOf } = await import("../workspace/completion.js");
const { acceptanceChecksFor } = await import("../workspace/acceptance-checks.js");
after(() => h.close());

setAskRuntimeStreamForTests(async (args) => {
  const turn: RuntimeTurn = { text: "ok", toolCalls: [], model: "test-model", credits: 0, tokensIn: 1, tokensOut: 1, reasoning: "", raw: {}, finishReason: "stop", cutOff: false };
  args.onDelta?.("ok");
  return turn;
});
afterEach(() => settleTurns());

const json = (response: LightMyRequestResponse) => response.json() as any;
const NOTES = "Write out.csv from data.json.\n\nAcceptance: AC-1 `node accept.js` passes in the export folder.";
const none = { state: "none" as const, url: null, source: null };
const acceptanceRun = (verdict: "pass" | "fail" | "not_run", reason: string | null) => ({
  name: "AC-1 `node accept.js` passes in the export folder.",
  id: "AC-1",
  command: "node accept.js",
  cwd: null,
  expects: "exit_0" as const,
  claimed: "skipped" as const,
  verdict,
  reason,
  exitCode: verdict === "fail" ? 1 : verdict === "pass" ? 0 : null,
  ms: 40,
  counts: null,
  output: verdict === "fail" ? "AC-1 failed: out.csv has no header" : "",
  from: "acceptance" as const,
});
const completionWith = (verdict: "pass" | "fail" | "not_run", reason: string | null = null) => completionOf({ outcome: "success", files: [{ added: 4, removed: 0 }], report: null, runs: [acceptanceRun(verdict, reason)], pr: none });

/** Mira, her computer (its device key, with or without runVerification), her node and their chat. */
async function setup(verifies: boolean) {
  const mira = await h.asUser();
  await h.prisma.user.update({ where: { id: mira.id }, data: { name: "Mira", emailVerifiedAt: new Date() } });
  const key = await h.asToken(mira, "device");
  const laptop = await h.prisma.device.create({ data: { userId: mira.id, name: "Mira's laptop", platform: "linux", tokenId: key.id, lastSeenAt: new Date(), capabilities: { folders: ["app"], engines: ["copilot-cli"], ...(verifies ? { runVerification: 1 } : {}) } as never } });
  const created = await mira.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  assert.equal(created.statusCode, 201, created.body);
  const { node, room } = json(created) as { node: { id: string; slug: string }; room: { id: string } };
  return { mira, key, laptop, node, room };
}

/** A node's session run for a board task with an acceptance command, running on the laptop under a lease. */
async function nodeRun(env: Awaited<ReturnType<typeof setup>>, title: string, planned?: { planId: string; planStep: string }) {
  const task = await h.prisma.task.create({ data: { userId: env.mira.id, title, notes: NOTES, owner: "agent", status: "in_progress" } });
  const leaseToken = randomBytes(8).toString("hex");
  const job = await h.prisma.workspaceJob.create({
    data: { userId: env.mira.id, taskId: task.id, deviceId: env.laptop.id, kind: "code", executionMode: "native", model: "gpt-6-luna", provider: "copilot-cli", status: "running", markDone: true, leaseOwner: env.laptop.id, leaseUntil: new Date(Date.now() + 600_000), leaseToken, context: { node: { nodeId: env.node.id } } },
  });
  const { message: root } = await postMessage(h.prisma, { roomId: env.room.id, userId: env.mira.id, authorKind: "human", body: `do ${title}` });
  const { message: card } = await postMessage(h.prisma, { roomId: env.room.id, userId: env.mira.id, authorKind: "node", authorNodeId: env.node.id, kind: "run", body: title, data: { jobId: job.id, status: "running", private: false }, rootMessageId: root.id });
  await h.prisma.nodeRun.create({ data: { userId: env.mira.id, nodeId: env.node.id, roomId: env.room.id, messageId: card.id, jobId: job.id, taskId: task.id, status: "running", settings: { resolved: { agent: "copilot-cli" } }, ...(planned ?? {}) } });
  return { task, job, leaseToken, card };
}

async function finish(env: Awaited<ReturnType<typeof setup>>, run: Awaited<ReturnType<typeof nodeRun>>, extra: Record<string, unknown>) {
  const done = await env.key.inject({ method: "POST", url: `/api/devices/self/jobs/${run.job.id}/complete`, payload: { leaseToken: run.leaseToken, outcome: "succeeded", summary: "Created out.csv; node accept.js passed.", ...extra } });
  assert.equal(done.statusCode, 200, done.body);
}

/** What the node is told when its run ends: the wake its run's end wrote. */
async function told(jobId: string): Promise<string> {
  await pollRuns(h.app);
  const run = await h.prisma.nodeRun.findUniqueOrThrow({ where: { jobId } });
  const wake = await h.prisma.nodeOutbox.findUniqueOrThrow({ where: { operationId: `run:${run.id}:end` } });
  return String((wake.payload as { request: { note: string } }).request.note);
}

test("the web marks a task done only when the checks its computer ran again passed; the node hears what they showed", async () => {
  const env = await setup(true);

  const passing = await nodeRun(env, "Export the Q3 numbers");
  await finish(env, passing, { completion: completionWith("pass") });
  assert.equal((await h.prisma.task.findUniqueOrThrow({ where: { id: passing.task.id } })).status, "done");
  const kept = await h.prisma.run.findFirstOrThrow({ where: { workspaceJob: { id: passing.job.id } }, select: { completion: true } });
  assert.equal((kept.completion as { checks: { state: string } }).checks.state, "passed", "the completion is kept on the web's run");
  assert.match(await told(passing.job.id), /finished, and its checks passed when Ensemble ran them again[\s\S]*Ensemble ran its checks again: passed AC-1 node accept\.js/);

  const failing = await nodeRun(env, "Export the Q4 numbers");
  await finish(env, failing, { completion: completionWith("fail", "It exited 1.") });
  const blocked = await h.prisma.task.findUniqueOrThrow({ where: { id: failing.task.id } });
  assert.equal(blocked.status, "blocked", "never done when a check failed");
  assert.match(JSON.stringify(blocked.blockedQuestion), /Its checks failed when Ensemble ran them again: AC-1 node accept\.js: It exited 1\./);
  const note = await told(failing.job.id);
  assert.match(note, /finished, but its checks failed when Ensemble ran them again/);
  assert.match(note, /failed AC-1 node accept\.js \(It exited 1\.\)/);
  assert.match(note, /The task was not marked done/);
  assert.match(note, /fix the work or say what is next: never change the check, its files or what it keeps between runs/);

  const unconfirmed = await nodeRun(env, "Export the yearly numbers");
  await finish(env, unconfirmed, { completion: completionWith("not_run", "A program it needs was not found here (exit 127).") });
  assert.equal((await h.prisma.task.findUniqueOrThrow({ where: { id: unconfirmed.task.id } })).status, "waiting_approval");
  assert.match(await told(unconfirmed.job.id), /finished, not verified[\s\S]*not run AC-1 node accept\.js/);

  // Its checks never came back (the computer could not run them): finished, not verified, as the task has a command.
  const silent = await nodeRun(env, "Export the monthly numbers");
  await finish(env, silent, {});
  assert.equal((await h.prisma.task.findUniqueOrThrow({ where: { id: silent.task.id } })).status, "waiting_approval");
});

test("a computer that does not run checks again keeps the old behaviour; a plan step ends with Ensemble's runs, not the worker's word", async () => {
  const older = await setup(false);
  const run = await nodeRun(older, "Export the Q1 numbers");
  await finish(older, run, {});
  assert.equal((await h.prisma.task.findUniqueOrThrow({ where: { id: run.task.id } })).status, "done");

  // The step's own acceptance criteria name a command too.
  const env = await setup(true);
  const mission = await h.prisma.nodeMission.create({
    data: { id: randomUUID(), userId: env.mira.id, leadNodeId: env.node.id, originRoomId: env.room.id, goal: "Export the numbers", status: "running", requirements: [{ id: "R1", text: "The export", acceptance: [{ id: "AC-9", text: "`npm test` passes" }] }] },
  });
  await h.prisma.nodeStep.create({ data: { missionId: mission.id, id: "S1", position: 0, nodeId: env.node.id, handle: env.node.slug, name: "Build", kind: "build", brief: "Write the export.", requirementIds: ["R1"], status: "working", attempt: 1 } });
  const step = await nodeRun(env, "Export the Q2 numbers", { planId: mission.id, planStep: "S1" });
  const acceptance = await acceptanceChecksFor(h.prisma, { userId: env.mira.id, jobId: step.job.id, parts: [NOTES] });
  assert.deepEqual(acceptance.map((check) => [check.id, check.command]), [["AC-1", "node accept.js"], ["AC-9", "npm test"]], "the task's and the step's commands");
  const report = { outcome: "done", summary: "Exported.", checks: [{ id: "AC-1", name: "acceptance", verdict: "pass", rerun: { command: "node accept.js", expects: "exit_0" } }] };
  const runs = [{ ...acceptanceRun("fail", "It exited 1."), name: "acceptance", claimed: "pass" as const, from: undefined }];
  await finish(env, step, { report, completion: completionOf({ outcome: "success", files: [], report: report as never, runs, pr: none }) });
  await pollRuns(h.app);
  const ended = await h.prisma.nodeStep.findFirstOrThrow({ where: { missionId: mission.id, id: "S1" } });
  assert.notEqual(ended.status, "done", "the worker said pass; Ensemble's run failed");
  assert.equal(ended.outcome, "blocked", "a builder whose own check failed is blocked (report.ts verdictOf)");
});

test("the owner's own choice while the checks ran stands: the run moves its task only from the status it left it in, and keeps what its checks showed", async () => {
  const env = await setup(true);
  const run = await nodeRun(env, "Export the Q3 numbers again");
  // Mira marks it done while her computer runs the checks: a status edit keeps the task with the agent.
  const marked = await env.mira.inject({ method: "PATCH", url: `/api/tasks/${run.task.id}`, payload: { status: "done" } });
  assert.equal(marked.statusCode, 200, marked.body);
  await finish(env, run, { completion: completionWith("fail", "It exited 1.") });
  const task = await h.prisma.task.findUniqueOrThrow({ where: { id: run.task.id } });
  assert.deepEqual([task.status, task.owner, Boolean(task.completedAt)], ["done", "agent", true], "her done stands");
  assert.equal(await h.prisma.taskTransition.count({ where: { taskId: run.task.id, actor: "agent", toStatus: "blocked" } }), 0);
  const kept = await h.prisma.run.findFirstOrThrow({ where: { workspaceJob: { id: run.job.id } }, select: { completion: true } });
  assert.equal((kept.completion as { checks: { state: string } }).checks.state, "failed", "the run keeps what its checks showed");
  const noted = await h.prisma.workspaceEvent.findFirstOrThrow({ where: { jobId: run.job.id, kind: "task_kept" } });
  assert.deepEqual(noted.data, { status: "done", wanted: "blocked", verified: "failed", question: "Its checks failed when Ensemble ran them again: AC-1 node accept.js: It exited 1." });
  const note = await told(run.job.id);
  assert.match(note, /Its owner marked the task done; it stays done, though its checks failed/);
  assert.doesNotMatch(note, /The task was not marked done/);
});

test("a run claimed while its task was in another status moves it from that status: the claim records where it left the task", async () => {
  const env = await setup(true);
  const task = await h.prisma.task.create({ data: { userId: env.mira.id, title: "Export the numbers once more", notes: NOTES, owner: "agent", status: "done", completedAt: new Date() } });
  const job = await h.prisma.workspaceJob.create({ data: { userId: env.mira.id, taskId: task.id, deviceId: env.laptop.id, kind: "code", executionMode: "native", model: "gpt-6-luna", provider: "copilot-cli", status: "queued", markDone: true } });
  const claimed = await env.key.inject({ method: "POST", url: "/api/devices/self/claim" });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const spec = json(claimed) as { id: string; leaseToken: string; acceptance?: Array<{ command: string }> };
  assert.equal(spec.id, job.id);
  assert.deepEqual(spec.acceptance?.map((check) => check.command), ["node accept.js"]);
  const stored = await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal((stored.context as { taskStatusAtStart?: string }).taskStatusAtStart, "done");
  const done = await env.key.inject({ method: "POST", url: `/api/devices/self/jobs/${job.id}/complete`, payload: { leaseToken: spec.leaseToken, outcome: "succeeded", summary: "Done.", completion: completionWith("fail", "It exited 1.") } });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal((await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status, "blocked", "moved from the status the claim left it in");
});
