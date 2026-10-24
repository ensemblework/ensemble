import assert from "node:assert/strict";
import test from "node:test";
import { canAddProfile, defaultProfile, differs, profileChoices, profileFields, profileSummary, quickProfile, removeProfile, upsertProfile } from "./run-profiles";

const quick = quickProfile({ defaultExecution: "sandbox", sandboxNetwork: false });

test("Quick is the default until a profile is saved", () => {
  assert.equal(quick.network, false);
  assert.deepEqual(profileChoices([], quick), [quick]);
  assert.equal(defaultProfile(undefined, null, quick).id, "quick");
});

test("the marked default wins, else the first saved profile", () => {
  const careful = { ...quick, id: "a", name: "Careful", mode: "ask" as const };
  const away = { ...quick, id: "b", name: "Away", mode: "unattended" as const };
  assert.equal(defaultProfile([careful, away], "b", quick).name, "Away");
  assert.equal(defaultProfile([careful, away], "gone", quick).name, "Careful");
});

test("at most three profiles; updating one keeps its place", () => {
  let list = upsertProfile([], { ...quick, id: "a", name: "One" });
  list = upsertProfile(list, { ...quick, id: "b", name: "Two" });
  list = upsertProfile(list, { ...quick, id: "c", name: "Three" });
  assert.equal(canAddProfile(list), false);
  assert.throws(() => upsertProfile(list, { ...quick, id: "d", name: "Four" }), /at most 3/);
  list = upsertProfile(list, { ...quick, id: "b", name: "Renamed" });
  assert.deepEqual(list.map((row) => row.name), ["One", "Renamed", "Three"]);
  assert.deepEqual(removeProfile(list, "a").map((row) => row.id), ["b", "c"]);
});

test("a changed field marks the form as modified", () => {
  const fields = profileFields(quick);
  assert.equal(differs(quick, fields), false);
  assert.equal(differs(quick, { ...fields, mode: "review" }), true);
  assert.equal(differs(quick, { ...fields, maxMinutes: 30 }), true);
});

test("the summary names the mode and git permission", () => {
  assert.equal(profileSummary(quick), "Code · Ask · may commit (asks before each commit)");
  assert.equal(profileSummary({ ...quick, mode: "unattended", delivery: "push" }), "Code · Run unattended · may commit and push");
});

import { quickAssignInput } from "./quick-assign.js";

test("quick assignment preserves the default profile's permissions and exact provider", () => {
  const input = quickAssignInput("task-12345678", { ...quick, id: "careful", name: "Careful", branchMode: "new", deviceId: "studio", model: "anthropic::claude-sonnet-5-5", effort: "high", mode: "review", delivery: "local", askBeforePublish: true, useCredentials: false, network: false, sandbox: true, maxMinutes: 12 });
  assert.equal(input.provider, "anthropic");
  assert.equal(input.model, "claude-sonnet-5-5");
  assert.equal(input.deviceId, "studio");
  assert.equal(input.mode, "review");
  assert.equal(input.delivery, "local");
  assert.equal(input.network, false);
  assert.equal(input.sandbox, true);
  assert.equal(input.reasoningEffort, "high");
  assert.equal(input.maxMinutes, 12);
  assert.match(input.branch ?? "", /^ensemble\/task-/);
});

test("subscription engines keep their model string and omit API effort", () => {
  const input = quickAssignInput("task", { ...quick, engine: "claude-code", model: "sonnet", effort: "high" });
  assert.equal(input.engine, "claude-code");
  assert.equal(input.model, "sonnet");
  assert.equal(input.provider, undefined);
  assert.equal(input.reasoningEffort, undefined);
});

import type { SubscriptionAgent } from "@ensemble/shared-types";
import { computerRuns, engineAssign, engineModel, fitEngineChoice } from "./engine-models.js";

const copilot: SubscriptionAgent = {
  id: "copilot-cli",
  via: "cli",
  version: "1.0.40",
  signedIn: true,
  account: "mira-chen",
  checkedAt: "2026-10-20T09:00:00.000Z",
  models: [
    { id: "auto", label: "Auto" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", isDefault: true, efforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contexts: [{ id: "default", label: "200K (standard)", tokens: 200000 }, { id: "long_context", label: "922K (long context)", tokens: 922000 }], vision: true, cost: "low cost", description: "OpenAI" },
    { id: "claude-haiku-4.5", label: "Claude Haiku 4.5", contexts: [{ id: "default", label: "136K", tokens: 136000 }], cost: "0.33× premium requests", description: "Anthropic" },
  ],
};

test("GitHub Copilot offers each model's own thinking levels and context windows, and sends only those", () => {
  const luna = engineModel(copilot, "");
  assert.equal(luna.model?.id, "gpt-5.6-luna", "Copilot default is the model the agent marks default");
  assert.deepEqual(luna.efforts, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(luna.defaultEffort, "medium");
  assert.deepEqual(luna.contexts.map((row) => row.id), ["default", "long_context"]);
  const haiku = engineModel(copilot, "claude-haiku-4.5");
  assert.deepEqual([haiku.efforts, haiku.contexts], [[], []], "one fixed size and no thinking setting: nothing to choose");
  assert.deepEqual(fitEngineChoice(haiku, "high", "long_context"), { effort: "default", context: undefined }, "switching to Haiku drops what it lacks");
  assert.deepEqual(fitEngineChoice(luna, "xhigh", "long_context"), { effort: "xhigh", context: "long_context" });

  assert.deepEqual(engineAssign("copilot-cli", { model: "gpt-5.6-luna", effort: "xhigh", context: "long_context" }, engineModel(copilot, "gpt-5.6-luna")), { engine: "copilot-cli", model: "gpt-5.6-luna", reasoningEffort: "xhigh", contextTier: "long_context" });
  assert.deepEqual(engineAssign("copilot-cli", { model: "gpt-5.6-luna", effort: "default" }, luna), { engine: "copilot-cli", model: "gpt-5.6-luna", contextTier: "default" });
  assert.deepEqual(engineAssign("copilot-cli", { model: "claude-haiku-4.5", effort: "high", context: "long_context" }, haiku), { engine: "copilot-cli", model: "claude-haiku-4.5" });
  assert.deepEqual(engineAssign("codex", { model: "gpt-6-luna", effort: "high", context: "long_context" }), { engine: "codex", model: "gpt-6-luna" }, "other agents take a model name only");

  assert.equal(computerRuns("copilot-cli", { engines: ["claude-code", "codex", "cursor-agent", "copilot-cli"] }), true);
  assert.equal(computerRuns("copilot-cli", {}), false, "a runtime without the engines list predates Copilot");
  assert.equal(computerRuns("codex", {}), true);
});

test("a Copilot profile keeps its model, thinking level and context window", () => {
  const profile = { ...quick, id: "copilot", name: "Copilot", engine: "copilot-cli" as const, model: "gpt-5.6-luna", effort: "high" as const, context: "long_context" as const };
  const input = quickAssignInput("task", profile);
  assert.deepEqual([input.engine, input.model, input.reasoningEffort, input.contextTier, input.provider], ["copilot-cli", "gpt-5.6-luna", "high", "long_context", undefined]);
  assert.equal(profileSummary(profile), "GitHub Copilot · Code · Ask · may commit (asks before each commit)");
  const fields = profileFields(profile);
  assert.equal(differs(profile, { ...fields, context: undefined }), true);
  assert.equal(differs({ ...profile, context: "default" }, { ...fields, context: undefined }), false, "unset and Standard are the same window");
});
