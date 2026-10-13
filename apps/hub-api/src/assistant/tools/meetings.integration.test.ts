/**
 * The assistant's meeting-note, calendar and weekly-recap tools on the in-memory database:
 * synced events with their notes, writing, editing and trashing notes (with the session's
 * mirror note and undo), imported notes staying read only, the recap, and another space of the
 * same account seeing none of it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { DEFAULT_SETTINGS } from "@ensemble/shared-types";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../../test/http.js";

const harness: HttpHarness = await createHttpHarness();
const db = harness.prisma;
const { getTool } = await import("../registry.js");
const { applyHeldCalls } = await import("../apply.js");
const { undoLast } = await import("../../lib/undo.js");
const { zonedParts } = await import("../../lib/clock.js");
const { addCalendarDays } = await import("../../cowork/dates.js");
type ToolContext = import("../types.js").ToolContext;
type AnyHubTool = import("../types.js").AnyHubTool;

after(() => harness.close());

const TZ = "Asia/Kolkata";

function ctx(userId: string): ToolContext {
  return { app: harness.app, prisma: db, userId, actor: "agent", settings: { ...DEFAULT_SETTINGS, timezone: TZ } };
}

function tool(name: string): AnyHubTool {
  const found = getTool(name);
  assert.ok(found, `${name} is registered`);
  return found;
}

async function read<T>(userId: string, name: string, input: Record<string, unknown>): Promise<T> {
  const t = tool(name);
  return (await t.run(ctx(userId), t.input.parse(input))).data as T;
}

async function apply(userId: string, name: string, input: Record<string, unknown>) {
  const t = tool(name);
  const parsed = t.input.parse(input);
  const preview = await t.preview?.(ctx(userId), parsed);
  const batch = await applyHeldCalls(harness.app, ctx(userId), [{ tool: t, input: parsed }]);
  const outcome = batch.outcomes[0]!;
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.error);
  return { preview, result: outcome.result, undoEntryId: batch.undoEntryId };
}

async function refused(promise: Promise<unknown> | unknown, pattern: RegExp, status?: number) {
  await assert.rejects(Promise.resolve().then(() => promise), (error: Error & { statusCode?: number }) => {
    assert.match(error.message, pattern);
    if (status) assert.equal(error.statusCode, status);
    return true;
  });
}

async function space(user: HttpUser, name: string): Promise<string> {
  const res = await user.inject({ method: "POST", url: "/api/spaces", payload: { name, templateId: "semester-desk", settings: { mode: "fresh" } } });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { space: { id: string } }).space.id;
}

const today = () => zonedParts(TZ).date;
/** A wall-clock time in Kolkata as a UTC instant. */
const at = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

async function event(userId: string, input: { title: string; start: Date; end?: Date; source?: "google" | "outlook"; people?: Array<{ name: string | null; email: string | null }> }) {
  return db.artifact.create({
    data: {
      userId,
      kind: "event",
      externalId: `${input.source ?? "google"}-${randomUUID()}`,
      ts: input.start,
      title: input.title,
      url: "https://calendar.example/event",
      participants: input.people ?? [],
      metadata: { source: input.source ?? "google", end: input.end?.toISOString() ?? null, allDay: false, joinUrl: "https://meet.example/abc", location: "Room 4", calendar: "Work" },
    },
  });
}

