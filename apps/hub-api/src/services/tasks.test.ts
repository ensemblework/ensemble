import assert from "node:assert/strict";
import test from "node:test";
import { CreateTask, PatchTask } from "@ensemble/shared-types";
import { labelPriority, taskChangePreview } from "./tasks.js";

test("task titles reject blank whitespace and normalize surrounding spaces on every write", () => {
  for (const title of ["", "   ", "\n\t\r"]) {
    assert.equal(CreateTask.safeParse({ title }).success, false);
    assert.equal(PatchTask.safeParse({ title }).success, false);
  }
  assert.equal(CreateTask.parse({ title: "  Ship notes  " }).title, "Ship notes");
  assert.equal(PatchTask.parse({ title: "  \u4f60\u597d \ud83d\ude80  " }).title, "\u4f60\u597d \ud83d\ude80");
});

test("priority labels match the board", () => {
  assert.equal(labelPriority("p0"), "High");
  assert.equal(labelPriority("p1"), "Normal");
  assert.equal(labelPriority("p2"), "Low");
});

test("update preview shows titles and before/after", () => {
  const text = taskChangePreview("Ship notes", { status: "todo", priority: "p1" }, { status: "done", priority: "p0" });
  assert.match(text, /Ship notes/);
  assert.match(text, /To do/);
  assert.match(text, /Done/);
  assert.match(text, /Normal/);
  assert.match(text, /High/);
});
