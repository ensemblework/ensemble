/**
 * Included models on the in-process runtime: request shapes, usage, the thinking replay, and the
 * credits ledger around each call. Azure and the ledger are faked. No network, no database.
 */
import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { INCLUDED_CREDITS_USED, INCLUDED_EFFORTS, INCLUDED_MODELS, INCLUDED_UNAVAILABLE, type IncludedModel } from "@ensemble/shared-types";
import { setIncludedBudgetForTests } from "../included/budget.js";
import { IncludedLimitError } from "../included/errors.js";
import type { IncludedTokens } from "../included/pricing.js";
import { PROVIDERS } from "./credentials.js";
import { dispatchRuntime } from "./dispatch.js";
import { ProviderError, noKeyMessage } from "./errors.js";
import { INCLUDED_HOSTED_ONLY, anthropicUsage, chatUsage, clearIncludedThinkingForTests, rememberTurn, responsesUsage, withoutThinking } from "./included.js";
import { completeText, completeWithTools, setRuntimeFetchForTests, streamWithTools } from "./models.js";
import { resetBuckets, setRuntimeSleepForTests } from "./pace.js";
import type { Json } from "./payload.js";

const KEY = "azure-test-key";
const RESETS = "2026-11-01T00:00:00.000Z";
const TOOLS = [{ type: "function", function: { name: "hub_list_tasks", description: "List tasks", parameters: { type: "object", properties: { limit: { type: "integer" } } } } }];
const GPT_REPLY = {
  status: "completed",
  model: "gpt-6.1-sol-2026-09-29",
  output: [
    { type: "reasoning", id: "rs_1", summary: [] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"ok": true}' }] },
  ],
  usage: { input_tokens: 5000, input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 600 }, output_tokens: 20 },
};
const GROK_REPLY = {
  status: "completed",
  model: "grok-4.7",
  output: [{ type: "function_call", call_id: "call_1", name: "hub_list_tasks", arguments: '{"limit":5}' }],
  usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 512 }, output_tokens: 70 },
};
const DEEPSEEK_REPLY = {
  model: "DeepSeek-V4-Flash",
  choices: [
    {
      message: {
        role: "assistant",
        content: "Looking.",
        reasoning_content: "They want tasks.",
        tool_calls: [{ id: "call_9", type: "function", function: { name: "hub_list_tasks", arguments: '{"limit":5}' } }],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1024 } },
};
const CLAUDE_CONTENT = [
  { type: "thinking", thinking: "The person wants their tasks.", signature: "sig-abc" },
  { type: "text", text: "Looking." },
  { type: "tool_use", id: "toolu_1", name: "hub_list_tasks", input: { limit: 5 } },
];
const CLAUDE_REPLY = {
  model: "claude-haiku-5-5-20261001",
  content: CLAUDE_CONTENT,
  stop_reason: "tool_use",
  usage: { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 50 },
};
const CLAUDE_DONE = { model: "claude-haiku-5-5-20261001", content: [{ type: "text", text: "You have two tasks." }], stop_reason: "end_turn", usage: { input_tokens: 40, output_tokens: 8 } };
/** A Claude deployment on Foundry's Anthropic endpoint. No model in the catalog uses it today. */
const CLAUDE: IncludedModel = {
  id: "claude-haiku-5-5",
  label: "Claude Haiku 5.5",
  vendor: "Anthropic",
  api: "anthropic",
  host: "services",
  azureVersion: null,
  efforts: INCLUDED_EFFORTS,
  autoEffort: "medium",
  relativeCost: 1,
  role: "everyday",
  offeredByDefault: true,
};
const ENV = ["AZURE_FOUNDRY_RESOURCE", "AZURE_FOUNDRY_API_KEY", "ENSEMBLE_INCLUDED_MODELS", "ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS"] as const;
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
const catalog = INCLUDED_MODELS as IncludedModel[];

type Sent = { url: string; headers: Record<string, string>; body: Json };
type Answer = (body: Json, init: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Azure: each request takes the next answer; the last one repeats. */
function azure(...answers: Answer[]): Sent[] {
  const sent: Sent[] = [];
  setRuntimeFetchForTests(async (input, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Json) : {};
    sent.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    return answer(body, init ?? {});
  });
  return sent;
}

type Settled = { id: string; usage: IncludedTokens | null; answeredBy?: string | null };

function ledger(options: { refuse?: IncludedLimitError; settleFails?: boolean } = {}) {
  const book = { reserves: [] as Array<Record<string, unknown>>, settles: [] as Settled[] };
  setIncludedBudgetForTests({
    reserve: async (args) => {
      book.reserves.push(args);
      if (options.refuse) throw options.refuse;
      return { id: `res-${book.reserves.length}` };
    },
    settle: async (args) => {
      book.settles.push(args);
      if (options.settleFails) throw new Error("ledger down");
      return { credits: 1.25 };
    },
  });
  return book;
}

function withClaude(): void {
  catalog.push(CLAUDE);
}

async function frames(body: Json): Promise<Array<{ event: string; data: Json }>> {
  const out: Array<{ event: string; data: Json }> = [];
  for await (const frame of streamWithTools(body)) {
    const event = frame.split("\n", 1)[0]!.replace("event: ", "");
    out.push({ event, data: JSON.parse(frame.split("data:")[1]!) as Json });
  }
  return out;
}

test.beforeEach(() => {
  process.env.ENSEMBLE_INPROCESS_RUNTIME = "1";
  process.env.AZURE_FOUNDRY_RESOURCE = "ensemble-ai";
  process.env.AZURE_FOUNDRY_API_KEY = KEY;
  delete process.env.ENSEMBLE_INCLUDED_MODELS;
  delete process.env.ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS;
  resetBuckets();
  clearIncludedThinkingForTests();
  setRuntimeSleepForTests(async () => undefined);
});

test.afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  const stub = catalog.indexOf(CLAUDE);
  if (stub >= 0) catalog.splice(stub, 1);
  setRuntimeFetchForTests(null);
  setRuntimeSleepForTests(null);
  setIncludedBudgetForTests(null);
});

