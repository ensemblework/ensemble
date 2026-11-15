/**
 * The OS sandbox is in beta and off by default (docs/24 §1): settings and run profiles with nothing
 * saved run without it, the built-in Quick profile follows Sandbox by default, and a choice made
 * (the beta turned on) is kept.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, pickRunProfile, quickRunProfile, RunProfile, Settings } from "./assistant.js";

test("empty settings leave the sandbox off: Sandbox by default and every new run profile", () => {
  assert.equal(Settings.parse({}).orchestration.defaultExecution, "native");
  assert.equal(DEFAULT_SETTINGS.orchestration.defaultExecution, "native");
  assert.equal(Settings.parse({ orchestration: {} }).orchestration.defaultExecution, "native");
  assert.equal(RunProfile.parse({ id: "a", name: "A" }).sandbox, false);
  assert.equal(Settings.parse({ runProfiles: [{ id: "a", name: "A" }] }).runProfiles[0]!.sandbox, false);
});

test("Quick follows Sandbox by default, and is off when nothing says", () => {
  assert.equal(quickRunProfile().sandbox, false);
  assert.equal(quickRunProfile(null).sandbox, false);
  assert.equal(quickRunProfile({}).sandbox, false);
  assert.equal(quickRunProfile({ defaultExecution: "native" }).sandbox, false);
  assert.equal(quickRunProfile({ defaultExecution: "sandbox" }).sandbox, true);
  assert.equal(pickRunProfile(Settings.parse({})).sandbox, false);
  assert.equal(pickRunProfile(Settings.parse({ orchestration: { defaultExecution: "sandbox" } })).sandbox, true);
});

test("a saved choice is kept: the beta turned on stays on", () => {
  const settings = Settings.parse({ orchestration: { defaultExecution: "sandbox" }, runProfiles: [{ id: "a", name: "A", sandbox: true }] });
  assert.equal(settings.orchestration.defaultExecution, "sandbox");
  assert.equal(settings.runProfiles[0]!.sandbox, true);
  assert.equal(pickRunProfile(settings).sandbox, true);
});