test("hub_list_events lists synced events in the person's days, with attendees, calendar and linked notes", async () => {
  const mira = await harness.asUser();
  const day = addCalendarDays(today(), 1);
  const review = await event(mira.id, { title: "Design review", start: at(day, "15:00"), end: at(day, "15:30"), people: [{ name: "Arjun Rao", email: "arjun@fieldnote.example" }, { name: null, email: "lena@fieldnote.example" }] });
  await event(mira.id, { title: "Standup", start: at(day, "09:30"), end: at(day, "09:45"), source: "outlook" });
  await event(mira.id, { title: "Far away", start: at(addCalendarDays(today(), 20), "10:00") });
  const session = await db.meetingSession.create({ data: { userId: mira.id, title: "Design review notes", artifactId: review.id, status: "ended" } });

  const listed = await read<{ events: Array<Record<string, unknown>>; note?: string; from: string; to: string }>(mira.id, "hub_list_events", {});
  assert.equal(listed.from, today());
  assert.equal(listed.to, addCalendarDays(today(), 7));
  assert.deepEqual(listed.events.map((row) => row.title), ["Standup", "Design review"]);
  const first = listed.events[1]!;
  assert.match(String(first.when), /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} 15:00–15:30$/);
  assert.deepEqual(first.attendees, ["Arjun Rao", "lena@fieldnote.example"]);
  assert.equal(first.calendar, "Google Calendar");
  assert.equal(first.link, "https://meet.example/abc");
  assert.equal(first.location, "Room 4");
  assert.deepEqual(first.meetingNotes, [{ id: session.id, title: "Design review notes" }]);
  assert.equal(listed.events[0]!.calendar, "Outlook calendar");
  assert.match(String(listed.note), /No calendar syncs to Ensemble yet/);

  await db.syncState.create({ data: { userId: mira.id, connector: "google_calendar", lastSyncAt: new Date(), lastError: null } });
  const ranged = await read<{ events: Array<{ title: string }>; sync: Array<{ calendar: string }>; note?: string }>(mira.id, "hub_list_events", { from: day, to: day, query: "review" });
  assert.deepEqual(ranged.events.map((row) => row.title), ["Design review"]);
  assert.deepEqual(ranged.sync.map((row) => row.calendar), ["Google Calendar"]);
  assert.equal(ranged.note, undefined);
  await refused(read(mira.id, "hub_list_events", { from: day, to: today() }), /to is before from/, 400);
  await refused(read(mira.id, "hub_list_events", { from: today(), to: addCalendarDays(today(), 90) }), /at most 62 days/, 400);
});

