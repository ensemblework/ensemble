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
