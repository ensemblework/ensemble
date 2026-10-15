import assert from "node:assert/strict";
import test from "node:test";
import { sameTimeZone, timeZoneLabel, timeZoneOptions } from "./time-zones";

test("the time zone list has every IANA zone once, keeps the saved spelling, and never offers a made-up one", () => {
  const zones = timeZoneOptions("Asia/Kolkata");
  assert.ok(zones.length > 300);
  assert.ok(zones.includes("Asia/Kolkata"));
  assert.ok(!zones.includes("Asia/Calcutta"), "one entry per place");
  assert.ok(zones.includes("UTC"));
  assert.ok(zones.includes("Europe/London"));
  assert.deepEqual([...zones].sort((a, b) => a.localeCompare(b)), zones);
  assert.ok(!timeZoneOptions("Mars/Olympus_1").includes("Mars/Olympus_1"));
  assert.ok(timeZoneOptions("europe/london").includes("Europe/London"));
});

test("zones compare by place and read with their offset", () => {
  assert.equal(sameTimeZone("Asia/Kolkata", "Asia/Calcutta"), true);
  assert.equal(sameTimeZone("Europe/London", "Europe/Paris"), false);
  assert.equal(sameTimeZone(null, "UTC"), false);
  assert.equal(timeZoneLabel("America/New_York", new Date("2026-10-16T12:00:00Z")), "America/New York · GMT-4");
  assert.match(timeZoneLabel("UTC", new Date("2026-10-16T12:00:00Z")), /^UTC · GMT/);
});
