import assert from "node:assert/strict";
import test from "node:test";
import { labelPriority, taskChangePreview } from "./tasks.js";

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
