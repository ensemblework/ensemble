import assert from "node:assert/strict";
import test from "node:test";
import { quickRunProfile } from "@ensemble/shared-types";
import type { Decision, JobCard, Workspace } from "./local.js";
import { buildItems, commandAnswer, decisionActions, matchCommands, parseCommand, runRequest, titleFrom } from "./model.js";

const job = (id: string, status: string): JobCard => ({ id, taskId: `t${id}`, title: id, status, kind: "code", folder: "/w", position: null, delivery: "commit", unattended: false, accessMode: "read-write", executionMode: "sandbox" });
const decision = (id: string, extra: Partial<Decision> = {}): Decision => ({ id, source: "ensemble", event: "permission", toolName: "Bash", title: id, detail: {}, cwd: null, status: "pending", requestedAt: "", ...extra });

test("runs are grouped, and a run with a question sits under Needs you with it", () => {
  const workspace: Workspace = { root: "/w", paused: false, maxConcurrent: 2, queued: [job("q", "queued")], running: [job("r", "running"), job("asks", "running")], waiting: [], stopped: [job("x", "failed")], completed: [job("d", "succeeded")] };
  const items = buildItems(workspace, [decision("d1", { detail: { jobId: "asks" } }), decision("editor", { source: "claude" })]);
  assert.deepEqual(items.map((item) => `${item.group}:${item.job?.id ?? item.decision?.id}`), ["needs:asks", "needs:editor", "running:r", "queued:q", "stopped:x", "done:d"]);
  assert.equal(items[0]!.decision?.id, "d1");
});

test("a request's buttons: its own options, or allow once, for this task, always and deny (never always outside the folder)", () => {
  assert.deepEqual(decisionActions(decision("p")).map((action) => action.id), ["once", "session", "always", "deny"]);
  assert.deepEqual(decisionActions(decision("o", { toolName: "outside" })).map((action) => action.id), ["once", "session", "deny"]);
  const question = decisionActions(decision("q", { event: "question", detail: { options: ["A", "B"], recommended: "B" } }));
  assert.deepEqual(question.map((action) => action.label), ["A", "B", "Skip"]);
  assert.equal(question[1]!.recommended, true);
  assert.deepEqual(question[1]!.answer, { decision: "allow", reason: "B" });
});

test("/allow, /deny and /answer say what they mean for the selected request", () => {
  const permission = decision("p");
  assert.deepEqual(commandAnswer(permission, "allow", ""), { decision: "allow", scope: "once" });
  assert.deepEqual(commandAnswer(permission, "allow", "task"), { decision: "allow", scope: "session" });
  assert.deepEqual(commandAnswer(permission, "deny", "too risky"), { decision: "deny", reason: "too risky" });
  assert.match(String(commandAnswer(decision("o", { toolName: "outside" }), "allow", "always")), /never always/);
  const question = decision("q", { event: "question", detail: { options: ["Yes", "No"], recommended: "No" } });
  assert.deepEqual(commandAnswer(question, "allow", ""), { decision: "allow", reason: "No" });
  assert.deepEqual(commandAnswer(question, "answer", "Maybe later"), { decision: "allow", reason: "Maybe later" });
});

test("slash commands match by prefix, this tab's first, and aliases work", () => {
  assert.equal(matchCommands("/pro", "tasks")[0]!.name, "profile");
  assert.equal(matchCommands("/", "chat")[0]!.tab === "tasks", false);
  assert.deepEqual(parseCommand("/quit"), { name: "exit", args: "" });
  assert.deepEqual(parseCommand("/run fix it  now"), { name: "run", args: "fix it  now" });
  assert.equal(parseCommand("hello"), null);
});

test("/run asks for a code run in this folder under the run profile, with the chosen engine", () => {
  const profile = { ...quickRunProfile(), mode: "review" as const, delivery: "local" as const, instructions: "Keep it small." };
  const body = runRequest({ taskId: "t", folder: "/work", instructions: "fix the tests", profile, engine: "codex" });
  assert.equal(body.engine, "codex");
  assert.equal(body.mode, "review");
  assert.equal(body.delivery, "local");
  assert.equal(body.folder, "/work");
  assert.equal(body.instructions, "Keep it small.\n\nfix the tests");
  assert.equal(titleFrom("  fix the failing\nCI step "), "fix the failing");
});
