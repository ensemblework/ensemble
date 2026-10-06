/**
 * Cowork routes against Postgres. Skips when the database is down.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ZodError } from "zod";
import "../config.js";
import { undoLast } from "../lib/undo.js";
import { saveSettings } from "../lib/settings.js";
import { prisma } from "../lib/prisma.js";
import { coworkRoutes } from "../routes/cowork.js";
import "../types.js";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function user(label: string) {
  return prisma.user.create({
    data: { email: `cowork-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@ensemble.test`, name: label },
  });
}

async function appFor(userId: string) {
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.addHook("onRequest", async (request) => {
    request.userId = userId;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: error.issues.map((issue) => issue.message).join("; ") });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(statusCode).send({ error: message });
  });
  await app.register(coworkRoutes);
  return app;
}

async function cleanup(userId: string) {
  await prisma.notification.deleteMany({ where: { userId } });
  await prisma.meetingSession.deleteMany({ where: { userId } });
  await prisma.meetingNote.deleteMany({ where: { userId } });
  await prisma.artifact.deleteMany({ where: { userId } });
  await prisma.taskTransition.deleteMany({ where: { userId } });
  await prisma.undoEntry.deleteMany({ where: { userId } });
  await prisma.task.deleteMany({ where: { userId } });
  await prisma.person.deleteMany({ where: { userId } });
  await prisma.syncState.deleteMany({ where: { userId } });
  await prisma.preference.deleteMany({ where: { userId } });
  await prisma.auditLedger.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

test("capture, brief, ask, nudges, meetings, and weekly recap", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner");
  const other = await user("other");
  const app = await appFor(owner.id);
  try {
    await saveSettings(prisma, owner.id, {
      timezone: "UTC",
      morningBrief: { enabled: true, time: "00:00" },
      staleNudge: { enabled: true, untouchedDays: 14 },
    });
    const person = await prisma.person.create({ data: { userId: owner.id, name: "Priya Shah", email: "priya@example.com" } });

    const preview = await app.inject({ method: "POST", url: "/api/capture/preview", payload: { text: "remind Priya about the contract Friday" } });
    assert.equal(preview.statusCode, 200);
    const previewBody = preview.json() as { parsed: { due: string; matched: Array<{ id: string }> } };
    assert.ok(previewBody.parsed.due);
    assert.equal(previewBody.parsed.matched[0]?.id, person.id);

    const captured = await app.inject({ method: "POST", url: "/api/capture", payload: { text: "remind Priya about the contract Friday" } });
    assert.equal(captured.statusCode, 201);
    const taskBody = captured.json() as { task: { id: string; title: string; people: string[]; due: string }; undoEntryId: string | null };
    assert.match(taskBody.task.title, /contract/i);
    assert.ok(taskBody.task.people.includes(person.id));
    assert.ok(taskBody.task.due);
    assert.ok(taskBody.undoEntryId);

    const brief = await app.inject({ method: "POST", url: "/api/brief/deliver" });
    assert.equal(brief.statusCode, 200);
    const briefBody = brief.json() as { delivered: boolean; notification: { id: string; channel: string; kind: string } };
    assert.equal(briefBody.delivered, true);
    assert.equal(briefBody.notification.kind, "morning_brief");
    assert.equal(briefBody.notification.channel, "hub");
    const again = await app.inject({ method: "GET", url: "/api/brief/today" });
    assert.equal(again.json().reason, "already");
    const notes = await app.inject({ method: "GET", url: "/api/notifications" });
    assert.ok(notes.json().notifications.some((row: { kind: string }) => row.kind === "morning_brief"));
    const read = await app.inject({ method: "POST", url: `/api/notifications/${briefBody.notification.id}/read` });
    assert.equal(read.json().updated, 1);

    const quiet = await prisma.task.create({
      data: { userId: owner.id, title: "Forgotten filing", status: "todo", owner: "me", createdBy: "me" },
    });
    await prisma.$executeRaw`UPDATE tasks SET updated_at = ${new Date("2020-01-01T00:00:00.000Z")} WHERE id = ${quiet.id}`;
    const nudges = await app.inject({ method: "GET", url: "/api/nudges" });
    assert.equal(nudges.statusCode, 200);
    const nudgeBody = nudges.json() as { nudges: Array<{ id: string; reasons: string[] }> };
    const found = nudgeBody.nudges.find((row) => row.id === quiet.id);
    assert.ok(found);
    assert.ok(found.reasons.includes("untouched"));
    const kept = await app.inject({ method: "POST", url: `/api/nudges/${quiet.id}`, payload: { action: "keep" } });
    assert.equal(kept.statusCode, 200);
    const afterKeep = await app.inject({ method: "GET", url: "/api/nudges" });
    assert.equal(afterKeep.json().nudges.some((row: { id: string }) => row.id === quiet.id), false);

    const late = await prisma.task.create({
      data: { userId: owner.id, title: "Overdue outline", status: "todo", owner: "me", createdBy: "me", due: new Date("2020-01-02T00:00:00.000Z") },
    });
    const done = await app.inject({ method: "POST", url: `/api/nudges/${late.id}`, payload: { action: "done" } });
    assert.equal(done.statusCode, 200);
    assert.equal(done.json().status, "done");
    const trashedTask = await prisma.task.create({
      data: { userId: owner.id, title: "Drop me", status: "todo", owner: "me", createdBy: "me", due: new Date("2020-01-03T00:00:00.000Z") },
    });
    const trashed = await app.inject({ method: "POST", url: `/api/nudges/${trashedTask.id}`, payload: { action: "trash" } });
    assert.equal(trashed.statusCode, 200);
    const gone = await prisma.task.findUnique({ where: { id: trashedTask.id } });
    assert.ok(gone?.deletedAt);

    const event = await prisma.artifact.create({
      data: {
        userId: owner.id,
        kind: "event",
        externalId: `evt-${owner.id}`,
        title: "Design review",
        ts: new Date(Date.now() + 30 * 60_000),
        participants: [{ name: "Priya Shah" }],
        metadata: { end: new Date(Date.now() + 90 * 60_000).toISOString() },
        text: "",
      },
    });
    await prisma.meetingNote.create({
      data: { userId: owner.id, title: "Last review", answer: "We decided Priya owns the draft.", personIds: [person.id], source: "paste" },
    });
    const cues = await app.inject({ method: "GET", url: "/api/meetings/cues" });
    assert.equal(cues.statusCode, 200);
    const cueBody = cues.json() as { cues: Array<{ title: string; kind: string; decisions: Array<{ text: string }>; openTasks: Array<{ id: string }> }>; voice: string };
    const cue = cueBody.cues.find((row) => row.title === "Design review");
    assert.ok(cue);
    assert.equal(cue.kind, "prep");
    assert.match(cueBody.voice, /TODO: voice notes/);
    assert.ok(cue.decisions.some((row) => /decided/i.test(row.text)));

    const started = await app.inject({ method: "POST", url: "/api/meetings/sessions", payload: { artifactId: event.id } });
    assert.equal(started.statusCode, 201);
    const sessionId = started.json().session.id as string;
    const saved = await app.inject({
      method: "PATCH",
      url: `/api/meetings/sessions/${sessionId}`,
      payload: { notes: "Priya said Rahul should review the contract.\nWe decided to ship Friday." },
    });
    assert.equal(saved.statusCode, 200);
    const ended = await app.inject({ method: "POST", url: `/api/meetings/sessions/${sessionId}/end` });
    assert.equal(ended.json().askAttach, true);
    const declined = await app.inject({ method: "POST", url: `/api/meetings/sessions/${sessionId}/decline` });
    assert.equal(declined.json().session.attachState, "declined");
    const listed = await app.inject({ method: "GET", url: "/api/meetings/sessions" });
    assert.ok(listed.json().sessions.some((row: { id: string }) => row.id === sessionId));

    const otherApp = await appFor(other.id);
    const hidden = await otherApp.inject({ method: "GET", url: `/api/meetings/sessions/${sessionId}` });
    assert.equal(hidden.statusCode, 404);
    await otherApp.close();

    const summary = await app.inject({
      method: "POST",
      url: "/api/meetings/summarize",
      payload: { question: "summarize what Priya said about Rahul" },
    });
    assert.equal(summary.statusCode, 200);
    assert.ok(summary.json().quotes.some((row: { text: string }) => /Rahul/.test(row.text)));

    const attachedStart = await app.inject({ method: "POST", url: "/api/meetings/sessions", payload: { artifactId: event.id, title: "Follow-up" } });
    const secondId = attachedStart.json().session.id as string;
    await app.inject({ method: "PATCH", url: `/api/meetings/sessions/${secondId}`, payload: { notes: "Follow up on the draft." } });
    const attached = await app.inject({ method: "POST", url: `/api/meetings/sessions/${secondId}/attach` });
    assert.equal(attached.statusCode, 200);
    assert.equal(attached.json().calendarWrite, false);
    assert.match(attached.json().message, /read-only/);
    const stored = await prisma.artifact.findUnique({ where: { id: event.id } });
    const metadata = stored?.metadata as { ensembleNotes?: string };
    assert.match(metadata.ensembleNotes ?? "", /Follow up/);

    const asked = await app.inject({ method: "POST", url: "/api/ask", payload: { question: "contract" } });
    assert.equal(asked.statusCode, 200);
    const askBody = asked.json() as { sources: Array<{ path: string; label: string }> };
    assert.ok(askBody.sources.some((source) => source.path.startsWith("/tasks/") || source.path.startsWith("/meetings")));

    await prisma.task.update({ where: { id: taskBody.task.id }, data: { status: "in_progress" } });
    await prisma.task.update({ where: { id: taskBody.task.id }, data: { status: "done", completedAt: new Date() } });
    const recap = await app.inject({ method: "GET", url: "/api/recap/week" });
    assert.equal(recap.statusCode, 200);
    const recapBody = recap.json() as { markdown: string; meetings: Array<{ summary: string }> };
    assert.match(recapBody.markdown, /contract/i);
    assert.ok(recapBody.meetings.length >= 1);
    assert.match(recapBody.markdown, /## Meetings/);
  } finally {
    await app.close();
    await cleanup(owner.id);
    await cleanup(other.id);
  }
});

test("cowork edge cases: dates, ownership, nudges, meetings, recap bounds", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("edges");
  const other = await user("stranger");
  const app = await appFor(owner.id);
  const otherApp = await appFor(other.id);
  try {
    await saveSettings(prisma, owner.id, {
      timezone: "UTC",
      morningBrief: { enabled: false, time: "08:00" },
      staleNudge: { enabled: true, untouchedDays: 14 },
    });
    const off = await app.inject({ method: "POST", url: "/api/brief/deliver" });
    assert.equal(off.statusCode, 200);
    assert.equal(off.json().delivered, false);
    assert.equal(off.json().reason, "off");

    const blank = await app.inject({ method: "POST", url: "/api/capture", payload: { text: "   " } });
    assert.equal(blank.statusCode, 400);
    const impossible = await app.inject({ method: "POST", url: "/api/capture/preview", payload: { text: "file the form on 2026-02-31" } });
    assert.equal(impossible.statusCode, 200);
    assert.equal(impossible.json().parsed.due, null);
    const huge = await app.inject({ method: "POST", url: "/api/capture/preview", payload: { text: "file the form in 999999999999 days" } });
    assert.equal(huge.statusCode, 200);
    assert.equal(huge.json().parsed.due, null);

    const priyaA = await prisma.person.create({ data: { userId: owner.id, name: "Priya Shah" } });
    const priyaB = await prisma.person.create({ data: { userId: owner.id, name: "Priya Rao" } });
    await prisma.person.create({ data: { userId: other.id, name: "Jordan Blake" } });
    const ambiguous = await app.inject({ method: "POST", url: "/api/capture", payload: { text: "remind Priya about the filing tomorrow" } });
    assert.equal(ambiguous.statusCode, 201);
    const ambiguousPeople = ambiguous.json().task.people as string[];
    assert.equal(ambiguousPeople.includes(priyaA.id), false);
    assert.equal(ambiguousPeople.includes(priyaB.id), false);
    assert.ok(ambiguousPeople.includes("Priya"));
    const foreign = await app.inject({ method: "POST", url: "/api/capture", payload: { text: "remind Jordan about the filing tomorrow" } });
    assert.equal((foreign.json().task.people as string[]).includes("Jordan"), true);
    assert.equal(foreign.json().parsed.matched.length, 0);

    const quiet = await prisma.task.create({
      data: { userId: owner.id, title: "Old outline", status: "todo", owner: "me", createdBy: "me" },
    });
    await prisma.$executeRaw`UPDATE tasks SET updated_at = ${new Date("2020-01-01T00:00:00.000Z")} WHERE id = ${quiet.id}`;
    const denied = await otherApp.inject({ method: "POST", url: `/api/nudges/${quiet.id}`, payload: { action: "keep" } });
    assert.equal(denied.statusCode, 404);
    const snoozed = await app.inject({ method: "POST", url: `/api/nudges/${quiet.id}`, payload: { action: "snooze" } });
    assert.equal(snoozed.statusCode, 200);
    const afterSnooze = await app.inject({ method: "GET", url: "/api/nudges" });
    assert.equal(afterSnooze.json().nudges.some((row: { id: string }) => row.id === quiet.id), false);
    const paused = await prisma.task.findUnique({ where: { id: quiet.id } });
    assert.ok(paused?.snoozedUntil && paused.snoozedUntil > new Date());

    const blocked = await prisma.task.create({
      data: { userId: owner.id, title: "Blocked filing", status: "blocked", owner: "me", createdBy: "me", due: new Date("2020-01-04T00:00:00.000Z") },
    });
    const finished = await app.inject({ method: "POST", url: `/api/nudges/${blocked.id}`, payload: { action: "done" } });
    assert.equal(finished.statusCode, 200);
    assert.equal(finished.json().status, "done");

    const proposed = await prisma.task.create({
      data: { userId: owner.id, title: "Proposed filing", status: "proposed", owner: "me", createdBy: "me", due: new Date("2020-01-05T00:00:00.000Z") },
    });
    const proposedDone = await app.inject({ method: "POST", url: `/api/nudges/${proposed.id}`, payload: { action: "done" } });
    assert.equal(proposedDone.json().status, "done");

    const started = await prisma.task.create({
      data: { userId: owner.id, title: "Already moving", status: "in_progress", owner: "me", createdBy: "me", due: new Date("2020-01-06T00:00:00.000Z") },
    });
    const dropped = await prisma.task.create({
      data: { userId: owner.id, title: "Dropped idea", status: "dropped", owner: "me", createdBy: "me", due: new Date("2020-01-07T00:00:00.000Z") },
    });
    await prisma.$executeRaw`UPDATE tasks SET updated_at = ${new Date("2020-01-01T00:00:00.000Z")} WHERE id = ${dropped.id}`;
    const open = await app.inject({ method: "GET", url: "/api/nudges" });
    const ids = open.json().nudges.map((row: { id: string }) => row.id) as string[];
    assert.equal(ids.includes(started.id), false);
    assert.equal(ids.includes(dropped.id), false);

    const disposable = await prisma.task.create({
      data: { userId: owner.id, title: "Trash me", status: "todo", owner: "me", createdBy: "me", due: new Date("2020-01-08T00:00:00.000Z") },
    });
    const removed = await app.inject({ method: "POST", url: `/api/nudges/${disposable.id}`, payload: { action: "trash" } });
    assert.equal(removed.statusCode, 200);
    await undoLast(prisma, owner.id, removed.json().undoEntryId);
    const restored = await prisma.task.findUnique({ where: { id: disposable.id } });
    assert.equal(restored?.deletedAt, null);

    await saveSettings(prisma, owner.id, { morningBrief: { enabled: true, time: "00:00" } });
    const brief = await app.inject({ method: "POST", url: "/api/brief/deliver" });
    const noteId = brief.json().notification.id as string;
    const stolen = await otherApp.inject({ method: "POST", url: `/api/notifications/${noteId}/read` });
    assert.equal(stolen.statusCode, 404);
    const marked = await app.inject({ method: "POST", url: "/api/notifications/read" });
    assert.ok(marked.json().updated >= 1);

    const stale = await app.inject({ method: "GET", url: "/api/nudges" });
    assert.equal(stale.statusCode, 200);
    const again = await app.inject({ method: "GET", url: "/api/nudges" });
    const notices = await app.inject({ method: "GET", url: "/api/notifications" });
    const staleNotes = notices.json().notifications.filter((row: { kind: string }) => row.kind === "stale_nudge");
    assert.equal(staleNotes.length, 1);
    assert.equal(again.statusCode, 200);

    const now = Date.now();
    const liveEvent = await prisma.artifact.create({
      data: {
        userId: owner.id,
        kind: "event",
        externalId: `live-${owner.id}`,
        title: "Live review",
        ts: new Date(now - 10 * 60_000),
        participants: [{ name: "Priya Shah" }],
        metadata: { end: new Date(now - 20 * 60_000).toISOString() },
        text: "",
      },
    });
    await prisma.artifact.create({
      data: {
        userId: owner.id,
        kind: "event",
        externalId: `follow-${owner.id}`,
        title: "Follow review",
        ts: new Date(now - 3 * 3600_000),
        participants: [{ name: "Priya Shah" }],
        metadata: { end: new Date(now - 2 * 3600_000).toISOString() },
        text: "",
      },
    });
    const cues = await app.inject({ method: "GET", url: "/api/meetings/cues" });
    const cueRows = cues.json().cues as Array<{ title: string; kind: string }>;
    assert.equal(cueRows.find((row) => row.title === "Live review")?.kind, "live");
    assert.equal(cueRows.find((row) => row.title === "Follow review")?.kind, "follow_up");

    const theirs = await prisma.artifact.create({
      data: { userId: other.id, kind: "event", externalId: `theirs-${other.id}`, title: "Secret", ts: new Date(), participants: [], text: "" },
    });
    const hiddenStart = await app.inject({ method: "POST", url: "/api/meetings/sessions", payload: { artifactId: theirs.id } });
    assert.equal(hiddenStart.statusCode, 404);
    const loose = await app.inject({ method: "POST", url: "/api/meetings/sessions", payload: { title: "Loose notes" } });
    const looseId = loose.json().session.id as string;
    const noEvent = await app.inject({ method: "POST", url: `/api/meetings/sessions/${looseId}/attach` });
    assert.equal(noEvent.statusCode, 400);

    const noted = await app.inject({ method: "POST", url: "/api/meetings/sessions", payload: { artifactId: liveEvent.id, title: "Live notes" } });
    const notedId = noted.json().session.id as string;
    await app.inject({ method: "PATCH", url: `/api/meetings/sessions/${notedId}`, payload: { notes: "First pass." } });
    await app.inject({ method: "POST", url: `/api/meetings/sessions/${notedId}/end` });
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/meetings/sessions/${notedId}`,
      payload: { notes: "We decided to wait." },
    });
    assert.match(edited.json().session.recap, /decided to wait/i);
    const note = await prisma.meetingNote.findFirst({ where: { userId: owner.id, artifactId: liveEvent.id } });
    assert.match(note?.answer ?? "", /decided to wait/);

    const removedSession = await app.inject({ method: "DELETE", url: `/api/meetings/sessions/${looseId}` });
    assert.equal(removedSession.statusCode, 200);
    const missing = await app.inject({ method: "GET", url: `/api/meetings/sessions/${looseId}` });
    assert.equal(missing.statusCode, 404);
    const listed = await app.inject({ method: "GET", url: "/api/meetings/sessions" });
    assert.equal(listed.json().sessions.some((row: { id: string }) => row.id === looseId), false);

    // A fixed past week. In the current week, a task due on its first day has not slipped yet on that day.
    const pastWeek = "/api/recap/week?date=2026-01-14";
    const week = await app.inject({ method: "GET", url: pastWeek });
    const bounds = week.json() as { start: string; end: string };
    await prisma.task.create({
      data: { userId: owner.id, title: "Slip inside", status: "todo", owner: "me", createdBy: "me", due: new Date(`${bounds.start}T00:00:00.000Z`) },
    });
    await prisma.task.create({
      data: { userId: owner.id, title: "Due next week", status: "todo", owner: "me", createdBy: "me", due: new Date(`${bounds.end}T00:00:00.000Z`) },
    });
    await prisma.task.create({
      data: {
        userId: owner.id,
        title: "Finished earlier",
        status: "done",
        owner: "me",
        createdBy: "me",
        completedAt: new Date("2020-01-01T00:00:00.000Z"),
      },
    });
    const bounded = await app.inject({ method: "GET", url: pastWeek });
    const markdown = bounded.json().markdown as string;
    assert.match(markdown, /Slip inside/);
    assert.doesNotMatch(markdown, /Due next week/);
    assert.doesNotMatch(markdown, /Finished earlier/);
    const nonsense = await app.inject({ method: "GET", url: "/api/recap/week?date=2026-02-31" });
    assert.equal(nonsense.statusCode, 400);

    const ask = await app.inject({ method: "POST", url: "/api/ask", payload: { question: "   " } });
    assert.equal(ask.statusCode, 400);
    const miss = await app.inject({ method: "POST", url: "/api/meetings/summarize", payload: { question: "what did Nobody say about Zzzz" } });
    assert.match(miss.json().answer, /couldn't find/i);
  } finally {
    await app.close();
    await otherApp.close();
    await cleanup(owner.id);
    await cleanup(other.id);
  }
});
