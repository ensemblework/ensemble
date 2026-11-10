import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness } from "../../test/http.js";

const h = await createHttpHarness();
after(() => h.close());
const db = h.prisma;
const { queueMeetingAi, runMeetingAi } = await import("./ai.js");
const { seriesProject } = await import("./links.js");
const { saveSettings } = await import("../../lib/settings.js");
const { startMeetingSession, saveMeetingNotes, endMeetingSession } = await import("../../cowork/service.js");
const { runMeetingPreps, prepareMeeting } = await import("../../cowork/prep.js");
const { eventSeriesKey } = await import("../../cowork/series.js");
const { listMeetingCues } = await import("../../cowork/service.js");
const { itemNeighbors } = await import("../../context/graph/neighbors.js");
const { runInScope } = await import("../../sharing/context.js");

const TRANSCRIPT = [
  "[00:12] Priya Shah: Thanks all. The beta is on the 20th, so latency is the priority this week.",
  "[03:40] Priya Shah: Akash, could you send me the latency budget by Friday so I can share it with the execs?",
  "[05:02] Akash Rao: Sure, I will also write the Atlas latency report.",
  "[07:15] Omar Ruiz: I will share the load-test numbers with Akash tomorrow.",
  "[09:30] Priya Shah: Let's keep the beta date unless the numbers say otherwise.",
].join("\n");

async function world() {
  const user = await h.asUser();
  const userId = user.id;
  await db.user.update({ where: { id: userId }, data: { name: "Akash Rao" } });
  const atlas = await db.project.create({ data: { userId, name: "Atlas", summary: "Search API latency", createdBy: "me" } });
  const priya = await db.person.create({ data: { userId, name: "Priya Shah", email: "priya@fieldnote.test", relationship: "my manager" } });
  const omar = await db.person.create({ data: { userId, name: "Omar Ruiz", email: "omar@fieldnote.test" } });
  const report = await db.task.create({ data: { userId, title: "Write the Atlas latency report", status: "todo", createdBy: "me", people: [priya.id] } });
  const note = await db.meetingNote.create({
    data: {
      userId,
      title: "Atlas weekly sync",
      occurredAt: new Date(Date.now() - 86_400_000),
      personIds: [priya.id, omar.id],
      seriesKey: "t:atlas weekly sync",
      source: "connector",
      externalSource: "fireflies",
      prompt: TRANSCRIPT,
      answer: "Latency review before the beta.",
    },
  });
  return { userId, atlas, priya, omar, report, note };
}

const reply = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    summary: "The team reviewed latency before the beta on the 20th.",
    decisions: ["Keep the beta date unless the numbers say otherwise"],
    items: [
      { title: "Send Priya the latency budget", kind: "task", owner: "me", requestedBy: "Priya Shah", due: "2026-11-06", why: "Priya needs it for the execs.", quote: "could you send me the latency budget by Friday", at: "03:40" },
      { title: "Share the load-test numbers", kind: "follow_up", owner: "Omar", requestedBy: null, quote: "I will share the load-test numbers with Akash tomorrow", at: "07:15" },
      { title: "Book the launch party venue", kind: "task", owner: "me", quote: "please book the launch party venue" },
      { title: "Write the Atlas latency report", kind: "task", owner: "me", quote: "I will also write the Atlas latency report", existingTask: "Write the Atlas latency report" },
    ],
    openQuestions: [],
    project: "Atlas",
    newPeople: [{ name: "Lena Park", role: "SRE" }],
    nextTime: ["Review the load-test numbers"],
    ...extra,
  });

