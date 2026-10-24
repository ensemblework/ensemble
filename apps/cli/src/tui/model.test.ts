import assert from "node:assert/strict";
import test from "node:test";
import { quickRunProfile } from "@ensemble/shared-types";
import type { Decision, JobCard, Workspace } from "./local.js";
import { agentChoiceLabel, buildItems, chatTurnRequest, commandAnswer, copilotNote, copilotOf, copilotProblem, decisionActions, installedAgent, matchCommands, modelEfforts, modelNote, parseCommand, profileSummary, runRequest, titleFrom } from "./model.js";
import { copilotAgent } from "./testing.js";

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

test("/run with a profile that ends in a pull request runs in a clone of this folder and sends the plan; a chat message never does", () => {
  const profile = { ...quickRunProfile(), engine: "claude-code" as const, branchMode: "new" as const, delivery: "push" as const, pullRequest: { base: "testing", merge: "auto" as const } };
  const run = runRequest({ taskId: "t", folder: "/work/app", instructions: "fix it", profile, engine: null });
  assert.deepEqual(run.pullRequest, { base: "testing", merge: "auto" });
  assert.equal(run.repoUrl, "/work/app", "its own clone of this folder");
  assert.equal(run.folder, undefined, "never the folder in place");
  assert.equal(run.delivery, "commit", "Ensemble pushes, not the run");
  assert.equal(run.branchMode, "as-is", "Ensemble makes the branch from the base");
  assert.match(profileSummary(profile), /pull request into testing, merged when its checks pass/);

  const chat = chatTurnRequest({ taskId: "t", folder: "/work/app", message: "fix it", profile, engine: "claude-code", model: null, previousJobId: null });
  assert.equal(chat.pullRequest, undefined);
  assert.equal(chat.repoUrl, undefined);
  assert.equal(chat.folder, "/work/app");
  assert.equal(chat.delivery, "push", "the profile's own git setting");

  const plain = runRequest({ taskId: "t", folder: "/work/app", instructions: "fix it", profile: { ...profile, pullRequest: null }, engine: null });
  assert.deepEqual([plain.pullRequest, plain.repoUrl, plain.folder, plain.delivery, plain.branchMode], [undefined, undefined, "/work/app", "push", "new"]);
});

test("a chat message runs the agent in this folder under the profile; later ones continue the first, on the same branch", () => {
  const profile = { ...quickRunProfile(), instructions: "Run the tests first.", branchMode: "new" as const, delivery: "push" as const };
  const first = chatTurnRequest({ taskId: "t", folder: "/work/app", message: "fix it", profile, engine: "codex", model: null, previousJobId: null });
  assert.equal(first.chat, true);
  assert.equal(first.engine, "codex");
  assert.equal(first.folder, "/work/app");
  assert.equal(first.branchMode, "as-is", "a chat does not start a branch per message");
  assert.equal(first.delivery, "push", "the profile's git setting still holds");
  assert.equal(first.markDone, false);
  assert.equal(first.instructions, "Run the tests first.\n\nfix it");
  assert.equal(first.model, undefined);
  const next = chatTurnRequest({ taskId: "t", folder: "/work/app", message: "and commit", profile, engine: "codex", model: "gpt-5.5", previousJobId: "j1" });
  assert.equal(next.continueFromJobId, "j1");
  assert.equal(next.instructions, "and commit", "the profile's instructions go with the first message only");
  assert.equal(next.model, "gpt-5.5");
});

test("with no model key, the agent to chat with is the first one installed (the ChatGPT app's Codex counts)", () => {
  const row = (id: string, cli: string | null, app = false) => ({ id, app, cli });
  assert.equal(installedAgent([row("claude", "/u/.local/bin/claude"), row("codex", null, true)]), "claude-code");
  assert.equal(installedAgent([row("claude", null, true), row("codex", null, true)]), "codex", "the Claude app alone does not run Claude Code");
  assert.equal(installedAgent([row("cursor", "/u/.local/bin/cursor-agent")]), "cursor-agent");
  assert.equal(installedAgent([row("copilot", "/opt/homebrew/bin/copilot")]), "copilot-cli");
  assert.equal(installedAgent([row("copilot", null)]), null);
});

