import assert from "node:assert/strict";
import test from "node:test";
import { sameTimeZone, timeZoneLabel } from "./time-zones";

test("zones compare by place and read with their offset", () => {
  assert.equal(sameTimeZone("Asia/Kolkata", "Asia/Calcutta"), true);
  assert.equal(sameTimeZone("Europe/London", "Europe/Paris"), false);
  assert.equal(sameTimeZone(null, "UTC"), false);
  assert.equal(timeZoneLabel("America/New_York", new Date("2026-10-16T12:00:00Z")), "America/New York · GMT-4");
  assert.match(timeZoneLabel("UTC", new Date("2026-10-16T12:00:00Z")), /^UTC · GMT/);
});
