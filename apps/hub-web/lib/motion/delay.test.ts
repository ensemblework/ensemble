import assert from "node:assert/strict";
import test from "node:test";
import { MOTION_MIN_VISIBLE_MS, MOTION_SHOW_DELAY_MS, delayIsShown, initialDelay, stepDelay } from "./delay";

test("a fast load never shows the indicator", () => {
  const started = stepDelay(initialDelay(), true, 0);
  assert.equal(started.snapshot.phase, "waiting");
  assert.equal(started.wait, MOTION_SHOW_DELAY_MS);
  assert.equal(delayIsShown(started.snapshot), false);
  const cancelled = stepDelay(started.snapshot, false, 40);
  assert.equal(cancelled.snapshot.phase, "idle");
  assert.equal(delayIsShown(cancelled.snapshot), false);
});

test("a slow load appears after the delay and stops as soon as work completes", () => {
  const started = stepDelay(initialDelay(), true, 0);
  const shown = stepDelay(started.snapshot, true, MOTION_SHOW_DELAY_MS);
  assert.equal(delayIsShown(shown.snapshot), true);
  const done = stepDelay(shown.snapshot, false, MOTION_SHOW_DELAY_MS + 1);
  assert.equal(done.snapshot.phase, "idle");
  assert.equal(done.wait, null);
  assert.equal(MOTION_MIN_VISIBLE_MS, 0);
});

test("a later request starts its own delay", () => {
  const shown = stepDelay(stepDelay(initialDelay(), true, 0).snapshot, true, MOTION_SHOW_DELAY_MS);
  const done = stepDelay(shown.snapshot, false, MOTION_SHOW_DELAY_MS + 1);
  const again = stepDelay(done.snapshot, true, MOTION_SHOW_DELAY_MS + 40);
  assert.equal(again.snapshot.phase, "waiting");
  assert.equal(delayIsShown(again.snapshot), false);
});
