import assert from "node:assert/strict";
import test from "node:test";
import { mentionItems } from "./mention-items";

const rows = () => [
  { kind: "plot", id: "space-a", label: "Training", detail: "Plot space · 1 tile", isSpace: true },
  { kind: "plot", id: "space-b", label: "Training", detail: "Plot space · 1 tile", isSpace: true },
  { kind: "plot", id: "space-a/accuracy", label: "Accuracy", detail: "", parentId: "space-a" },
  { kind: "plot", id: "space-b/loss", label: "Loss", detail: "", parentId: "space-b" },
  { kind: "plot", id: "saved-id", label: "Untitled plot", detail: "", parentId: "saved" },
  { kind: "dataset", id: "data-id", label: "epochs.csv", detail: "CSV", parentId: "data" },
];
const on = () => true;
test("@ offers Ask Ensemble and one Plots category, not every plot or blank plot creation", () => {
  const items = mentionItems("", rows, on, on);
  assert.equal(items[0]?.label, "Ask Ensemble");
  assert.equal(items.filter((item) => "kind" in item && item.kind === "plot").length, 1);
  assert.equal(items.some((item) => item.type === "create" && item.kind === "plot"), false);
  assert.equal(mentionItems("ensemble", rows, on, on)[0]?.label, "Ask Ensemble");
});
test("plot spaces drill down by stable id even when their names match", () => {
  const items = mentionItems("plots:", rows, on, on);
  const spaces = items.filter((item) => item.type === "group" && item.label === "Training");
  assert.equal(spaces.length, 2);
  assert.deepEqual(spaces.map((item) => item.type === "group" ? item.prefix : null), ["plots:space-a:", "plots:space-b:"]);
  assert.deepEqual(mentionItems("plots:space-a:", rows, on, on).map((item) => item.label), ["Accuracy"]);
  assert.deepEqual(mentionItems("plots:space-b:lo", rows, on, on).map((item) => item.label), ["Loss"]);
});
test("both plot aliases find uploaded files and saved charts are nested", () => {
  for (const prefix of ["plot", "plots"]) {
    const items = mentionItems(`${prefix}:epochs`, rows, on, on);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.type === "entity" && items[0].kind, "dataset");
    assert.equal("id" in items[0]! && items[0].id, "data-id");
  }
  assert.deepEqual(mentionItems("plots:saved:", rows, on, on).map((item) => item.label), ["Untitled plot"]);
  assert.equal(mentionItems("plots:unknown:", rows, on, on).length, 0);
});
test("disabled modules cannot be reached through a scoped prefix", () => {
  assert.deepEqual(mentionItems("plots:", rows, on, () => false), []);
  assert.deepEqual(mentionItems("dataset:", rows, on, () => false), []);
});
