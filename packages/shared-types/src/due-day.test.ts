import assert from "node:assert/strict";
import test from "node:test";
import { dueDay, isDateOnlyDue } from "./due-day.js";

test("a date-only due keeps its date in every time zone", () => {
  const due = new Date("2026-11-30T00:00:00.000Z");
  assert.equal(isDateOnlyDue(due), true);
  for (const zone of ["America/Los_Angeles", "Asia/Kolkata", "Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"]) {
    assert.equal(dueDay(due, zone), "2026-11-30", zone);
  }
  assert.equal(dueDay("2026-11-30T00:00:00.000Z", "America/Los_Angeles"), "2026-11-30");
  assert.equal(dueDay("2026-11-30"), "2026-11-30");
});

test("a due with a time falls on its date in the person's zone", () => {
  // 17:00 in Los Angeles on 30 Nov is 01:00 UTC on 1 Dec.
  const evening = new Date("2026-12-01T01:00:00.000Z");
  assert.equal(isDateOnlyDue(evening), false);
  assert.equal(dueDay(evening, "America/Los_Angeles"), "2026-11-30");
  assert.equal(dueDay(evening, "Asia/Kolkata"), "2026-12-01");
  // 17:00 in Kolkata on 30 Nov is 11:30 UTC the same day.
  assert.equal(dueDay("2026-11-30T11:30:00.000Z", "Asia/Kolkata"), "2026-11-30");
  assert.equal(dueDay("2026-11-30T11:30:00.000Z", "America/Los_Angeles"), "2026-11-30");
});

test("no due, or one that is not a date, has no day", () => {
  assert.equal(dueDay(null), null);
  assert.equal(dueDay(undefined), null);
  assert.equal(dueDay(""), null);
  assert.equal(dueDay("soon"), null);
});
