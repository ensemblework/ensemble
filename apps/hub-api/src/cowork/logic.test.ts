import assert from "node:assert/strict";
import test from "node:test";
import { Settings, SHORTCUTS, eventMatchesChord, matchShortcut, shortcutProblems } from "@ensemble/shared-types";
import { composeAskAnswer, searchTerms } from "./ask.js";
import { formatMorningBrief } from "./brief.js";
import { parseCapture } from "./capture.js";
import { weekBounds } from "./dates.js";
import { extractiveAnswer, meetingPhase, parseCrossMeetingQuestion, participantNames } from "./meetings.js";
import { nudgeQuestion, nudgeReasons, pathToDone } from "./nudges.js";
import { recapHighlights, recapNarrative, renderWeeklyRecap, slippedLinks, weekShape, type RecapStats } from "./recap.js";

const WEDNESDAY: { date: string; weekday: string } = { date: "2026-09-30", weekday: "Wednesday" };

test("quick capture reads a person and the next Friday", () => {
  const parsed = parseCapture("remind Priya about the contract Friday", WEDNESDAY, ["Priya Shah"]);
  assert.equal(parsed.due, "2026-10-02");
  assert.equal(parsed.dueLabel?.toLowerCase(), "friday");
  assert.ok(parsed.personNames.some((name) => name.toLowerCase().includes("priya")));
  assert.match(parsed.title, /contract/i);
  assert.doesNotMatch(parsed.title, /friday/i);
});

test("next Friday skips to the following week", () => {
  const parsed = parseCapture("send the draft next Friday", WEDNESDAY);
  assert.equal(parsed.due, "2026-10-09");
});

test("tomorrow and an explicit name", () => {
  const parsed = parseCapture("remind Jordan about filing tomorrow", WEDNESDAY);
  assert.equal(parsed.due, "2026-10-01");
  assert.deepEqual(parsed.personNames, ["Jordan"]);
});

test("capture dates stay real and do not throw", () => {
  const friday = { date: "2026-10-02", weekday: "Friday" };
  assert.equal(parseCapture("send it next Friday", friday).due, "2026-10-09");
  assert.equal(parseCapture("file it tonight", WEDNESDAY).due, "2026-09-30");
  assert.equal(parseCapture("file it in 1 day", WEDNESDAY).due, "2026-10-01");
  assert.equal(parseCapture("file it on 2026-02-31", WEDNESDAY).due, null);
  assert.equal(parseCapture("file it on 2026-13-01", WEDNESDAY).due, null);
  assert.equal(parseCapture("file it in 999999999999 days", WEDNESDAY).due, null);
  assert.equal(parseCapture("remind Priya on February 31", WEDNESDAY).due, null);
  assert.equal(parseCapture("pay the invoice on January 5", WEDNESDAY).due, "2027-01-05");
  assert.equal(parseCapture("pay the invoice on January 5, 2020", WEDNESDAY).due, "2020-01-05");
  assert.equal(parseCapture("meet on 2026-10-02", WEDNESDAY).due, "2026-10-02");
});

test("capture does not glue a shorter name onto a longer one", () => {
  const parsed = parseCapture("remind Priyanka about the filing", WEDNESDAY, ["Priya Shah", "José Alvarez"]);
  assert.equal(parsed.personNames.some((name) => name.startsWith("Priya ")), false);
  const jose = parseCapture("remind José about the filing", WEDNESDAY, ["José Alvarez"]);
  assert.deepEqual(jose.personNames, ["José Alvarez"]);
  const ambiguous = parseCapture("remind Priya about the filing", WEDNESDAY, ["Priya Shah", "Priya Rao"]);
  assert.deepEqual(ambiguous.personNames, ["Priya"]);
});

test("morning brief is plain text with the day's sections", () => {
  const brief = formatMorningBrief({
    date: "2026-09-29",
    timezone: "UTC",
    focus: [{ title: "File the brief" }],
    proposed: [],
    deliverables: [{ title: "Contract", due: "2026-10-02", project: "Acme" }],
    meetings: [{ title: "Design review", start: "2026-09-29T14:30:00.000Z" }],
    needsMe: { pendingApprovals: 1, pendingEditorDecisions: 0 },
  });
  assert.match(brief.title, /Morning brief/);
  assert.match(brief.body, /File the brief/);
  assert.match(brief.body, /Design review/);
  assert.match(brief.body, /Needs you: 1 item/);
  assert.doesNotMatch(brief.body, /email/i);
});

