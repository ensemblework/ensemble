import assert from "node:assert/strict";
import test from "node:test";
import { threadTitle } from "./thread-title.js";

test("a thread is named by the few words of its request that matter", () => {
  assert.equal(threadTitle("hey can you please fix the login redirect bug on Safari"), "Fix login redirect bug on Safari");
  assert.equal(threadTitle("I want you to add a dark mode toggle to the settings page and make sure it persists"), "Add dark mode toggle");
  assert.equal(threadTitle("write unit tests for the ToolsPicker component"), "Write unit tests for ToolsPicker component");
  assert.equal(threadTitle("Can you check whether my connected apps like GitHub, Notion and Gmail are working?"), "Check connected apps");
  assert.equal(threadTitle("summarize the meeting notes from yesterday and create tasks for the action items"), "Summarize meeting notes from yesterday");
  assert.equal(threadTitle("please investigate why the runner crashes on startup"), "Investigate runner crashes on startup");
});

test("links, paths, code and long pastes become a word or two, and nothing useful leaves the default", () => {
  assert.equal(threadTitle("https://github.com/ensemblework/ensemble/issues/303 please work on this issue"), "Issue #303");
  assert.equal(threadTitle("refactor src/workspace/assign.ts to split the device path into its own module"), "Refactor assign.ts");
  assert.equal(threadTitle("Here is the stack trace:\nTypeError: cannot read properties of undefined\n" + "at frame (x.ts:1)\n".repeat(5000)), "Stack trace");
  assert.equal(threadTitle("```ts\nconst x = 1;\n```\nwhy is this slow"), "Slow");
  assert.equal(threadTitle("hello"), "New thread");
  assert.equal(threadTitle("   "), "New thread");
  assert.ok(threadTitle("optimize " + "verylongidentifier".repeat(10)).length <= 48);
});
