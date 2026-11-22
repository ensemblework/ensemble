import assert from "node:assert/strict";
import test from "node:test";
import { markdown, suiteTable, summary, summaryTable, totals, withMetrics } from "./report.js";
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

test("no-answer turns and error messages come from the metrics, or from the errors of an older file", () => {
  const older = run("a", { errors: ["turn of @assistant failed: The model returned no answer. Recorded actions are available separately.", "error message in the chat: The model returned no answer.", "turn of @x failed: Rate limited.", "turn of @y failed: The model ended its turn without replying or doing anything. Try again, or choose another model."] });
  assert.deepEqual([withMetrics(older).metrics.noAnswerTurns, withMetrics(older).metrics.errorMessages], [2, 1]);
  const newer = run("b", { metrics: { ...run("b").metrics, noAnswerTurns: 2, errorMessages: 0 } });
  assert.deepEqual([withMetrics(newer).metrics.noAnswerTurns, withMetrics(newer).metrics.errorMessages], [2, 0]);
  assert.match(summaryTable([older, newer]).split("\n").at(-1)!, /\| 0 \| 4 \/ 1 \|/);
});

test("the suite table has a row per suite, an overall row, and input tokens per task", () => {
  const lines = suiteTable([run("a"), run("b", { suite: "hard", pass: false, verifiedPass: false, score: 0.5, falseClaims: ["x"] }), run("c", { suite: "hard" })]).split("\n");
  assert.equal(lines.length, 5);
  assert.match(lines[2]!, /^\| core \| 1 \| 0 \| 1 \| 1 \| 100% \| 0 \| 0 \| 0 \| 12k \| 1 \| 1\.0 min \| 0\.50 \|$/);
  assert.match(lines[3]!, /^\| hard \| 2 \| 0 \| 1 \| 1 \| 75% \| 0 \| 0 \| 1 \| 12k \| 2 \| 2\.0 min \|/);
  assert.match(lines[4]!, /^\| \*\*all\*\* \| 3 \| 0 \| 2 \| 2 \|/);
});

test("a summary puts several runs' suites side by side and lists its sources", () => {
  const saved = (label: string, results: RunResult[]): Saved => ({ label, stamp: "s", commit: "abc", agent: "copilot-cli", model: "gpt-6-luna", judgeModel: "gpt-6-luna", tasks: [], repeat: 1, startedAt: "", finishedAt: "", results, cleanup: [{ agent: "copilot-cli", id: "1", kind: "node-turn", task: "a", deleted: true }], notes: ["same setup"] });
  const text = summary("baseline", [{ name: "one", saved: saved("one", [run("a")]) }, { name: "two", saved: saved("two", [run("b", { suite: "hard" })]) }]);
  assert.match(text, /\| core \| 1 \|/);
  assert.match(text, /\| hard \| 1 \|/);
  assert.match(text, /\| \*\*all\*\* \| 2 \|/);
  assert.match(text, /- \[`one\.md`\]\(one\.md\): core, 1 task, 1 of 1 agent session deleted\./);
  assert.equal(text.match(/- same setup/g)?.length, 1);
  assert.ok(!text.includes("—") && !text.includes(" -- "));
});

test("a skipped task counts in no total and is listed with what it requires", () => {
  const skipped = run("restart-reconciliation", { suite: "orch", status: "skipped", skipped: "requires tool-journal (the node tool journal)", pass: false, verifiedPass: false, score: 0, checks: [], metrics: { ...run("x").metrics, wallMs: 0, tokensIn: 0, turns: 0 } });
  const t = totals([run("a", { suite: "orch" }), skipped]);
  assert.deepEqual([t.runs, t.skipped, t.passed, t.meanScore], [1, 1, 1, 1]);
  const suites = suiteTable([run("a", { suite: "orch" }), skipped]).split("\n");
  assert.match(suites[2]!, /^\| orch \| 1 \| 1 \| 1 \| 1 \| 100% \|/);
  const onlySkipped = suiteTable([skipped]).split("\n");
  assert.match(onlySkipped[2]!, /^\| orch \| 0 \| 1 \| 0 \| 0 \| n\/a \|/);
  const table = summaryTable([run("a", { suite: "orch" }), skipped]).split("\n");
  assert.match(table[3]!, /^\| restart-reconciliation \| orch \| skipped \|/);
  assert.equal(table[3]!.split("|").length, table[0]!.split("|").length);
  assert.match(table.at(-1)!, /\*\*1\/1\*\* \(1 skipped\)/);
  const saved: Saved = { label: "x", stamp: "s", commit: "abc", agent: "copilot-cli", model: "gpt-6-luna", judgeModel: "gpt-6-luna", tasks: [], repeat: 1, startedAt: "", finishedAt: "", results: [skipped], cleanup: [], notes: [] };
  const text = markdown(saved);
  assert.match(text, /## Skipped\n\n- \*\*restart-reconciliation\*\*: requires tool-journal/);
  assert.doesNotMatch(text, /\*\*restart-reconciliation\*\*: all checks passed/);
});

test("a stuck plan step the harness finished without is counted and listed as a problem, with the step and why", () => {
  const stuck = { id: "p", type: "plan_decision", answer: "finish without it", answered: true, at: "", note: "step s2-abc stuck: @builder's step in @manager's plan is stuck. No access to the repo." };
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
    results: [run("a", { cards: [stuck], metrics: { ...run("a").metrics, approvals: 1, stuckSteps: 1 } })],
    cleanup: [],
    notes: [],
  };
  const text = markdown(saved);
  assert.match(text, /- \*\*a\*\*: all checks passed\.\n {2}- Stuck steps finished without them: step s2-abc stuck: @builder's step in @manager's plan is stuck\. No access to the repo\./);
  assert.match(summaryTable(saved.results).split("\n")[2]!, /\| 1 \(1 stuck\) \|/);
  assert.equal(totals(saved.results).stuckSteps, 1);
});