test("stale reasons cover quiet work and due work with no progress", () => {
  const now = new Date("2026-09-29T12:00:00.000Z");
  const quiet = nudgeReasons(
    {
      id: "1",
      title: "Old",
      status: "todo",
      due: null,
      updatedAt: new Date("2026-09-01T12:00:00.000Z"),
      snoozedUntil: null,
      nudgePausedUntil: null,
    },
    now,
    14,
  );
  assert.deepEqual(quiet, ["untouched"]);
  const due = nudgeReasons(
    {
      id: "2",
      title: "Late",
      status: "todo",
      due: new Date("2026-09-28T00:00:00.000Z"),
      updatedAt: now,
      snoozedUntil: null,
      nudgePausedUntil: null,
    },
    now,
    14,
  );
  assert.deepEqual(due, ["due_no_progress"]);
  assert.match(nudgeQuestion(["untouched", "due_no_progress"], 14), /Still relevant/);
  const paused = nudgeReasons(
    {
      id: "3",
      title: "Kept",
      status: "todo",
      due: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      snoozedUntil: null,
      nudgePausedUntil: new Date("2026-10-01T00:00:00.000Z"),
    },
    now,
    14,
  );
  assert.deepEqual(paused, []);
  assert.deepEqual(pathToDone("proposed"), ["in_progress", "done"]);
  assert.deepEqual(pathToDone("blocked"), ["in_progress", "done"]);
  assert.deepEqual(pathToDone("todo"), ["done"]);
  assert.deepEqual(pathToDone("done"), []);
  const moving = nudgeReasons(
    {
      id: "4",
      title: "Started",
      status: "in_progress",
      due: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: now,
      snoozedUntil: null,
      nudgePausedUntil: null,
    },
    now,
    14,
  );
  assert.deepEqual(moving, []);
  const dropped = nudgeReasons(
    {
      id: "5",
      title: "Gone",
      status: "dropped",
      due: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
      snoozedUntil: null,
      nudgePausedUntil: null,
    },
    now,
    14,
  );
  assert.deepEqual(dropped, []);
});

test("meeting phase and cross-meeting quotes", () => {
  const start = new Date("2026-09-29T15:00:00.000Z");
  const end = new Date("2026-09-29T16:00:00.000Z");
  assert.equal(meetingPhase(start, end, new Date("2026-09-29T14:00:00.000Z")), "upcoming");
  assert.equal(meetingPhase(start, end, new Date("2026-09-29T15:30:00.000Z")), "live");
  assert.equal(meetingPhase(start, end, new Date("2026-09-29T17:00:00.000Z")), "follow_up");
  assert.equal(meetingPhase(start, new Date("2026-09-29T14:30:00.000Z"), new Date("2026-09-29T15:30:00.000Z")), "live");
  assert.equal(meetingPhase(new Date("not-a-date"), end, new Date("2026-09-29T15:30:00.000Z")), "past");
  assert.deepEqual(participantNames([{ name: "Priya" }, "Rahul"]), ["Priya", "Rahul"]);
  const query = parseCrossMeetingQuestion("summarize what Priya said about Rahul");
  assert.deepEqual(query, { speaker: "Priya", topic: "Rahul" });
  const answer = extractiveAnswer(
    [{ title: "Design review", text: "Priya said Rahul owns the contract. The weather was fine.", href: "/meetings?session=1" }],
    query!,
  );
  assert.equal(answer.quotes.length, 1);
  assert.match(answer.quotes[0]!.text, /Rahul/);
  const titled = extractiveAnswer(
    [{ title: "Rahul sync", text: "Priya said the weather was fine. Priya said Rahul owns it.", href: "/meetings?session=2" }],
    { speaker: "Priya", topic: "Rahul" },
  );
  assert.equal(titled.quotes.length, 1);
  assert.match(titled.quotes[0]!.text, /owns it/);
});

test("weekly recap rolls meeting summaries into markdown", () => {
  const bounds = weekBounds("2026-09-30", "Wednesday");
  assert.equal(bounds.start, "2026-09-28");
  assert.equal(bounds.end, "2026-10-05");
  const markdown = renderWeeklyRecap({
    label: bounds.label,
    done: [{ title: "Filed the brief", href: "/tasks/1" }],
    decided: [{ title: "Ship on Friday", href: "/meetings?session=1" }],
    slipped: [{ title: "Contract", href: "/tasks/2", detail: "2026-10-02" }],
    meetings: [{ title: "Design review", when: "2026-09-29", summary: "Priya will send the draft.", href: "/meetings?session=1" }],
  });
  assert.match(markdown, /Filed the brief/);
  assert.match(markdown, /Ship on Friday/);
  assert.match(markdown, /Priya will send the draft/);
  assert.match(markdown, /Contract/);
});