test("a meeting's AI pass proposes only grounded, untracked work, carrying who asked and the project", async () => {
  const { userId, atlas, priya, omar, report, note } = await world();
  assert.equal(await queueMeetingAi(db, userId, note.id), "queued");
  const outcome = await runMeetingAi(note.id, { db, ask: async () => ({ text: reply(), model: "scripted" }) });
  assert.deepEqual(outcome, { status: "done", proposed: 2 });

  const tasks = await db.task.findMany({ where: { userId, meetingNoteId: note.id }, orderBy: { title: "asc" }, include: { page: { select: { notesSnapshot: true } } } });
  assert.deepEqual(tasks.map((task) => task.title), ["Omar: Share the load-test numbers", "Send Priya the latency budget"]);
  const [follow, mine] = tasks;
  assert.equal(mine!.status, "proposed");
  assert.equal(mine!.owner, "me");
  assert.equal(follow!.owner, "unassigned");
  assert.equal(mine!.projectId, atlas.id, "the model's project applies to a meeting with none");
  assert.ok(mine!.people.includes(priya.id), "the person who asked is on the task");
  assert.match(mine!.page?.notesSnapshot ?? "", /could you send me the latency budget by Friday/);
  assert.match(mine!.page?.notesSnapshot ?? "", /ensemble:\/\/meeting\//);
  assert.deepEqual(follow!.labels, ["waiting-on"]);
  assert.ok(follow!.people.includes(omar.id));

  const saved = await db.meetingNote.findUniqueOrThrow({ where: { id: note.id } });
  assert.equal(saved.aiStatus, "done");
  assert.equal(saved.projectId, atlas.id);
  const ai = (saved.extraction as { ai: { items: Array<{ title: string; grounded: boolean; alreadyTracked?: string }>; newPeople: unknown[] } }).ai;
  assert.equal(ai.items.length, 4);
  assert.equal(ai.items.find((item) => item.title.startsWith("Book"))!.grounded, false, "an unquoted item is kept for review but not proposed");
  assert.equal(ai.items.find((item) => item.title.startsWith("Write"))!.alreadyTracked, report.id);
  // The existing task hears about it: the new ask, with its words, goes on its page.
  const reportPage = await db.taskPage.findFirst({ where: { taskId: report.id }, select: { searchText: true } });
  assert.match(reportPage?.searchText ?? "", /I will also write the Atlas latency report/);
  assert.equal(ai.newPeople.length, 1);
  assert.equal(await db.notification.count({ where: { userId, kind: "meeting_tasks" } }), 1);

  // Asked again: the same work is not proposed twice.
  assert.equal(await queueMeetingAi(db, userId, note.id), "done", "a finished pass is not re-queued on its own");
  assert.equal(await queueMeetingAi(db, userId, note.id, { force: true }), "queued");
  const again = await runMeetingAi(note.id, { db, ask: async () => reply() });
  assert.equal(again?.proposed, 0);
  assert.equal(await db.task.count({ where: { userId, meetingNoteId: note.id } }), 2);

  // A later meeting of the series borrows the project.
  assert.equal(await seriesProject(db, userId, { seriesKey: "t:atlas weekly sync", before: new Date(), personIds: [priya.id] }), atlas.id);
});

test("with the switch off nothing is read on its own, but asking still works", async () => {
  const { userId, note } = await world();
  await saveSettings(db, userId, { automations: { meetings: { enabled: false } } });
  assert.equal(await queueMeetingAi(db, userId, note.id), null);
  assert.equal((await db.meetingNote.findUniqueOrThrow({ where: { id: note.id } })).aiStatus, null);
  assert.equal(await queueMeetingAi(db, userId, note.id, { force: true }), "queued");
});

test("notes typed in Ensemble keep the meeting's project and series on their note", async () => {
  const { userId, atlas } = await world();
  const { session } = await startMeetingSession(db, userId, { title: "Atlas weekly sync", projectId: atlas.id });
  await saveMeetingNotes(db, userId, session.id, { notes: "Priya asked for the latency budget by Friday." });
  await endMeetingSession(db, userId, session.id);
  const row = await db.meetingSession.findUniqueOrThrow({ where: { id: session.id } });
  const note = await db.meetingNote.findUniqueOrThrow({ where: { id: row.meetingNoteId! } });
  assert.equal(note.projectId, atlas.id);
  assert.equal(note.seriesKey, "t:atlas weekly sync");

  // A second session of the same series takes the project without being told.
  const next = await startMeetingSession(db, userId, { title: "Atlas weekly sync" });
  assert.equal((await db.meetingSession.findUniqueOrThrow({ where: { id: next.session.id } })).projectId, atlas.id);
});

test("a recurring meeting gets a prep brief from last time, once", async () => {
  const { userId, note, report } = await world();
  const metadata = { source: "google", seriesId: "atlas-weekly" };
  await db.meetingNote.update({ where: { id: note.id }, data: { seriesKey: eventSeriesKey(metadata)!, extraction: { ai: { nextTime: ["Review the load-test numbers"] } } } });
  await db.task.update({ where: { id: report.id }, data: { meetingNoteId: note.id } });
  const event = await db.artifact.create({
    data: { userId, kind: "event", externalId: "atlas-weekly-1", title: "Atlas weekly sync", ts: new Date(Date.now() + 20 * 60_000), metadata, participants: [{ name: "Priya Shah", email: "priya@fieldnote.test" }] },
  });
  const prompts: string[] = [];
  const ask = async (prompt: string) => {
    prompts.push(prompt);
    return { text: "Last time: latency review. Still open: the latency report.", model: "scripted" };
  };
  assert.equal(await runMeetingPreps(db, userId, { ask }), 1);
  assert.match(prompts[0]!, /Atlas weekly sync/);
  const meta = (await db.artifact.findUniqueOrThrow({ where: { id: event.id } })).metadata as { ensemblePrep?: { text: string; previousId: string } };
  assert.equal(meta.ensemblePrep?.previousId, note.id);
  assert.equal(await db.notification.count({ where: { userId, kind: "meeting_prep" } }), 1);
  assert.equal(await runMeetingPreps(db, userId, { ask }), 0, "a brief is written once");

  // Today's cue carries last time; a titled event with no one from People and no series history gets none.
  await db.artifact.create({ data: { userId, kind: "event", externalId: "dentist-1", title: "Dentist", ts: new Date(Date.now() + 60 * 60_000), metadata: {} } });
  const { cues } = await listMeetingCues(db, userId);
  assert.deepEqual(cues.map((cue) => cue.title), ["Atlas weekly sync"]);
  assert.equal(cues[0]!.previous?.id, note.id);
  assert.match(cues[0]!.prep?.text ?? "", /latency review/);

  // The owner's calendar stays theirs: a member of the shared space cannot open the event through the graph.
  assert.ok(await itemNeighbors({ db, userId }, { kind: "event", id: event.id }));
  const member = { spaceId: userId, accountId: "member-account", access: { kind: "member" as const, role: "viewer" as const, ownerId: userId } };
  assert.equal(await runInScope(member, () => itemNeighbors({ db, userId }, { kind: "event", id: event.id })), null);

  const asked = await prepareMeeting(db, userId, event.id, { ask });
  assert.deepEqual(asked.previous.openTasks.map((task) => task.title), ["Write the Atlas latency report"]);
  assert.deepEqual(asked.previous.nextTime, ["Review the load-test numbers"]);
});
