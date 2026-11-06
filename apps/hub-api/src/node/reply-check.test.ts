/**
 * The reply check (node/reply-check.ts): a node's reply against what its tools did. The cases are the
 * Software team crew's replies of 5 November 2026 (node.ensemblework.com), and replies that are fine.
 * No database.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantToolCall } from "@ensemble/shared-types";
import { replyProblems } from "./reply-check.js";

const call = (name: string, extra: Partial<AssistantToolCall> = {}) => ({ call: { id: name, name, state: "ok" as const, ...extra }, result: {} });

test("a reply that tells the crew to start, delegating nothing, goes back", () => {
  const text = "Done. I assigned both auto-format tasks to @swe-2.\n\n@swe-1 @swe-2 — start work on your assigned tasks now.";
  const problems = replyProblems(text, [call("hub_update_task", { isWrite: true }), call("hub_update_task", { isWrite: true })]);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /a message in the chat starts nothing: hand the work over with node_delegate/);
  assert.deepEqual(replyProblems(text, [call("hub_update_task", { isWrite: true }), call("node_delegate")]), []);
});

test("promises and permission questions instead of the work go back; reporting back later is fine", () => {
  const promise = replyProblems("Acknowledged — I’ll resume the interrupted coding session and continue from where it left off. Do you want me to resume now?", []);
  assert.equal(promise.length, 2);
  assert.match(promise[0]!, /promises/);
  assert.match(promise[1]!, /do it instead of asking/);
  assert.deepEqual(replyProblems("Steered the session with the low-RAM rules; I’ll report back when it finishes.", [call("node_session_send")]), []);
  // After one round, a question to the owner may stand.
  assert.deepEqual(replyProblems("Which repository should I use: ensemble or ensemble-node?", [], 1), []);
});

test("a claim with no tool behind it goes back; drafting notes go back; plain answers pass", () => {
  assert.match(replyProblems("I've created the eight tasks on your board.", [call("hub_list_tasks")]).join(), /no tool call in this turn did that/);
  assert.deepEqual(replyProblems("I've created the eight tasks on your board.", [call("hub_create_tasks", { isWrite: true })]), []);
  assert.match(replyProblems("Who should I assign?Ok, now need to craft the final reply. We must respond as TechLead, short and plain.", []).join(), /your own notes/);
  assert.deepEqual(replyProblems("Node.js 24 is the current LTS; its support ends on 30 April 2028.", []), []);
  assert.deepEqual(replyProblems("", []), []);
  // A failed call does not back a claim.
  assert.equal(replyProblems("I've delegated it to @swe-1.", [call("node_delegate", { state: "failed" })]).length, 1);
});
