import assert from "node:assert/strict";
import test from "node:test";
import { writeModeNote } from "./agent.js";
import { assistantInstructions, turnContext } from "./state.js";
import { pastScheduleWarning, withPastScheduleWarning } from "./schedule.js";

test("every message's context carries today, its week and the time zone, with or without a page open", () => {
  const bare = turnContext(undefined, { today: "2026-10-04", weekday: "Sunday", timezone: "America/Los_Angeles" });
  assert.match(bare, /Today is Sunday, 2026-10-04/);
  assert.match(bare, /Monday 2026-09-28/);
  assert.match(bare, /Time zone America\/Los_Angeles/);
  const open = turnContext({ path: "/today", timezone: "Asia/Kolkata", today: "2026-10-04", weekday: "Sunday" }, { today: "2026-10-04", weekday: "Sunday", timezone: "Asia/Kolkata" });
  assert.match(open, /Today is Sunday, 2026-10-04/);
  assert.match(open, /Asia\/Kolkata/);
});

test("the instructions say how dates, times and held writes read, with nothing that changes per message", () => {
  const prompt = assistantInstructions({ skills: [] }, { timezone: "America/Los_Angeles", writeMode: writeModeNote("preview") });
  assert.match(prompt, /Dates are YYYY-MM-DD and times HH:MM, in America\/Los_Angeles/);
  assert.match(prompt, /waits until the person presses Apply: describe it as ready to apply, never as done/);
  assert.doesNotMatch(prompt, /Today is|2026-/, "the date is the message's, so the instructions stay the same all day");
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