test("GPT-6 Luna goes to Responses on the openai host, and the reservation counts every byte sent", async () => {
  const sent = azure(() => json(GPT_REPLY));
  const book = ledger();
  const turn = await completeWithTools({
    provider: "ensemble",
    model: "gpt-6-luna",
    userId: "u1",
    reasoningEffort: "low",
    purpose: "Hub chat",
    fallbackModel: "gpt-6.1-sol",
    messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Grüße, 東京 — wie geht's?" }],
    chatTools: TOOLS,
  });
  assert.equal(sent.length, 1);
  const call = sent[0]!;
  assert.equal(call.url, "https://ensemble-ai.openai.azure.com/openai/v1/responses");
  assert.equal(call.headers["api-key"], KEY);
  assert.equal("authorization" in call.headers || "anthropic-version" in call.headers, false);
  assert.equal(call.body.model, "gpt-6-luna");
  assert.equal(call.body.max_output_tokens, 16000);
  assert.deepEqual(call.body.reasoning, { effort: "low" });
  assert.equal(call.body.store, false);
  assert.equal(((call.body.tools as Json[])[0] as Json).name, "hub_list_tasks");
  for (const field of ["temperature", "top_p", "messages"]) assert.equal(field in call.body, false, field);
  const bytes = Buffer.byteLength(JSON.stringify(call.body), "utf8");
  assert.ok(bytes > JSON.stringify(call.body).length, "non-ASCII text counts every UTF-8 byte");
  assert.deepEqual(book.reserves, [{ userId: "u1", model: "gpt-6-luna", inputTokens: bytes, maxOutputTokens: 16000, purpose: "Hub chat" }]);
  assert.deepEqual(book.settles, [
    { id: "res-1", usage: { inputTokens: 5000, cacheReadTokens: 4000, cacheWriteTokens: 600, outputTokens: 20 }, answeredBy: "gpt-6.1-sol-2026-09-29" },
  ]);
  assert.deepEqual([turn.tokensIn, turn.tokensOut, turn.credits], [5000, 20, 1.25]);
});

