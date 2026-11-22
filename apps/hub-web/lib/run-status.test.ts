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

test("a finished run is done only when the checks Ensemble ran again passed", () => {
  assert.deepEqual(runPresentation({ outcome: "success", verified: "passed" }), { label: "Done", tone: "green", active: false });
  assert.deepEqual(runPresentation({ outcome: "success", verified: "failed" }), { label: "Checks failed", tone: "red", active: false });
  assert.deepEqual(runPresentation({ outcome: "success", verified: "not_verified" }), { label: "Not verified", tone: "yellow", active: false });
  assert.equal(runPresentation({ outcome: "success", verified: null }).label, "Done", "a run with no checks, as before");
  assert.equal(runPresentation({ outcome: "failed", verified: "failed" }).label, "Failed");
});
