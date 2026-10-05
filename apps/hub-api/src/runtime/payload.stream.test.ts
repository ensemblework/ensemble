/**
 * Streamed tool calls stay separate. Fixtures are shared with the agent-runtime
 * test. The Anthropic blocks are synthetic: there are no real Anthropic captures.
 * No network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FIXTURE_DIR, applyStreamEvent, fromOpenAi, newStreamState, streamStateToCompletion, type Json } from "./payload.js";

const recorded = JSON.parse(readFileSync(`${FIXTURE_DIR}/parallel_tool_stream.json`, "utf8")) as Record<string, Json[]>;
const followups = JSON.parse(readFileSync(`${FIXTURE_DIR}/stream_tool_followups.json`, "utf8")) as Record<string, Json[]>;

function replay(events: Json[]): { calls: Json[]; text: string } {
  const state = newStreamState();
  let text = "";
  for (const event of events) text += applyStreamEvent(state, event);
  const message = ((streamStateToCompletion(state, "mock").choices as Json[])[0]?.message ?? {}) as Json;
  return { calls: (message.tool_calls as Json[] | undefined) ?? [], text };
}

function parsedArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return raw;
  }
}

function brief(calls: Json[]): Array<{ id: string; name: string; arguments: unknown; signature?: unknown }> {
  return calls.map((call) => {
    const fn = (call.function ?? {}) as Json;
    const google = ((call.extra_content as Json | undefined)?.google ?? {}) as Json;
    return {
      id: String(call.id ?? ""),
      name: String(fn.name ?? ""),
      arguments: parsedArgs(String(fn.arguments ?? "")),
      signature: google.thought_signature,
    };
  });
}

const expected = [
  { id: "call_a", name: "hub_update_task", arguments: { id: "a" } },
  { id: "call_b", name: "hub_update_task", arguments: { id: "b" } },
];

test("parallel streamed tool calls stay separate", () => {
  for (const name of ["sameNameWithoutIndex", "sameChunkWithoutIndex", "idFragments", "openaiIndexes"] as const) {
    const { calls, text } = replay(recorded[name] ?? []);
    assert.deepEqual(
      brief(calls).map(({ id, name: callName, arguments: args }) => ({ id, name: callName, arguments: args })),
      expected,
      name,
    );
    if (name === "openaiIndexes") assert.equal(text, "Moving both.");
  }

  const unnamed = replay(recorded.nameStartsNewCall ?? []);
  assert.deepEqual(
    brief(unnamed.calls).map(({ name, arguments: args }) => ({ name, arguments: args })),
    [
      { name: "hub_update_task", arguments: { id: "a" } },
      { name: "hub_update_task", arguments: { id: "b" } },
    ],
  );

  for (const name of ["geminiParts", "geminiPartsOneChunk"] as const) {
    const { calls, text } = replay(recorded[name] ?? []);
    const parsed = brief(calls);
    assert.deepEqual(
      calls.map((call) => String(((call.function ?? {}) as Json).arguments ?? "")),
      ['{"id":"a"}', '{"id":"b"}'],
      name,
    );
    assert.deepEqual(
      parsed.map(({ name: callName, arguments: args, signature }) => ({ name: callName, arguments: args, signature })),
      [
        { name: "hub_update_task", arguments: { id: "a" }, signature: "sig-a" },
        { name: "hub_update_task", arguments: { id: "b" }, signature: "sig-b" },
      ],
      name,
    );
    if (name === "geminiParts") assert.equal(text, "Moving both.");
  }

  const repeated = brief(replay(recorded.geminiRepeatedPart ?? []).calls);
  assert.deepEqual(
    repeated.map(({ name, arguments: args, signature }) => ({ name, arguments: args, signature })),
    [
      { name: "hub_update_task", arguments: { id: "a" }, signature: "sig-a" },
      { name: "hub_update_task", arguments: { id: "b" }, signature: "sig-b" },
    ],
  );

  // Synthetic Anthropic stream. There is no real Anthropic capture on this project.
  const anthropic = replay(recorded.anthropicBlocks ?? []);
  assert.deepEqual(
    brief(anthropic.calls).map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
    [
      { id: "toolu_a", name: "hub_update_task", arguments: { id: "a" } },
      { id: "toolu_b", name: "hub_update_task", arguments: { id: "b" } },
    ],
    "synthetic Anthropic fixture",
  );
  assert.equal(anthropic.text, "Moving both.");
});

test("streamed tool-call follow-ups match the Python path", () => {
  // Real gemini-3.5-flash-lite OpenAI-compatible captures. Each call is whole,
  // has its own id, and has no tool-call index. The signature is only on the first.
  const captured = [
    {
      name: "twoTools",
      expected: [
        { id: "call_1476450", name: "hub_list_tasks", arguments: {} },
        { id: "call_1476453", name: "hub_list_projects", arguments: {} },
      ],
    },
    {
      name: "sameToolDiffArgs",
      expected: [
        { id: "call_2608831", name: "hub_create_task", arguments: { title: "Buy milk" } },
        { id: "call_2608832", name: "hub_create_task", arguments: { title: "Call mom" } },
      ],
    },
    {
      name: "sameToolSameArgs",
      expected: [
        { id: "call_1313370", name: "hub_create_task", arguments: { title: "Untitled" } },
        { id: "call_1313373", name: "hub_create_task", arguments: { title: "Untitled" } },
      ],
    },
  ] as const;
  for (const { name, expected } of captured) {
    const calls = brief(replay(followups[name] ?? []).calls);
    assert.equal(calls.length, 2, name);
    assert.ok(calls[0]?.signature);
    assert.equal(calls[1]?.signature, undefined);
    assert.deepEqual(
      calls.map(({ id, name: callName, arguments: args }) => ({ id, name: callName, arguments: args })),
      expected,
      name,
    );
  }

  const resent = replay(followups.sameIdResend ?? []).calls;
  assert.equal(resent.length, 1);
  assert.equal(String(resent[0]?.id), "call_1");
  assert.equal(String(((resent[0]?.function ?? {}) as Json).name), "hub_create_task");
  assert.equal(String(((resent[0]?.function ?? {}) as Json).arguments), '{"title":"B"}');

  const fragments = replay(followups.sameIdFragments ?? []).calls;
  assert.equal(fragments.length, 1);
  assert.equal(String(((fragments[0]?.function ?? {}) as Json).name), "hub_create_task");
  assert.equal(String(((fragments[0]?.function ?? {}) as Json).arguments), '{"title":"Buy milk"}');

  const placeholder = replay(followups.emptyObjectThenFragments ?? []).calls;
  assert.equal(placeholder.length, 1);
  assert.equal(String(((placeholder[0]?.function ?? {}) as Json).name), "hub_create_task");
  assert.equal(String(((placeholder[0]?.function ?? {}) as Json).arguments), '{"title":"Milk"}');

  const indexed = replay(followups.sameIndexDifferentIds ?? []).calls;
  assert.deepEqual(
    indexed.map((call) => {
      const fn = (call.function ?? {}) as Json;
      return { id: String(call.id), name: String(fn.name), arguments: String(fn.arguments) };
    }),
    [
      { id: "call_a", name: "hub_list_tasks", arguments: '{"x":' },
      { id: "call_b", name: "hub_list_projects", arguments: '{"y":1}' },
    ],
  );

  const mixed = brief(replay(followups.mixedIndexAndId ?? []).calls);
  assert.deepEqual(
    mixed.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
    [
      { id: "call_a", name: "hub_list_tasks", arguments: { status: "open" } },
      { id: "call_b", name: "hub_create_task", arguments: { title: "B" } },
      { id: "call_c", name: "hub_list_projects", arguments: {} },
    ],
  );

  const blank = replay(followups.blankFunctionCallId ?? []).calls;
  assert.deepEqual(
    blank.map((call) => {
      const fn = (call.function ?? {}) as Json;
      return { id: String(call.id), name: String(fn.name), arguments: String(fn.arguments) };
    }),
    [
      { id: "part_7", name: "hub_list_tasks", arguments: "{}" },
      { id: "call_real", name: "hub_list_projects", arguments: '{"q":1}' },
    ],
  );
});

test("a Gemini usageMetadata chunk is recorded like a non-streamed usage block", () => {
  const state = newStreamState();
  applyStreamEvent(state, { candidates: [{ content: { parts: [{ text: "Hi" }] } }] });
  applyStreamEvent(state, { usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4, totalTokenCount: 15 } });
  const done = streamStateToCompletion(state, "gemini-test");
  const usage = done.usage as Json;
  assert.equal(usage.prompt_tokens, 11);
  assert.equal(usage.completion_tokens, 4);
  const turn = fromOpenAi(done, "gemini-test");
  assert.equal(turn.tokensIn, 11);
  assert.equal(turn.tokensOut, 4);
  assert.equal(turn.text, "Hi");
});

test("gemini-2.5-flash usageMetadata is a real token count, and an empty usage object does not wipe it", () => {
  const state = newStreamState();
  applyStreamEvent(state, { model: "gemini-2.5-flash", choices: [{ delta: { content: "Hello" } }], usage: {} });
  applyStreamEvent(state, {
    model: "gemini-2.5-flash",
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: null, completion_tokens: null },
    usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 6, totalTokenCount: 24 },
  });
  applyStreamEvent(state, { usage: {} });
  const turn = fromOpenAi(streamStateToCompletion(state, "gemini-2.5-flash"), "gemini-2.5-flash");
  assert.equal(turn.model, "gemini-2.5-flash");
  assert.equal(turn.tokensIn, 18);
  assert.notEqual(turn.tokensIn, null);
  assert.equal(turn.tokensOut, 6);
  assert.notEqual(turn.tokensOut, null);
});
