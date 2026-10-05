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

test("a slow load appears after the delay and then holds", () => {
  const started = stepDelay(initialDelay(), true, 0);
  const shown = stepDelay(started.snapshot, true, MOTION_SHOW_DELAY_MS);
  assert.equal(shown.snapshot.phase, "visible");
  assert.equal(delayIsShown(shown.snapshot), true);
  const early = stepDelay(shown.snapshot, false, MOTION_SHOW_DELAY_MS + 40);
  assert.equal(early.snapshot.phase, "holding");
  assert.equal(early.wait, MOTION_MIN_VISIBLE_MS - 40);
  assert.equal(delayIsShown(early.snapshot), true);
  const done = stepDelay(early.snapshot, false, MOTION_SHOW_DELAY_MS + MOTION_MIN_VISIBLE_MS);
  assert.equal(done.snapshot.phase, "idle");
});

test("work that resumes during the hold stays visible", () => {
  const shown = stepDelay(stepDelay(initialDelay(), true, 0).snapshot, true, MOTION_SHOW_DELAY_MS);
  const holding = stepDelay(shown.snapshot, false, MOTION_SHOW_DELAY_MS + 20);
  const again = stepDelay(holding.snapshot, true, MOTION_SHOW_DELAY_MS + 40);
  assert.equal(again.snapshot.phase, "visible");
  assert.equal(delayIsShown(again.snapshot), true);
});
