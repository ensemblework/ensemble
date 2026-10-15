import assert from "node:assert/strict";
import test from "node:test";
import { meetingWhen, newMeetingTitle, newestFirst } from "./meeting-time.js";

const now = new Date(2026, 9, 16, 15, 0);

test("a meeting card says the day and the time the meeting started", () => {
  assert.equal(meetingWhen(new Date(2026, 9, 16, 14, 30), now), "Today, 2:30 pm");
  assert.equal(meetingWhen(new Date(2026, 9, 15, 9, 5), now), "Yesterday, 9:05 am");
  assert.equal(meetingWhen(new Date(2026, 9, 12, 16, 0), now), "Mon, 12 Oct, 4:00 pm");
  assert.equal(meetingWhen(new Date(2026, 8, 3, 11, 0), now), "3 Sept, 11:00 am");
  assert.equal(meetingWhen(new Date(2025, 8, 3, 11, 0), now), "3 Sept 2025, 11:00 am");
  assert.equal(meetingWhen("not a date", now), "—");
});

test("new notes are titled with when they started, so two notes on one day differ", () => {
  assert.equal(newMeetingTitle(new Date(2026, 9, 16, 14, 30)), "Meeting notes · 16 Oct, 2:30 pm");
  assert.notEqual(newMeetingTitle(new Date(2026, 9, 16, 9, 0)), newMeetingTitle(new Date(2026, 9, 16, 14, 30)));
});

test("the library lists the newest meeting first", () => {
  const rows = [
    { id: "a", startedAt: "2026-10-14T09:00:00.000Z" },
    { id: "b", startedAt: "2026-10-16T08:30:00.000Z" },
    { id: "c", startedAt: "2026-10-16T08:00:00.000Z" },
  ];
  assert.deepEqual(newestFirst(rows).map((row) => row.id), ["b", "c", "a"]);
});
