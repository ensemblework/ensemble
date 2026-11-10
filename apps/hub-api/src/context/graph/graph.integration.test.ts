import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness } from "../../test/http.js";
import { parseItemRef, refOf } from "./refs.js";
import { titleSeriesKey, eventSeriesKey } from "../../cowork/series.js";

const h = await createHttpHarness();
after(() => h.close());
const { itemNeighbors } = await import("./neighbors.js");
const { workContext } = await import("./packet.js");
const { rankedSearch, queryTerms } = await import("./search.js");

async function world() {
  const user = await h.asUser();
  const db = h.prisma;
  const userId = user.id;
  const project = await db.project.create({ data: { userId, name: "Atlas", summary: "Latency work for the search API", createdBy: "me" } });
  const priya = await db.person.create({ data: { userId, name: "Priya Shah", email: "priya@fieldnote.test", role: "PM", relationship: "my manager" } });
  const omar = await db.person.create({ data: { userId, name: "Omar Ruiz", email: "omar@fieldnote.test" } });
  await db.projectPerson.create({ data: { projectId: project.id, personId: priya.id, role: "Product lead", addedBy: "me" } });
  const repo = await db.repo.create({ data: { userId, fullName: "fieldnote/atlas" } });
  await db.projectRepo.create({ data: { projectId: project.id, repoId: repo.id, addedBy: "me" } });
  const earlier = await db.meetingNote.create({
    data: { userId, title: "Atlas weekly sync", occurredAt: new Date("2026-10-28T10:00:00Z"), personIds: [priya.id], projectId: project.id, seriesKey: "t:atlas weekly sync", source: "connector", answer: "We looked at p95 latency." },
  });
  const meeting = await db.meetingNote.create({
    data: {
      userId,
      title: "Atlas weekly sync",
      occurredAt: new Date("2026-11-04T10:00:00Z"),
      personIds: [priya.id, omar.id],
      projectId: project.id,
      seriesKey: "t:atlas weekly sync",
      source: "connector",
      answer: "Agreed to cut p95 latency below 200ms before the beta.",
      prompt: "[12:31] Priya Shah: Could you send the latency budget by Friday?",
      extraction: { decisions: ["Ship the beta on Nov 20"], actionItems: [], waitingOn: [{ text: "Share the load-test numbers", owner: { name: "Omar Ruiz" } }] },
    },
  });
  const task = await db.task.create({
    data: {
      userId,
      title: "Send the latency budget to Priya",
      status: "todo",
      projectId: project.id,
      repoId: repo.id,
      meetingNoteId: meeting.id,
      people: [priya.id],
      excerpt: "Could you send the latency budget by Friday?",
      rationale: "Priya asked for it in the Atlas weekly sync.",
      sourceKind: "meeting",
    },
  });
  const sibling = await db.task.create({ data: { userId, title: "Draft the latency dashboard", status: "in_progress", projectId: project.id, people: [priya.id] } });
  const blocker = await db.task.create({ data: { userId, title: "Collect p95 numbers", status: "todo", projectId: project.id } });
  await db.task.update({ where: { id: task.id }, data: { dependsOn: [blocker.id] } });
  const done = await db.task.create({ data: { userId, title: "Send the error budget to Priya", status: "done", completedAt: new Date(), projectId: project.id } });
  await db.run.create({ data: { userId, taskId: done.id, worker: "code", outcome: "success", result: "Wrote budget.md with p50/p95 targets and shared it." } });
  const waiting = await db.task.create({ data: { userId, title: "Omar: share load-test numbers", status: "todo", projectId: project.id, people: [omar.id], labels: ["waiting-on"] } });
  return { user, userId, project, priya, omar, repo, earlier, meeting, task, sibling, blocker, done, waiting };
}