test("GitHub Copilot: Chat and /run send the /model choice (model, thinking level, context window); its default sends none", () => {
  const profile = quickRunProfile();
  const chosen = chatTurnRequest({ taskId: "t", folder: "/work", message: "go on", profile, engine: "copilot-cli", model: "gpt-5.6-luna", effort: "high", context: "long_context", previousJobId: "j1" });
  assert.deepEqual(
    { engine: chosen.engine, model: chosen.model, reasoningEffort: chosen.reasoningEffort, contextTier: chosen.contextTier, chat: chosen.chat, continueFromJobId: chosen.continueFromJobId },
    { engine: "copilot-cli", model: "gpt-5.6-luna", reasoningEffort: "high", contextTier: "long_context", chat: true, continueFromJobId: "j1" },
  );
  const standard = chatTurnRequest({ taskId: "t", folder: "/work", message: "hi", profile, engine: "copilot-cli", model: "gpt-5.6-luna", effort: null, context: null, previousJobId: null });
  assert.equal(standard.reasoningEffort, undefined);
  assert.equal(standard.contextTier, undefined);
  const plain = chatTurnRequest({ taskId: "t", folder: "/work", message: "hi", profile, engine: "copilot-cli", model: null, previousJobId: null });
  assert.deepEqual([plain.model, plain.reasoningEffort, plain.contextTier], [undefined, undefined, undefined], "Copilot's own default model");

  // A Copilot run profile brings its model, thinking level and context window; a /model choice replaces all three.
  const copilotProfile = { ...quickRunProfile(), engine: "copilot-cli" as const, model: "claude-opus-4.7", effort: "xhigh" as const, context: "long_context" as const };
  const fromProfile = runRequest({ taskId: "t", folder: "/work", instructions: "fix it", profile: copilotProfile, engine: null });
  assert.deepEqual([fromProfile.engine, fromProfile.model, fromProfile.reasoningEffort, fromProfile.contextTier], ["copilot-cli", "claude-opus-4.7", "xhigh", "long_context"]);
  const picked = runRequest({ taskId: "t", folder: "/work", instructions: "fix it", profile: copilotProfile, engine: "copilot-cli", agent: { model: "gpt-5.6-luna", effort: "low" } });
  assert.deepEqual([picked.model, picked.reasoningEffort, picked.contextTier], ["gpt-5.6-luna", "low", undefined]);
  // Other engines' runs are as they were: no thinking level or context window from the profile.
  const claude = runRequest({ taskId: "t", folder: "/work", instructions: "fix it", profile: { ...copilotProfile, engine: "claude-code", model: "opus" }, engine: null });
  assert.deepEqual([claude.model, claude.reasoningEffort, claude.contextTier], ["opus", undefined, undefined]);
});

test("Copilot's sign-in gives its /agent note and whether a message can go to it", () => {
  assert.equal(copilotNote(copilotOf([copilotAgent()]), true), "your Copilot sign-in (mira-chen)");
  assert.equal(copilotNote(copilotOf([copilotAgent({ signedIn: false })]), true), "not signed in · run copilot login");
  assert.equal(copilotNote(copilotOf([]), true), "not found · npm install -g @github/copilot");
  assert.equal(copilotNote(undefined, true), "your Copilot sign-in", "before the check answers, the copilot command counts");
  assert.equal(copilotProblem(copilotOf([copilotAgent()])), null);
  assert.match(copilotProblem(copilotOf([copilotAgent({ signedIn: false })]))!, /run copilot login/);
  assert.match(copilotProblem(copilotOf([]))!, /npm install -g @github\/copilot/);
  assert.equal(copilotProblem(copilotOf(null)), null, "no answer: the run says what is wrong");
});

test("Copilot's models: cost and context sizes as a note, each model's thinking levels, and the choice as a label", () => {
  const copilot = copilotAgent();
  const [auto, luna] = copilot.models;
  assert.equal(modelNote(luna!), "low cost · 200K / 922K context");
  assert.equal(modelNote(auto!), "");
  assert.deepEqual(modelEfforts(luna!, copilot), ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(modelEfforts(auto!, copilotAgent({ efforts: ["low", "high"] })), ["low", "high"], "an older Copilot's levels are for every model");
  assert.equal(agentChoiceLabel({ model: "gpt-5.6-luna", effort: "high", context: "long_context" }, copilot.models), "GPT-5.6 Luna · high thinking · long context");
  assert.equal(agentChoiceLabel({ model: null }, copilot.models), "Auto (Copilot picks)");
  assert.equal(agentChoiceLabel({ model: null }), "default model");
});
