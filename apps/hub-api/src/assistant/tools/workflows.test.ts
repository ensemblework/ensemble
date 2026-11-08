import "../../runtime/test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkflowRefs } from "./workflows.js";

test("a step's result is found when the reference guesses a wrapper or leaves one out", () => {
  const results = new Map<string, unknown>([
    ["create_page", { id: "p1", title: "Notes" }],
    ["person", { person: { id: "u1", name: "Priya" } }],
    ["tasks", { tasks: [{ id: "t1" }] }],
  ]);
  assert.equal(resolveWorkflowRefs({ $ref: "create_page.id" }, results), "p1");
  assert.equal(resolveWorkflowRefs({ $ref: "create_page.page.id" }, results), "p1");
  assert.equal(resolveWorkflowRefs({ $ref: "person.person.id" }, results), "u1");
  assert.equal(resolveWorkflowRefs({ $ref: "person.id" }, results), "u1");
  assert.equal(resolveWorkflowRefs({ $ref: "tasks.tasks.0.id" }, results), "t1");
  assert.throws(() => resolveWorkflowRefs({ $ref: "create_page.slug" }, results), /create_page returned: id, title/);
  assert.throws(() => resolveWorkflowRefs({ $ref: "create_page.__proto__.x" }, results), /No result/);
});
