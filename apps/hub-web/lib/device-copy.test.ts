import assert from "node:assert/strict";
import test from "node:test";
import { computerName, deviceDecisionView, folderPlace, freshCloneHint, interruptedLabel, pairingCodeConsumed, platformLabel, pullRequestNumber, rerunAssignInput, sandboxStay } from "./device-copy";

test("copy uses the device name, or your computer when none is chosen", () => {
  assert.equal(computerName("Studio PC"), "Studio PC");
  assert.equal(computerName("Build box"), "Build box");
  assert.equal(computerName("  "), "your computer");
  assert.equal(computerName(null), "your computer");
  assert.equal(folderPlace("Studio PC"), "A folder on Studio PC");
  assert.equal(folderPlace("Build box"), "A folder on Build box");
  assert.equal(folderPlace(undefined), "A folder on your computer");
  assert.equal(sandboxStay("Studio PC"), "Sandbox and trust stay on Studio PC.");
  assert.equal(platformLabel("windows"), "Windows");
  assert.equal(platformLabel("linux"), "Linux");
  assert.equal(platformLabel("macos"), "Mac");
});

test("run again copies every setting from the original job", () => {
  const input = rerunAssignInput({
    id: "job-1",
    taskId: "task-1",
    kind: "code",
    deviceId: "device-1",
    delivery: "push",
    repoUrl: "https://github.com/octocat/Hello-World.git",
    folderLabel: "Desk",
    instructions: "Keep the failing test.",
    provider: "anthropic",
    model: "custom-model",
    reasoningEffort: "high",
    branchMode: "existing",
    branch: "release",
    askBeforePublish: false,
    useCredentials: true,
    executionMode: "native",
    networkAccess: false,
    markDone: false,
    maxMinutes: 12,
    maxTurns: 7,
    maxToolCalls: 15,
  });
  assert.equal(input.instructions, "Keep the failing test.");
  assert.equal(input.model, "custom-model");
  assert.equal(input.provider, "anthropic");
  assert.equal(input.branch, "release");
  assert.equal(input.branchMode, "existing");
  assert.equal(input.useCredentials, true);
  assert.equal(input.askBeforePublish, false);
  assert.equal(input.markDone, false);
  assert.equal(input.maxMinutes, 12);
  assert.equal(input.maxTurns, 7);
  assert.equal(input.maxToolCalls, 15);
  assert.equal(input.reasoningEffort, "high");
  assert.equal(input.sandbox, false);
  assert.equal(input.network, false);
  assert.equal(input.continueFromJobId, "job-1");
  assert.equal(input.folderLabel, "Desk");
});

test("only a real GitHub pull request is labelled as one", () => {
  assert.equal(pullRequestNumber("https://github.com/octocat/Hello-World/pull/12"), "12");
  assert.equal(pullRequestNumber("https://github.com/octocat/Hello-World/pull/12/files"), "12");
  assert.equal(pullRequestNumber("https://github.com/octocat/Hello-World/pull/12?w=1"), "12");
  assert.equal(pullRequestNumber("javascript:alert(1)"), null);
  assert.equal(pullRequestNumber("https://evil.example/pull/12"), null);
  assert.equal(pullRequestNumber("https://github.com.evil.example/octocat/Hello-World/pull/12"), null);
  assert.equal(pullRequestNumber("https://evil.example/github.com/octocat/Hello-World/pull/12"), null);
  assert.equal(pullRequestNumber("http://github.com/octocat/Hello-World/pull/12"), null);
});

test("a run-branch push is approved on the computer, with no Yes", () => {
  const push = deviceDecisionView({ tier: "run_branch_push", event: "permission", deviceName: "Build box", options: ["Yes"] });
  assert.equal(push.kind, "approve-on-computer");
  if (push.kind === "approve-on-computer") assert.equal(push.message, "Approve this on Build box.");
  const unnamed = deviceDecisionView({ tier: "run_branch_push", deviceName: "  " });
  if (unnamed.kind === "approve-on-computer") assert.equal(unnamed.message, "Approve this on your computer.");
});

test("a device question sends the chosen option, and a plain Yes is only for no options", () => {
  const choices = deviceDecisionView({ event: "question", options: ["Ship the notes", "Leave it"], deviceName: "Build box" });
  assert.deepEqual(choices, { scope: "once", kind: "choices", options: ["Ship the notes", "Leave it"] });
  assert.equal(deviceDecisionView({ event: "question", options: [], deviceName: "Build box" }).kind, "yes-no");
  assert.equal(deviceDecisionView({ event: "permission", deviceName: "Build box" }).kind, "yes-no");
  assert.equal(deviceDecisionView({ event: "permission", deviceName: "Build box" }).scope, "once");
  const risk = deviceDecisionView({ tier: "high_risk", event: "permission", deviceName: "Build box" });
  assert.equal(risk.kind, "confirm");
  if (risk.kind === "confirm") assert.equal(risk.message, "Confirm this on Build box. A Yes here does not let the task continue.");
});

test("pairing, clone path, and a removed computer", () => {
  assert.equal(pairingCodeConsumed(["a"], ["a"]), false);
  assert.equal(pairingCodeConsumed(["a"], ["a", "b"]), true);
  assert.equal(pairingCodeConsumed([], ["b"]), true);
  const hint = freshCloneHint("Studio PC", "/tmp/ensemble-workspace");
  assert.match(hint, /on Studio PC/);
  assert.doesNotMatch(hint, /ensemble-workspace/);
  assert.match(freshCloneHint(null, "/tmp/ensemble-workspace"), /\/tmp\/ensemble-workspace\/runs/);
  assert.equal(interruptedLabel("Studio PC", true), "Interrupted · Studio PC removed");
  assert.equal(interruptedLabel("Studio PC", false), "Interrupted · Studio PC went offline");
});
