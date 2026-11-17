import assert from "node:assert/strict";
import test from "node:test";
import { compactCount, elapsed, relativeIn, threadTitle, toolKind, toolPath, workRows } from "./code-agent";
import type { TraceEntry } from "./run-trace";

test("tool calls read as the same kinds whichever agent made them", () => {
  for (const name of ["Bash", "commandExecution", "execute"]) assert.equal(toolKind(name), "command");
  for (const name of ["Edit", "Write", "MultiEdit", "fileChange", "edit", "create"]) assert.equal(toolKind(name), "edit");
  for (const name of ["Read", "view", "read"]) assert.equal(toolKind(name), "read");
  for (const name of ["Grep", "Glob", "search"]) assert.equal(toolKind(name), "search");
  for (const name of ["WebSearch", "WebFetch", "fetch"]) assert.equal(toolKind(name), "web");
  assert.equal(toolKind("mcp__ensemble__ensemble_act"), "ensemble");
  assert.equal(toolKind("mcp__ensemble__ensemble_search"), "ensemble");
  assert.equal(toolKind("ensemble_app_call"), "apps");
  assert.equal(toolKind("mcp__ensemble__ask_person"), "ask");
  assert.equal(toolKind("TodoWrite"), "plan");
});

test("a tool call's file opens only when it is in the folder", () => {
  assert.equal(toolPath(JSON.stringify({ file_path: "/work/relay/src/export.ts" }), "/work/relay"), "src/export.ts");
  assert.equal(toolPath(JSON.stringify({ path: "./README.md" }), "/work/relay/"), "README.md");
  assert.equal(toolPath(JSON.stringify({ changes: [{ path: "/work/relay/a.ts" }] }), "/work/relay"), "a.ts");
  assert.equal(toolPath(JSON.stringify({ file_path: "/work/other/a.ts" }), "/work/relay"), null);
  assert.equal(toolPath(JSON.stringify({ file_path: "/work/relay-old/a.ts" }), "/work/relay"), null);
  assert.equal(relativeIn("/work/relay", "../secrets"), null);
  assert.equal(relativeIn("/work/relay", "~/notes.md"), null);
  assert.equal(toolPath("not json", "/work/relay"), null);
});

test("a turn's work log keeps tools, thinking and what it said on the way, not the answer it ends with", () => {
  const entry = (over: Partial<TraceEntry>): TraceEntry => ({ id: "e", index: 0, kind: "step", title: "", status: "done", reasoning: "", text: "", error: "", model: null, tokensIn: null, tokensOut: null, calls: [], startedAt: null, endedAt: null, ms: null, offset: null, width: null, ...over });
  const rows = workRows(
    [
      entry({ id: "t", kind: "thinking", text: "Look at the exporter first." }),
      entry({ id: "c", kind: "tools", title: "Edit", calls: [{ key: "c:1", name: "Edit", summary: "Edit src/export.ts", args: JSON.stringify({ file_path: "/work/relay/src/export.ts" }), output: "", ok: true, running: false, ms: 40 }] }),
      entry({ id: "m", kind: "message", text: "Now the tests." }),
      entry({ id: "r", kind: "result", text: "Done: the export keeps dates." }),
      entry({ id: "m2", kind: "message", text: "Done: the export keeps dates." }),
    ],
    "/work/relay",
    "Done: the export keeps dates.",
  );
  assert.deepEqual(rows.map((row) => row.type), ["thinking", "tool", "message"]);
  const tool = rows[1]!;
  assert.equal(tool.type === "tool" ? tool.path : null, "src/export.ts");
});

test("threads are named by their first line, and counts and times read short", () => {
  assert.equal(threadTitle("  Fix the export.\nThen run the tests"), "Fix the export");
  assert.equal(threadTitle("   "), "New thread");
  assert.equal(threadTitle("x".repeat(120)).length, 80);
  assert.equal(compactCount(999), "999");
  assert.equal(compactCount(1234), "1.2k");
  assert.equal(elapsed(42_000), "42s");
  assert.equal(elapsed(185_000), "3m 05s");
  assert.equal(elapsed(3_720_000), "1h 02m");
});
