import assert from "node:assert/strict";
import test from "node:test";
import { compareSave, mergeSaveObject, resolveSave, type SaveConflict } from "./save-merge.js";

test("full sections omit unchanged leaves and merge disjoint changes", () => {
  const base = { appearance: { theme: "system", font: "default" } };
  const current = { appearance: { theme: "dark", font: "default" } };
  const result = compareSave(base, current, { appearance: { theme: "system", font: "serif" } });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(mergeSaveObject(current, result.patch), { appearance: { theme: "dark", font: "serif" } });
});

test("arrays stay whole, idempotent saves do not conflict and choosing saved keeps unrelated edits", () => {
  const base = { roots: ["one"], time: "09:00" };
  const current = { roots: ["two"], time: "09:00" };
  assert.deepEqual(compareSave(base, current, { roots: ["two"] }).conflicts, []);
  const result = compareSave(base, current, { roots: ["three"], time: "10:00" });
  const conflict: SaveConflict = { code: "SAVE_CONFLICT", current, ...result };
  assert.deepEqual(resolveSave(conflict, "saved"), { roots: ["two"], time: "10:00" });
  assert.deepEqual(resolveSave(conflict, "yours"), { roots: ["three"], time: "10:00" });
  assert.deepEqual(result.patch, { roots: ["three"], time: "10:00" }, "resolution leaves the retained draft intact");
});

test("unsafe object keys are refused before merging", () => {
  assert.throws(() => compareSave({}, {}, JSON.parse('{"__proto__":{"changed":true}}')), /Invalid save field/);
  assert.throws(() => mergeSaveObject({}, JSON.parse('{"constructor":{"changed":true}}')), /Invalid save field/);
});
