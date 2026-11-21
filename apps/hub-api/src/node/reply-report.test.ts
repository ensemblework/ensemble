/**
 * A reply's report fields for its turn's trace (node/reply-report.ts): the outcome the reply states, what it says
 * remains, and the outcome recorded, where what Ensemble observed outweighs the reply's own word.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { remainingIn, replyOutcome, statedOutcome } from "./reply-report.js";

test("the outcome a reply states, labelled or leading, and none when it states none", () => {
  assert.equal(statedOutcome("Outcome: partial. Two of the three pages are done."), "partial");
  assert.equal(statedOutcome("Fixed the tests.\n\n**Status:** blocked (needs your sign-in)"), "blocked");
  assert.equal(statedOutcome("Partially done: the table is there, the chart is not."), "partial");
  assert.equal(statedOutcome("Done. The task is in your list."), "done");
  assert.equal(statedOutcome("Uncertain: the page may have changed since."), "uncertain");
  assert.equal(statedOutcome("I've done the first part and the rest is done tomorrow."), null);
});

test("what a reply says remains: the line after the label, or the list under it; none when it says nothing is left", () => {
  assert.equal(remainingIn("Done: the README.\nRemaining: the changelog and the release notes."), "the changelog and the release notes.");
  assert.equal(remainingIn("Partial.\n\n**Still to do:**\n- write the tests\n- update the docs\n\nAsk me to go on."), "write the tests; update the docs");
  assert.equal(remainingIn("All set.\nRemaining: none."), null);
  assert.equal(remainingIn("The remaining tasks are in your list."), null, "only a label counts");
});

test("the recorded outcome: how the turn ended first, then the reply's own word unless it says done, then what the checks found", () => {
  const plain = { stated: null, verified: null, falseClaims: 0, remaining: false } as const;
  assert.equal(replyOutcome({ ...plain, ended: "done" }), "done");
  assert.equal(replyOutcome({ ...plain, ended: "cancelled", stated: "done" }), "stopped");
  assert.equal(replyOutcome({ ...plain, ended: "failed" }), "failed");
  assert.equal(replyOutcome({ ...plain, ended: null, error: true }), "failed", "a turn that threw");
  assert.equal(replyOutcome({ ...plain, ended: "parked" }), "blocked", "waiting for its owner's answer");
  assert.equal(replyOutcome({ ...plain, ended: "done", stated: "uncertain" }), "uncertain");
  assert.equal(replyOutcome({ ...plain, ended: "done", stated: "done", verified: false }), "partial", "the answer check did not pass");
  assert.equal(replyOutcome({ ...plain, ended: "done", falseClaims: 1 }), "partial", "a claim was taken out");
  assert.equal(replyOutcome({ ...plain, ended: "done", remaining: true }), "partial", "it names work left");
  assert.equal(replyOutcome({ ...plain, ended: "done", verified: true }), "done");
});
