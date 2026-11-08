import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";

const h = await createHttpHarness();
after(() => h.close());
const db = h.prisma;
const { answerContextTool } = await import("./context-tools.js");
const { noticeReadyForReview } = await import("./review-notice.js");
const { saveSettings } = await import("../lib/settings.js");

async function taskFromMeeting(userId: string) {
  const project = await db.project.create({ data: { userId, name: "Atlas", summary: "Search latency", createdBy: "me" } });
  const priya = await db.person.create({ data: { userId, name: "Priya Shah", relationship: "my manager" } });
  await db.projectPerson.create({ data: { projectId: project.id, personId: priya.id, role: "Product lead", addedBy: "me" } });
  const meeting = await db.meetingNote.create({ data: { userId, title: "Atlas weekly sync", occurredAt: new Date("2026-11-04T10:00:00Z"), projectId: project.id, personIds: [priya.id], answer: "Cut p95 latency before the beta.", source: "connector" } });
  const task = await db.task.create({ data: { userId, title: "Send the latency budget", status: "todo", owner: "agent", projectId: project.id, meetingNoteId: meeting.id, people: [priya.id], excerpt: "Could you send the latency budget by Friday?" } });
  for (let i = 0; i < 4; i++) await db.task.create({ data: { userId, title: `Latency follow-up ${i}`, status: "todo", projectId: project.id } });
  return { project, priya, meeting, task };
}

test("a run's context tools answer for its task: the packet, one relation in pages, and search closest first", async () => {
  const user = await h.asUser();
  const w = await taskFromMeeting(user.id);
  const ctx = { db, userId: user.id };
  const packet = await answerContextTool(ctx, w.task.id, "ensemble_context", {});
  assert.match(packet, /Atlas weekly sync/);
  assert.match(packet, /Could you send the latency budget by Friday\?/);
  assert.match(packet, /Priya Shah — Product lead · my manager/);
  const first = await answerContextTool(ctx, w.task.id, "ensemble_context", { item: `ensemble://project/${w.project.id}`, rel: "open_tasks", limit: 2 });
  assert.match(first, /More: call again with rel "open_tasks" and offset 2/);
  const search = await answerContextTool(ctx, w.task.id, "ensemble_search", { query: "latency budget" });
  assert.match(search.split("\n")[1] ?? "", /Send the latency budget/);
  await assert.rejects(answerContextTool(ctx, w.task.id, "ensemble_context", { item: "not a handle" }), /handle/);
  const stranger = await h.asUser();
  assert.match(await answerContextTool({ db, userId: stranger.id }, w.task.id, "ensemble_context", {}), /not in this space/);
});

test("a paired computer's claim carries the task's context, and its run asks for more under the job's lease only", async () => {
  const user = await h.asUser();
  const w = await taskFromMeeting(user.id);
  const token = await h.asToken(user, "device");
  const device = await db.device.create({ data: { userId: user.id, tokenId: token.id, name: "Laptop", platform: "linux" } });
  const job = await db.workspaceJob.create({ data: { userId: user.id, taskId: w.task.id, deviceId: device.id, executionMode: "auto", model: "fixture", status: "queued" } });
  const claim = await token.inject({ method: "POST", url: "/api/devices/self/claim", payload: {} });
  assert.equal(claim.statusCode, 200, claim.body);
  const spec = claim.json() as { id: string; leaseToken: string; task: { description: string } };
  assert.equal(spec.id, job.id);
  assert.match(spec.task.description, /## Context from Ensemble/);
  assert.match(spec.task.description, /Could you send the latency budget by Friday\?/);

  const ask = (lease: string, body: unknown) => token.inject({ method: "POST", url: `/api/devices/self/jobs/${job.id}/context`, headers: { "x-ensemble-job-lease": lease }, payload: body as Record<string, unknown> });
  const answer = await ask(spec.leaseToken, { name: "ensemble_context", args: { item: `ensemble://person/${w.priya.id}` } });
  assert.equal(answer.statusCode, 200, answer.body);
  assert.match((answer.json() as { text: string }).text, /Priya Shah/);
  assert.equal((await ask("wrong-lease", { name: "ensemble_context", args: {} })).statusCode, 409);
  assert.equal((await ask(spec.leaseToken, { name: "drop_tables", args: {} })).statusCode, 400);
  assert.equal((await user.inject({ method: "POST", url: `/api/devices/self/jobs/${job.id}/context`, headers: { "x-ensemble-job-lease": spec.leaseToken }, payload: { name: "ensemble_context" } })).statusCode, 403);

  // The run changes Ensemble around its task through the editors' allowlist, under the same lease; never the apps.
  const act = (body: unknown) => token.inject({ method: "POST", url: `/api/devices/self/jobs/${job.id}/act`, headers: { "x-ensemble-job-lease": spec.leaseToken }, payload: body as Record<string, unknown> });
  const listed = await act({ name: "ensemble_actions", args: { groups: "tasks" } });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.match((listed.json() as { text: string }).text, /hub_update_task/);
  const changed = await act({ name: "ensemble_act", args: { action: "hub_update_task", input: { taskId: w.task.id, matchTitle: w.task.title, labels: ["from-run"] } } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual((await db.task.findUniqueOrThrow({ where: { id: w.task.id } })).labels, ["from-run"]);
  const settings = await act({ name: "ensemble_act", args: { action: "hub_update_settings", input: {} } });
  assert.match((settings.json() as { text: string }).text, /assistant and Ensemble Node/);
  const apps = await act({ name: "ensemble_act", args: { action: "gmail_search", input: { query: "x" } } });
  assert.match((apps.json() as { text: string }).text, /connected apps/);
});

test("ready-for-review notices follow the automation switch", async () => {
  const user = await h.asUser();
  const w = await taskFromMeeting(user.id);
  await noticeReadyForReview(db, { userId: user.id, taskId: w.task.id, title: w.task.title, summary: "Wrote budget.md.", runId: null });
  assert.equal(await db.notification.count({ where: { userId: user.id, title: { startsWith: "Ready for review" } } }), 1);
  await saveSettings(db, user.id, { automations: { reviewNotices: false } });
  await noticeReadyForReview(db, { userId: user.id, taskId: w.task.id, title: w.task.title, summary: "Again.", runId: null });
  assert.equal(await db.notification.count({ where: { userId: user.id, title: { startsWith: "Ready for review" } } }), 1);
});