test("refs parse handles, links and aliases", () => {
  const id = "0b0f1a52-6c2e-4b3a-9a77-1c2d3e4f5a6b";
  assert.deepEqual(parseItemRef(`ensemble://task/${id}`), { kind: "task", id });
  assert.deepEqual(parseItemRef(`ensemble://people/${id}`), { kind: "person", id });
  assert.deepEqual(parseItemRef(`https://app.ensemblework.com/projects/${id}?peek=1`), { kind: "project", id });
  assert.deepEqual(parseItemRef(`/meetings?session=${id}`), { kind: "meeting", id });
  assert.deepEqual(parseItemRef({ kind: "meeting_note", id }), { kind: "meeting", id });
  assert.deepEqual(parseItemRef(id, "document"), { kind: "file", id });
  assert.equal(parseItemRef(id), null);
  assert.equal(parseItemRef("ensemble://reminder/x"), null);
  assert.equal(refOf("task", id), `ensemble://task/${id}`);
});

test("series keys come from the calendar series, else a specific title", () => {
  assert.equal(titleSeriesKey("Atlas sync — 4 Nov"), titleSeriesKey("Re: Atlas sync 11/11"));
  assert.equal(titleSeriesKey("Meeting"), null);
  assert.equal(titleSeriesKey("Weekly call"), "t:weekly call");
  assert.equal(eventSeriesKey({ source: "google", seriesId: "abc" }), "s:google:abc");
  assert.equal(eventSeriesKey({ uid: "u1", originalStart: "2026-11-04T10:00:00Z" }), "u:u1");
  assert.equal(eventSeriesKey({ uid: "u1", originalStart: null }), null);
});

test("a task links to its project, meeting, people with roles, dependencies, related work and how similar work went", async () => {
  const w = await world();
  const hood = await itemNeighbors({ db: h.prisma, userId: w.userId }, { kind: "task", id: w.task.id });
  assert.ok(hood);
  const group = (rel: string) => hood.groups.find((row) => row.rel === rel);
  assert.equal(group("project")?.items[0]?.id, w.project.id);
  assert.equal(group("meeting")?.items[0]?.id, w.meeting.id);
  const person = group("people")?.items[0];
  assert.equal(person?.id, w.priya.id);
  assert.equal(person?.role, "Product lead");
  assert.equal(person?.detail, "my manager");
  assert.deepEqual(group("depends_on")?.items.map((row) => row.id), [w.blocker.id]);
  assert.ok(group("related")?.items.some((row) => row.id === w.sibling.id && /same people/.test(row.detail ?? "")));
  const before = group("done_before")?.items.find((row) => row.id === w.done.id);
  assert.match(before?.detail ?? "", /budget\.md/);
  assert.deepEqual(group("repos")?.items.map((row) => row.id), [w.repo.id]);

  const blocker = await itemNeighbors({ db: h.prisma, userId: w.userId }, { kind: "task", id: w.blocker.id });
  assert.deepEqual(blocker?.groups.find((row) => row.rel === "blocks")?.items.map((row) => row.id), [w.task.id]);

  const other = await h.asUser();
  assert.equal(await itemNeighbors({ db: h.prisma, userId: other.id }, { kind: "task", id: w.task.id }), null);
});

test("a person shows projects with roles, open work, what we wait on them for, and meetings", async () => {
  const w = await world();
  const priya = await itemNeighbors({ db: h.prisma, userId: w.userId }, { kind: "person", id: w.priya.id });
  assert.equal(priya?.item.detail, "my manager");
  assert.deepEqual(priya?.groups.find((row) => row.rel === "projects")?.items.map((row) => [row.id, row.role]), [[w.project.id, "Product lead"]]);
  const open = priya?.groups.find((row) => row.rel === "open_tasks")?.items.map((row) => row.id) ?? [];
  assert.ok(open.includes(w.task.id) && open.includes(w.sibling.id));
  assert.equal(priya?.groups.find((row) => row.rel === "meetings")?.items.length, 2);
  const omar = await itemNeighbors({ db: h.prisma, userId: w.userId }, { kind: "person", id: w.omar.id });
  assert.deepEqual(omar?.groups.find((row) => row.rel === "waiting_on")?.items.map((row) => row.id), [w.waiting.id]);
  assert.equal(omar?.groups.find((row) => row.rel === "open_tasks"), undefined);
});

