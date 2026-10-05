import assert from "node:assert/strict";
import test from "node:test";
import { reflectProposals, replyAfterApply } from "./reply.js";

test("a reply does not claim tasks were added when the batch rejected them", () => {
  const text = reflectProposals("I added the tasks to Launch.", [
    { name: "hub_create_project", state: "awaiting_approval", summary: "Create project “Launch”", isWrite: true },
    { name: "hub_create_tasks", state: "failed", error: "No project named “Launch”.", isWrite: true },
  ]);
  assert.equal(text.includes("I added"), false);
  assert.match(text, /Proposed, not applied yet: Create project “Launch”/);
  assert.match(text, /Not added: No project named “Launch”/);
});

test("a truthful proposal keeps the model text and adds the missing fact", () => {
  const text = reflectProposals("I can set that up once you apply.", [
    { name: "hub_create_tasks", state: "awaiting_approval", summary: "Add 2 task(s)", isWrite: true },
  ]);
  assert.match(text, /I can set that up once you apply/);
  assert.match(text, /Proposed, not applied yet: Add 2 task\(s\)/);
});

test("apply removes the stale prompt when every write landed", () => {
  const text = replyAfterApply("Create project “Launch”.\n\nNothing has changed yet — press Apply.", [
    { name: "hub_create_project", state: "ok", summary: "Created “Launch”.", isWrite: true },
  ]);
  assert.equal(text.includes("Nothing has changed yet"), false);
  assert.match(text, /Applied\. Created “Launch”\./);
});

test("a partial apply names what landed and what is still waiting", () => {
  const text = replyAfterApply("Two changes.\n\nNothing has changed yet — press Apply.", [
    { name: "hub_create_project", state: "ok", summary: "Created “Launch”.", isWrite: true },
    { name: "hub_create_tasks", state: "awaiting_approval", summary: "Add 1 task(s)", isWrite: true },
  ]);
  assert.equal(text.includes("Nothing has changed yet"), false);
  assert.match(text, /Applied: Created “Launch”\./);
  assert.match(text, /Still waiting — press Apply for Add 1 task\(s\)\./);
});

test("apply drops the proposed lines so the saved reply does not contradict itself", () => {
  const before = reflectProposals("I added the project and its tasks.", [
    { name: "hub_create_project", state: "awaiting_approval", summary: "Create project “Website relaunch”", isWrite: true },
    { name: "hub_create_tasks", state: "awaiting_approval", summary: "Add 2 task(s)", isWrite: true },
  ]);
  assert.match(before, /Proposed, not applied yet/);
  const text = replyAfterApply(`${before}\n\nNothing has changed yet — press Apply.`, [
    { name: "hub_create_project", state: "ok", summary: "Created “Website relaunch”.", isWrite: true },
    { name: "hub_create_tasks", state: "ok", summary: "Added 2 task(s): Draft copy, Ship it.", isWrite: true },
  ]);
  assert.equal(text.includes("Proposed, not applied yet"), false);
  assert.equal(text, "Applied. Created “Website relaunch”; Added 2 task(s): Draft copy, Ship it.");
});

test("a partial apply does not double the sentence punctuation", () => {
  const text = replyAfterApply("Proposed, not applied yet: Create project “Launch”\nProposed, not applied yet: Add 1 task(s)", [
    { name: "hub_create_project", state: "ok", summary: "Created “Launch”.", isWrite: true },
    { name: "hub_create_tasks", state: "awaiting_approval", summary: "Add 1 task(s).", isWrite: true },
  ]);
  assert.equal(text, "Applied: Created “Launch”. Still waiting — press Apply for Add 1 task(s).");
  assert.equal(replyAfterApply(text, [
    { name: "hub_create_project", state: "ok", summary: "Created “Launch”.", isWrite: true },
    { name: "hub_create_tasks", state: "ok", summary: "Added 1 task(s).", isWrite: true },
  ]), "Applied. Created “Launch”; Added 1 task(s).");
});

test("nothing applied leaves the reply as it was", () => {
  const content = "Two changes.\n\nNothing has changed yet — press Apply.";
  assert.equal(replyAfterApply(content, [
    { name: "hub_create_tasks", state: "failed", error: "No project.", isWrite: true },
  ]), content);
});
