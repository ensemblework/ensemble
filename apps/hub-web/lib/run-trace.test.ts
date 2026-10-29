import assert from "node:assert/strict";
import test from "node:test";
import type { RunStep } from "./api";
import { duration, modelsSeen, readableTraceValue, sameModel, toolStats, traceEntries, usd } from "./run-trace";

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

test("JSON trace values show decoded strings and keep structured fields and primitives", () => {
  const command = 'printf "hello\\nworld"\nnext command';
  assert.equal(readableTraceValue(JSON.stringify({ command, initial_wait: 120 })).text, `command:\n${command}\n\ninitial_wait:\n120`);
  assert.equal(readableTraceValue('{"nested":{"enabled":true},"empty":null}').text, 'nested:\n{\n  "enabled": true\n}\n\nempty:\nnull');
  for (const text of ["null", "false", "0", "{}", "[]", "[1,2]"]) {
    assert.equal(readableTraceValue(text).text, JSON.stringify(JSON.parse(text), null, 2));
  }
  assert.equal(readableTraceValue('"one\\ntwo"').text, "one\ntwo");
});

test("tool envelopes show readable content without losing metadata, details or non-text blocks", () => {
  const content = 'diff --git a/file b/file\n+const x = "hello";\n';
  assert.equal(readableTraceValue(JSON.stringify({ content, detailedContent: content }), true).text, content);
  assert.equal(readableTraceValue('{"content":[null,0,false]}', true).text, "null\n\n0\n\nfalse");
  const formatted = readableTraceValue(JSON.stringify({
    content: [{ type: "text", text: "first\nsecond" }, { type: "image", data: "image-data" }],
    detailedContent: "more detail",
    isError: true,
    exitCode: 1,
  }), true).text;
  assert.match(formatted, /first\nsecond/);
  assert.match(formatted, /"type": "image"/);
  assert.match(formatted, /image-data/);
  assert.match(formatted, /detailedContent:\nmore detail/);
  assert.match(formatted, /isError:\ntrue/);
  assert.match(formatted, /exitCode:\n1/);
});

test("bounded tool envelopes recover only valid content string prefixes and identify incomplete JSON", () => {
  const content = 'first\n"quoted"\tC:\\files\\file';
  const text = JSON.stringify({ content, detailedContent: "long details" });
  assert.deepEqual(readableTraceValue(text.slice(0, -5), true), { text: content, incomplete: true });
  const prefix = JSON.stringify({ content }).slice(0, -2);
  assert.deepEqual(readableTraceValue(prefix, true), { text: content, incomplete: true });
  for (const ending of ["\\", "\\u", "\\u0", "\\u00", "\\u004"]) {
    assert.deepEqual(readableTraceValue(prefix + ending, true), { text: content, incomplete: true });
  }
  for (const raw of ["plain\noutput", '{"other":"unfinished', '{"content":"bad\\x', '{"content":"bad\nnewline', '{"command":']) {
    assert.deepEqual(readableTraceValue(raw, true), { text: raw, incomplete: false });
  }
  assert.deepEqual(readableTraceValue(prefix), { text: prefix, incomplete: false }, "input is not guessed from partial JSON");
});

test("tool output is not repeated as Said, but distinct assistant commentary stays", () => {
  const output = JSON.stringify({ content: "one\ntwo" });
  const entries = traceEntries([
    step(0, { output, toolCalls: [{ name: "bash", output }] }),
    step(1, { output: JSON.stringify(JSON.parse(output), null, 2), toolCalls: [{ name: "bash", output }] }),
    step(2, { output: "I will fix the error.", toolCalls: [{ name: "bash", output }] }),
    step(3, { title: "Message", output }),
    step(4, { output: "different", toolCalls: [{ name: "bash", output }] }),
  ], at(0), at(1));
  assert.deepEqual(entries.map(entry => entry.text), ["", "", "I will fix the error.", output, "different"]);
  assert.equal(entries[0]!.calls[0]!.output, output, "the recorded tool output stays untouched");
});
