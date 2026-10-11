import assert from "node:assert/strict";
import test from "node:test";
import { answerText, questionInput } from "../../../scripts/ensemble-ask-mcp.mjs";
import { answeredInput, engineOutput, hookFile, normalizePayload, output, questionCards, withHooks } from "../../../scripts/ensemble-hook.mjs";

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
  const claude = withHooks("claude", { hooks: { PreToolUse: [theirs] }, model: "opus" }, false, hookCommand, 60);
  assert.equal(claude.model, "opus");
  assert.equal(claude.hooks.PreToolUse.length, 2);
  assert.equal(claude.hooks.PreToolUse[1].matcher, "AskUserQuestion");
  assert.equal(claude.hooks.PermissionRequest.length, 1);
  const again = withHooks("claude", claude, false, (source: string) => `node /new/ensemble-hook.mjs --source ${source}`, 60);
  assert.equal(again.hooks.PreToolUse.length, 2, "reinstalling does not duplicate");
  const removed = withHooks("claude", again, true, hookCommand, 60);
  assert.deepEqual(removed.hooks.PreToolUse, [theirs]);
  assert.deepEqual(removed.hooks.PermissionRequest, []);

  const codex = withHooks("codex", {}, false, hookCommand, 60);
  assert.equal(codex.hooks.PermissionRequest[0].hooks[0].command, "node ensemble-hook.mjs --source codex");
  assert.equal(codex.hooks.PreToolUse, undefined);

  const copilot = withHooks("copilot-cli", {}, false, hookCommand, 60);
  assert.equal(copilot.version, 1);
  assert.equal(copilot.hooks.preToolUse[0].bash, "node ensemble-hook.mjs --source copilot-cli");
  assert.equal(copilot.hooks.preToolUse[0].timeoutSec, 90);
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