test("a meeting lists its tasks and the earlier meeting of its series; relations page", async () => {
  const w = await world();
  const ctx = { db: h.prisma, userId: w.userId };
  const hood = await itemNeighbors(ctx, { kind: "meeting", id: w.meeting.id });
  assert.deepEqual(hood?.groups.find((row) => row.rel === "tasks")?.items.map((row) => row.id), [w.task.id]);
  assert.deepEqual(hood?.groups.find((row) => row.rel === "earlier")?.items.map((row) => row.id), [w.earlier.id]);
  assert.deepEqual((hood?.item.facts as { decisions: string[] }).decisions, ["Ship the beta on Nov 20"]);
  const later = await itemNeighbors(ctx, { kind: "meeting", id: w.earlier.id });
  assert.deepEqual(later?.groups.find((row) => row.rel === "later")?.items.map((row) => row.id), [w.meeting.id]);

  const first = await itemNeighbors(ctx, { kind: "project", id: w.project.id }, { rel: "open_tasks", limit: 2 });
  assert.equal(first?.groups[0]?.items.length, 2);
  assert.equal(first?.groups[0]?.more, true);
  const second = await itemNeighbors(ctx, { kind: "project", id: w.project.id }, { rel: "open_tasks", limit: 2, offset: 2 });
  const ids = new Set([...(first?.groups[0]?.items ?? []), ...(second?.groups[0]?.items ?? [])].map((row) => row.id));
  assert.equal(ids.size, 4);
  await assert.rejects(itemNeighbors(ctx, { kind: "project", id: w.project.id }, { rel: "nonsense" }), /no relation/);
});

test("the work packet carries the meeting's words, people and related work within its budget", async () => {
  const w = await world();
  const packet = await workContext({ db: h.prisma, userId: w.userId }, { kind: "task", id: w.task.id }, { budget: 4000 });
  assert.ok(packet);
  assert.match(packet.text, /Where it came from: meeting “Atlas weekly sync”/);
  assert.match(packet.text, /Could you send the latency budget by Friday\?/);
  assert.match(packet.text, /Ship the beta on Nov 20/);
  assert.match(packet.text, /Priya Shah: Product lead · my manager/);
  assert.match(packet.text, /Collect p95 numbers/);
  assert.match(packet.text, /budget\.md/);
  assert.ok(packet.text.length <= 4000);
  const tight = await workContext({ db: h.prisma, userId: w.userId }, { kind: "task", id: w.task.id }, { budget: 900 });
  assert.ok(tight && tight.text.length <= 900);
  assert.match(tight.text, /Send the latency budget to Priya/);
});

test("ranked search matches every word, prefers titles and records near the anchor", async () => {
  const w = await world();
  assert.deepEqual(queryTerms('the "latency budget" for Priya').terms, ["latency budget", "priya"]);
  const ctx = { db: h.prisma, userId: w.userId };
  const { hits } = await rankedSearch(ctx, "latency budget");
  assert.equal(hits[0]?.id, w.task.id);
  assert.ok(hits.some((hit) => hit.kind === "meeting" && hit.id === w.meeting.id));
  const near = await rankedSearch(ctx, "numbers", { near: { kind: "task", id: w.task.id } });
  assert.equal(near.hits[0]?.id, w.blocker.id);
  assert.ok(near.hits[0]?.why.includes("linked to it"));
  const people = await rankedSearch(ctx, "manager", { kinds: ["person"] });
  assert.deepEqual(people.hits.map((hit) => hit.id), [w.priya.id]);
});
