import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "./state.js";
import { pastScheduleWarning, withPastScheduleWarning } from "./schedule.js";

const EMPTY = { proposed: 0, todo: [], inProgress: 0, needsMe: 0, projects: [], people: [], repos: [], skills: [] };

test("the assistant prompt includes today's date and timezone with no page open", () => {
  const prompt = buildSystemPrompt(EMPTY, undefined, undefined, {
    today: "2026-10-04",
    weekday: "Sunday",
    timezone: "America/Los_Angeles",
  });
  assert.match(prompt, /Today is Sunday, 2026-10-04/);
  assert.match(prompt, /America\/Los_Angeles/);
  assert.match(prompt, /tomorrow/);
  assert.match(prompt, /before the Oct 6 release/);
  assert.match(prompt, /not "before the release tomorrow"/);
  assert.match(prompt, /I've proposed a project page — press Apply to create it/);
  assert.match(prompt, /created or drafted/);
});

test("an open page still carries the date and timezone", () => {
  const prompt = buildSystemPrompt(EMPTY, {
    path: "/today",
    timezone: "Asia/Kolkata",
    today: "2026-10-04",
    weekday: "Sunday",
  });
  assert.match(prompt, /Today is Sunday, 2026-10-04/);
  assert.match(prompt, /Asia\/Kolkata/);
});

const zone = "America/Los_Angeles";
const now = new Date("2026-10-04T17:00:00.000Z");

test("Apply warns when a reminder or due date is already past", () => {
  const reminder = pastScheduleWarning({ dueDate: "2026-10-03", dueTime: "09:00" }, zone, now);
  assert.match(reminder ?? "", /in the past/);
  assert.match(reminder ?? "", /2026-10-03/);
  assert.equal(pastScheduleWarning({ dueDate: "2026-10-05", dueTime: "09:00" }, zone, now), null);
  const due = pastScheduleWarning({ tasks: [{ due: "2026-10-01" }] }, zone, now);
  assert.match(due ?? "", /due 2026-10-01/);
  assert.equal(pastScheduleWarning({ tasks: [{ due: "2026-10-04" }] }, zone, now), null);
  const stamped = pastScheduleWarning({ due: "2026-10-04T16:00:00.000Z" }, zone, now);
  assert.match(stamped ?? "", /in the past/);
  const line = withPastScheduleWarning("Remind: Call on 2026-10-03 at 09:00", { dueDate: "2026-10-03", dueTime: "09:00" }, zone, now);
  assert.match(line, /Remind: Call/);
  assert.match(line, /in the past/);
});
