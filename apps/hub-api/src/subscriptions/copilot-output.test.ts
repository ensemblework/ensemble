/**
 * Reading `copilot -p --output-format json` for a chat turn. The events are from a real Copilot CLI 1.0.109 run
 * (ids shortened) whose turn started a sub-agent with its task tool: the sub-agent's messages carry its agent id.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { copilotOutput } from "./copilot-output.js";

test("a sub-agent's messages are not the chat's reply", () => {
  const streamed: string[] = [];
  const output = copilotOutput("claude-haiku-5.5", (text) => streamed.push(text));
  for (const event of [
    { type: "assistant.message", data: { content: "" } },
    { type: "assistant.message_delta", agentId: "7ec2f61b", data: { deltaContent: "PL", parentToolCallId: "toolu_01EDS" } },
    { type: "assistant.message_delta", agentId: "7ec2f61b", data: { deltaContent: "UM", parentToolCallId: "toolu_01EDS" } },
    { type: "assistant.message", agentId: "7ec2f61b", data: { content: "PLUM", parentToolCallId: "toolu_01EDS" } },
    { type: "assistant.message_delta", data: { deltaContent: "DONE" } },
    { type: "assistant.message", data: { content: "DONE" } },
  ]) output.line(JSON.stringify(event));
  assert.equal(output.finish().text, "DONE");
  assert.equal(streamed.join(""), "DONE");
});

test("the turn's own messages still join as before", () => {
  const streamed: string[] = [];
  const output = copilotOutput(null, (text) => streamed.push(text));
  output.line(JSON.stringify({ type: "assistant.message_delta", data: { deltaContent: "First." } }));
  output.line(JSON.stringify({ type: "assistant.message", data: { content: "First." } }));
  output.line(JSON.stringify({ type: "assistant.message", data: { content: "Second." } }));
  assert.equal(output.finish().text, "First.\n\nSecond.");
  assert.equal(streamed.join(""), "First.\n\nSecond.");
});
