/**
 * Telling a session's sub-agents apart from the session's own work on its stream (#272). The Claude Code
 * figures are from real runs of Claude Code 2.1.325 (a background sub-agent under `-p`; a resumed session).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addClaudeResult, claudeFromSubAgent, copilotEventFromSubAgent, copilotUpdateAgent, otherCodexThread, sessionToDelete, SubAgentLog, withClaudeSubAgentLimits } from "./sub-agents.js";

test("a Codex notification about another thread is a sub-agent's", () => {
  assert.equal(otherCodexThread({ threadId: "child" }, "parent"), true);
  assert.equal(otherCodexThread({ threadId: "parent" }, "parent"), false);
  assert.equal(otherCodexThread({}, "parent"), false, "a notification that names no thread is the connection's");
  assert.equal(otherCodexThread({ threadId: "child" }, null), false, "before the session's thread is known nothing is set aside");
});

test("Copilot marks a sub-agent's ACP updates and JSON events with its agent id", () => {
  assert.equal(copilotUpdateAgent({ _meta: { "github.com/copilot": { agentId: "f1905b8e" } } }), "f1905b8e");
  assert.equal(copilotUpdateAgent({ _meta: { "github.com/copilot": { agentId: "" } } }), null);
  assert.equal(copilotUpdateAgent({ _meta: { other: { agentId: "x" } } }), null);
  assert.equal(copilotUpdateAgent({}), null);
  assert.equal(copilotEventFromSubAgent({ agentId: "7ec2f61b", data: { content: "PLUM" } }), true);
  assert.equal(copilotEventFromSubAgent({ data: { content: "PLUM", parentToolCallId: "toolu_1" } }), true);
  assert.equal(copilotEventFromSubAgent({ data: { content: "DONE" } }), false);
});

test("a Claude Code message from a sub-agent names the Agent tool call that started it", () => {
  assert.equal(claudeFromSubAgent({ type: "assistant", parent_tool_use_id: "toolu_01BcvC" }), true);
  assert.equal(claudeFromSubAgent({ type: "assistant", parent_tool_use_id: null }), false);
  assert.equal(claudeFromSubAgent({ type: "assistant" }), false);
});

test("a Claude Code run that answers twice: tokens and cost over both stretches, sub-agent included", () => {
  // The run started a background sub-agent, said it was waiting (result 0), then answered (result 1).
  const first = addClaudeResult(null, {
    result_index: 0,
    total_cost_usd: 0.004649305,
    usage: { input_tokens: 4, output_tokens: 341, cache_read_input_tokens: 20683, cache_creation_input_tokens: 21208 },
    model_usage_since_last_result: { "claude-haiku-5-5": { inputTokens: 6, outputTokens: 347, cacheReadInputTokens: 20683, cacheCreationInputTokens: 34147, costUSD: 0.004649305 } },
  });
  const both = addClaudeResult(first, {
    result_index: 1,
    total_cost_usd: 0.00495066,
    usage: { input_tokens: 4, output_tokens: 5, cache_read_input_tokens: 21208, cache_creation_input_tokens: 691 },
    model_usage_since_last_result: { "claude-haiku-5-5": { inputTokens: 4, outputTokens: 5, cacheReadInputTokens: 21208, cacheCreationInputTokens: 691, costUSD: 0.000301355 } },
  });
  // The first stretch's tokens include the sub-agent's 12,941 (its 2 in, 6 out and 12,939 cache writes).
  assert.equal(both.tokensIn, 6 + 20683 + 34147 + 4 + 21208 + 691);
  assert.equal(both.tokensOut, 347 + 5);
  assert.ok(Math.abs((both.costUsd ?? 0) - 0.00495066) < 1e-12);
});

test("a resumed Claude Code session: the run's own cost, not the session's total so far", () => {
  const spend = addClaudeResult(null, {
    total_cost_usd: 0.00379922,
    usage: { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 20653, cache_creation_input_tokens: 67 },
    modelUsage: { "claude-haiku-5-5": { inputTokens: 6, outputTokens: 15, cacheReadInputTokens: 34462, cacheCreationInputTokens: 27572, costUSD: 0.00379922 } },
    model_usage_since_last_result: { "claude-haiku-5-5": { inputTokens: 2, outputTokens: 5, cacheReadInputTokens: 20653, cacheCreationInputTokens: 67, costUSD: 0.000217605 } },
  });
  assert.deepEqual(spend, { tokensIn: 2 + 20653 + 67, tokensOut: 5, costUsd: 0.000217605, perResult: true });
});

test("an older Claude Code without the per-stretch field: each result's own usage, and its total cost", () => {
  const first = addClaudeResult(null, { total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 20 } });
  const both = addClaudeResult(first, { total_cost_usd: 0.012, usage: { input_tokens: 30, output_tokens: 5, cache_read_input_tokens: 70 } });
  assert.deepEqual(both, { tokensIn: 200, tokensOut: 25, costUsd: 0.012, perResult: false });
  assert.deepEqual(addClaudeResult(null, { usage: {} }), { tokensIn: 0, tokensOut: 0, costUsd: null, perResult: false });
});

test("a Claude Code run Ensemble starts nests sub-agents at most 3 deep, unless the person chose a depth, and has no agent teams", () => {
  const env = withClaudeSubAgentLimits({ PATH: "/usr/bin", CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" });
  assert.equal(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, "3");
  assert.equal(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, "0", "a teammate would be a session of its own, outside Ensemble's");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(withClaudeSubAgentLimits({ CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: " 1 " }).CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, "1", "the person's own depth stays");
  assert.equal(withClaudeSubAgentLimits({ CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "deep" }).CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, "3");
});

test("a run notes each child its agent started once, again only when its task arrives later, and never fails for it", async () => {
  const events: Array<Record<string, unknown>> = [];
  const log = new SubAgentLog(async (event, data) => void events.push({ event, ...data }), "codex");
  await log.note("thread-root", { id: "thread-euclid", kind: "thread" });
  await log.note("thread-root", { id: "thread-euclid", kind: "thread" });
  await log.note("thread-root", { id: "thread-euclid", kind: "thread", parent: "thread-root", title: "  Reply\n PLUM ", model: "gpt-6-luna" });
  await log.note("thread-root", { id: "thread-euclid", kind: "thread", title: "Another task" });
  await log.note("thread-root", { id: "thread-james", kind: "thread", parent: "thread-euclid" });
  await log.note("thread-root", { id: "thread-root", kind: "thread" });
  await log.note("thread-root", { id: "", kind: "thread" });
  assert.deepEqual(events, [
    { event: "sub_agent", engine: "codex", session: "thread-root", id: "thread-euclid", kind: "thread" },
    { event: "sub_agent", engine: "codex", session: "thread-root", id: "thread-euclid", kind: "thread", title: "Reply PLUM", model: "gpt-6-luna" },
    { event: "sub_agent", engine: "codex", session: "thread-root", id: "thread-james", kind: "thread", parent: "thread-euclid" },
  ], "the parent is named only when it is not the session itself");
  const failing = new SubAgentLog(async () => { throw new Error("database gone"); }, "cursor-agent");
  await failing.note("chat-1", { id: "chat-2", kind: "chat" });
});

test("a session's deletion takes its own session and the sessions of their own its agent started, not the sub-agents inside it", () => {
  assert.equal(sessionToDelete({ kind: "engine", data: { engine: "codex", session: "thread-root" } }, "codex"), "thread-root");
  assert.equal(sessionToDelete({ kind: "sub_agent", data: { engine: "codex", id: "thread-euclid", kind: "thread" } }, "codex"), "thread-euclid");
  assert.equal(sessionToDelete({ kind: "sub_agent", data: { engine: "cursor-agent", id: "9b0a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d", kind: "chat" } }, "cursor-agent"), "9b0a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d");
  assert.equal(sessionToDelete({ kind: "sub_agent", data: { engine: "claude-code", id: "toolu_1", kind: "inside" } }, "claude-code"), null, "part of the session's own files");
  assert.equal(sessionToDelete({ kind: "sub_agent", data: { engine: "codex", id: "thread-euclid", kind: "thread" } }, "cursor-agent"), null, "another agent's child");
  assert.equal(sessionToDelete({ kind: "tool", data: { session: "x" } }, "codex"), null);
});
