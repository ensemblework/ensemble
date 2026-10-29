/**
 * Direct dispatch end to end (ensemble-node docs/design B8) against an in-memory database with the model
 * scripted: work in files goes from its packet straight to a coding agent, and its worker's report ends
 * the step, so no step node takes a model turn between hand-over and verdict; a failed check repairs the
 * build in the builder's own session and retests in the checker's; a run that ends without its result is
 * asked once, then its node judges; "ask me before computer work" still holds the packet for a card.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { randomBytes } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { pollRuns } = await import("./runs.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
const { REPORT_ASK } = await import("./dispatch.js");
after(() => h.close());

type Call = { name: string; arguments: Record<string, unknown> };
type Step = { calls?: Call[]; text?: string; then?: string };
type Seen = { slug: string; transcript: string };
let script: (turn: Seen) => Step = () => ({ text: "ok" });
const seen: Seen[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const system = messages.filter((row) => row.role === "system").map((row) => String(row.content)).join("\n");
  const slug = /You are .+? \(@([a-z0-9-]+)\), (?:an Ensemble Node|a temporary helper)/.exec(system)?.[1] ?? "?";
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  const current: Seen = { slug, transcript };
  if (!second) seen.push(current);
  const step = script(current);
  const calls = second ? [] : (step.calls ?? []);
  const text = second ? (step.then ?? "Done.") : calls.length ? "" : (step.text ?? "ok");
  const turn: RuntimeTurn = {
    text,
    toolCalls: calls.map((call, index) => ({ id: `call-${randomBytes(4).toString("hex")}-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })),
    model: "test-model",
    credits: 0,
    tokensIn: 10,
    tokensOut: 5,
    reasoning: "",
    raw: {},
    finishReason: "stop",
    cutOff: false,
  };
  if (text) args.onDelta?.(text);
  return turn;
});

afterEach(async () => {
  await settleTurns();
  seen.length = 0;
});

const json = (response: LightMyRequestResponse) => response.json() as any;

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

async function createNode(user: HttpUser, templateId: string) {
  const response = await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId } });
  assert.equal(response.statusCode, 201, response.body);
  return json(response) as { node: { id: string; slug: string }; room: { id: string } };
}

async function laptopFor(user: HttpUser) {
  const key = await h.asToken(user, "device");
  const laptop = await h.prisma.device.create({
    data: { userId: user.id, name: "Laptop", platform: "linux", tokenId: key.id, capabilities: { folders: ["live-test"], engines: ["claude-code", "codex"] }, lastSeenAt: new Date() },
  });
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "careful", name: "Careful", engine: "claude-code", mode: "ask", delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "careful" });
  return laptop;
}

async function crew(user: HttpUser) {
  const ids: Record<string, string> = {};
  for (const template of ["manager", "feature-engineer", "tester"]) ids[template] = (await createNode(user, template)).node.id;
  const made = await user.inject({ method: "POST", url: "/api/node/crews", payload: { title: `Crew ${randomBytes(3).toString("hex")}`, nodeIds: Object.values(ids), leadNodeId: ids.manager } });
  assert.equal(made.statusCode, 201, made.body);
  return { ids, room: json(made).room as { id: string } };
}

const PLAN = {
  goal: "Markdown tables render record titles safely",
  requirements: [{ id: "R1", text: "Titles containing | stay in one cell", acceptance: [{ id: "A1", text: "A title with | renders in one cell" }] }],
  constraints: { folder: "~/ensemble-workspace/live-test", branch: "live-testing", publish: "push", agent: "codex", notes: ["Webapp only."] },
  steps: [
    { id: "build", to: "builder", kind: "build", requirementIds: ["R1"], brief: "Escape | in record titles in Markdown tables." },
    { id: "check", to: "tester", kind: "verify", requirementIds: ["R1"], brief: "Check record titles with | in tables.", after: ["build"], verifies: "build" },
  ],
};

async function post(user: HttpUser, roomId: string, body: string) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });
  assert.equal(response.statusCode, 201, response.body);
  await settleTurns();
}

/** The live run of a step: its node run and job. */
async function runOf(planId: string, stepKind: "build" | "verify", index = 0) {
  const step = await h.prisma.nodeStep.findFirstOrThrow({ where: { missionId: planId, kind: stepKind } });
  const runs = await h.prisma.nodeRun.findMany({ where: { planId, planStep: step.id }, orderBy: { createdAt: "asc" } });
  const run = runs[index];
  assert.ok(run, `run ${index} of the ${stepKind} step`);
  const row = await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: run.jobId }, include: { task: { select: { description: true } } } });
  // What the agent is given: an off-board run's prompt is its task's description, plus any instructions.
  const job = { ...row, instructions: [row.task?.description, row.instructions].filter(Boolean).join("\n\n") };
  return { step, run, job, runs };
}