test("slipped lists every open task past due, not only this week's", () => {
  const due = (day: string) => new Date(`${day}T11:30:00.000Z`);
  const tasks = [
    { id: "a", title: "Due this week", status: "todo", due: due("2026-10-13") },
    { id: "b", title: "Due last month", status: "in_progress", due: due("2026-09-02") },
    { id: "c", title: "Due last year", status: "blocked", due: due("2025-01-01") },
    { id: "d", title: "Due today", status: "todo", due: due("2026-10-16") },
    { id: "e", title: "Finished late", status: "done", due: due("2026-09-01") },
    { id: "f", title: "Dropped", status: "dropped", due: due("2026-09-01") },
    { id: "g", title: "No date", status: "todo", due: null },
  ];
  const slipped = slippedLinks(tasks, "2026-10-16", "2026-10-16");
  assert.deepEqual(slipped.map((row) => row.title), ["Due last year", "Due last month", "Due this week"]);
  assert.equal(slipped[0]!.detail, "1 Jan 2025");
  assert.equal(slipped[2]!.href, "/tasks/a");
  const markdown = renderWeeklyRecap({ label: "12 Oct – 18 Oct", done: [], decided: [], slipped, meetings: [] });
  assert.match(markdown, /Due last month/);
  assert.doesNotMatch(markdown, /Nothing past due is still open/);
  assert.deepEqual(slippedLinks(tasks, "2025-06-01", "2026-10-16").map((row) => row.title), ["Due last year"], "a past week counts what was due before its end");
});

