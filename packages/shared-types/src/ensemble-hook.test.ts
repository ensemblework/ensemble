import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { answerText, heartbeat, questionInput, toolsFor } from "../../../scripts/ensemble-ask-mcp.mjs";
import { ACTIVITY_EVENTS, answeredInput, engineOutput, hookFile, lastAssistantText, normalizePayload, output, questionCards, questionOutput, withHooks } from "../../../scripts/ensemble-hook.mjs";

const hookCommand = (source: string) => `node ensemble-hook.mjs --source ${source}`;

test("Claude Code and Codex get the PermissionRequest reply; no answer lets them ask themselves", () => {
  for (const source of ["claude", "codex"]) {
    assert.deepEqual(output(source, "PermissionRequest", { decision: "allow" }), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    assert.deepEqual(output(source, "PermissionRequest", { decision: "deny", reason: "not today" }), {
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "not today" } },
    });
    assert.equal(output(source, "PermissionRequest", { decision: null }), null);
  }
  // Codex does not support "ask" from PreToolUse yet: silence instead.
  assert.equal(output("codex", "PreToolUse", { decision: null }), null);
});

test("Copilot CLI reads the decision at the top level and its tool arguments as a JSON string", () => {
  assert.deepEqual(output("copilot-cli", "preToolUse", { decision: "deny", reason: "no" }), { permissionDecision: "deny", permissionDecisionReason: "Denied in Ensemble: no." });
  assert.equal(output("copilot-cli", "preToolUse", { decision: null }), null);
  const payload = normalizePayload({ toolName: "bash", toolArgs: '{"command":"rm -rf build"}', cwd: "/repo" });
  assert.equal(payload.tool_name, "bash");
  assert.deepEqual(payload.tool_input, { command: "rm -rf build" });
});

test("each AskUserQuestion question becomes a card with its options, descriptions and a typed answer", () => {
  const payload = {
    tool_name: "AskUserQuestion",
    session_id: "s1",
    tool_input: {
      questions: [
        { question: "Which runner?", header: "Tests", multiSelect: false, options: [{ label: "Vitest", description: "Fast" }, { label: "Jest" }] },
        { question: "Which checks?", header: "CI", multiSelect: true, options: [{ label: "Lint", description: "" }, { label: "Types", description: "" }] },
      ],
    },
  };
  const cards = questionCards(payload);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0]!.payload.options, ["Vitest", "Jest"]);
  assert.deepEqual(cards[0]!.payload.option_details, [
    { label: "Vitest", description: "Fast" },
    { label: "Jest", description: "" },
  ]);
  assert.equal(cards[1]!.payload.multi_select, true);
  assert.equal(cards[0]!.payload.allow_custom, true);
  const input = answeredInput(payload, { "Which runner?": "Vitest", "Which checks?": "Lint, Types" });
  assert.deepEqual(input.questions, payload.tool_input.questions);
  assert.deepEqual(input.answers, { "Which runner?": "Vitest", "Which checks?": "Lint, Types" });
});

test("installing keeps the person's own hooks and replaces only Ensemble's", () => {
  const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] };
  // An earlier install also answered questions through PreToolUse, which held Claude's own question card back.
  const legacy = { matcher: "AskUserQuestion", hooks: [{ type: "command", command: "node ensemble-hook.mjs --source claude" }] };
  const claude = withHooks("claude", { hooks: { PreToolUse: [theirs, legacy] }, model: "opus" }, false, hookCommand, 60);
  assert.equal(claude.model, "opus");
  assert.deepEqual(claude.hooks.PreToolUse, [theirs], "questions now go through PermissionRequest, beside Claude's own card");
  assert.equal(claude.hooks.PermissionRequest.length, 1);
  assert.equal(claude.hooks.PermissionRequest[0].hooks[0].async, undefined, "the asking hook is waited on");
  for (const event of ["PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop"]) {
    assert.equal(claude.hooks[event][0].hooks[0].async, true, `${event} reports in the background`);
    assert.equal(claude.hooks[event][0].hooks[0].timeout, 15);
  }
  const again = withHooks("claude", claude, false, (source: string) => `node /new/ensemble-hook.mjs --source ${source}`, 60);
  assert.equal(again.hooks.PermissionRequest.length, 1, "reinstalling does not duplicate");
  assert.equal(again.hooks.Stop.length, 1);
  const removed = withHooks("claude", again, true, hookCommand, 60);
  assert.deepEqual(removed.hooks.PreToolUse, [theirs]);
  assert.equal(removed.hooks.PermissionRequest, undefined);
  assert.equal(removed.hooks.Stop, undefined);

  const codex = withHooks("codex", {}, false, hookCommand, 60);
  assert.equal(codex.hooks.PermissionRequest[0].hooks[0].command, "node ensemble-hook.mjs --source codex");
  assert.equal(codex.hooks.PreToolUse, undefined);
  assert.deepEqual(Object.keys(codex.hooks).sort(), ["PermissionRequest", "PostToolUse", "Stop", "UserPromptSubmit"]);
  assert.equal(codex.hooks.Stop[0].hooks[0].async, undefined, "Codex hashes each hook; no fields it may not know");

  const copilot = withHooks("copilot-cli", {}, false, hookCommand, 60);
  assert.equal(copilot.version, 1);
  assert.equal(copilot.hooks.preToolUse[0].bash, "node ensemble-hook.mjs --source copilot-cli");
  assert.equal(copilot.hooks.preToolUse[0].timeoutSec, 90);
  assert.equal(copilot.hooks.postToolUse[0].timeoutSec, 15);

  const cursor = withHooks("cursor", { hooks: { beforeShellExecution: [{ command: "their-hook" }] } }, false, hookCommand, 60);
  assert.deepEqual(cursor.hooks.beforeShellExecution.map((item: { command: string }) => item.command), ["their-hook", "node ensemble-hook.mjs --source cursor"]);
  assert.ok(cursor.hooks.beforeSubmitPrompt && cursor.hooks.stop && cursor.hooks.afterShellExecution);
});

