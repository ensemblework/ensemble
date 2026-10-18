import assert from "node:assert/strict";
import test from "node:test";
import { BUILDER_MODULES, OPTIONAL_MODULES, moduleFitsProfile } from "@ensemble/shared-types/modules";
import { defaultExtras, extrasForProfile } from "./desk-extras.js";

test("desk extras are offered only to the profiles they fit", () => {
  const offered = (profile: Parameters<typeof extrasForProfile>[0]) => extrasForProfile(profile).map((extra) => extra.id);
  assert.deepEqual(offered("engineer"), [], "no exam deadlines, learning tab or bench for an engineer");
  assert.deepEqual(offered("vibe"), []);
  assert.deepEqual(offered("lawyer"), []);
  assert.deepEqual(offered("manager"), []);
  assert.deepEqual(offered("student"), ["deadlines", "learning"]);
  assert.deepEqual(offered("teacher"), ["deadlines", "learning"]);
  assert.deepEqual(offered(null), []);
  assert.deepEqual(defaultExtras("bench"), [], "a Builder's desk does not start with a hardware bench");
  assert.deepEqual(defaultExtras("exam"), ["deadlines"]);
});

test("only profiles that build software are offered Code, Workspace, Runs and Skills", () => {
  for (const profile of ["engineer", "vibe", null]) assert.ok(OPTIONAL_MODULES.every((module) => moduleFitsProfile(module, profile)), String(profile));
  for (const profile of ["lawyer", "teacher", "student", "manager"]) {
    assert.deepEqual(OPTIONAL_MODULES.filter((module) => !moduleFitsProfile(module, profile)), [...BUILDER_MODULES], profile);
    assert.ok(moduleFitsProfile("metrics", profile), "Metrics, where credits are counted, stays for everyone");
  }
});
