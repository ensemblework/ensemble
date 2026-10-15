import assert from "node:assert/strict";
import test from "node:test";
import { SHORTCUTS, formatBinding, shortcutProblems } from "@ensemble/shared-types";

test("the help sheet can label every binding", () => {
  assert.deepEqual(shortcutProblems(SHORTCUTS), []);
  for (const binding of SHORTCUTS) {
    assert.ok(formatBinding(binding, true).length > 0 || formatBinding(binding, false).length > 0);
  }
  const capture = SHORTCUTS.find((binding) => binding.id === "capture");
  assert.equal(formatBinding(capture!, true), "⌘⌃⇧U");
  assert.equal(formatBinding(capture!, false), "Ctrl+Alt+Shift+U");
});

test("G then a letter runs its sequence, and a stray or repeated letter starts over", async () => {
  const { sequenceStep } = await import("./shortcut-sequence.js");
  const key = (value: string, extra: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key: value, metaKey: false, ctrlKey: false, altKey: false, ...extra });
  let step = sequenceStep("", key("g"), false, SHORTCUTS);
  assert.deepEqual(step, { buffer: "g", hit: null });
  step = sequenceStep(step.buffer, key("Shift"), false, SHORTCUTS);
  assert.deepEqual(step, { buffer: "g", hit: null });
  assert.deepEqual(sequenceStep(step.buffer, key("B"), false, SHORTCUTS), { buffer: "", hit: "go-board" });
  assert.deepEqual(sequenceStep("g", key("g"), false, SHORTCUTS), { buffer: "g", hit: null });
  assert.deepEqual(sequenceStep("g", key("x"), false, SHORTCUTS), { buffer: "", hit: null });
  assert.deepEqual(sequenceStep("", key("c"), false, SHORTCUTS), { buffer: "", hit: "capture-key" });
  assert.deepEqual(sequenceStep("g", key("t"), true, SHORTCUTS), { buffer: "", hit: null }, "typing in a field cancels the sequence");
  assert.deepEqual(sequenceStep("g", key("t", { ctrlKey: true }), false, SHORTCUTS), { buffer: "g", hit: null });
});

test("the help sheet hides off modules and other surfaces, and lists each action once", async () => {
  const { shortcutHelp } = await import("./shortcut-help.js");
  const rows = (groups: Array<{ title: string; rows: Array<{ label: string; keys: string[] }> }>) => groups.flatMap((group) => group.rows.map((row) => `${group.title}: ${row.label}`));
  const plain = shortcutHelp(SHORTCUTS, { apple: false, modules: "", pathname: "/board" });
  const labels = rows(plain);
  assert.ok(labels.includes("Go to: Go to Board"));
  assert.ok(!labels.some((label) => label.includes("Plots") || label.includes("Block Diagrams") || label.startsWith("Code:")));
  assert.ok(!labels.some((label) => label.startsWith("On Today") || label.startsWith("In a diagram") || label.startsWith("On a page")));
  assert.equal(labels.filter((label) => label.endsWith("Quick capture")).length, 1);
  const capture = plain.flatMap((group) => group.rows).find((row) => row.label === "Quick capture");
  assert.deepEqual(capture?.keys, ["Ctrl+Alt+Shift+U", "C"]);
  assert.deepEqual(plain.map((group) => group.title), ["Everywhere", "Create", "Go to"]);

  const diagrams = shortcutHelp(SHORTCUTS, { apple: true, modules: "diagrams,plots", pathname: "/diagrams/abc" });
  assert.equal(diagrams[0]?.title, "In a diagram", "the surface you are on comes first");
  const remove = diagrams[0]?.rows.find((row) => row.label === "Delete the selection");
  assert.deepEqual(remove?.keys, ["Delete", "Backspace"]);
  assert.ok(diagrams[0]?.rows.some((row) => row.keys.includes("Esc")));
  assert.ok(rows(diagrams).includes("Go to: Go to Plots"));
  assert.ok(rows(shortcutHelp(SHORTCUTS, { apple: true, modules: "", pathname: "/today" })).includes("On Today: Drop"));
});
