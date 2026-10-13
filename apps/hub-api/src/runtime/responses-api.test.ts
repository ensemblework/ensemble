/**
 * Copilot models served only on /responses (gpt-5.4, gpt-5.4-mini, the codex models): sent there,
 * read back as one turn, streamed, and learned from a refusal that names the endpoint. HTTP is mocked.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setCredentialResolverForTests, type Credential } from "./credentials.js";
import { ProviderError } from "./errors.js";
import { catalog, clearCatalogCache, completeText, completeWithTools, setRuntimeFetchForTests, streamWithTools } from "./models.js";
import { resetBuckets, setRuntimeSleepForTests } from "./pace.js";
import { apiFor, cleanItems, forgetLearnedForTests, otherEndpoint } from "./responses-api.js";

const REFUSAL = { error: { message: 'model "gpt-5.4-mini" is not accessible via the /chat/completions endpoint', code: "model_not_supported", type: "invalid_request_error" } };
const RESPONSE = {
  id: "resp_1",
  status: "completed",
  model: "gpt-5.4-mini",
  output: [
    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Thinking about it." }] },
    { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Hello from Copilot." }] },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "hub_list_tasks", arguments: '{"limit":5}' },
  ],
  usage: { input_tokens: 12, output_tokens: 7 },
};
const STREAM = [
  { type: "response.created", response: { id: "resp_2" } },
  { type: "response.output_text.delta", delta: "Hel" },
  { type: "response.output_text.delta", delta: "lo." },
  { type: "response.completed", response: { ...RESPONSE, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello." }] }] } },
];

type Call = { url: string; body: Record<string, unknown> };

function install(): Call[] {
  const calls: Call[] = [];
  setRuntimeFetchForTests(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, body });
    if (url.endsWith("/chat/completions")) {
      if (body.model === "gpt-5.4-mini") return new Response(JSON.stringify(REFUSAL), { status: 400, headers: { "content-type": "application/json" } });
      const reply = { model: body.model, choices: [{ message: { role: "assistant", content: "chat answer" }, finish_reason: "stop" }], usage: {} };
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/responses")) {
      if (body.stream) return new Response(STREAM.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
      return new Response(JSON.stringify(RESPONSE), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/models")) {
      const rows = [
        { id: "gpt-5.4-mini", supported_endpoints: ["/responses"], capabilities: { type: "chat", supports: { reasoning_effort: ["low"] } } },
        { id: "claude-sonnet-4.6", capabilities: { type: "chat", supports: {} } },
        { id: "text-embedding-3-small", capabilities: { type: "embeddings" } },
      ];
      return new Response(JSON.stringify({ data: rows }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  });
  return calls;
}

const endpoints = (calls: Call[]) => calls.map((call) => call.url.split("/").pop());

test.beforeEach(() => {
  process.env.ENSEMBLE_INPROCESS_RUNTIME = "1";
  resetBuckets();
  clearCatalogCache();
  forgetLearnedForTests();
  setRuntimeSleepForTests(async () => undefined);
  setCredentialResolverForTests(async (_userId, provider): Promise<Credential> => ({ provider, secret: "github_pat_fine", source: "you", baseUrl: null }));
});

test.afterEach(() => {
  setRuntimeFetchForTests(null);
  setCredentialResolverForTests(null);
  setRuntimeSleepForTests(null);
  forgetLearnedForTests();
});

test("a gpt-5 model on Copilot goes to /responses and comes back as one turn", async () => {
  const calls = install();
  const turn = await completeWithTools({
    provider: "copilot",
    model: "gpt-5.4-mini",
    userId: "u1",
    reasoningEffort: "low",
    messages: [{ role: "user", content: "Hi" }],
    responsesMessages: [
      { role: "user", content: "Hi" },
      { type: "reasoning", id: "rs_0", summary: [] },
      { type: "function_call", id: "fc_0", call_id: "call_0", name: "hub_get_task", arguments: "{}" },
      { type: "function_call_output", call_id: "call_0", output: "{}" },
    ],
    chatTools: [{ type: "function", function: { name: "hub_list_tasks", description: "List", parameters: { type: "object", properties: {} } } }],
    responsesTools: [{ type: "function", name: "hub_list_tasks", description: "List", parameters: { type: "object", properties: {} } }],
  });
  assert.deepEqual(endpoints(calls), ["responses"]);
  const sent = calls[0]!.body as { store: boolean; reasoning: unknown; tools: Array<{ name: string }>; input: Array<Record<string, unknown>> };
  assert.equal(sent.store, false);
  assert.deepEqual(sent.reasoning, { effort: "low" });
  assert.equal(sent.tools[0]?.name, "hub_list_tasks");
  assert.equal(sent.input.some((item) => item.type === "reasoning"), false, "reasoning items are not sent back with store off");
  assert.equal(turn.text, "Hello from Copilot.");
  assert.deepEqual(turn.toolCalls, [{ id: "call_1", name: "hub_list_tasks", arguments: '{"limit":5}' }]);
  assert.deepEqual([turn.tokensIn, turn.tokensOut, turn.finishReason, turn.cutOff], [12, 7, "tool_calls", false]);
  assert.equal(turn.reasoning, "Thinking about it.");
});

test("a chat refusal that names the endpoint switches once and is remembered; other Copilot models stay on chat", async () => {
  const calls = install();
  forgetLearnedForTests(/^never$/);
  const first = await completeText({ provider: "copilot", model: "gpt-5.4-mini", userId: "u1", prompt: "Say hi" });
  assert.equal(first.text, "Hello from Copilot.");
  assert.deepEqual(endpoints(calls), ["completions", "responses"]);
  await completeText({ provider: "copilot", model: "gpt-5.4-mini", userId: "u1", prompt: "Again" });
  assert.deepEqual(endpoints(calls).slice(2), ["responses"]);
  const other = await completeText({ provider: "copilot", model: "claude-sonnet-4.6", userId: "u1", prompt: "Hi" });
  assert.equal(other.text, "chat answer");
});

test("a streamed /responses turn sends deltas, then the turn", async () => {
  install();
  const frames: string[] = [];
  for await (const frame of streamWithTools({ provider: "copilot", model: "gpt-5.4-mini", userId: "u1", messages: [{ role: "user", content: "Hi" }] })) frames.push(frame);
  const read = (event: string) => frames.filter((frame) => frame.startsWith(`event: ${event}`)).map((frame) => JSON.parse(frame.split("data:")[1]!) as { text: string });
  assert.deepEqual(read("delta").map((frame) => frame.text), ["Hel", "lo."]);
  assert.equal(read("turn")[0]?.text, "Hello.");
  assert.equal(read("error").length, 0);
});

test("Copilot's model list keeps chat models only and settles which endpoint each takes", async () => {
  install();
  forgetLearnedForTests(/^never$/);
  const rows = await catalog("u-list", null, undefined, ["copilot"]);
  const copilot = rows[0]!;
  assert.deepEqual(copilot.models, ["gpt-5.4-mini", "claude-sonnet-4.6"], "embedding models are not offered");
  assert.deepEqual((copilot.meta as Record<string, { endpoints?: string[] }>)["gpt-5.4-mini"]?.endpoints, ["/responses"]);
  assert.equal(apiFor("copilot", "gpt-5.4-mini"), "responses");
  assert.equal(apiFor("copilot", "claude-sonnet-4.6"), "chat");
  assert.equal(apiFor("openai", "gpt-5.4-mini"), "chat", "only Copilot is routed");
});

test("only a refusal that names an endpoint switches; history is cleaned for store off", () => {
  assert.equal(otherEndpoint(new ProviderError(400, "other", REFUSAL.error.message)), "responses");
  assert.equal(otherEndpoint(new ProviderError(400, "other", 'model "claude-x" is not supported via the /responses endpoint')), "chat");
  assert.equal(otherEndpoint(new ProviderError(400, "other", "The requested model is not supported.")), null);
  assert.equal(otherEndpoint(new ProviderError(503, "unavailable", "/chat/completions not accessible")), null);
  assert.deepEqual(
    cleanItems([
      { role: "assistant", content: "Done." },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
      { type: "reasoning", id: "rs" },
    ]),
    [{ role: "assistant", content: "Done." }],
    "an earlier reply's text is sent once",
  );
});
