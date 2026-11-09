/**
 * After tools have run, a reply that writes a tool call as text or announces the next write is sent back
 * once (agent.ts, leavesWorkUndone). Reports and offers are not.
 */
import assert from "node:assert/strict";
import test from "node:test";
import "../runtime/test-env.js";

const { leavesWorkUndone } = await import("./agent.js");

test("a tool call written as text, or the next write announced, leaves the work undone", () => {
  for (const text of [
    'Proceeding to create the task.{"call":"hub_create_tasks","args":{"tasks":[{"title":"Upgrade"}]}}',
    "I found the date. Proceeding to create the todo with it.",
    "Calling hub_create_tasks now.",
    "Got it. Now I'll add the todo with that date.",
    "Next, I will update the task's notes.",
  ]) {
    assert.equal(leavesWorkUndone(text), true, text);
  }
});

test("a report, an offer or a plain answer does not", () => {
  for (const text of [
    "Added “Renew passport”. 2026-12-25 is a Friday.",
    "Python 3.14 was released on 2025-10-07 ([python.org](https://www.python.org/downloads/)).",
    "If you like, I'll add a reminder for the appointment.",
    "I could not read that page: the site refuses automated reads.",
    "Done — I replaced October 20 with October 22.",
  ]) {
    assert.equal(leavesWorkUndone(text), false, text);
  }
});