test("Grok goes to Responses on the services host with the operator's cap", async () => {
  process.env.ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS = "32000";
  const sent = azure(() => json(GROK_REPLY));
  const book = ledger();
  const turn = await completeWithTools({ provider: "ensemble", model: "grok-4.7", userId: "u1", reasoningEffort: "medium", messages: [{ role: "user", content: "My tasks?" }], chatTools: TOOLS });
  const call = sent[0]!;
  assert.equal(call.url, "https://ensemble-ai.services.ai.azure.com/openai/v1/responses");
  assert.equal(call.headers["api-key"], KEY);
  assert.equal(call.body.max_output_tokens, 32000, "the operator's cap is what Azure gets");
  assert.equal(book.reserves[0]!.maxOutputTokens, 32000, "and what the reservation holds");
  assert.deepEqual(call.body.reasoning, { effort: "medium" });
  assert.deepEqual(book.settles[0]!.usage, { inputTokens: 900, cacheReadTokens: 512, cacheWriteTokens: 0, outputTokens: 70 });
  assert.deepEqual(turn.toolCalls, [{ id: "call_1", name: "hub_list_tasks", arguments: '{"limit":5}' }]);
  assert.deepEqual([turn.model, turn.finishReason], ["grok-4.7", "tool_calls"]);
});

test("a level the model does not take is not sent", async () => {
  const sent = azure(() => json(GPT_REPLY));
  ledger();
  await completeText({ provider: "ensemble", model: "gpt-6-luna", userId: "u1", reasoningEffort: "xhigh", prompt: "Hi" });
  assert.equal("reasoning" in sent[0]!.body, false);
});

test("DeepSeek goes to Chat Completions on the services host, with no thinking level", async () => {
  const sent = azure(() => json(DEEPSEEK_REPLY));
  const book = ledger();
  const turn = await completeWithTools({
    provider: "ensemble",
    model: "deepseek-v4-flash",
    userId: "u1",
    reasoningEffort: "high",
    messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "My tasks?" }],
    chatTools: TOOLS,
    responsesMessages: [{ role: "user", content: "ignored" }],
  });
  const call = sent[0]!;
  assert.equal(call.url, "https://ensemble-ai.services.ai.azure.com/openai/v1/chat/completions");
  assert.equal(call.headers["api-key"], KEY);
  assert.equal(call.body.model, "deepseek-v4-flash");
  assert.deepEqual(call.body.messages, [{ role: "system", content: "Be brief." }, { role: "user", content: "My tasks?" }]);
  assert.deepEqual(call.body.tools, TOOLS);
  assert.equal(call.body.tool_choice, "auto");
  assert.equal(call.body.max_completion_tokens, 16000);
  for (const field of ["reasoning_effort", "reasoning", "temperature", "top_p", "response_format", "max_tokens"]) assert.equal(field in call.body, false, field);
  assert.equal(book.reserves[0]!.maxOutputTokens, 16000);
  assert.deepEqual(book.settles[0]!.usage, { inputTokens: 1200, cacheReadTokens: 1024, cacheWriteTokens: 0, outputTokens: 30 });
  assert.equal(turn.text, "Looking.");
  assert.equal(turn.reasoning, "They want tasks.");
  assert.deepEqual(turn.toolCalls, [{ id: "call_9", name: "hub_list_tasks", arguments: '{"limit":5}' }]);
  assert.deepEqual([turn.model, turn.tokensIn, turn.tokensOut, turn.credits, turn.cutOff], ["DeepSeek-V4-Flash", 1200, 30, 1.25, false]);
});

