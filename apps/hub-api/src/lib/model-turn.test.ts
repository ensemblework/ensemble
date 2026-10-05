import assert from "node:assert/strict";
import test from "node:test";
import { ModelQuotaError } from "./model-quota.js";
import { RuntimeError } from "./runtime.js";
import { assistantEcho, errorFromStreamFrame, prepareProviderMessages, type RuntimeTurn } from "./model-turn.js";

test("assistantEcho keeps a streamed thought signature", () => {
  const signature = "sig-from-stream";
  const turn: RuntimeTurn = {
    text: "",
    toolCalls: [{ id: "call_sig", name: "hub_list_tasks", arguments: "{}" }],
    model: "gemini-3.5-flash",
    credits: null,
    tokensIn: null,
    tokensOut: null,
    reasoning: "",
    finishReason: null,
    cutOff: false,
    raw: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_sig",
                type: "function",
                extra_content: { google: { thought_signature: signature } },
                function: { name: "hub_list_tasks", arguments: "{}" },
              },
            ],
          },
        },
      ],
    },
  };
  const echoed = assistantEcho(turn);
  const calls = echoed.tool_calls as Array<{ extra_content?: { google?: { thought_signature?: string } } }>;
  assert.equal(calls[0]?.extra_content?.google?.thought_signature, signature);
});

test("a failed tool beside a proposal is a complete Gemini turn", () => {
  const signature = "sig-parallel";
  const messages = prepareProviderMessages([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_bad",
          type: "function",
          function: { name: "hub_update_task", arguments: "{\"projectName\":\"Core Platform\"}" },
        },
        {
          id: "call_ok",
          type: "function",
          extra_content: { google: { thought_signature: signature } },
          function: { name: "hub_update_task", arguments: "{\"status\":\"in_progress\"}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_bad",
      name: "hub_update_task",
      content: JSON.stringify({
        error: "No project named “Core Platform”.",
        hint: "Ask the user a question instead of proposing this write.",
      }),
    },
  ]);
  const assistant = messages[0] as { content: unknown; tool_calls: Array<{ id: string; extra_content?: { google?: { thought_signature?: string } } }> };
  assert.equal(assistant.content, null);
  assert.equal(assistant.tool_calls[0]?.extra_content?.google?.thought_signature, signature);
  const responses = messages.filter((message) => message.role === "tool");
  assert.deepEqual(
    responses.map((message) => message.tool_call_id),
    ["call_bad", "call_ok"],
  );
  assert.match(String(responses[0]?.content), /Core Platform/);
  assert.match(String(responses[1]?.content), /did not return/);
  assert.equal(responses.every((message) => String(message.content).trim().length > 0), true);
});

function parallelTurn(name: string, firstId: string, secondId: string, firstBody: string, secondBody: string) {
  const signature = "sig-on-second-only";
  return prepareProviderMessages([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: firstId, type: "function", function: { name, arguments: "{}" } },
        { id: "call_middle", type: "function", function: { name, arguments: "{}" } },
        {
          id: secondId,
          type: "function",
          extra_content: { google: { thought_signature: signature } },
          function: { name, arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: firstId, name, content: firstBody },
    { role: "tool", tool_call_id: secondId, name, content: secondBody },
  ]);
}

test("two board moves and two deletes are complete Gemini turns", () => {
  for (const [name, first, second] of [
    ["hub_update_task", JSON.stringify({ ok: true, status: "in_progress" }), JSON.stringify({ ok: true, status: "done" })],
    ["hub_delete_task", JSON.stringify({ ok: true }), JSON.stringify({ ok: true })],
  ] as const) {
    const messages = parallelTurn(name, "call_a", "call_b", first, second);
    const assistant = messages[0] as {
      content: unknown;
      tool_calls: Array<{ id: string; extra_content?: { google?: { thought_signature?: string } } }>;
    };
    assert.equal(assistant.content, null);
    assert.equal(assistant.tool_calls.length, 3);
    assert.equal(
      assistant.tool_calls.every((call) => call.extra_content?.google?.thought_signature === "sig-on-second-only"),
      true,
    );
    const responses = messages.filter((message) => message.role === "tool");
    assert.deepEqual(
      responses.map((message) => message.tool_call_id),
      ["call_a", "call_middle", "call_b"],
    );
    assert.equal(String(responses[0]?.content), first);
    assert.equal(String(responses[2]?.content), second);
    assert.match(String(responses[1]?.content), /did not return/);
    assert.equal(responses.every((message) => String(message.content).trim().length > 0), true);
  }
});

test("a quota stream frame is model_quota_exceeded and not a generic 502", () => {
  const now = new Date("2026-10-04T20:30:00.000Z");
  const quota = errorFromStreamFrame(
    { message: "Resource exhausted", kind: "quota", status: 429, retryAfterSeconds: 30 },
    "gemini-3.5-flash",
    now,
  );
  assert.ok(quota instanceof ModelQuotaError);
  assert.equal(quota.statusCode, 429);
  assert.equal(quota.code, "model_quota_exceeded");
  assert.equal(quota.model, "gemini-3.5-flash");
  assert.equal(quota.resetsAt, "2026-10-04T20:30:30.000Z");
  assert.match(quota.message, /gemini-3.5-flash is out of quota until/);

  const daily = errorFromStreamFrame({ message: "RESOURCE_EXHAUSTED", kind: "quota", status: 429 }, "gemini-3.5-flash-lite", now);
  assert.ok(daily instanceof ModelQuotaError);
  assert.equal(daily.resetsAt, "2026-10-05T07:00:00.000Z");

  const limited = errorFromStreamFrame(
    { message: "slow down", kind: "rate_limit", status: 429, retryAfterSeconds: 2 },
    "gemini-3.5-flash",
    now,
  );
  assert.equal(limited instanceof ModelQuotaError, false);
  assert.ok(limited instanceof RuntimeError);
  assert.equal(limited.statusCode, 429);

  const other = errorFromStreamFrame({ message: "boom", kind: "other", status: 500 }, "gemini-3.5-flash", now);
  assert.equal(other.statusCode, 502);
});
