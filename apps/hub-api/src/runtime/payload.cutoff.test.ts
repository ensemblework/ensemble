/**
 * Cut-off replies. The RECITATION streams are the real Gemini captures shared with
 * the Python agent. No network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FIXTURE_DIR,
  applyStreamEvent,
  feedSse,
  finishIsCutOff,
  fromAnthropic,
  fromOpenAi,
  newStreamState,
  streamStateToCompletion,
  type Json,
} from "./payload.js";

const captures = JSON.parse(readFileSync(`${FIXTURE_DIR}/recitation_cutoffs.json`, "utf8")) as Record<
  string,
  { text: string; finishReason: string; sse: string }
>;

function turnFromSse(block: string, model = "gemini-3.5-flash-lite"): Json {
  const state = newStreamState();
  feedSse(state, block);
  return fromOpenAi(streamStateToCompletion(state, model), model);
}

function turnFromEvents(events: Json[], model = "mock"): Json {
  const state = newStreamState();
  for (const event of events) applyStreamEvent(state, event);
  return fromOpenAi(streamStateToCompletion(state, model), model);
}

test("recitation captures are cut off and keep the partial text", () => {
  assert.deepEqual(Object.keys(captures).sort(), ["py-count-2", "py-count-3", "ts-count-1", "ts-count-2", "ts-count-3"]);
  for (const [name, capture] of Object.entries(captures)) {
    const turn = turnFromSse(capture.sse);
    assert.equal(turn.cutOff, true, name);
    assert.equal(turn.finishReason, "content_filter: RECITATION", name);
    assert.equal(turn.text, capture.text, name);
  }
});

test("length and a stream with no finish reason are cut off", () => {
  const length = turnFromEvents([
    { choices: [{ delta: { content: "one two three" } }] },
    { choices: [{ delta: {}, finish_reason: "length" }] },
  ]);
  assert.equal(length.cutOff, true);
  assert.equal(length.finishReason, "length");
  assert.equal(length.text, "one two three");

  const dropped = turnFromSse('data: {"choices":[{"delta":{"content":"Hello"}}]}\n');
  assert.equal(dropped.cutOff, true);
  assert.equal(dropped.finishReason, null);
  assert.equal(dropped.text, "Hello");

  const other = fromOpenAi(
    { choices: [{ message: { role: "assistant", content: "nope" }, finish_reason: "content_filter: OTHER" }] },
    "mock",
  );
  assert.equal(other.cutOff, true);
  assert.equal(other.finishReason, "content_filter: OTHER");

  const untouched = fromOpenAi({ choices: [{ message: { role: "assistant", content: "ready" } }] }, "mock");
  assert.equal(untouched.cutOff, false);
  assert.equal(untouched.finishReason, null);
});

test("normal finish reasons are not cut off", () => {
  const stop = turnFromEvents([{ choices: [{ delta: { content: "done" } }] }, { choices: [{ finish_reason: "stop" }] }]);
  assert.equal(stop.cutOff, false);
  assert.equal(stop.finishReason, "stop");
  assert.equal(stop.text, "done");

  const tools = turnFromEvents([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "hub_list_tasks", arguments: "{}" } }] } }] },
    { choices: [{ finish_reason: "tool_calls" }] },
  ]);
  assert.equal(tools.cutOff, false);
  assert.equal(tools.finishReason, "tool_calls");
  assert.equal((tools.toolCalls as Json[])[0]?.name, "hub_list_tasks");

  const legacy = fromOpenAi(
    { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "function_call" }] },
    "mock",
  );
  assert.equal(legacy.cutOff, false);
  assert.equal(legacy.finishReason, "function_call");

  for (const reason of ["end_turn", "tool_use", "stop_sequence"]) {
    const turn = turnFromEvents([
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "message_delta", delta: { stop_reason: reason } },
    ]);
    assert.equal(turn.cutOff, false, reason);
    assert.equal(turn.finishReason, reason);
    assert.equal(turn.text, "ok");
  }

  const nativeStop = turnFromEvents([{ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] }]);
  assert.equal(nativeStop.cutOff, false);
  assert.equal(nativeStop.finishReason, "STOP");
  for (const reason of ["RECITATION", "MAX_TOKENS", "SAFETY"]) {
    const native = turnFromEvents([{ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: reason }] }]);
    assert.equal(native.cutOff, true, reason);
    assert.equal(native.finishReason, reason);
  }

  const ollamaStop = turnFromEvents([{ done: true, done_reason: "stop" }]);
  assert.equal(ollamaStop.cutOff, false);
  assert.equal(ollamaStop.finishReason, "stop");
  const ollamaLength = turnFromEvents([{ done_reason: "length" }]);
  assert.equal(ollamaLength.cutOff, true);
  assert.equal(ollamaLength.finishReason, "length");

  const anthropic = fromAnthropic(
    { model: "claude", stop_reason: "end_turn", content: [{ type: "text", text: "ready" }], usage: {} },
    "claude",
  );
  assert.equal(anthropic.cutOff, false);
  assert.equal(anthropic.finishReason, "end_turn");
  const toolUse = fromAnthropic(
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_1", name: "hub_list_tasks", input: {} }] },
    "claude",
  );
  assert.equal(toolUse.cutOff, false);
  assert.equal(toolUse.finishReason, "tool_use");
  const limited = fromAnthropic({ stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }] }, "claude");
  assert.equal(limited.cutOff, true);
  assert.equal(limited.finishReason, "max_tokens");
  assert.equal(finishIsCutOff("stop", "anthropic"), true);
  assert.equal(finishIsCutOff("end_turn", "openai"), true);
});