async function finish(jobId: string, report: Record<string, unknown> | null, summary = "Done.") {
  await h.prisma.workspaceJob.update({ where: { id: jobId }, data: { status: "succeeded", summary, startedAt: new Date(), finishedAt: new Date(), ...(report ? { report: report as never } : {}) } });
  await pollRuns(h.app);
  await settleTurns();
}

const planScript = (report: string): ((turn: Seen) => Step) => (turn) => {
  if (turn.slug === "manager" && turn.transcript.includes("fix the tables")) return { calls: [{ name: "node_plan", arguments: PLAN }], then: "Planned: build, then an independent check." };
  if (turn.slug === "manager" && turn.transcript.includes("nothing left to run")) return { text: report };
  return { text: "(no reply)" };
};

test("work in files goes straight from its packet to the agent; reports end the steps with no step-node turn", async () => {
  const mira = await person("Mira");
  await laptopFor(mira);
  const { room } = await crew(mira);
  script = planScript("Fixed and checked: titles with | stay in one cell.");
  await post(mira, room.id, "Please fix the tables bug, then have it checked.");
  const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { originRoomId: room.id } });

  const build = await runOf(mission.id, "build");
  assert.equal(build.job.folderLabel, "live-test", "the mission's folder path resolves to the folder the laptop shares");
  assert.equal(build.job.provider, "codex", "the plan's agent");
  for (const part of ["## Your part", "Escape | in record titles", "A1 (must pass): A title with | renders in one cell", "Branch: live-testing.", "Webapp only.", "report_result"]) {
    assert.ok(build.job.instructions?.includes(part), `the agent's instructions carry “${part}”`);
  }
  assert.equal(build.job.instructions?.split("Branch: live-testing.").length, 2, "each constraint once");
  const card = await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id: build.run.messageId! } });
  assert.match(String((card.data as { told?: string }).told), /## Goal\nMarkdown tables render record titles safely/);

  await finish(build.job.id, { outcome: "done", summary: "Escaped pipes in titles.", subject: { branch: "live-testing", commit: "abc1234" } });
  const check = await runOf(mission.id, "verify");
  assert.notEqual(check.run.sessionId, build.run.sessionId, "a check runs in its own session");
  assert.match(check.job.instructions ?? "", /independently, at commit abc1234 on live-testing/);
  await finish(check.job.id, { outcome: "pass", summary: "Titles with | stay in one cell.", checks: [{ id: "A1", name: "pipe title in one cell", verdict: "pass" }], subject: { commit: "abc1234" } });

  const ended = await h.prisma.nodeMission.findUniqueOrThrow({ where: { id: mission.id } });
  assert.equal(ended.status, "succeeded");
  // Only the lead thought: once to plan, once to report. No step node took a turn.
  assert.deepEqual(seen.map((turn) => turn.slug), ["manager", "manager"]);
});