test("meeting notes: write from an event, edit behind the title guard, trash, and undo each step with the mirror note", async () => {
  const mira = await harness.asUser();
  const arjun = await db.person.create({ data: { userId: mira.id, name: "Arjun Rao", email: "arjun@fieldnote.example" } });
  const lena = await db.person.create({ data: { userId: mira.id, name: "Lena Park" } });
  const day = addCalendarDays(today(), -1);
  const sync = await event(mira.id, { title: "Weekly sync", start: at(day, "11:00"), end: at(day, "11:30"), people: [{ name: "Arjun Rao", email: "arjun@fieldnote.example" }] });

  const fromEvent = await apply(mira.id, "hub_create_meeting_note", { eventId: sync.id, notes: "## Decisions\n\n- We agreed to ship Friday." });
  assert.match(String(fromEvent.preview), /^Save meeting notes “Weekly sync” for [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} 11:00 on the event “Weekly sync”$/);
  const id = (fromEvent.result.data as { id: string }).id;
  assert.equal(fromEvent.result.href, `/meetings?session=${id}`);
  const session = await db.meetingSession.findUniqueOrThrow({ where: { id } });
  assert.equal(session.status, "ended");
  assert.equal(session.startedAt.toISOString(), sync.ts.toISOString());
  assert.deepEqual(session.personIds, [arjun.id], "attendees come from the event");
  assert.ok(session.meetingNoteId);
  const mirror = await db.meetingNote.findUniqueOrThrow({ where: { id: session.meetingNoteId! } });
  assert.equal(mirror.source, "live");
  assert.match(mirror.answer, /ship Friday/);

  const note = await read<{ title: string; attendees: Array<{ name: string }>; event: { title: string }; decisions: string[]; notes: string; status: string }>(mira.id, "hub_read_meeting_note", { meetingId: id });
  assert.equal(note.title, "Weekly sync");
  assert.deepEqual(note.attendees.map((row) => row.name), ["Arjun Rao"]);
  assert.equal(note.event.title, "Weekly sync");
  assert.deepEqual(note.decisions, ["We agreed to ship Friday."]);
  assert.equal(note.status, "ended");
  assert.equal((await read<{ id: string }>(mira.id, "hub_read_meeting_note", { meetingId: mirror.id })).id, id, "the mirror note's id reads the same note");

  const planned = await apply(mira.id, "hub_create_meeting_note", { title: "Budget call", date: day, time: "16:00", notes: "Numbers look fine.", attendeeIds: [lena.id] });
  assert.match(String(planned.preview), /“Budget call” for .* 16:00 with Lena Park$/);
  const budgetId = (planned.result.data as { id: string }).id;
  assert.equal((await db.meetingSession.findUniqueOrThrow({ where: { id: budgetId } })).startedAt.toISOString(), at(day, "16:00").toISOString());
  const create = tool("hub_create_meeting_note");
  await refused(create.preview!(ctx(mira.id), create.input.parse({ title: "X", attendeeIds: [randomUUID()] })), /No person with id .*hub_list_people/, 404);
  await refused(create.preview!(ctx(mira.id), create.input.parse({ notes: "x" })), /Give the note a title, or pass the calendar eventId/, 400);
  await refused(create.preview!(ctx(mira.id), create.input.parse({ title: "X", eventId: randomUUID() })), /No calendar event with that id/, 404);

  const listed = await read<{ notes: Array<{ id: string; title: string; from: string }> }>(mira.id, "hub_list_meeting_notes", { query: "numbers" });
  assert.deepEqual(listed.notes.map((row) => row.title), ["Budget call"]);
  const byDate = await read<{ notes: Array<{ title: string }> }>(mira.id, "hub_list_meeting_notes", { from: day, to: day });
  assert.deepEqual(byDate.notes.map((row) => row.title), ["Budget call", "Weekly sync"]);

  const update = tool("hub_update_meeting_note");
  await refused(update.preview!(ctx(mira.id), update.input.parse({ meetingId: id, matchTitle: "Budget call", notes: "x" })), /That note is “Weekly sync”, not “Budget call”/, 409);
  const appended = await apply(mira.id, "hub_update_meeting_note", { meetingId: id, matchTitle: "weekly sync", notes: "## Action items\n\n- Arjun sends the build" });
  assert.match(String(appended.preview), /^Meeting notes “Weekly sync”: add: ## Action items$/);
  const edited = await db.meetingSession.findUniqueOrThrow({ where: { id } });
  assert.match(edited.notes, /ship Friday\.\n\n## Action items\n\n- Arjun sends the build$/);
  assert.match((await db.meetingNote.findUniqueOrThrow({ where: { id: mirror.id } })).answer, /Arjun sends the build/, "the mirror note follows");

  const renamed = await apply(mira.id, "hub_update_meeting_note", { meetingId: budgetId, matchTitle: "Budget call", mode: "replace", notes: "Rewritten.", title: "Budget review", eventId: sync.id });
  assert.match(String(renamed.preview), /rewrite the notes; rename to “Budget review”; attach the event “Weekly sync”/);
  const budget = await db.meetingSession.findUniqueOrThrow({ where: { id: budgetId } });
  assert.deepEqual([budget.title, budget.notes, budget.artifactId], ["Budget review", "Rewritten.", sync.id]);
  await undoLast(db, mira.id, renamed.undoEntryId!);
  const undone = await db.meetingSession.findUniqueOrThrow({ where: { id: budgetId } });
  assert.deepEqual([undone.title, undone.notes, undone.artifactId], ["Budget call", "Numbers look fine.", null]);
  assert.equal((await db.meetingNote.findUniqueOrThrow({ where: { id: undone.meetingNoteId! } })).title, "Budget call");

  const trashed = await apply(mira.id, "hub_delete_meeting_note", { meetingId: id });
  assert.equal(trashed.preview, "Move meeting notes “Weekly sync” to Trash");
  assert.deepEqual(trashed.result.data, { id, restore: "Undo in the app bar, or Trash (/trash), brings it back." });
  assert.ok((await db.meetingSession.findUniqueOrThrow({ where: { id } })).deletedAt);
  assert.ok((await db.meetingNote.findUniqueOrThrow({ where: { id: mirror.id } })).deletedAt);
  await refused(read(mira.id, "hub_read_meeting_note", { meetingId: id }), /No meeting note with that id/, 404);
  await undoLast(db, mira.id, trashed.undoEntryId!);
  assert.equal((await db.meetingSession.findUniqueOrThrow({ where: { id } })).deletedAt, null);
  assert.equal((await db.meetingNote.findUniqueOrThrow({ where: { id: mirror.id } })).deletedAt, null);

  const scratch = await apply(mira.id, "hub_create_meeting_note", { title: "Scratch", notes: "Mistake." });
  await undoLast(db, mira.id, scratch.undoEntryId!);
  const gone = await db.meetingSession.findUniqueOrThrow({ where: { id: (scratch.result.data as { id: string }).id } });
  assert.ok(gone.deletedAt, "undoing the create moves the note to Trash");
  assert.ok((await db.meetingNote.findUniqueOrThrow({ where: { id: gone.meetingNoteId! } })).deletedAt, "and its mirror note");
});

test("notes from meeting tools read with decisions and action items and stay read only", async () => {
  const mira = await harness.asUser();
  const imported = await db.meetingNote.create({
    data: {
      userId: mira.id,
      title: "Pricing call",
      answer: "Summary: pricing stays flat.",
      source: "connector",
      externalSource: "fathom",
      externalId: "fathom-1",
      occurredAt: at(addCalendarDays(today(), -2), "10:00"),
      extraction: { decisions: ["Keep the price flat"], actionItems: [{ text: "Send the deck", owner: { name: "Mira Chen" }, due: "2026-10-20" }] },
    },
  });
  const listed = await read<{ notes: Array<{ id: string; title: string; when: string; from: string; readOnly?: boolean }> }>(mira.id, "hub_list_meeting_notes", { query: "pricing" });
  assert.deepEqual(listed.notes.map(({ when: _when, ...row }) => row), [{ id: imported.id, title: "Pricing call", from: "Fathom", readOnly: true }]);
  const note = await read<{ from: string; decisions: string[]; actionItems: Array<{ text: string; owner: string; due: string }>; notes: string }>(mira.id, "hub_read_meeting_note", { meetingId: imported.id });
  assert.equal(note.from, "Fathom");
  assert.deepEqual(note.decisions, ["Keep the price flat"]);
  assert.deepEqual(note.actionItems, [{ text: "Send the deck", owner: "Mira Chen", due: "2026-10-20" }]);
  assert.equal(note.notes, "Summary: pricing stays flat.");
  const update = tool("hub_update_meeting_note");
  await refused(update.preview!(ctx(mira.id), update.input.parse({ meetingId: imported.id, matchTitle: "Pricing call", notes: "x" })), /“Pricing call” \(from Fathom\) is read only here/, 400);
  await refused(tool("hub_delete_meeting_note").preview!(ctx(mira.id), { meetingId: imported.id }), /read only here/, 400);
  await refused(applyHeldCalls(harness.app, ctx(mira.id), [{ tool: tool("hub_delete_meeting_note"), input: { meetingId: imported.id } }]), /read only here/);
  assert.equal((await db.meetingNote.findUniqueOrThrow({ where: { id: imported.id } })).deletedAt, null);
});

test("hub_weekly_recap returns the week's done, slipped, upcoming and meetings", async () => {
  const mira = await harness.asUser();
  await db.preference.create({ data: { userId: mira.id, key: "hub.settings", value: { timezone: TZ }, source: "me" } });
  const now = new Date();
  const todayDate = today();
  await db.task.create({ data: { userId: mira.id, title: "Shipped the export", status: "done", completedAt: now, boardOrder: 0 } });
  const recapWeek = await read<{ start: string; end: string }>(mira.id, "hub_weekly_recap", {});
  const nextWeekDay = addCalendarDays(recapWeek.end, 2);
  await db.task.create({ data: { userId: mira.id, title: "Prepare the board deck", status: "todo", due: new Date(`${nextWeekDay}T00:00:00.000Z`), boardOrder: 1 } });
  if (recapWeek.start < todayDate) {
    await db.task.create({ data: { userId: mira.id, title: "Late review", status: "todo", due: new Date(`${recapWeek.start}T00:00:00.000Z`), boardOrder: 2 } });
  }
  await db.meetingSession.create({ data: { userId: mira.id, title: "Team sync", notes: "We decided to freeze scope.", status: "ended", startedAt: now } });

  const recap = await read<{ week: string; done: Array<{ title: string }>; slipped: Array<{ title: string }>; upcoming: Array<{ title: string; due: string }>; meetings: Array<{ title: string }>; decided: Array<{ title: string }> }>(mira.id, "hub_weekly_recap", {});
  assert.ok(recap.done.some((row) => row.title === "Shipped the export"));
  assert.deepEqual(recap.upcoming.map((row) => [row.title, row.due]), [["Prepare the board deck", nextWeekDay]]);
  assert.deepEqual(recap.meetings.map((row) => row.title), ["Team sync"]);
  assert.ok(recap.decided.some((row) => row.title === "We decided to freeze scope."));
  if (recapWeek.start < todayDate) assert.deepEqual(recap.slipped.map((row) => row.title), ["Late review"]);

  const lastWeek = await read<{ start: string; done: Array<{ title: string }> }>(mira.id, "hub_weekly_recap", { date: addCalendarDays(todayDate, -7) });
  assert.equal(lastWeek.start, addCalendarDays(recapWeek.start, -7));
  assert.equal(lastWeek.done.length, 0);
});

test("another space of the same account sees none of these events or notes and cannot change them", async () => {
  const mira = await harness.asUser();
  const other = await space(mira, "Side project");
  const day = addCalendarDays(today(), 1);
  const primaryEvent = await event(mira.id, { title: "Primary board meeting", start: at(day, "10:00") });
  const written = await apply(mira.id, "hub_create_meeting_note", { title: "Primary notes", notes: "Confidential numbers." });
  const writtenId = (written.result.data as { id: string }).id;
  const imported = await db.meetingNote.create({ data: { userId: mira.id, title: "Primary import", answer: "x", source: "connector", externalSource: "granola", externalId: "g-1" } });
  await db.task.create({ data: { userId: mira.id, title: "Primary finished task", status: "done", completedAt: new Date(), boardOrder: 0 } });

  const events = await read<{ events: Array<{ id: string }> }>(other, "hub_list_events", {});
  assert.ok(!events.events.some((row) => row.id === primaryEvent.id));
  const notes = await read<{ notes: Array<{ id: string }> }>(other, "hub_list_meeting_notes", { query: "Primary" });
  assert.deepEqual(notes.notes, []);
  for (const meetingId of [writtenId, imported.id]) await refused(read(other, "hub_read_meeting_note", { meetingId }), /No meeting note with that id/, 404);
  const update = tool("hub_update_meeting_note");
  await refused(update.preview!(ctx(other), update.input.parse({ meetingId: writtenId, matchTitle: "Primary notes", notes: "x" })), /No meeting note with that id/, 404);
  await refused(applyHeldCalls(harness.app, ctx(other), [{ tool: update, input: update.input.parse({ meetingId: writtenId, matchTitle: "Primary notes", notes: "x" }) }]), /No meeting note with that id/);
  await refused(applyHeldCalls(harness.app, ctx(other), [{ tool: tool("hub_delete_meeting_note"), input: { meetingId: writtenId } }]), /No meeting note with that id/);
  const create = tool("hub_create_meeting_note");
  await refused(create.preview!(ctx(other), create.input.parse({ eventId: primaryEvent.id })), /No calendar event with that id/, 404);
  const person = await db.person.create({ data: { userId: mira.id, name: "Primary person" } });
  await refused(create.preview!(ctx(other), create.input.parse({ title: "x", attendeeIds: [person.id] })), /No person with id/, 404);
  const kept = await db.meetingSession.findUniqueOrThrow({ where: { id: writtenId } });
  assert.deepEqual([kept.notes, kept.deletedAt], ["Confidential numbers.", null]);
  const recap = await read<{ done: Array<{ title: string }> }>(other, "hub_weekly_recap", {});
  assert.ok(!recap.done.some((row) => row.title === "Primary finished task"));
});

test("meeting notes are a page: the editor's document is kept, its Markdown mirrors it, and the assistant appends after the person's blocks", async () => {
  const mira = await harness.asUser();
  const arjun = await db.person.create({ data: { userId: mira.id, name: "Arjun Rao" } });
  const started = await mira.inject({ method: "POST", url: "/api/meetings/sessions", payload: { title: "Design review" } });
  assert.equal(started.statusCode, 201, started.body);
  const id = (started.json() as { session: { id: string; content: unknown } }).session.id;
  const content = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Notes" }] },
      { type: "paragraph", content: [{ type: "text", text: "Asked " }, { type: "mention", attrs: { kind: "people", id: arjun.id, label: "Arjun Rao" } }, { type: "text", text: " for the build." }] },
      { type: "ensembleReply", attrs: { threadId: randomUUID(), prompt: "summarise", pageKind: "meeting", pageId: id } },
    ],
  };
  const saved = await mira.inject({ method: "PATCH", url: `/api/meetings/sessions/${id}`, payload: { content } });
  assert.equal(saved.statusCode, 200, saved.body);
  const row = await db.meetingSession.findUniqueOrThrow({ where: { id } });
  assert.equal(row.notes, `## Notes\n\nAsked [@Arjun Rao](ensemble://people/${arjun.id}) for the build.`, "notes are the page's Markdown");
  const detail = (await mira.inject({ method: "GET", url: `/api/meetings/sessions/${id}` })).json() as { session: { content: { content: Array<{ type: string }> } } };
  assert.deepEqual(detail.session.content.content.map((node) => node.type), ["heading", "paragraph", "ensembleReply"]);

  await apply(mira.id, "hub_update_meeting_note", { meetingId: id, matchTitle: "Design review", notes: "- [ ] Arjun sends the build" });
  const after = await db.meetingSession.findUniqueOrThrow({ where: { id } });
  assert.deepEqual((after.content as { content: Array<{ type: string }> }).content.map((node) => node.type), ["heading", "paragraph", "ensembleReply", "taskList"], "the person's blocks stay; the new ones follow");
  assert.match(after.notes, /for the build\.\n\n- \[ \] Arjun sends the build$/);

  const old = await db.meetingSession.create({ data: { userId: mira.id, title: "Before pages", notes: "## Plan\n\n- One" } });
  const legacy = (await mira.inject({ method: "GET", url: `/api/meetings/sessions/${old.id}` })).json() as { session: { content: { content: Array<{ type: string }> } } };
  assert.deepEqual(legacy.session.content.content.map((node) => node.type), ["heading", "bulletList"], "notes typed before pages open as a page");
  const list = (await mira.inject({ method: "GET", url: "/api/meetings/sessions" })).json() as { sessions: Array<Record<string, unknown>> };
  assert.equal("content" in list.sessions[0]!, false, "the list stays light");

  assert.equal((await mira.inject({ method: "GET", url: `/api/pages/meeting/${id}/comments` })).statusCode, 200, "inline @ensemble answers are kept on the meeting");
  const ben = await harness.asUser();
  assert.equal((await ben.inject({ method: "GET", url: `/api/pages/meeting/${id}/comments` })).statusCode, 404);
});
