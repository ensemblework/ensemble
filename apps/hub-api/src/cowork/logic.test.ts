import assert from "node:assert/strict";
import test from "node:test";
import { Settings, SHORTCUTS, eventMatchesChord, matchShortcut, shortcutProblems } from "@ensemble/shared-types";
import { composeAskAnswer, searchTerms } from "./ask.js";
import { formatMorningBrief } from "./brief.js";
import { parseCapture } from "./capture.js";
import { weekBounds } from "./dates.js";
import { extractiveAnswer, meetingPhase, parseCrossMeetingQuestion, participantNames } from "./meetings.js";
import { nudgeQuestion, nudgeReasons, pathToDone } from "./nudges.js";
import { renderWeeklyRecap } from "./recap.js";

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
