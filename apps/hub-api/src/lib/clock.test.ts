import assert from "node:assert/strict";
import test from "node:test";
import { isHmTime, isIsoDate, nextPacificMidnight, parseDue, retentionCatchUp, retentionDue, workWeekLine, zonedDateTimeToUtc, zonedParts } from "./clock.js";

test("a due date that is not a real day is a client error", () => {
  assert.equal(parseDue("2026-09-29")?.toISOString(), "2026-09-29T00:00:00.000Z");
  assert.equal(parseDue(null), null);
  assert.throws(() => parseDue("2026-02-31"), (error: unknown) => (error as { statusCode?: number }).statusCode === 400);
  assert.throws(() => parseDue("2026-02-31T00:00:00.000Z"), (error: unknown) => (error as { statusCode?: number }).statusCode === 400);
});

test("iso dates reject calendar nonsense", () => {
  assert.equal(isIsoDate("2026-09-29"), true);
  assert.equal(isIsoDate("tomorrow"), false);
  assert.equal(isIsoDate("2026-02-31"), false);
  assert.equal(isHmTime("09:30"), true);
  assert.equal(isHmTime("9:30"), false);
});

test("retention catch-up runs when a day was missed", () => {
  assert.equal(retentionCatchUp(null, "2026-09-29"), true);
  assert.equal(retentionCatchUp("2026-09-28", "2026-09-29"), true);
  assert.equal(retentionCatchUp("2026-09-29", "2026-09-29"), false);
});

test("retention waits for the slot on the first run and catches up after downtime", () => {
  assert.equal(retentionDue(null, { date: "2026-09-29", time: "02:00" }), false);
  assert.equal(retentionDue(null, { date: "2026-09-29", time: "03:30" }), true);
  assert.equal(retentionDue("2026-09-28", { date: "2026-09-29", time: "02:00" }), true);
  assert.equal(retentionDue("2026-09-29", { date: "2026-09-29", time: "12:00" }), false);
});

test("Tuesday 29 Sep 2026 is not described as Monday", () => {
  const line = workWeekLine("2026-09-29", "Tuesday");
  assert.match(line, /Today is Tuesday, 2026-09-29/);
  assert.match(line, /Tuesday 2026-09-29 \(today\)/);
  assert.match(line, /Monday 2026-09-28/);
  assert.equal(line.includes("Monday 2026-09-29"), false);
});

test("this week on a weekend is the Monday–Sunday week that contains today", () => {
  const saturday = workWeekLine("2026-10-03", "Saturday");
  assert.match(saturday, /Today is Saturday, 2026-10-03/);
  assert.match(saturday, /Saturday 2026-10-03 \(today\)/);
  assert.match(saturday, /Monday 2026-09-28/);
  assert.match(saturday, /Sunday 2026-10-04/);
  assert.equal(saturday.includes("2026-09-27"), false);

  const sunday = workWeekLine("2026-10-04", "Sunday");
  assert.match(sunday, /Sunday 2026-10-04 \(today\)/);
  assert.match(sunday, /Monday 2026-09-28/);
  assert.match(sunday, /Saturday 2026-10-03/);
  assert.equal(sunday.includes("Monday 2026-10-05"), false);

  const monday = workWeekLine("2026-09-28", "Monday");
  assert.match(monday, /Monday 2026-09-28 \(today\)/);
  assert.match(monday, /Sunday 2026-10-04/);
});

test("this week follows the timezone, including Asia/Kolkata just after UTC Sunday", () => {
  const at = new Date("2026-10-04T20:30:00.000Z");
  const parts = zonedParts("Asia/Kolkata", at);
  assert.equal(parts.date, "2026-10-05");
  assert.equal(parts.weekday, "Monday");
  const line = workWeekLine(parts.date, parts.weekday);
  assert.match(line, /Monday 2026-10-05 \(today\)/);
  assert.match(line, /Sunday 2026-10-11/);
  assert.equal(line.includes("2026-09-28"), false);
  assert.equal(nextPacificMidnight(at).toISOString(), "2026-10-05T07:00:00.000Z");
});

test("zoned wall time becomes a real instant", () => {
  const utc = zonedDateTimeToUtc("2026-01-15", "09:00", "Asia/Kolkata");
  assert.equal(utc.toISOString(), "2026-01-15T03:30:00.000Z");
});
