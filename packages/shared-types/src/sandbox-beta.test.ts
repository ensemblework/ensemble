/**
 * The OS sandbox is in beta and off by default (docs/24 §1): settings and run profiles with nothing
 * saved run without it, the built-in Quick profile follows Sandbox by default, and a choice made
 * (the beta turned on) is kept.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, pickRunProfile, quickRunProfile, RunPlace, RunProfile, runPlaceProblem, Settings } from "./assistant.js";

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

test("older profiles keep their checkout; a folder place round-trips with its computer and cannot save a continuation", () => {
  assert.equal(RunProfile.parse({ id: "old", name: "Old" }).place, undefined);
  assert.equal(quickRunProfile().place, undefined);
  const place = { kind: "folder", label: "live-test", path: "~/workspace/live-test" };
  const profile = RunProfile.parse({ id: "folder", name: "Folder", deviceId: "studio", place });
  assert.deepEqual(pickRunProfile(Settings.parse({ runProfiles: [profile] })).place, place);
  assert.equal(RunPlace.safeParse({ kind: "continue", jobId: "earlier" }).success, false);
  assert.equal(RunPlace.safeParse({ kind: "folder", label: "/not-a-label" }).success, false);
  const computer = { name: "Studio", online: true, folders: ["live-test"] };
  assert.equal(runPlaceProblem(profile.place, "studio", computer), null);
  assert.match(runPlaceProblem(profile.place, "studio", { ...computer, online: false })!, /Studio is offline/);
  assert.match(runPlaceProblem(profile.place, "studio", null)!, /no longer paired/);
  assert.match(runPlaceProblem(profile.place, "studio", { ...computer, folders: [] })!, /no longer shares “live-test”/);
});
