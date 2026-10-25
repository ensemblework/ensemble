import "../runtime/test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { queueWaitReason } from "./queue-policy.js";

const job = (over: Partial<Parameters<typeof queueWaitReason>[0]["candidate"]> = {}) => ({
  id: "q",
  deviceId: "home",
  repoUrl: null,
  resourceKeys: ["label:ensemble-workspace"],
  continueFromJobId: null,
  task: { projectId: null, repoId: null },
  ...over,
});

test("a queued task says why it has not started: the pause, the running task it waits for, or every slot in use", () => {
  const running = { ...job({ id: "r" }), title: "Plan and implement artifact interpretation" };
  assert.equal(queueWaitReason({ candidate: job(), active: [running], limit: 3, paused: false }), "Same folder as “Plan and implement artifact interpretation”, which is running: it starts when that one ends.");
  assert.equal(queueWaitReason({ candidate: job({ deviceId: "laptop" }), active: [running], limit: 3, paused: false }), null, "a folder of the same name on another computer is another folder");
  assert.match(queueWaitReason({ candidate: job({ resourceKeys: [], task: { projectId: "p", repoId: null } }), active: [{ ...running, task: { projectId: "p", repoId: null } }], limit: 3, paused: false })!, /^Same project as/);
  assert.match(queueWaitReason({ candidate: job({ resourceKeys: [], continueFromJobId: "r" }), active: [running], limit: 3, paused: false })!, /^It continues/);
  assert.equal(queueWaitReason({ candidate: job({ resourceKeys: [] }), active: [running], limit: 1, paused: false }), "All 1 slot is in use.");
  assert.equal(queueWaitReason({ candidate: job(), active: [], limit: 3, paused: true }), "Paused: nothing starts until you resume.");
});
