import assert from "node:assert/strict";
import test from "node:test";
import { markSchedulerEnabled, markSchedulerTick, resetSchedulerClockForTests, schedulerSnapshot } from "./scheduler-clock.js";

test("the clock records enablement and the last finished tick", () => {
  resetSchedulerClockForTests();
  assert.equal(schedulerSnapshot(500).enabled, false);
  markSchedulerEnabled(1_000);
  markSchedulerEnabled(1_500);
  const starting = schedulerSnapshot(2_000);
  assert.equal(starting.enabled, true);
  assert.equal(starting.startedAt, 1_000);
  assert.equal(starting.lastTickAt, null);
  markSchedulerTick(3_000);
  assert.equal(schedulerSnapshot(4_000).lastTickAt, 3_000);
  resetSchedulerClockForTests();
});
