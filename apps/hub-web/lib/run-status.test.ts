import assert from "node:assert/strict";
import test from "node:test";
import { runPresentation } from "./run-status";

test("queueing, human decisions and cancellation never imply computation", () => {
  for (const [jobStatus, label] of [["queued", "Queued"], ["claimed", "Starting"], ["waiting_approval", "Waiting for you"], ["stopping", "Stopping"], ["paused", "Paused"]]) {
    const state = runPresentation({ jobStatus });
    assert.equal(state.active, false);
    assert.equal(state.label, label);
  }
  assert.equal(runPresentation({ jobStatus: "running" }).active, true);
});

test("a terminal run stops its animation even with stale running job state", () => {
  assert.equal(runPresentation({ jobStatus: "running", endedAt: "2026-01-01T00:00:00Z" }).active, false);
  assert.equal(runPresentation({ jobStatus: "running", outcome: "success" }).label, "Done");
  assert.equal(runPresentation({ jobStatus: "running", outcome: "waiting_approval" }).active, false);
  assert.equal(runPresentation({ jobStatus: "interrupted" }).label, "Interrupted");
});
