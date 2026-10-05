import assert from "node:assert/strict";
import test from "node:test";
import { Settings, personaBlock, quickActions } from "@ensemble/shared-types";
import { citeAnswer } from "./citations.js";
import { describeGraph, fitBudget, personNodeId } from "./graph-facts.js";
import { shortestPath } from "./graph-path.js";
import { hiddenRequested } from "./surfaces.js";
import { parseWatcher, watcherDue } from "./watchers.js";

const scopes = [
  { kind: "deliverable" as const, id: "11111111-1111-4111-8111-111111111111", title: "Brief" },
  { kind: "task" as const, id: "22222222-2222-4222-8222-222222222222", title: "File it" },
];

test("Settings.parse fills actAs when the assistant block is omitted or partial", () => {
  assert.equal(Settings.parse({}).assistant.actAs, "general");
  assert.equal(Settings.parse({ assistant: { writePolicy: "preview" } }).assistant.actAs, "general");
  assert.equal(Settings.parse({ assistant: { actAs: "lawyer" } }).assistant.actAs, "lawyer");
});

test("presets change the prompt and the suggestions, and say they do not change permissions", () => {
  for (const actAs of ["general", "student", "engineer", "teacher", "lawyer"] as const) {
    const block = personaBlock(actAs);
    assert.match(block, new RegExp(`Act as: ${actAs}`));
    assert.match(block, /does not change permissions/);
    assert.ok(quickActions(actAs, "board").length > 0);
  }
  assert.match(personaBlock("student"), /Quiz from the notes/);
  assert.match(personaBlock("engineer"), /who knows this code/i);
  assert.match(personaBlock("teacher"), /falling behind/);
  assert.match(personaBlock("lawyer"), /obligations/);
  assert.ok(quickActions("student", "page").some((line) => /quiz/i.test(line)));
  assert.ok(quickActions("engineer", "graph").some((line) => /who knows this code/i.test(line)));
  assert.ok(quickActions("lawyer", "code").some((line) => /clause/i.test(line)));
});

test("parseWatcher maps the two example phrases and ignores everything else", () => {
  const done = parseWatcher("@ensemble tell me when all tasks under this deliverable are done", scopes);
  assert.equal(done?.condition, "all_tasks_done");
  assert.equal(done?.scopeId, scopes[0]?.id);
  const remind = parseWatcher("remind the owner 2 days before due", scopes);
  assert.equal(remind?.condition, "days_before_due");
  assert.equal(remind?.daysBefore, 2);
  assert.equal(remind?.scopeKind, "deliverable");
  assert.equal(parseWatcher("remind the owner 2 days before due", [scopes[1]!])?.scopeKind, "task");
  assert.equal(parseWatcher("what is missing before the due date?", scopes), null);
  assert.equal(parseWatcher("tell me when all tasks under this deliverable are done", []), null);
});

test("watcherDue is true only inside the window", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  assert.equal(watcherDue(new Date("2026-10-01T12:00:00Z"), 2, now), true);
  assert.equal(watcherDue(new Date("2026-10-10T12:00:00Z"), 2, now), false);
  assert.equal(watcherDue(new Date("2026-09-28T12:00:00Z"), 2, now), true);
  assert.equal(watcherDue(new Date("2026-09-27T11:00:00Z"), 2, now), false);
  assert.equal(watcherDue(null, 2, now), false);
});

test("shortest path uses real edges and refuses an id outside the graph", () => {
  const nodes = new Set(["a", "b", "c"]);
  const edges = [
    { source: "a", target: "b", kind: "member" },
    { source: "b", target: "c", kind: "repo" },
  ];
  assert.deepEqual(shortestPath(nodes, edges, "a", "c"), ["a", "b", "c"]);
  assert.equal(shortestPath(nodes, edges, "a", "missing"), null);
  assert.deepEqual(shortestPath(nodes, edges, "a", "a"), ["a"]);
});

test("hiddenRequested drops ids the read did not return", () => {
  assert.deepEqual(hiddenRequested(["owned", "foreign"], ["owned"]), ["foreign"]);
  assert.deepEqual(hiddenRequested(undefined, ["owned"]), []);
});

test("citeAnswer strips invented ids and keeps web URLs", () => {
  const real = "11111111-1111-4111-8111-111111111111";
  const fake = "22222222-2222-4222-8222-222222222222";
  const result = citeAnswer(`See ${fake} and ${real} and https://example.com/case.`, [
    { id: real, kind: "task", label: "File it" },
  ]);
  assert.equal(result.text.includes(fake), false);
  assert.equal(result.text.includes(real), true);
  assert.equal(result.text.includes("Sources:"), false);
  assert.ok(result.citations.some((row) => row.url === "https://example.com/case"));
  assert.ok(result.citations.some((row) => row.id === real && row.href === `/tasks/${real}`));
  assert.equal(result.citations.some((row) => row.id === "33333333-3333-4333-8333-333333333333"), false);
});

test("citeAnswer does not pad unused entities", () => {
  const used = "11111111-1111-4111-8111-111111111111";
  const unused = "33333333-3333-4333-8333-333333333333";
  const result = citeAnswer(`Only ${used}.`, [
    { id: used, kind: "task", label: "Used" },
    { id: unused, kind: "repo", label: "httpx" },
  ]);
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0]?.id, used);
  assert.equal(result.text.includes(unused), false);
});

test("graph facts keep a repo's tasks and match people by id", () => {
  const priya = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const httpx = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const task = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const filler = Array.from({ length: 20 }, (_, index) => ({
    id: `eeeeeeee-eeee-4eee-8eee-${String(index).padStart(12, "0")}`,
    kind: "note",
    label: `Note ${index}`,
  }));
  const nodes = [
    { id: priya, kind: "people", label: "Priya" },
    { id: project, kind: "project", label: "Ensemble Hub" },
    { id: httpx, kind: "repo", label: "encode/httpx" },
    { id: task, kind: "task", label: "Reply to Priya" },
    ...filler,
  ];
  const edges = [
    { source: priya, target: project, kind: "member" },
    { source: project, target: httpx, kind: "repo" },
    { source: httpx, target: task, kind: "repo" },
  ];
  const described = describeGraph(nodes, edges, []);
  assert.match(described.text, /encode\/httpx/);
  assert.match(described.text, /Reply to Priya/);
  assert.equal(personNodeId(priya, new Set([priya]), new Map([["priya", "other"]])), priya);
  assert.equal(personNodeId("Priya", new Set([priya]), new Map([["priya", priya]])), priya);
});

test("graph budget keeps the path when sixty nodes would overflow", () => {
  const nodes = Array.from({ length: 60 }, (_, index) => ({
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    kind: "note",
    label: `Node ${index} ${"x".repeat(80)}`,
  }));
  const start = nodes[0]!;
  const end = nodes[59]!;
  const edges = nodes.slice(0, -1).map((node, index) => ({ source: node.id, target: nodes[index + 1]!.id, kind: "link" }));
  const pathLine = `Shortest path: ${start.label} (${start.id}) → ${end.label} (${end.id}).`;
  const described = describeGraph(nodes, edges, [start.id, end.id]);
  const facts = fitBudget([pathLine, described.text], 7000);
  assert.ok(described.text.length > 7000);
  assert.ok(facts.length <= 7000);
  assert.ok(facts.startsWith("Shortest path:"));
  assert.ok(facts.includes(start.id));
  assert.ok(facts.includes(end.id));
});
