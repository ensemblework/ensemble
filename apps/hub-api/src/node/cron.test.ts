import assert from "node:assert/strict";
import { test } from "node:test";
import { CronError, cronMatches, describeCron, localTime, nextRun, parseCron, validTimeZone, zonedInstant } from "./cron.js";

test("fields, ranges, steps, lists and names parse; bad schedules say why", () => {
  const cron = parseCron("*/15 9-17 * * mon-fri");
  assert.deepEqual(cron.minutes, [0, 15, 30, 45]);
  assert.deepEqual(cron.hours, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...cron.weekdays].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("0 0 * * 7").weekdays], [0]);
  assert.deepEqual(parseCron("5,35 1 * * *").minutes, [5, 35]);
  assert.deepEqual(parseCron("@daily").hours, [0]);
  assert.throws(() => parseCron("0 9 * *"), CronError);
  assert.throws(() => parseCron("60 9 * * *"), /not a valid minute/);
  assert.throws(() => parseCron("0 9 * * 5-1"), /backwards/);
  assert.throws(() => parseCron("*/0 * * * *"), /step/);
  assert.equal(validTimeZone("Asia/Kolkata"), true);
  assert.equal(validTimeZone("Mars/Olympus"), false);
});

test("the next run is in the routine's time zone", () => {
  const cron = parseCron("0 9 * * 1-5");
  // Friday 2026-11-06 10:00 in Kolkata (04:30 UTC): the next is Monday 09:00 IST = 03:30 UTC.
  const next = nextRun(cron, "Asia/Kolkata", new Date("2026-11-06T04:30:00Z"));
  assert.equal(next?.toISOString(), "2026-11-09T03:30:00.000Z");
  // Before 09:00 on a weekday: the same day.
  assert.equal(nextRun(cron, "Asia/Kolkata", new Date("2026-11-06T02:00:00Z"))?.toISOString(), "2026-11-06T03:30:00.000Z");
  // Exactly at a run: the next one, not the same.
  assert.equal(nextRun(cron, "Asia/Kolkata", new Date("2026-11-06T03:30:00Z"))?.toISOString(), "2026-11-09T03:30:00.000Z");
  assert.equal(nextRun(parseCron("0 0 31 2 *"), "UTC", new Date("2026-01-01T00:00:00Z")), null);
  assert.equal(nextRun(parseCron("0 12 29 2 *"), "UTC", new Date("2026-03-01T00:00:00Z"))?.toISOString(), "2028-02-29T12:00:00.000Z");
});

test("clock changes: a skipped time moves forward, and runs keep their wall-clock time", () => {
  // New York springs forward on 2027-03-14 at 02:00: 02:30 does not exist that day.
  const skipped = zonedInstant({ year: 2027, month: 3, day: 14, hour: 2, minute: 30 }, "America/New_York");
  assert.equal(localTime(skipped, "America/New_York").hour, 3);
  // 09:00 every day is 14:00 UTC before the change and 13:00 UTC after it.
  const daily = parseCron("0 9 * * *");
  assert.equal(nextRun(daily, "America/New_York", new Date("2027-03-13T15:00:00Z"))?.toISOString(), "2027-03-14T13:00:00.000Z");
  assert.equal(nextRun(daily, "America/New_York", new Date("2027-03-12T15:00:00Z"))?.toISOString(), "2027-03-13T14:00:00.000Z");
});

test("both day fields restricted run on either, as in cron; matching a wall-clock minute", () => {
  const cron = parseCron("0 8 1 * mon");
  assert.equal(cronMatches(cron, { year: 2026, month: 12, day: 1, hour: 8, minute: 0 }), true); // the 1st (a Tuesday)
  assert.equal(cronMatches(cron, { year: 2026, month: 12, day: 7, hour: 8, minute: 0 }), true); // a Monday
  assert.equal(cronMatches(cron, { year: 2026, month: 12, day: 8, hour: 8, minute: 0 }), false);
  assert.equal(describeCron("0 9 * * 1-5", "Asia/Kolkata"), "Weekdays at 09:00 (Asia/Kolkata)");
  assert.equal(describeCron("30 7 * * *", "UTC"), "Every day at 07:30 (UTC)");
  assert.equal(describeCron("0 10 * * 5", "Europe/London"), "Every Friday at 10:00 (Europe/London)");
});
