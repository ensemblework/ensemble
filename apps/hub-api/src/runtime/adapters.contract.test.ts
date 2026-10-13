/**
 * Adapter contract: request URLs, headers, and response mapping for each provider.
 * HTTP is mocked. No real keys.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FIXTURE_DIR, anthropicPayload, buildChatPayload, effortFor, fromAnthropic, fromOpenAi } from "./payload.js";
import { ProviderError, errorFromRuntimeBody, friendlyKeyError, parseProviderError } from "./errors.js";
import { setCredentialResolverForTests, type Credential } from "./credentials.js";
import { catalog, clearCatalogCache, completeText, completeWithTools, copilotEndpoint, listModels, setRuntimeFetchForTests } from "./models.js";
import { resetBuckets, setRuntimeSleepForTests } from "./pace.js";

const COMPLETION = {
  model: "echo-model",
  choices: [
    {
      message: {
        role: "assistant",
        content: "ready",
        tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{\"q\":1}" } }],
      },
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 1 },
};

function keyFor(provider: string): Credential {
  return { provider, secret: `test-key-${provider}`, source: "you", baseUrl: null };
}

function install(handler: (url: string, init: RequestInit) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  setRuntimeFetchForTests(async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let body: unknown = undefined;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    const result = handler(url, init ?? {});
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { "content-type": "application/json", ...(result.headers ?? {}) },
    });
  });
  return calls;
}

test.beforeEach(() => {
  process.env.ENSEMBLE_INPROCESS_RUNTIME = "1";
  resetBuckets();
  clearCatalogCache();
  setRuntimeSleepForTests(async () => undefined);
  setCredentialResolverForTests(async (_userId, provider) => keyFor(provider));
});

test.afterEach(() => {
  setRuntimeFetchForTests(null);
  setCredentialResolverForTests(null);
  setRuntimeSleepForTests(null);
});

test("the chosen thinking level is sent as it is, in each provider's own field", () => {
  const gemini3 = buildChatPayload("gemini-3.5-flash", "google", [], { temperature: 0, reasoningEffort: "minimal" });
  assert.equal("temperature" in gemini3, false);
  assert.equal(gemini3.reasoning_effort, "minimal");
  const older = buildChatPayload("gemini-2.5-flash", "google", [{ role: "user", content: "hi" }], { temperature: 0, reasoningEffort: "low" });
  assert.equal(older.temperature, 0);
  assert.equal(older.reasoning_effort, "low", "never swapped for another level");
  const routed = buildChatPayload("anthropic/claude-sonnet-5-5", "openrouter", [], { reasoningEffort: "xhigh" });
  assert.deepEqual(routed.reasoning, { effort: "xhigh" }, "OpenRouter reads its own reasoning object");
  assert.equal("reasoning_effort" in routed, false);
  assert.deepEqual(anthropicPayload({ reasoningEffort: "max" }, "claude-opus-5-5", [{ role: "user", content: "hi" }]).output_config, { effort: "max" });
  assert.equal(effortFor("openai", "minimal", "gpt-5-mini"), "minimal");
  assert.equal(effortFor("google", "default", "gemini-3.5-flash"), null);
});

test("a level the provider refuses is its error, not a silent retry without it", async () => {
  const calls = install(() => ({ status: 400, body: { error: { message: "Unsupported value: 'reasoning_effort' does not support 'minimal' with this model. Supported values are: 'low', 'medium', and 'high'." } } }));
  await assert.rejects(
    () => completeWithTools({ userId: "user-openai", provider: "openai", model: "o3", reasoningEffort: "minimal", messages: [{ role: "user", content: "hi" }] }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /does not support 'minimal'/);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("a provider error object is the sentence, and 429 stays 429", () => {
  const raw = JSON.stringify({ detail: { message: "slow down", kind: "rate_limit", retryAfterSeconds: 2 } });
  const parsed = errorFromRuntimeBody(429, raw);
  assert.equal(parsed.message, "slow down");
  assert.equal(parsed.statusCode, 429);
  const quota = parseProviderError(429, readFileSync(`${FIXTURE_DIR}/gemini_error.json`, "utf8"), null);
  assert.equal(quota.kind, "quota");
  assert.equal(quota.quotaId, "GenerateRequestsPerDayPerProjectPerModel");
  assert.equal(quota.retryAfterSeconds, 2);
  assert.match(quota.message, /exceeded your current quota/);
  assert.match(quota.describe(), /status=429/);
  assert.match(quota.describe(), /kind=quota/);
});

const OPENAI_COMPAT = [
  { provider: "google", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", extra: {} },
  { provider: "openai", url: "https://api.openai.com/v1/chat/completions", extra: {} },
  { provider: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", extra: { "x-title": "Ensemble" } },
  { provider: "mistral", url: "https://api.mistral.ai/v1/chat/completions", extra: {} },
  { provider: "kimi", url: "https://api.moonshot.ai/v1/chat/completions", extra: {} },
  { provider: "qwen", url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", extra: {} },
] as const;

for (const spec of OPENAI_COMPAT) {
  test(`${spec.provider} chat posts the OpenAI body and maps the turn`, async () => {
    const calls = install(() => ({ body: { ...COMPLETION, model: `${spec.provider}-echo` } }));
    const turn = await completeWithTools({
      userId: `user-${spec.provider}`,
      provider: spec.provider,
      model: spec.provider === "google" ? "gemini-3.5-flash" : "vendor-model",
      messages: [{ role: "user", content: "hi" }],
      chatTools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      reasoningEffort: "low",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, spec.url);
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers.authorization, `Bearer test-key-${spec.provider}`);
    for (const [name, value] of Object.entries(spec.extra)) assert.equal(calls[0]?.headers[name], value);
    const sent = calls[0]?.body as { model: string; tools: unknown; reasoning_effort?: string; reasoning?: { effort: string }; temperature?: number };
    if (spec.provider === "openrouter") assert.deepEqual(sent.reasoning, { effort: "low" });
    else assert.equal(sent.reasoning_effort, "low");
    assert.equal(sent.temperature, undefined);
    assert.ok(sent.tools);
    assert.equal(turn.text, "ready");
    assert.equal((turn.toolCalls as Array<{ name: string }>)[0]?.name, "lookup");
    assert.equal(turn.tokensIn, 3);
    assert.equal(turn.tokensOut, 1);
    assert.equal(turn.model, `${spec.provider}-echo`);
  });
}

test("anthropic uses the Messages API and maps tool_use back to a turn", async () => {
  const calls = install(() => ({
    body: {
      model: "claude-haiku",
      content: [
        { type: "text", text: "ready" },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: 1 } },
      ],
      usage: { input_tokens: 4, output_tokens: 2 },
    },
  }));
  const turn = await completeWithTools({
    userId: "user-anthropic",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    reasoningEffort: "high",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
    ],
    chatTools: [{ type: "function", function: { name: "lookup", description: "Look", parameters: { type: "object" } } }],
  });
  assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0]?.headers["x-api-key"], "test-key-anthropic");
  assert.equal(calls[0]?.headers["anthropic-version"], "2023-06-01");
  const sent = calls[0]?.body as { system: string; max_tokens: number; output_config: { effort: string }; tools: Array<{ name: string }> };
  assert.equal(sent.system, "Be brief.");
  assert.equal(sent.max_tokens, 4096);
  assert.equal(sent.output_config.effort, "high");
  assert.equal(sent.tools[0]?.name, "lookup");
  assert.equal(turn.text, "ready");
  assert.deepEqual(turn.toolCalls, [{ id: "toolu_1", name: "lookup", arguments: "{\"q\":1}" }]);
  assert.equal(turn.tokensIn, 4);
  assert.equal(turn.tokensOut, 2);
  const mapped = fromAnthropic(
    { model: "claude-haiku", content: [{ type: "text", text: "ready" }], usage: { input_tokens: 1, output_tokens: 1 } },
    "claude-haiku",
  );
  assert.equal(mapped.text, "ready");
  assert.equal(fromOpenAi(COMPLETION, "fallback").text, "ready");
});

test("copilot sends the person's GitHub token to the Copilot API, and refuses a classic token", async () => {
  const calls = install(() => ({ body: COMPLETION }));
  const turn = await completeWithTools({ userId: "user-copilot", provider: "copilot", model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] });
  assert.equal(calls.length, 1, "no token exchange with GitHub's internal endpoint");
  assert.equal(calls[0]?.url, "https://api.githubcopilot.com/chat/completions");
  assert.equal(calls[0]?.headers.authorization, "Bearer test-key-copilot");
  assert.equal(calls[0]?.headers["copilot-integration-id"], "copilot-developer-cli");
  assert.equal(turn.text, "ready");
  assert.throws(() => copilotEndpoint("ghp_classic0000"), /classic GitHub token.*Copilot requests/);
  assert.equal(copilotEndpoint("github_pat_fine").headers.Authorization, "Bearer github_pat_fine");
  assert.match(friendlyKeyError("copilot", 404), /Copilot requests/);
});

test("cursor is not a chat provider, and its model list uses HTTP basic auth", async () => {
  await assert.rejects(
    () => completeWithTools({ userId: "user-cursor", provider: "cursor", model: "composer-2.5", messages: [{ role: "user", content: "hi" }] }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Cursor runs delegated agent work/);
      return true;
    },
  );
  const calls = install(() => ({ body: { models: ["composer-2.5"] } }));
  const models = await listModels("cursor", "user-cursor", null);
  assert.equal(calls[0]?.url, "https://api.cursor.com/v0/models");
  assert.equal(calls[0]?.headers.authorization, `Basic ${Buffer.from("test-key-cursor:").toString("base64")}`);
  assert.deepEqual(models, ["composer-2.5"]);
});

test("catalog filters drop embedding and non-chat model ids", async () => {
  const calls = install((url) => {
    if (url.includes("googleapis.com")) {
      return {
        body: {
          models: [
            { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent", "generateContent"] },
            { name: "models/gemini-tts", supportedGenerationMethods: ["generateContent"] },
          ],
        },
      };
    }
    if (url.includes("openai.com")) return { body: { data: [{ id: "gpt-4.1-mini" }, { id: "text-embedding-3-large" }, { id: "whisper-1" }] } };
    if (url.includes("mistral.ai")) return { body: { data: [{ id: "mistral-small-latest" }, { id: "mistral-embed" }] } };
    if (url.includes("dashscope")) return { body: { data: [{ id: "qwen-flash" }, { id: "qwen-vl-max" }, { id: "qwen2-embed" }] } };
    return { body: { data: [{ id: "vendor-model" }] } };
  });
  assert.deepEqual(await listModels("google", "filter-user", null), ["gemini-3.5-flash"]);
  assert.deepEqual(await listModels("openai", "filter-user", null), ["gpt-4.1-mini"]);
  assert.deepEqual(await listModels("mistral", "filter-user", null), ["mistral-small-latest"]);
  assert.deepEqual(await listModels("qwen", "filter-user", null), ["qwen-flash"]);
  assert.ok(calls.length >= 4);
});

test("morning-fetch JSON completions keep the object inside prose", async () => {
  install(() => ({
    body: {
      model: "gemini-3.5-flash-lite",
      choices: [{ message: { role: "assistant", content: "Here you go {\"todos\":[{\"id\":\"a\"}]}" } }],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    },
  }));
  const result = await completeText({
    userId: "triage-user",
    provider: "google",
    model: "gemini-3.5-flash-lite",
    system: "Return only JSON.",
    prompt: "classify",
    json: true,
    temperature: 0,
  });
  assert.deepEqual(result.json, { todos: [{ id: "a" }] });
  assert.equal(result.model, "gemini-3.5-flash-lite");
  assert.equal(result.tokensIn, 8);
});

test("morning-fetch JSON completions keep a fenced array", async () => {
  install(() => ({
    body: {
      model: "gemini-3.5-flash-lite",
      choices: [
        {
          message: {
            role: "assistant",
            content: "```json\n[{\"id\":\"art_priya\",\"title\":\"Reply to Priya with p95 latency numbers\"}]\n```",
          },
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 6 },
    },
  }));
  const result = await completeText({
    userId: "triage-user",
    provider: "google",
    model: "gemini-3.5-flash-lite",
    system: "Return only JSON.",
    prompt: "classify",
    json: true,
    temperature: 0,
  });
  assert.deepEqual(result.json, [{ id: "art_priya", title: "Reply to Priya with p95 latency numbers" }]);
});

test("the catalog keeps the thinking levels Anthropic and Copilot list per model", async () => {
  install((url) =>
    url.includes("anthropic.com")
      ? {
          body: {
            data: [
              { id: "claude-opus-5-5", capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } } } },
              { id: "claude-haiku-4-5", capabilities: { effort: { supported: false } } },
            ],
          },
        }
      : { body: { data: [{ id: "claude-opus-5.5", capabilities: { supports: { reasoning_effort: ["low", "medium", "high", "xhigh", "max"] } } }, { id: "gpt-4.1", capabilities: { supports: {} } }] } },
  );
  const rows = await catalog("user-meta", null, undefined, ["anthropic", "copilot"]);
  assert.deepEqual(rows.map((row) => row.provider), ["anthropic", "copilot"], "only the providers asked for");
  const anthropic = rows.find((row) => row.provider === "anthropic")!;
  assert.deepEqual((anthropic.meta as Record<string, { efforts: string[] }>)["claude-opus-5-5"]?.efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual((anthropic.meta as Record<string, { efforts: string[] }>)["claude-haiku-4-5"]?.efforts, []);
  const copilot = rows.find((row) => row.provider === "copilot")!;
  assert.deepEqual((copilot.meta as Record<string, { efforts: string[] }>)["claude-opus-5.5"]?.efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual((copilot.meta as Record<string, { efforts: string[] }>)["gpt-4.1"]?.efforts, []);
});