test("DeepSeek JSON mode, and its own cache field", async () => {
  const reply = {
    model: "DeepSeek-V4-Flash",
    choices: [{ message: { role: "assistant", content: '{"ok": true}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 800, completion_tokens: 6, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 160 },
  };
  const sent = azure(() => json(reply));
  const book = ledger();
  const result = await completeText({ provider: "ensemble", model: "deepseek-v4-flash", userId: "u1", system: "Return JSON.", prompt: "Ok?", json: true, temperature: 0 });
  assert.deepEqual(sent[0]!.body.response_format, { type: "json_object" });
  assert.equal("temperature" in sent[0]!.body, false);
  assert.deepEqual(book.settles[0]!.usage, { inputTokens: 800, cacheReadTokens: 640, cacheWriteTokens: 0, outputTokens: 6 });
  assert.deepEqual([result.json, result.credits], [{ ok: true }, 1.25]);
});

test("GPT JSON mode reads back with its credits", async () => {
  const sent = azure(() => json(GPT_REPLY));
  ledger();
  const result = await completeText({ provider: "ensemble", model: "gpt-6.1-sol", userId: "u1", reasoningEffort: "high", system: "Return JSON.", prompt: "Is it ok?", json: true, temperature: 0 });
  const call = sent[0]!;
  assert.equal(call.url, "https://ensemble-ai.openai.azure.com/openai/v1/responses");
  assert.deepEqual(call.body.text, { format: { type: "json_object" } });
  assert.deepEqual(call.body.input, [{ role: "system", content: "Return JSON." }, { role: "user", content: "Is it ok?" }]);
  assert.equal("temperature" in call.body, false);
  assert.deepEqual(result.json, { ok: true });
  assert.deepEqual([result.tokensIn, result.tokensOut, result.credits, result.model], [5000, 20, 1.25, "gpt-6.1-sol-2026-09-29"]);
});

test("a streamed included turn sends deltas, then the turn with its credits", async () => {
  azure(() => json({ ...GPT_REPLY, output: [{ type: "message", content: [{ type: "output_text", text: "Hello there." }] }] }));
  ledger();
  const out = await frames({ provider: "ensemble", model: "gpt-6-luna", userId: "u1", messages: [{ role: "user", content: "Hi" }], chatTools: TOOLS });
  assert.equal(out.filter((frame) => frame.event === "delta").map((frame) => frame.data.text).join(""), "Hello there.");
  assert.equal(out.find((frame) => frame.event === "turn")?.data.credits, 1.25);
});

test("a refused reservation never reaches Azure and keeps its code and reset time", async () => {
  const sent = azure(() => json(GPT_REPLY));
  const refusal = new IncludedLimitError(INCLUDED_CREDITS_USED, "You've used this month's Ensemble credits.", RESETS);
  const book = ledger({ refuse: refusal });
  const out = await frames({ provider: "ensemble", model: "grok-4.7", userId: "u1", messages: [{ role: "user", content: "Hi" }] });
  assert.deepEqual(out, [{ event: "error", data: { message: refusal.message, kind: "credits", status: 429, code: INCLUDED_CREDITS_USED, resetsAt: RESETS } }]);
  await assert.rejects(completeWithTools({ provider: "ensemble", model: "grok-4.7", userId: "u1", messages: [{ role: "user", content: "Hi" }] }), (error) => error === refusal);
  await assert.rejects(dispatchRuntime("/api/complete", { method: "POST", json: { provider: "ensemble", model: "deepseek-v4-flash", userId: "u1", prompt: "Hi" } }), (error) => error === refusal, "not wrapped as a generic 502");
  assert.equal(sent.length, 0);
  assert.equal(book.settles.length, 0);
});

test("a provider error after its retries settles at zero, on one reservation", async () => {
  const sent = azure(() => json({ error: { message: "Internal server error" } }, 500));
  const book = ledger();
  await assert.rejects(completeWithTools({ provider: "ensemble", model: "deepseek-v4-flash", userId: "u1", messages: [{ role: "user", content: "Hi" }] }), (error) => error instanceof ProviderError && error.status === 500);
  assert.equal(sent.length, 3);
  assert.equal(book.reserves.length, 1);
  assert.deepEqual(book.settles, [{ id: "res-1", usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, answeredBy: null }]);
});

test("Claude goes to Foundry's Messages endpoint, and every input token is reported", async () => {
  withClaude();
  const sent = azure(() => json(CLAUDE_REPLY));
  const book = ledger();
  const turn = await completeWithTools({
    provider: "ensemble",
    model: "claude-haiku-5-5",
    userId: "u1",
    reasoningEffort: "low",
    messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "My tasks?" }],
    chatTools: TOOLS,
  });
  const call = sent[0]!;
  assert.equal(call.url, "https://ensemble-ai.services.ai.azure.com/anthropic/v1/messages");
  assert.equal(call.headers["api-key"], KEY);
  assert.equal(call.headers["anthropic-version"], "2023-06-01");
  assert.equal("x-api-key" in call.headers || "authorization" in call.headers, false);
  assert.equal(call.body.max_tokens, 16000);
  assert.deepEqual(call.body.output_config, { effort: "low" });
  assert.equal(call.body.system, "Be brief.");
  assert.deepEqual(((call.body.tools as Json[])[0]!.input_schema as Json).properties, { limit: { type: "integer" } });
  for (const field of ["temperature", "top_p", "thinking"]) assert.equal(field in call.body, false, field);
  assert.deepEqual(book.settles, [
    { id: "res-1", usage: { inputTokens: 2400, cacheReadTokens: 2000, cacheWriteTokens: 300, outputTokens: 50 }, answeredBy: "claude-haiku-5-5-20261001" },
  ]);
  assert.deepEqual([turn.tokensIn, turn.tokensOut, turn.credits, turn.finishReason], [2400, 50, 1.25, "tool_use"]);
});

test("thinking blocks go back to Claude on the next tool round, and only for the same account", async () => {
  withClaude();
  const sent = azure(() => json(CLAUDE_REPLY), () => json(CLAUDE_DONE));
  ledger();
  const first = await completeWithTools({ provider: "ensemble", model: "claude-haiku-5-5", userId: "u1", messages: [{ role: "user", content: "My tasks?" }], chatTools: TOOLS });
  const echoed = ((first.raw as Json).choices as Json[])[0]!.message as Json;
  const history = [
    { role: "user", content: "My tasks?" },
    { role: "assistant", content: echoed.content, tool_calls: echoed.tool_calls },
    { role: "tool", tool_call_id: "toolu_1", name: "hub_list_tasks", content: "[]" },
  ];
  await completeWithTools({ provider: "ensemble", model: "claude-haiku-5-5", userId: "u1", messages: history, chatTools: TOOLS });
  const replayed = sent[1]!.body.messages as Json[];
  assert.deepEqual(replayed[1], { role: "assistant", content: CLAUDE_CONTENT }, "the turn goes back exactly as Claude wrote it, signature included");
  assert.deepEqual((replayed[2]!.content as Json[])[0], { type: "tool_result", tool_use_id: "toolu_1", content: "[]" });
  await completeWithTools({ provider: "ensemble", model: "claude-haiku-5-5", userId: "u2", messages: history, chatTools: TOOLS });
  const other = ((sent[2]!.body.messages as Json[])[1]!.content as Json[]).map((block) => block.type);
  assert.deepEqual(other, ["text", "tool_use"], "another account never gets this account's turn");
});

test("a thinking refusal retries Claude once without thinking, on the same reservation", async () => {
  withClaude();
  rememberTurn("u1", CLAUDE_CONTENT);
  const refusal = { type: "error", error: { type: "invalid_request_error", message: "messages.1.content.0: Invalid `signature` in `thinking` block" } };
  const sent = azure(() => json(refusal, 400), () => json(CLAUDE_DONE));
  const book = ledger();
  const turn = await completeWithTools({
    provider: "ensemble",
    model: "claude-haiku-5-5",
    userId: "u1",
    messages: [
      { role: "user", content: "My tasks?" },
      { role: "assistant", content: "Looking.", tool_calls: [{ id: "toolu_1", type: "function", function: { name: "hub_list_tasks", arguments: '{"limit": 5}' } }] },
      { role: "tool", tool_call_id: "toolu_1", content: "[]" },
    ],
  });
  assert.equal(sent.length, 2);
  const [tried, retried] = sent.map((call) => call.body);
  assert.equal((((tried!.messages as Json[])[1]!.content as Json[])[0] as Json).type, "thinking");
  assert.equal("thinking" in tried!, false);
  assert.deepEqual(((retried!.messages as Json[])[1]!.content as Json[]).map((block) => block.type), ["text", "tool_use"]);
  assert.deepEqual(retried!.thinking, { type: "disabled" });
  assert.equal(turn.text, "You have two tasks.");
  assert.equal(book.reserves.length, 1);
  assert.equal(book.settles.length, 1);
  assert.equal(book.settles[0]!.usage?.inputTokens, 40);
  const sonnet = withoutThinking({ model: "claude-sonnet-5-5", messages: [{ role: "assistant", content: [CLAUDE_CONTENT[0]] }] });
  assert.deepEqual(sonnet.thinking, { type: "between_tools" });
  assert.deepEqual((sonnet.messages as Json[])[0]!.content, [{ type: "text", text: "" }]);
});

test("a 400 is not retried for another reason or another model", async () => {
  withClaude();
  const sent = azure(() => json({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } }, 400));
  const book = ledger();
  await assert.rejects(completeWithTools({ provider: "ensemble", model: "claude-haiku-5-5", userId: "u1", messages: [{ role: "user", content: "Hi" }] }), ProviderError);
  const again = azure(() => json({ error: { message: "Invalid thinking signature" } }, 400));
  await assert.rejects(completeWithTools({ provider: "ensemble", model: "grok-4.7", userId: "u1", messages: [{ role: "user", content: "Hi" }] }), ProviderError);
  assert.equal(sent.length, 1);
  assert.equal(again.length, 1, "only Claude has thinking blocks to drop");
  assert.equal(book.settles.length, 2);
});

