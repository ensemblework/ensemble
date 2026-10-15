import assert from "node:assert/strict";
import test from "node:test";
import { exportTimeZone, isoInZone } from "./when";

test("download times are ISO 8601 in the person's zone, with the offset written out", () => {
  const at = "2026-10-16T08:35:07.250Z";
  assert.equal(isoInZone(at, "Asia/Kolkata"), "2026-10-16T14:05:07+05:30");
  assert.equal(isoInZone(at, "UTC"), "2026-10-16T08:35:07+00:00");
  assert.equal(isoInZone(at, "America/New_York"), "2026-10-16T04:35:07-04:00");
  assert.equal(isoInZone("2026-01-16T08:35:07Z", "America/New_York"), "2026-01-16T03:35:07-05:00", "winter time has its own offset");
  assert.equal(isoInZone("2026-10-16T23:30:00Z", "Asia/Kolkata"), "2026-10-17T05:00:00+05:30", "the date moves with the zone");
  assert.equal(isoInZone("2026-10-16T00:10:00Z", "Asia/Kathmandu"), "2026-10-16T05:55:00+05:45");
  assert.equal(isoInZone("2026-10-16T12:00:00Z", "Pacific/Chatham"), "2026-10-17T01:45:00+13:45");
});

test("missing and unreadable times stay readable", () => {
  assert.equal(isoInZone(null, "UTC"), "");
  assert.equal(isoInZone(undefined, "UTC"), "");
  assert.equal(isoInZone("", "UTC"), "");
  assert.equal(isoInZone("next week", "UTC"), "next week");
});

test("the zone is the person's when it is real, else this computer's", () => {
  assert.equal(exportTimeZone("Europe/London"), "Europe/London");
  assert.equal(exportTimeZone("Mars/Olympus_1"), exportTimeZone(null));
  assert.ok(exportTimeZone(null).length > 0);
});
