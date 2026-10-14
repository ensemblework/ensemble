import assert from "node:assert/strict";
import test from "node:test";
import type { RunStep } from "./api";
import { duration, modelsSeen, sameModel, toolStats, traceEntries, usd } from "./run-trace";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 14, 10, 0, seconds)).toISOString();

function step(index: number, over: Partial<RunStep>): RunStep {
  return { id: `s${index}`, index, title: "Step", status: "done", output: null, error: null, model: null, credits: null, toolCalls: [], ...over };
}

test("a Claude Code trace reads as thinking, tool calls with timings, and the result", () => {
  const steps: RunStep[] = [
    step(0, { title: "Thinking", reasoning: "Clone first.", startedAt: at(1), endedAt: at(1) }),
    step(1, { title: "$ git clone https://github.com/a/b", toolCalls: [{ id: "t1", name: "Bash", args: '{"command":"git clone"}', output: "Cloning…", ok: true, ms: 2400, engine: "claude-code" }], startedAt: at(2), endedAt: at(4) }),
    step(2, { title: "Read README.md", status: "failed", toolCalls: [{ id: "t2", name: "Read", args: { file_path: "README.md" }, output: "No such file", ok: false, ms: 30 }], startedAt: at(5), endedAt: at(5) }),
    step(3, { title: "Grep", status: "running", toolCalls: [{ id: "t3", name: "Grep", args: "{}" }], startedAt: at(6) }),
    step(4, { title: "Result", output: "## Summary\nDone.", model: "claude-sonnet-4-6-20260101", startedAt: at(9), endedAt: at(9) }),
  ];
  const entries = traceEntries(steps, at(0), at(10), Date.parse(at(10)));
  assert.deepEqual(entries.map((entry) => entry.kind), ["thinking", "tools", "tools", "tools", "result"]);
  assert.equal(entries[0]!.reasoning, "Clone first.");
  assert.equal(entries[1]!.ms, 2400, "a single call's own time wins over the step's");
  assert.equal(entries[1]!.offset, 0.2);
  assert.equal(entries[2]!.calls[0]!.ok, false);
  assert.match(entries[2]!.calls[0]!.args, /"file_path": "README.md"/, "older rows keep args as an object");
  assert.equal(entries[3]!.calls[0]!.running, true);
  assert.equal(entries[3]!.calls[0]!.ok, null);
  const stats = toolStats(entries);
  assert.deepEqual(stats.map((row) => [row.name, row.count, row.failed, row.ms]), [["Grep", 1, 0, 4000], ["Bash", 1, 0, 2400], ["Read", 1, 1, 30]], "a call still running counts the time so far");
  assert.deepEqual(modelsSeen(steps), ["claude-sonnet-4-6-20260101"]);
});

test("Ensemble's agent: several calls in one turn, each with its own time", () => {
  const entries = traceEntries(
    [step(0, { title: "read_file, run_command", toolCalls: [{ name: "read_file", args: "{}", ms: 10, ok: true, summary: "Read a.ts" }, { name: "run_command", ms: 900, ok: true, summary: "npm test → exit 0" }], startedAt: at(0), endedAt: at(1) })],
    at(0),
    at(1),
  );
  assert.equal(entries[0]!.calls.length, 2);
  assert.equal(entries[0]!.ms, 1000, "a turn with several calls takes the step's time");
  assert.equal(toolStats(entries).find((row) => row.name === "run_command")?.ms, 900);
});

test("the model that answered is compared with the one asked for, allowing dated ids", () => {
  assert.equal(sameModel("claude-sonnet-4.6", "claude-sonnet-4-6-20260101"), true);
  assert.equal(sameModel("gpt-5.4-mini", "gpt-5.4-mini-2026-03-01"), true);
  assert.equal(sameModel("openai/gpt-5.4", "gpt-5.4"), true);
  assert.equal(sameModel("mai-code-1.1-flash", "gemini-2.5-flash"), false);
  assert.equal(sameModel("default", null), true);
  assert.equal(sameModel("default", "claude-sonnet-4-6"), true, "the harness's default is whatever it picked");
  assert.equal(sameModel("auto", "gpt-5.4"), true);
});

test("durations and costs read plainly", () => {
  assert.equal(duration(340), "340ms");
  assert.equal(duration(2400), "2.4s");
  assert.equal(duration(75_000), "1m 15s");
  assert.equal(duration(null), "");
  assert.equal(usd(0.004), "<$0.01");
  assert.equal(usd(1.234), "$1.23");
});