test("a failed settlement still returns the turn", async () => {
  azure(() => json(GPT_REPLY));
  ledger({ settleFails: true });
  const turn = await completeWithTools({ provider: "ensemble", model: "gpt-6-luna", userId: "u1", messages: [{ role: "user", content: "Hi" }] });
  assert.equal(turn.credits, null);
  assert.equal(turn.text, '{"ok": true}');
});

test("a cancelled call settles without usage", async () => {
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => (started = resolve));
  azure((_body, init) => {
    started();
    return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  });
  const book = ledger();
  const stop = new AbortController();
  const call = completeText({ provider: "ensemble", model: "gpt-6-luna", userId: "u1", prompt: "Hi" }, { signal: stop.signal });
  await waiting;
  stop.abort();
  await assert.rejects(call);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(book.settles, [{ id: "res-1", usage: null, answeredBy: null }]);
});

test("included needs the server set up; a paired computer says so", async () => {
  const sent = azure(() => json(GPT_REPLY));
  const book = ledger();
  const body = { provider: "ensemble", model: "gpt-6-luna", userId: "u1", prompt: "Hi" };
  process.env.ENSEMBLE_INCLUDED_MODELS = "grok-4.7";
  await assert.rejects(completeText(body), /GPT-6 Luna \(2026-09-22\) is not offered/);
  delete process.env.ENSEMBLE_INCLUDED_MODELS;
  delete process.env.AZURE_FOUNDRY_API_KEY;
  await assert.rejects(completeText(body), (error) => {
    assert.ok(error instanceof IncludedLimitError);
    assert.deepEqual([error.code, error.statusCode, error.message], [INCLUDED_UNAVAILABLE, 503, INCLUDED_HOSTED_ONLY]);
    return true;
  });
  assert.equal(sent.length, 0);
  assert.equal(book.reserves.length, 0);
});

test("ensemble is named but is never a stored credential", () => {
  assert.equal(noKeyMessage("ensemble"), "Included AI is not set up on this server. Add your own API key or AI plan in Settings → Models.");
  assert.equal((PROVIDERS as readonly string[]).includes("ensemble"), false);
  assert.deepEqual(anthropicUsage({ input_tokens: 3 }), { inputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  assert.deepEqual(responsesUsage(null), { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  assert.deepEqual(chatUsage({ prompt_tokens: 5 }), { inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
});