test("a failed check repairs the build in the builder's own session, then retests in the checker's", async () => {
  const mira = await person("Mira");
  await laptopFor(mira);
  const { room } = await crew(mira);
  script = planScript("Fixed after one repair.");
  await post(mira, room.id, "Please fix the tables bug, then have it checked.");
  const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { originRoomId: room.id } });
  const build = await runOf(mission.id, "build");
  await finish(build.job.id, { outcome: "done", summary: "Escaped pipes.", subject: { commit: "abc1234" } });
  const check = await runOf(mission.id, "verify");
  await finish(check.job.id, { outcome: "fail", summary: "Links break.", checks: [{ id: "A1", name: "pipe title in one cell", verdict: "fail", detail: "the link after it breaks" }], subject: { commit: "abc1234" } });

  const repair = await runOf(mission.id, "build", 1);
  assert.equal(repair.run.sessionId, build.run.sessionId, "the repair continues the builder's session");
  assert.match(repair.job.instructions ?? "", /FAILED\. This is attempt 2/);
  assert.match(repair.job.instructions ?? "", /- FAIL A1 pipe title in one cell: the link after it breaks/);
  await finish(repair.job.id, { outcome: "done", summary: "Fixed the links too.", subject: { commit: "def5678" } });

  const retest = await runOf(mission.id, "verify", 1);
  assert.equal(retest.run.sessionId, check.run.sessionId, "the retest continues the checker's session");
  assert.match(retest.job.instructions ?? "", /Check the new candidate: commit def5678/);
  await finish(retest.job.id, { outcome: "pass", summary: "All good.", checks: [{ id: "A1", name: "pipe title in one cell", verdict: "pass" }], subject: { commit: "def5678" } });
  assert.equal((await h.prisma.nodeMission.findUniqueOrThrow({ where: { id: mission.id } })).status, "succeeded");
  assert.deepEqual(seen.map((turn) => turn.slug), ["manager", "manager"]);
});

test("a run that ends without its result is asked once in its session; then its node judges with the step in front of it", async () => {
  const mira = await person("Mira");
  await laptopFor(mira);
  const { room } = await crew(mira);
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("fix the tables")) return { calls: [{ name: "node_plan", arguments: PLAN }], then: "Planned." };
    if (turn.slug === "builder" && turn.transcript.includes("handed straight to the agent")) return { calls: [{ name: "node_step_report", arguments: { outcome: "done", summary: "The agent fixed it (commit abc1234); it did not report.", subject: { commit: "abc1234" } } }], then: "(no reply)" };
    return { text: "(no reply)" };
  };
  await post(mira, room.id, "Please fix the tables bug, then have it checked.");
  const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { originRoomId: room.id } });
  const build = await runOf(mission.id, "build");
  await finish(build.job.id, null, "Fixed it.");
  const asked = await runOf(mission.id, "build", 1);
  assert.equal(asked.run.sessionId, build.run.sessionId);
  assert.equal(asked.job.instructions?.includes(REPORT_ASK), true);
  assert.equal(seen.filter((turn) => turn.slug === "builder").length, 0, "nobody thought yet");

  await finish(asked.job.id, null, "Already done.");
  const turn = seen.find((row) => row.slug === "builder");
  assert.ok(turn, "then the builder node judges");
  assert.match(turn.transcript, /Your step \(build\), which Ensemble handed straight to the agent: Escape \| in record titles/);
  assert.equal(await h.prisma.nodeRun.count({ where: { planId: mission.id } }), 3, "the build, the ask, and now the check");
});

test("ask me before computer work: the packet waits on the owner's card; no job until they approve", async () => {
  const mira = await person("Mira");
  await laptopFor(mira);
  const { ids, room } = await crew(mira);
  const careful = await mira.inject({ method: "PATCH", url: `/api/node/nodes/${ids["feature-engineer"]}`, payload: { autonomy: { computerWork: "ask" } } });
  assert.equal(careful.statusCode, 200, careful.body);
  script = planScript("Done.");
  await post(mira, room.id, "Please fix the tables bug, then have it checked.");
  const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { originRoomId: room.id } });
  assert.equal(await h.prisma.nodeRun.count({ where: { planId: mission.id } }), 0);
  const cards = await h.prisma.nodeMessage.findMany({ where: { kind: "approval", roomId: room.id } });
  assert.equal(cards.length, 1);
  assert.match(cards[0]!.body, /## Your part/);
  const approved = await mira.inject({ method: "POST", url: `/api/node/approvals/${cards[0]!.id}`, payload: { decision: "approve" } });
  assert.equal(approved.statusCode, 200, approved.body);
  await settleTurns();
  const build = await runOf(mission.id, "build");
  assert.equal(build.job.folderLabel, "live-test");
});

