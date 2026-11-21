import assert from "node:assert/strict";
import test from "node:test";
import { markdown, summaryTable, totals } from "./report.js";
import type { RunResult, Saved } from "./types.js";

const run = (task: string, over: Partial<RunResult> = {}): RunResult => ({
  task,
  suite: "core",
  category: "qa",
  repeat: 0,
  status: "done",
  score: 1,
  pass: true,
  verifiedPass: true,
  checks: [{ name: "a", pass: true, kind: "reply" }],
  falseClaims: [],
  metrics: { wallMs: 61_000, turns: 1, failedTurns: 0, modelCalls: 4, tokensIn: 12_000, tokensOut: 300, credits: 0.5, ensembleCalls: 1, ensembleTools: 2, agentTools: 3, approvals: 1, unanswered: 0, errors: 0 },
  tools: [],
  agentToolNames: [],
  models: [],
  cards: [],
  errors: [],
  sessions: [],
  trace: "",
  startedAt: "",
  ...over,
});

test("totals add the runs up", () => {
  const t = totals([run("a"), run("b", { pass: false, verifiedPass: false, score: 0.5, falseClaims: ["x"], status: "timeout" })]);
  assert.equal(t.runs, 2);
  assert.equal(t.passed, 1);
  assert.equal(t.verified, 1);
  assert.equal(t.meanScore, 0.75);
  assert.equal(t.falseClaims, 1);
  assert.equal(t.tokensIn, 24_000);
  assert.equal(t.timeouts, 1);
});

test("the summary table has a row per run and a total", () => {
  const table = summaryTable([run("fact-with-source"), run("web-screenshot", { pass: false, score: 0.5, status: "timeout" })]);
  const lines = table.split("\n");
  assert.equal(lines.length, 5);
  assert.match(lines[2]!, /^\| fact-with-source \| core \| pass \| yes \| 100% \|/);
  assert.match(lines[3]!, /\| web-screenshot \| core \| timeout \|/);
  assert.match(lines[4]!, /\*\*1\/2\*\*/);
});

test("the report lists failed checks, false claims, unanswered cards and the cleanup receipt, with no dashes", () => {
  const saved: Saved = {
    label: "baseline",
    stamp: "s",
    commit: "abc",
    agent: "copilot-cli",
    model: "gpt-6-luna",
    judgeModel: "gpt-6-luna",
    tasks: ["a"],
    repeat: 1,
    startedAt: "t0",
    finishedAt: "t1",
    results: [run("a", { pass: false, score: 0, checks: [{ name: "the todo exists", pass: false, kind: "state", note: "none | found" }], falseClaims: ["says a task was created, and none exists"], cards: [{ id: "c", type: "sudo", answer: "", answered: false, at: "", note: "needs a password" }] })],
    cleanup: [{ agent: "copilot-cli", id: "1234", kind: "node-turn", task: "a", deleted: true }],
    notes: ["a note"],
  };
  const text = markdown(saved);
  assert.match(text, /the todo exists \(none \/ found\)/);
  assert.match(text, /False claim: says a task was created/);
  assert.match(text, /Cards not answered: sudo \(needs a password\)/);
  assert.match(text, /1 of 1 agent sessions deleted/);
  assert.ok(!text.includes("—") && !text.includes(" -- "));
});
