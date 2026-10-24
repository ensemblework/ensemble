/** How GitHub Copilot's ACP permission requests read in the judge's terms, and what goes back after a refusal. */
import assert from "node:assert/strict";
import test from "node:test";
import { copilotCalls, refusalMessage } from "./copilot.js";

test("Copilot's tool calls become the judge's calls, one per path", () => {
  assert.deepEqual(copilotCalls({ kind: "execute", rawInput: { command: "npm test", commands: ["npm test"] } }), [{ tool: "Bash", input: { command: "npm test" } }]);
  assert.deepEqual(copilotCalls({ kind: "execute", title: "Run", rawInput: { commands: ["a", "b"] } }), [{ tool: "Bash", input: { command: "a && b" } }]);
  assert.deepEqual(
    copilotCalls({ kind: "edit", rawInput: { fileName: "/w/a.ts" }, locations: [{ path: "/w/a.ts" }, { path: "/w/b.ts" }] }),
    [{ tool: "Write", input: { file_path: "/w/a.ts" } }, { tool: "Write", input: { file_path: "/w/b.ts" } }],
    "a patch over two files is judged for each",
  );
  assert.deepEqual(copilotCalls({ kind: "read", rawInput: { path: "/etc/hostname" }, locations: [{ path: "/etc/hostname" }] }), [{ tool: "Read", input: { file_path: "/etc/hostname" } }]);
  assert.deepEqual(copilotCalls({ kind: "fetch", rawInput: { url: "https://example.com" } }), [{ tool: "WebFetch", input: { url: "https://example.com" } }]);
  // MCP tools: the permission names the tool, the tool_call update named "<server>-<tool>".
  assert.deepEqual(copilotCalls({ kind: "other", title: "ask_person", rawInput: { question: "?" } }, "ensemble-ask_person"), [{ tool: "mcp__ensemble__ask_person", input: { question: "?" } }]);
  assert.deepEqual(copilotCalls({ kind: "other", title: "echo_text", rawInput: {} }, "probe-echo_text"), [{ tool: "mcp__probe__echo_text", input: {} }]);
});

test("a refusal goes back to Copilot with its reason, as the run's setting", () => {
  const text = refusalMessage([{ tool: "the command `git push`", reason: "This run may not push." }]);
  assert.match(text, /Ensemble refused/);
  assert.match(text, /`git push`: This run may not push\./);
  assert.match(text, /not an error to work around/);
});