test("a plan's report shows the checked screenshots and video; node_show shows only the owner's files; files open for whoever reads the message", async () => {
  const mira = await person("Mira");
  await laptopFor(mira);
  const { room } = await crew(mira);
  script = planScript("Fixed and checked. Here it is working.");
  await post(mira, room.id, "Please fix the tables bug, then have it checked.");
  const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { originRoomId: room.id } });
  const file = (jobId: string, kind: string, name: string, mime: string) =>
    h.prisma.jobEvidence.create({ data: { userId: mira.id, jobId, kind, name, mime, size: 4, sha256: randomBytes(8).toString("hex"), storageKey: `k-${name}`, bytes: Buffer.from("data") } });
  const build = await runOf(mission.id, "build");
  const log = await file(build.job.id, "log", "build.log", "text/plain");
  await finish(build.job.id, { outcome: "done", summary: "Escaped pipes.", subject: { commit: "abc1234" } });
  const check = await runOf(mission.id, "verify");
  const shot = await file(check.job.id, "screenshot", "table.png", "image/png");
  const video = await file(check.job.id, "video", "table.webm", "video/webm");
  await finish(check.job.id, { outcome: "pass", summary: "One cell.", checks: [{ id: "A1", name: "pipe title in one cell", verdict: "pass", evidence: [shot.id] }], evidence: [{ kind: "video", ref: video.id, caption: "Typing a title with |" }], subject: { commit: "abc1234" } });

  const messages = json(await mira.inject({ method: "GET", url: `/api/node/rooms/${room.id}/messages` })).messages as Array<{ kind: string; authorKind: string; body: string; data: any }>;
  const reported = messages.find((row) => row.kind === "text" && row.authorKind === "node" && row.body.includes("Here it is working"))!;
  assert.deepEqual(reported.data.media.map((row: { name: string }) => row.name), ["table.webm", "table.png"], "named media first, video first; no logs");
  assert.equal(reported.data.media[0].caption, "Typing a title with |");
  assert.ok(!reported.data.media.some((row: { evidenceId: string }) => row.evidenceId === log.id));

  assert.equal((await mira.inject({ method: "GET", url: `/api/node/evidence/${video.id}` })).statusCode, 200);
  const stranger = await person("Ben");
  assert.equal((await stranger.inject({ method: "GET", url: `/api/node/evidence/${video.id}` })).statusCode, 404);

  // node_show: the owner's own file, attached to the reply; someone else's file is refused.
  const theirs = await h.prisma.workspaceJob.create({ data: { userId: stranger.id, taskId: (await h.prisma.task.create({ data: { userId: stranger.id, title: "x", owner: "agent", status: "todo", createdBy: "agent" } })).id, kind: "code", provider: "codex", model: "default", status: "succeeded", executionMode: "sandbox" } });
  const foreign = await h.prisma.jobEvidence.create({ data: { userId: stranger.id, jobId: theirs.id, kind: "screenshot", name: "theirs.png", mime: "image/png", size: 4, sha256: "y", storageKey: "y", bytes: Buffer.from("data") } });
  const dm = (await h.prisma.nodeRoom.findFirstOrThrow({ where: { userId: mira.id, kind: "dm", members: { some: { node: { slug: "manager" } } } } })).id;
  script = (turn) => (turn.transcript.includes("show me the table") ? { calls: [{ name: "node_show", arguments: { evidence: [shot.id, foreign.id] } }], then: "This is the table now." } : { text: "(no reply)" });
  await post(mira, dm, "show me the table");
  const shown = (json(await mira.inject({ method: "GET", url: `/api/node/rooms/${dm}/messages` })).messages as Array<{ body: string; data: any }>).find((row) => row.body === "This is the table now.")!;
  assert.deepEqual(shown.data.media.map((row: { name: string }) => row.name), ["table.png"]);
});