test("reporting events never wait, and Claude's questions are answered through PermissionRequest", () => {
  assert.ok(ACTIVITY_EVENTS.has("Stop") && ACTIVITY_EVENTS.has("PostToolUse") && ACTIVITY_EVENTS.has("beforeSubmitPrompt"));
  assert.ok(!ACTIVITY_EVENTS.has("PermissionRequest") && !ACTIVITY_EVENTS.has("preToolUse"));
  const answers = { questions: [{ question: "Which?" }], answers: { "Which?": "A" } };
  assert.deepEqual(questionOutput("PermissionRequest", answers), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: answers } } });
  assert.equal(questionOutput("PreToolUse", answers).hookSpecificOutput.permissionDecision, "allow");
});

test("the task's summary is the agent's last words in its transcript", () => {
  const lines = [
    JSON.stringify({ type: "user", message: { content: "do it" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done: changed two files." }, { type: "tool_use", name: "Bash" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
    '{"type":"assistant","message":{"content":[{"type":"te',
  ];
  assert.equal(lastAssistantText(lines.join("\n")), "Done: changed two files.");
  assert.equal(lastAssistantText(""), null);
});

test("hook files live where each tool reads them", () => {
  assert.equal(hookFile("codex", { home: "/home/mira" }), "/home/mira/.codex/hooks.json");
  assert.equal(hookFile("claude", { home: "/home/mira" }), "/home/mira/.claude/settings.json");
  assert.match(hookFile("copilot-cli", { home: "/home/mira" }), /\.copilot\/hooks\/ensemble\.json$/);
  assert.throws(() => hookFile("gemini", { home: "/home/mira" }), /--target/);
});

test("an engine run's hook allows with the answered input, and fails closed", () => {
  assert.deepEqual(engineOutput({ decision: "allow", updatedInput: { answers: { q: "a" } } }), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Allowed by this run's settings in Ensemble.", updatedInput: { answers: { q: "a" } } },
  });
  assert.equal(engineOutput(null).hookSpecificOutput.permissionDecision, "deny");
  assert.match(engineOutput({ decision: "deny", message: "keys" }).hookSpecificOutput.permissionDecisionReason, /keys/);
});

test("ask_person marks the recommended option and returns the person's answer as text", () => {
  const input = questionInput({ question: "Which colour?", options: ["Red", "Blue", ""], recommended: "Blue" });
  assert.deepEqual(input.questions[0]!.options, [{ label: "Red" }, { label: "Blue (Recommended)" }]);
  assert.equal(answerText(input, { decision: "allow", updatedInput: { answers: { "Which colour?": "Blue (Recommended)" } } }), "The person answered: Blue");
  assert.equal(answerText(input, { decision: "allow", updatedInput: { answers: { "Which colour?": "Green, please" } } }), "The person answered: Green, please");
  assert.match(answerText(input, { decision: "deny", message: "skipped" }), /^No answer: skipped/);
});

test("the run's ensemble MCP server offers the person's board only in Chat", () => {
  assert.deepEqual(toolsFor({}).map((tool) => tool.name), ["ask_person"]);
  assert.deepEqual(toolsFor({ ENSEMBLE_CHAT: "1" }).map((tool) => tool.name), ["ask_person", "ensemble_list_tasks", "ensemble_create_task", "ensemble_search"]);
});

test("a waiting question sends progress only when the agent gave a progress token", async () => {
  const sent: Array<{ params: { progressToken: unknown; progress: number } }> = [];
  assert.equal(typeof heartbeat({ params: {} }, (message: never) => sent.push(message), 5), "function");
  const stop = heartbeat({ params: { _meta: { progressToken: "t1" } } }, (message: never) => sent.push(message), 5);
  await new Promise((resolve) => setTimeout(resolve, 30));
  stop();
  const count = sent.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(count >= 2);
  assert.equal(sent.length, count);
  assert.deepEqual(sent.slice(0, 2).map((message) => [message.params.progressToken, message.params.progress]), [["t1", 1], ["t1", 2]]);
});

test("a question the agent cancels hangs up on Ensemble (which withdraws the card) and gets no reply", async () => {
  let hungUp!: () => void;
  const closed = new Promise<void>((resolve) => (hungUp = resolve));
  let asked!: () => void;
  const reached = new Promise<void>((resolve) => (asked = resolve));
  // Ensemble that never answers, as when nobody has answered the Needs me card yet.
  const server = createServer((request, response) => {
    asked();
    response.on("close", () => {
      if (!response.writableFinished) hungUp();
    });
    void request;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../../scripts/ensemble-ask-mcp.mjs", import.meta.url))], {
    env: { ...process.env, ENSEMBLE_ENGINE_URL: `http://127.0.0.1:${port}`, ENSEMBLE_RUN: "job.secret" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ask_person", arguments: { question: "Go on?", options: ["Yes", "No"] } } })}\n`);
    await reached;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "timed out" } })}\n`);
    await closed;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const replies = out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id?: number });
    assert.deepEqual(replies.map((reply) => reply.id), [8]);
  } finally {
    child.kill();
    server.closeAllConnections();
    server.close();
  }
});
