import assert from "node:assert/strict";
import test from "node:test";
import { agentHref, commandOf, compactCount, elapsed, ensembleTool, groupThreads, linkedTasks, recordLinks, relativeIn, shortAgo, splitMentions, thought, threadTitle, toolKind, toolLine, toolOutput, toolPath, withMentions, workRows } from "./code-agent";
import type { CodeThread } from "./api";
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
  assert.equal(threadTitle("x".repeat(120)).length, 60);
  assert.equal(threadTitle("hello can you please write a BFS example in C++ and save it as a Word document"), "Write a BFS example in C++");
  assert.equal(threadTitle("Hey, I want you to make a page for @task:Launch plan"), "Make a page for Launch plan");
  assert.equal(compactCount(999), "999");
  assert.equal(compactCount(1234), "1.2k");
  assert.equal(elapsed(42_000), "42s");
  assert.equal(elapsed(185_000), "3m 05s");
  assert.equal(elapsed(3_720_000), "1h 02m");
});

test("mentions go to the agent as handles its Ensemble tools open, and come back as chips in the thread", () => {
  const task = { kind: "task" as const, id: "5f1c2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f", label: "Fix the export" };
  const diagram = { kind: "diagram" as const, id: "d1", label: "Services" };
  const sent = withMentions("Do @task:Fix the export, see @diagram:Services", [task, diagram, { kind: "date", id: "2026-11-20", label: "20 Nov" }]);
  assert.match(sent, /ensemble:\/\/task\/5f1c2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f/);
  assert.match(sent, /diagram id d1/);
  assert.doesNotMatch(sent, /20 Nov/);
  assert.deepEqual(splitMentions(sent), { text: "Do @task:Fix the export, see @diagram:Services", mentions: [task, diagram] });
  assert.equal(withMentions("Plain", []), "Plain");
  assert.deepEqual(linkedTasks([sent, withMentions("Again", [task])]), [{ id: task.id, label: "Fix the export" }]);
});

test("the sessions list puts pinned threads first, then one group per folder, with No folder for the rest", () => {
  const thread = (id: string, folder: string | null, updatedAt: string): CodeThread => ({ id, title: id, createdAt: updatedAt, updatedAt, turns: 1, last: null, place: { deviceId: null, deviceName: null, folder, workdir: null } });
  const groups = groupThreads([thread("a", "/work/relay", "2026-11-01T00:00:00Z"), thread("b", null, "2026-11-03T00:00:00Z"), thread("c", "/work/relay", "2026-11-02T00:00:00Z"), thread("d", "/work/site", "2026-10-01T00:00:00Z")], new Set(["d"]));
  assert.deepEqual(groups.map((group) => [group.label, group.threads.map((row) => row.id)]), [["Pinned", ["d"]], ["No folder", ["b"]], ["relay", ["c", "a"]]]);
  assert.equal(shortAgo("2026-11-01T00:00:00Z", Date.parse("2026-11-01T03:10:00Z")), "3h");
  assert.equal(shortAgo("2026-11-01T00:00:00Z", Date.parse("2026-11-03T00:00:00Z")), "2d");
});

test("a thread opens where it works: its folder in the editor's window, or Code's home with no folder", () => {
  assert.equal(agentHref({ deviceId: "dev", folder: "/work/relay" }, { thread: "t1" }), "/code/review?device=dev&repo=%2Fwork%2Frelay&view=agent&thread=t1");
  assert.equal(agentHref({ deviceId: null, folder: null }, { thread: "new" }), "/code?view=agent&thread=new");
  assert.equal(agentHref({ deviceId: null, folder: "/work/relay" }, { view: "editor", file: "src/a.ts" }), "/code/review?repo=%2Fwork%2Frelay&view=editor&file=src%2Fa.ts");
});

test("tool calls read as what they did: commands with their reason, Ensemble's tools by name, outputs without JSON", () => {
  const bash = toolLine("bash", JSON.stringify({ command: "git status --short && ls -la", description: "Inspect repository and working tree" }), "bash");
  assert.deepEqual(bash, { label: "Inspect repository and working tree", detail: "git status --short && ls -la", ensemble: false });
  assert.equal(commandOf(JSON.stringify({ command: ["bash", "-lc", "npm test"] }))?.command, "bash -lc npm test");
  assert.equal(commandOf(JSON.stringify({ command: "/bin/bash -lc 'npm test'" }))?.command, "npm test");
  assert.equal(toolLine("ensemble-report_result", "{}", "").label, "Reported the result");
  assert.equal(toolLine("mcp__ensemble__ensemble_act", JSON.stringify({ action: "hub_create_page", input: { title: "BFS" } }), "").label, "Made a page");
  assert.equal(toolLine("ensemble-ensemble_act", JSON.stringify({ action: "hub_create_page", input: { title: "BFS" } }), "").detail, "BFS");
  assert.equal(toolLine("apply_patch", "{}", "").label, "Edited files");
  assert.equal(ensembleTool("bash"), null);

  const output = toolOutput(JSON.stringify({ content: "total 12\ndrwx .git\n<shellId: 0 completed with exit code 0>", detailedContent: "same", contents: [{ type: "shell_exit", exitCode: 0 }] }));
  assert.deepEqual(output, { text: "total 12\ndrwx .git", exitCode: 0 });
  assert.deepEqual(toolOutput("plain text"), { text: "plain text", exitCode: null });
  assert.deepEqual(toolOutput(JSON.stringify({ stdout: "", stderr: "boom", exit_code: 2 })), { text: "boom", exitCode: 2 });

  assert.deepEqual(thought("**Checking the tests**\n\nThey run with node."), { title: "Checking the tests", body: "They run with node." });
  assert.equal(thought("plain line").title, "plain line");
  assert.equal(thought("**Making a sample&nbsp;json**").title, "Making a sample json");
});

test("a reply's links to Ensemble records become cards, once each, with their names", () => {
  const id = "3f0c2a9e-1b2c-4d5e-8f90-123456789abc";
  const links = recordLinks(`Created [BFS-in-Cpp.docx](https://app.ensemble.work/files/${id}) and saved it. See /files/${id} and [the plan](/pages/${id.replace("3f", "4f")}), ensemble://task/${id.replace("3f", "5f")}. Not [GitHub](https://github.com/a/b/pull/12) or /pages/new.`);
  assert.deepEqual(links.map((row) => [row.kind, row.label]), [["file", "BFS-in-Cpp.docx"], ["page", "the plan"], ["task", null]]);
  assert.equal(links[0]!.href, `/files/${id}`);
});