test("recap days and hours follow the person's time zone, across a DST change", () => {
  const task = (id: string, at: string, byAgent = false) => ({ id, title: id, priority: "p1", projectId: null, at: new Date(at), byAgent });
  const kolkata = weekShape({
    start: "2026-10-26",
    today: "2026-11-01",
    timeZone: "Asia/Kolkata",
    completed: [task("monday-early", "2026-10-25T19:00:00Z"), task("sunday-late", "2026-11-01T18:29:00Z", true), task("next-week", "2026-11-01T18:31:00Z")],
    created: [new Date("2026-10-25T18:00:00Z"), new Date("2026-10-27T06:00:00Z")],
    views: [
      { at: new Date("2026-10-27T04:20:00Z"), durationMs: 20 * 60_000, surface: "board" },
      { at: new Date("2026-10-28T10:00:00Z"), durationMs: 5 * 60_000, surface: "pages" },
    ],
  });
  assert.deepEqual(kolkata.days.map((day) => day.date), ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
  assert.equal(kolkata.days[0]!.completedByYou, 1, "00:30 in Kolkata on Monday is still Sunday in UTC");
  assert.equal(kolkata.days[6]!.completedByAgents, 1);
  assert.equal(kolkata.days.reduce((sum, day) => sum + day.completedByYou + day.completedByAgents, 0), 2, "after Sunday midnight local is next week");
  assert.deepEqual(kolkata.days.map((day) => day.created), [0, 1, 0, 0, 0, 0, 0]);
  // 09:50 local for 20 minutes: ten minutes in the 9 o'clock hour, ten in the 10 o'clock hour.
  assert.equal(kolkata.rhythm[1]![9], 10);
  assert.equal(kolkata.rhythm[1]![10], 10);
  assert.equal(kolkata.days[1]!.activeMinutes, 20);
  assert.deepEqual(kolkata.surfaces, [{ surface: "board", minutes: 20 }, { surface: "pages", minutes: 5 }]);
  // New York leaves daylight time on 1 Nov 2026: 04:30 UTC on 2 Nov is 23:30 on Sunday, not 00:30 on Monday.
  const newYork = weekShape({ start: "2026-10-26", today: "2026-10-29", timeZone: "America/New_York", completed: [task("late", "2026-11-02T04:30:00Z")], created: [], views: [] });
  assert.equal(newYork.days[6]!.completedByYou, 1);
  assert.deepEqual(newYork.days.map((day) => day.future), [false, false, false, false, true, true, true]);
});

test("recap narrative compares with last week and highlights are deterministic", () => {
  const stats = (patch: Partial<RecapStats>): RecapStats => ({ completed: 0, completedByAgents: 0, created: 0, agentRuns: 0, agentSucceeded: 0, activeMinutes: 0, meetings: 0, decisions: 0, pagesEdited: 0, ...patch });
  const day = (date: string, you: number, agents = 0, activeMinutes = 0) => ({ date, completedByYou: you, completedByAgents: agents, created: 0, activeMinutes, future: false });
  const days = [day("2026-10-26", 1), day("2026-10-27", 0, 0, 30), day("2026-10-28", 4, 2), day("2026-10-29", 2), day("2026-10-30", 0), day("2026-10-31", 0), day("2026-11-01", 0)];
  const week = stats({ completed: 9, completedByAgents: 2, agentRuns: 4, agentSucceeded: 4, activeMinutes: 30 });
  assert.equal(
    recapNarrative({ stats: week, previous: stats({ completed: 5 }), days, current: false }),
    "You and your agents finished 9 tasks, 4 more than the week before; agents handled 2 of them. Wednesday was your busiest day.",
  );
  assert.match(recapNarrative({ stats: stats({ completed: 2 }), previous: stats({ completed: 3 }), days, current: true }), /^You have finished 2 tasks, 1 fewer than this time last week\./);
  assert.match(recapNarrative({ stats: stats({}), previous: stats({ completed: 3 }), days, current: false }), /^A quiet week/);
  const at = (iso: string) => new Date(iso);
  const highlights = recapHighlights({
    days,
    stats: week,
    completed: [
      { id: "b", title: "Ship the API", priority: "p0", projectId: null, at: at("2026-10-28T10:00:00Z"), byAgent: false },
      { id: "a", title: "Fix the outage", priority: "critical", projectId: null, at: at("2026-10-27T10:00:00Z"), byAgent: false },
    ],
    deliverables: [{ title: "Mobile release", href: "/projects/p" }],
    projectsDone: [],
    projects: [{ id: "p", name: "Mobile", href: "/projects/p", completed: 3, created: 0, open: 2 }],
    firstRun: false,
    current: false,
    waiting: 0,
    decided: 1,
  });
  assert.deepEqual(highlights.map((row) => row.kind), ["deliverable", "priority", "best_day", "project_push", "streak", "agents"]);
  assert.equal(highlights[1]!.title, "2 high-priority tasks done");
  assert.equal(highlights[1]!.href, "/tasks/a", "the earliest finished high-priority task leads");
  assert.equal(highlights[4]!.title, "Active 4 of 7 days");
  const markdown = renderWeeklyRecap({
    label: "26 Oct – 1 Nov",
    done: [],
    decided: [],
    slipped: [],
    meetings: [],
    summary: { narrative: "A good week.", stats: week, previous: stats({ completed: 5 }), current: false, highlights, dueSoon: [{ title: "Send the deck", href: "/tasks/c", due: "2026-11-03" }] },
  });
  assert.match(markdown, /A good week\.\n\n## At a glance/);
  assert.match(markdown, /- Done: 9 tasks \(7 by you, 2 by agents\) \(4 more than the week before\)/);
  assert.match(markdown, /## Highlights\n\n- Delivered “Mobile release”/);
  assert.match(markdown, /Send the deck — due 3 Nov/);
  assert.match(markdown, /## Meetings/);
});

test("ask answer keeps source links and finds useful words", () => {
  assert.deepEqual(searchTerms('what did Priya say about "the contract"'), ["the contract", "Priya"]);
  const composed = composeAskAnswer("contract", [
    { id: "t1", kind: "task", label: "Review the contract", excerpt: "Due Friday", url: "http://localhost:3000/tasks/t1", path: "/tasks/t1" },
  ]);
  assert.match(composed.answer, /Review the contract/);
  assert.equal(composed.sources[0]?.path, "/tasks/t1");
  const empty = composeAskAnswer("missing", []);
  assert.match(empty.answer, /couldn't find/i);
});

test("morning brief time is a real clock time", () => {
  assert.equal(Settings.parse({}).morningBrief.time, "08:00");
  assert.equal(Settings.parse({ morningBrief: { time: "07:30" } }).morningBrief.time, "07:30");
  assert.throws(() => Settings.parse({ morningBrief: { time: "99:99" } }));
  assert.throws(() => Settings.parse({ morningBrief: { time: "8:00" } }));
});

test("shortcuts never bind OS or Super keys", () => {
  assert.deepEqual(shortcutProblems(), []);
  const capture = SHORTCUTS.find((binding) => binding.id === "capture");
  assert.ok(capture?.mac);
  assert.equal(
    matchShortcut({ key: "u", metaKey: true, ctrlKey: true, altKey: false, shiftKey: true }, true, true)?.id,
    "capture",
  );
  assert.equal(
    matchShortcut({ key: "u", metaKey: false, ctrlKey: true, altKey: true, shiftKey: true }, false, true)?.id,
    "capture",
  );
  assert.equal(matchShortcut({ key: "q", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, true, false), null);
  assert.equal(matchShortcut({ key: "w", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, true, false), null);
  assert.equal(eventMatchesChord({ key: "F4", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false }, { key: "f4", alt: true }, false), true);
  assert.ok(shortcutProblems([{ id: "bad", label: "Quit", group: "x", scope: "global", whileTyping: false, mac: { key: "q", mod: true }, other: { key: "q", mod: true } }]).length);
});
