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
