import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness, type HttpUser } from "../test/http.js";

const h = await createHttpHarness();
after(() => h.close());
const db = h.prisma;

async function world(user: HttpUser) {
  const userId = user.id;
  const project = await db.project.create({ data: { userId, name: "Atlas", summary: "Search latency", createdBy: "me" } });
  const priya = await db.person.create({ data: { userId, name: "Priya Shah", relationship: "my manager" } });
  await db.projectPerson.create({ data: { projectId: project.id, personId: priya.id, role: "Product lead", addedBy: "me" } });
  const meeting = await db.meetingNote.create({ data: { userId, title: "Atlas weekly sync", occurredAt: new Date("2026-11-04T10:00:00Z"), projectId: project.id, personIds: [priya.id], answer: "Cut p95 latency.", source: "connector", prompt: "[12:31] Priya Shah: Could you send the latency budget by Friday?" } });
  const task = await db.task.create({ data: { userId, title: "Send the latency budget", status: "todo", projectId: project.id, meetingNoteId: meeting.id, people: [priya.id], excerpt: "Could you send the latency budget by Friday?" } });
  const review = await db.task.create({ data: { userId, title: "Latency dashboard", status: "waiting_approval", projectId: project.id } });
  return { project, priya, meeting, task, review };
}

async function bridgeKey(user: HttpUser, canWrite: boolean) {
  const key = await h.asToken(user, "bridge");
  await db.apiToken.update({ where: { id: key.id }, data: { canWrite } });
  return key;
}

test("context, brief by task and ranked search read the graph through a bridge key", async () => {
  const user = await h.asUser();
  const w = await world(user);
  const key = await bridgeKey(user, false);
  const get = (url: string) => key.inject({ method: "GET", url });

  const context = await get(`/api/bridge/context?item=${encodeURIComponent(`ensemble://task/${w.task.id}`)}`);
  assert.equal(context.statusCode, 200, context.body);
  const body = context.json() as { item: { title: string }; groups: Array<{ rel: string; items: Array<{ id: string; url?: string }> }> };
  assert.equal(body.item.title, "Send the latency budget");
  assert.equal(body.groups.find((group) => group.rel === "meeting")?.items[0]?.id, w.meeting.id);
  const packet = await get(`/api/bridge/context?item=${w.task.id}&kind=task&format=packet`);
  assert.match((packet.json() as { text: string }).text, /Could you send the latency budget by Friday\?/);
  assert.equal((await get("/api/bridge/context?item=nonsense")).statusCode, 400);

  const brief = (await get(`/api/bridge/brief?task=${encodeURIComponent(`ensemble://task/${w.task.id}`)}`)).json() as { resolution: string; workContext: string; contextRef: string };
  assert.equal(brief.resolution, "task");
  assert.match(brief.workContext, /Priya Shah/);
  const byTitle = (await get(`/api/bridge/brief?task=${encodeURIComponent("send the latency budget")}`)).json() as { resolution: string };
  assert.equal(byTitle.resolution, "task");
  const missing = (await get(`/api/bridge/brief?task=${encodeURIComponent("latency report")}`)).json() as { resolution: string; candidates: Array<{ title: string }> };
  assert.equal(missing.resolution, "task_not_found");
  assert.ok(missing.candidates.length > 0);
  const byBranch = (await get(`/api/bridge/brief?branch=${encodeURIComponent(`fix/${w.task.id.slice(0, 8)}-budget`)}`)).json() as { resolution: string; resolved: { task: { id: string } | null } };
  assert.equal(byBranch.resolved.task?.id, w.task.id);

  const search = (await get("/api/bridge/search?q=latency%20budget")).json() as { match: string; results: Array<{ id: string; kind: string; ref: string }> };
  assert.equal(search.match, "ranked");
  assert.equal(search.results[0]?.id, w.task.id);
  assert.ok(search.results.some((hit) => hit.kind === "meeting_note" && hit.id === w.meeting.id));

  const today = (await get("/api/bridge/today")).json() as { readyForReview: Array<{ id: string }> };
  assert.deepEqual(today.readyForReview.map((row) => row.id), [w.review.id]);

  const stranger = await bridgeKey(await h.asUser(), false);
  assert.equal((await stranger.inject({ method: "GET", url: `/api/bridge/context?item=ensemble://task/${w.task.id}` })).statusCode, 404);
});

test("task writes need a key made with task updates allowed", async () => {
  const user = await h.asUser();
  const w = await world(user);
  const readOnly = await bridgeKey(user, false);
  const writer = await bridgeKey(user, true);

  assert.equal((await readOnly.inject({ method: "GET", url: "/api/bridge/whoami" })).json().canWrite, false);
  assert.equal((await writer.inject({ method: "GET", url: "/api/bridge/whoami" })).json().canWrite, true);
  const refused = await readOnly.inject({ method: "PATCH", url: `/api/bridge/write/tasks/${w.task.id}`, payload: { status: "in_progress" } });
  assert.equal(refused.statusCode, 403);
  assert.equal((await readOnly.inject({ method: "POST", url: "/api/tasks", payload: { title: "x" } })).statusCode, 403);
  assert.equal((await writer.inject({ method: "POST", url: "/api/tasks", payload: { title: "x" } })).statusCode, 403, "only the bridge's write routes");

  const started = await writer.inject({ method: "PATCH", url: `/api/bridge/write/tasks/${encodeURIComponent(`ensemble://task/${w.task.id}`)}`, payload: { status: "in_progress", note: "Drafted the budget in budget.md.", matchTitle: "Send the latency budget" } });
  assert.equal(started.statusCode, 200, started.body);
  const task = await db.task.findUniqueOrThrow({ where: { id: w.task.id }, include: { page: true } });
  assert.equal(task.status, "in_progress");
  assert.match(JSON.stringify(task.page?.content), /Drafted the budget in budget\.md/);
  assert.equal((await writer.inject({ method: "PATCH", url: `/api/bridge/write/tasks/${w.task.id}`, payload: { status: "done", matchTitle: "Something else" } })).statusCode, 409);

  const made = await writer.inject({ method: "POST", url: "/api/bridge/write/tasks", payload: { title: "Share the budget with Omar", from: `ensemble://task/${w.task.id}`, projectName: "Atlas", people: ["Priya Shah"] } });
  assert.equal(made.statusCode, 201, made.body);
  const created = await db.task.findUniqueOrThrow({ where: { id: (made.json() as { task: { id: string } }).task.id }, include: { page: true } });
  assert.equal(created.status, "proposed");
  assert.equal(created.projectId, w.project.id);
  assert.deepEqual(created.people, [w.priya.id]);
  assert.match(created.page?.notesSnapshot ?? "", /Related: \[Send the latency budget\]/);
  assert.equal(await db.auditLedger.count({ where: { userId: user.id, action: { startsWith: "bridge.task." } } }), 2);
});
