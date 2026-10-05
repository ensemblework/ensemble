/**
 * Model adapters ported from apps/agent-runtime/ensemble_agent/models.py.
 * hub-api calls these in-process on the desktop. Hosted Ensemble still uses Python.
 *
 * There is no embeddings call in hub-api. Settings stores models.embedding, and
 * the schema has an embedding column, but nothing in this tree requests vectors.
 */
import { ModelUnreachableError } from "../lib/model-reach.js";
import { CONNECTION_DROPPED_NOTICE, normalizeTransportError } from "../lib/stream-drop.js";
import { truncateText } from "../lib/text.js";
import { ModelAuthError, ProviderError, parseProviderError } from "./errors.js";
import { PROVIDERS, resolveCredential, type Credential } from "./credentials.js";
import { parseModelJson } from "./model-json.js";
import { pace, resetBuckets, runtimeSleep, takeToken } from "./pace.js";
import {
  BASES,
  CHEAPEST,
  anthropicPayload,
  buildChatPayload,
  filterCatalogModels,
  filterGeminiRows,
  fixtureName,
  fromAnthropic,
  fromOpenAi,
  inferProvider,
  raiseFixtureError,
  readFixture,
  canCrossModelFallback,
  readSseStream,
  retryPlan,
  sse,
  textChunks,
  type Json,
} from "./payload.js";

export { resetBuckets };

let fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);

export function setRuntimeFetchForTests(fetchFn: typeof fetch | null): void {
  fetchImpl = fetchFn ?? globalThis.fetch.bind(globalThis);
}

export interface CallOptions {
  signal?: AbortSignal;
}

const copilotCache = new Map<string, { token: string; base: string; expiresAt: number }>();
const catalogCache = new Map<string, { expires: number; models: string[] }>();

function cacheKey(provider: string, userId: string | null | undefined, secret: string | null | undefined, ollamaUrl: string | null | undefined): string {
  return [provider, userId ?? "", secret ? secret.slice(-6) : "", ollamaUrl ?? ""].join("\0");
}

export function clearCatalogCache(): void {
  catalogCache.clear();
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function vendorFetch(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  return fetchImpl(url, { ...init, signal: combineSignals(signal, timeoutMs) });
}

async function copilotSession(githubToken: string, signal?: AbortSignal): Promise<{ token: string; base: string }> {
  const cached = copilotCache.get(githubToken);
  if (cached && cached.expiresAt > Date.now() / 1000 + 60) return { token: cached.token, base: cached.base };
  const response = await vendorFetch(
    "https://api.github.com/copilot_internal/v2/token",
    {
      headers: { Authorization: `token ${githubToken}`, Accept: "application/json", "User-Agent": "Ensemble" },
    },
    20_000,
    signal,
  );
  if (!response.ok) {
    throw new ModelAuthError(`GitHub did not issue a Copilot token (${response.status}). Is Copilot enabled on this account?`);
  }
  const body = (await response.json()) as { token?: string; endpoints?: { api?: string }; expires_at?: number };
  const base = (body.endpoints?.api || process.env.COPILOT_API_BASE || "https://api.githubcopilot.com").replace(/\/$/, "");
  if (!body.token) throw new ModelAuthError("GitHub did not issue a Copilot token. Is Copilot enabled on this account?");
  copilotCache.set(githubToken, { token: body.token, base, expiresAt: Number(body.expires_at ?? Date.now() / 1000 + 600) });
  return { token: body.token, base };
}

export async function endpoint(
  provider: string,
  userId: string | null | undefined,
  ollamaUrl: string | null | undefined,
  signal?: AbortSignal,
): Promise<{ base: string; headers: Record<string, string>; source: string }> {
  if (provider === "mock") return { base: "mock://local", headers: {}, source: "you" };
  const cred = await resolveCredential(userId, provider);
  if (provider === "ollama") {
    const base = (cred.baseUrl || ollamaUrl || process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
    return { base: `${base}/v1`, headers: {}, source: "local" };
  }
  if (!cred.secret) {
    throw new ModelAuthError(`No key for ${provider}. Paste one in Settings → Models, or pick a provider that has a key.`);
  }
  if (provider === "copilot") {
    const session = await copilotSession(cred.secret, signal);
    return {
      base: session.base,
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Editor-Version": "Ensemble/0.1",
        "Copilot-Integration-Id": "vscode-chat",
      },
      source: cred.source,
    };
  }
  if (!BASES[provider]) throw new ModelAuthError(`${provider} is not a chat provider.`);
  const base = (cred.baseUrl || BASES[provider]).replace(/\/$/, "");
  const headers: Record<string, string> = { Authorization: `Bearer ${cred.secret}` };
  if (provider === "openrouter") headers["X-Title"] = "Ensemble";
  return { base, headers, source: cred.source };
}

async function sendJson(
  url: string,
  headers: Record<string, string>,
  payload: Json,
  timeoutMs: number,
  signal?: AbortSignal,
  context?: { provider: string; model: string; url: string },
): Promise<Response> {
  try {
    return await vendorFetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload) }, timeoutMs, signal);
  } catch (error) {
    if (!context) throw error;
    throw normalizeTransportError(error, context);
  }
}

export async function postWithRetry(
  send: (payload: Json) => Promise<Response>,
  payload: Json,
  options: { retry?: boolean; sleep?: (seconds: number) => Promise<void> } = {},
): Promise<Response> {
  const pause = options.sleep ?? runtimeSleep;
  const retry = options.retry !== false;
  let current = { ...payload };
  let stripped = false;
  let attempt = 0;
  while (true) {
    const response = await send(current);
    if (response.ok) return response;
    const body = await response.text();
    if (!stripped && response.status === 400 && body.includes("reasoning_effort") && "reasoning_effort" in current) {
      current = Object.fromEntries(Object.entries(current).filter(([key]) => key !== "reasoning_effort"));
      stripped = true;
      continue;
    }
    const error = parseProviderError(response.status, body, response.headers);
    if (!retry) throw error;
    const delay = retryPlan(error, attempt);
    if (delay == null) throw error;
    await pause(delay);
    attempt += 1;
  }
}

function canFallback(error: ProviderError, fallback: unknown, model: string): boolean {
  return canCrossModelFallback(error, fallback, model);
}

async function withModelFallback(body: Json, model: string, call: (chosen: string, allowRetry: boolean) => Promise<Json>): Promise<Json> {
  try {
    return await call(model, true);
  } catch (error) {
    if (!(error instanceof ProviderError) || !canFallback(error, body.fallbackModel, model)) throw error;
    const result = await call(String(body.fallbackModel), false);
    result.fallbackFrom = model;
    return result;
  }
}

async function readJsonObject(response: Response): Promise<Json> {
  try {
    const data = (await response.json()) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ProviderError(502, "other", "The model provider returned a non-JSON response.");
    }
    return data as Json;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(502, "other", "The model provider returned a non-JSON response.");
  }
}

async function openaiChat(
  provider: string,
  payload: Json,
  userId: string | null | undefined,
  ollamaUrl: string | null | undefined,
  timeoutMs: number,
  options: { retry?: boolean; signal?: AbortSignal } = {},
): Promise<Json> {
  await pace(userId, provider);
  if (payload.stream) return collectOpenAiStream(provider, payload, userId, ollamaUrl, timeoutMs, options);
  const target = await endpoint(provider, userId, ollamaUrl, options.signal);
  const url = `${target.base}/chat/completions`;
  const response = await postWithRetry(
    (current) =>
      sendJson(url, target.headers, current, timeoutMs, options.signal, {
        provider,
        model: String(payload.model ?? ""),
        url,
      }),
    payload,
    { retry: options.retry !== false },
  );
  return readJsonObject(response);
}

async function* readLines(response: Response): AsyncGenerator<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) yield line;
  }
  if (buffer) yield buffer;
}

async function* openaiStreamEvents(
  provider: string,
  payload: Json,
  userId: string | null | undefined,
  ollamaUrl: string | null | undefined,
  timeoutMs: number,
  options: { retry?: boolean; signal?: AbortSignal } = {},
): AsyncGenerator<{ kind: "delta"; text: string } | { kind: "done"; data: Json }> {
  const target = await endpoint(provider, userId, ollamaUrl, options.signal);
  const url = `${target.base}/chat/completions`;
  let current: Json = { ...payload, stream: true };
  let stripped = false;
  let attempt = 0;
  const retry = options.retry !== false;
  while (true) {
    const where = { provider, model: String(current.model ?? ""), url };
    let response: Response;
    try {
      response = await sendJson(url, target.headers, current, timeoutMs, options.signal, where);
    } catch (error) {
      throw normalizeTransportError(error, where);
    }
    if (!response.ok) {
      const body = await response.text();
      if (!stripped && response.status === 400 && body.includes("reasoning_effort") && "reasoning_effort" in current) {
        current = Object.fromEntries(Object.entries(current).filter(([key]) => key !== "reasoning_effort"));
        stripped = true;
        continue;
      }
      const failure = parseProviderError(response.status, body, response.headers);
      const delay = retry ? retryPlan(failure, attempt) : null;
      if (delay == null) throw failure;
      await runtimeSleep(delay);
      attempt += 1;
      continue;
    }
    try {
      yield* readSseStream(readLines(response), String(current.model ?? ""), options.signal);
      return;
    } catch (error) {
      throw normalizeTransportError(error, where);
    }
  }
}

async function collectOpenAiStream(
  provider: string,
  payload: Json,
  userId: string | null | undefined,
  ollamaUrl: string | null | undefined,
  timeoutMs: number,
  options: { retry?: boolean; signal?: AbortSignal } = {},
): Promise<Json> {
  let result: Json | null = null;
  for await (const event of openaiStreamEvents(provider, payload, userId, ollamaUrl, timeoutMs, options)) {
    if (event.kind === "done") result = event.data;
  }
  if (!result) throw new ProviderError(502, "other", "The model stream ended without a completion.");
  return result;
}

function asMessages(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => !!item && typeof item === "object" && !Array.isArray(item)) : [];
}

function mockFromParts(text: string, calls: Json[], model: string, tokensIn: unknown, tokensOut: unknown): Json {
  const normalized = calls.map((call) => ({
    id: String(call.id ?? ""),
    name: String(call.name ?? ""),
    arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
  }));
  const asInt = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : 0;
  };
  const promptTokens = asInt(tokensIn);
  const completionTokens = asInt(tokensOut);
  const raw = {
    model,
    choices: [
      {
        message: {
          role: "assistant",
          content: text,
          tool_calls: normalized.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
        },
      },
    ],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
  return { text, toolCalls: normalized, model, credits: null, tokensIn: promptTokens, tokensOut: completionTokens, reasoning: "", raw };
}

function mockTurn(body: Json, model: string): Json {
  const name = fixtureName(body);
  const chosen = model || "mock";
  if (!name) return mockFromParts("Mock answer.", [], chosen, 0, 0);
  const data = readFixture(name);
  raiseFixtureError(data);
  if (Array.isArray(data.choices)) return fromOpenAi(data, String(data.model || chosen));
  const calls = Array.isArray(data.toolCalls) ? (data.toolCalls as Json[]) : [];
  return mockFromParts(String(data.text ?? ""), calls, String(data.model || chosen), data.tokensIn, data.tokensOut);
}

function cursorChatError(): ModelAuthError {
  return new ModelAuthError(
    "Cursor runs delegated agent work, not the chat. Pick Gemini, OpenAI, Claude, Mistral, Kimi, Qwen, OpenRouter, Copilot or Ollama for this tier.",
  );
}

async function anthropicChat(body: Json, model: string, userId: string | null | undefined, timeoutMs: number, signal?: AbortSignal): Promise<Json> {
  const cred = await resolveCredential(userId, "anthropic");
  if (!cred.secret) throw new ModelAuthError("No key for anthropic. Paste one in Settings → Models.");
  const url = `${(cred.baseUrl || "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`;
  const headers = { "x-api-key": cred.secret, "anthropic-version": "2023-06-01" };
  const messages = asMessages(body.messages);
  const call = async (chosen: string, allowRetry: boolean) => {
    const response = await postWithRetry(
      (current) => sendJson(url, headers, current, timeoutMs, signal),
      anthropicPayload(body, chosen, messages),
      { retry: allowRetry },
    );
    return fromAnthropic(await readJsonObject(response), chosen);
  };
  return withModelFallback(body, model, call);
}

async function openaiTurn(
  body: Json,
  model: string,
  provider: string,
  messages: Json[],
  timeoutMs: number,
  options: { tools?: Json[] | null; temperature?: number | null; jsonMode?: boolean; stream?: boolean; signal?: AbortSignal } = {},
): Promise<Json> {
  const call = async (chosen: string, allowRetry: boolean) => {
    const payload = buildChatPayload(chosen, provider, messages, {
      tools: options.tools,
      reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : null,
      temperature: options.temperature,
      jsonMode: options.jsonMode,
      stream: options.stream,
    });
    const data = await openaiChat(provider, payload, typeof body.userId === "string" ? body.userId : null, typeof body.ollamaUrl === "string" ? body.ollamaUrl : null, timeoutMs, {
      retry: allowRetry,
      signal: options.signal,
    });
    return fromOpenAi(data, chosen);
  };
  return withModelFallback(body, model, call);
}

function toolsOf(body: Json): Json[] | null {
  return Array.isArray(body.chatTools) && body.chatTools.length ? (body.chatTools as Json[]) : null;
}

export async function completeWithTools(body: Json, options: CallOptions = {}): Promise<Json> {
  const model = String(body.model || inferProviderModel("coder"));
  const provider = String(body.provider || inferProvider(model));
  if (provider === "mock") return mockTurn(body, model);
  if (provider === "cursor") throw cursorChatError();
  if (provider === "anthropic") return anthropicChat(body, model, stringOrNull(body.userId), 300_000, options.signal);
  return openaiTurn(body, model, provider, asMessages(body.messages), 300_000, {
    tools: toolsOf(body),
    stream: Boolean(body.stream),
    signal: options.signal,
  });
}

function inferProviderModel(role: string): string {
  const envKey =
    role === "planner"
      ? "ENSEMBLE_MODEL_PLANNER"
      : role === "drafter"
        ? "ENSEMBLE_MODEL_DRAFTER"
        : role === "classifier"
          ? "ENSEMBLE_MODEL_CLASSIFIER"
          : role === "coder"
            ? "ENSEMBLE_MODEL_CODER"
            : "ENSEMBLE_EMBEDDING_MODEL";
  return process.env[envKey] || CHEAPEST.google || "gemini-3.5-flash-lite";
}

export async function completeText(body: Json, options: CallOptions = {}): Promise<Json> {
  const model = String(body.model || CHEAPEST.google);
  const provider = String(body.provider || inferProvider(model));
  const messages: Json[] = [];
  if (body.system) messages.push({ role: "system", content: body.system });
  messages.push({ role: "user", content: body.prompt ?? "" });
  let result: Json;
  if (provider === "mock") {
    result = mockTurn({ ...body, messages }, model);
  } else if (provider === "cursor") {
    throw new ModelAuthError("Cursor is not a completion provider. Pick another provider for this tier.");
  } else if (provider === "anthropic") {
    result = await anthropicChat(
      {
        messages,
        maxTokens: body.maxTokens,
        userId: body.userId,
        reasoningEffort: body.reasoningEffort,
        fallbackModel: body.fallbackModel,
        chatTools: body.chatTools,
      },
      model,
      stringOrNull(body.userId),
      120_000,
      options.signal,
    );
  } else {
    const rawTemp = body.temperature === undefined ? 0 : body.temperature;
    const temperature = rawTemp == null ? 0 : Number(rawTemp);
    result = await openaiTurn(body, model, provider, messages, 120_000, {
      temperature,
      jsonMode: Boolean(body.json),
      stream: Boolean(body.stream),
      signal: options.signal,
    });
  }
  const out: Json = { text: result.text, model: result.model, tokensIn: result.tokensIn ?? null, tokensOut: result.tokensOut ?? null };
  if (result.fallbackFrom) out.fallbackFrom = result.fallbackFrom;
  if (body.json) {
    const shape = body.jsonShape === "triage" || body.jsonShape === "plan" ? body.jsonShape : undefined;
    out.json = parseModelJson(String(result.text ?? ""), shape);
  }
  return out;
}

function publicFailure(error: unknown): Json {
  if (error instanceof ModelUnreachableError) return error.toJSON();
  if (error instanceof Error && error.name === "ConnectionDropped") {
    return { message: CONNECTION_DROPPED_NOTICE, kind: "other", status: 503 };
  }
  if (error instanceof ProviderError) {
    return {
      message: error.message,
      kind: error.kind,
      status: error.status,
      ...(error.quotaId ? { quotaId: error.quotaId } : {}),
      ...(error.retryAfterSeconds != null ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    };
  }
  if (error instanceof ModelAuthError) return { message: error.message, kind: "auth", status: 503 };
  const text = error instanceof Error ? error.message : String(error);
  const safe = text.includes("http://") || text.includes("https://") ? "The model provider could not be reached." : truncateText(text, 800);
  return { message: safe, kind: "other", status: 502 };
}

async function* yieldOpenAiFrames(
  provider: string,
  payload: Json,
  body: Json,
  model: string,
  options: { retry: boolean; fallbackFrom?: string; signal?: AbortSignal },
): AsyncGenerator<string> {
  const userId = stringOrNull(body.userId);
  const delay = await takeToken(userId, provider);
  if (delay > 0) {
    yield sse("status", { text: "Waiting for the rate limit…" });
    await runtimeSleep(delay);
  }
  for await (const event of openaiStreamEvents(provider, payload, userId, typeof body.ollamaUrl === "string" ? body.ollamaUrl : null, 300_000, {
    retry: options.retry,
    signal: options.signal,
  })) {
    if (event.kind === "delta") yield sse("delta", { text: event.text });
    else {
      const result = fromOpenAi(event.data, model);
      if (options.fallbackFrom) result.fallbackFrom = options.fallbackFrom;
      yield sse("turn", result);
    }
  }
}

async function* chatFrames(body: Json, signal?: AbortSignal): AsyncGenerator<string> {
  const model = String(body.model || inferProviderModel("coder"));
  const provider = String(body.provider || inferProvider(model));
  if (provider === "mock") {
    const result = mockTurn(body, model);
    for (const piece of textChunks(String(result.text ?? ""))) yield sse("delta", { text: piece });
    yield sse("turn", result);
    return;
  }
  if (provider === "cursor") throw cursorChatError();
  if (provider === "anthropic") {
    const result = await anthropicChat(body, model, stringOrNull(body.userId), 300_000, signal);
    for (const piece of textChunks(String(result.text ?? ""))) yield sse("delta", { text: piece });
    yield sse("turn", result);
    return;
  }
  const payload = buildChatPayload(model, provider, asMessages(body.messages), {
    tools: toolsOf(body),
    reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : null,
    stream: true,
  });
  let emitted = false;
  try {
    for await (const frame of yieldOpenAiFrames(provider, payload, body, model, { retry: true, signal })) {
      emitted = true;
      yield frame;
    }
  } catch (error) {
    if (!(error instanceof ProviderError) || emitted || !canFallback(error, body.fallbackModel, model)) throw error;
    const alt = buildChatPayload(String(body.fallbackModel), provider, asMessages(body.messages), {
      tools: toolsOf(body),
      reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : null,
      stream: true,
    });
    yield* yieldOpenAiFrames(provider, alt, body, String(body.fallbackModel), { retry: false, fallbackFrom: model, signal });
  }
}

export async function* streamWithTools(body: Json, options: CallOptions = {}): AsyncGenerator<string> {
  try {
    yield* chatFrames(body, options.signal);
  } catch (error) {
    yield sse("error", publicFailure(error));
  }
}

export async function listModels(
  provider: string,
  userId: string | null | undefined,
  ollamaUrl: string | null | undefined,
  secret?: string | null,
  signal?: AbortSignal,
): Promise<string[]> {
  const key = cacheKey(provider, userId, secret, ollamaUrl);
  const cached = catalogCache.get(key);
  if (cached && cached.expires > Date.now() / 1000) return cached.models;
  const cred = await resolveCredential(userId, provider);
  const apiKey = secret || cred.secret || "";
  let models: string[] = [];
  if (provider === "google") {
    const response = await vendorFetch(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
      { headers: { "x-goog-api-key": apiKey } },
      15_000,
      signal,
    );
    if (!response.ok) throw await httpFailure(response);
    const data = (await response.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
    models = filterGeminiRows(data.models ?? []);
  } else if (provider === "openai" || provider === "openrouter" || provider === "mistral" || provider === "kimi" || provider === "qwen") {
    const response = await vendorFetch(`${BASES[provider]}/models`, { headers: { Authorization: `Bearer ${apiKey}` } }, 15_000, signal);
    if (!response.ok) throw await httpFailure(response);
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    models = filterCatalogModels(provider, (data.data ?? []).map((row) => String(row.id ?? "")).filter(Boolean).sort());
  } else if (provider === "anthropic") {
    const response = await vendorFetch(
      "https://api.anthropic.com/v1/models",
      { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } },
      15_000,
      signal,
    );
    if (!response.ok) throw await httpFailure(response);
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    models = (data.data ?? []).map((row) => String(row.id ?? "")).filter(Boolean);
  } else if (provider === "cursor") {
    const response = await vendorFetch(
      "https://api.cursor.com/v0/models",
      { headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` } },
      15_000,
      signal,
    );
    if (!response.ok) throw await httpFailure(response);
    const data = (await response.json()) as { models?: string[] };
    models = Array.isArray(data.models) ? data.models.map(String) : [];
  } else if (provider === "ollama") {
    const base = (cred.baseUrl || ollamaUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
    const response = await vendorFetch(`${base}/api/tags`, {}, 2_000, signal);
    if (!response.ok) throw await httpFailure(response);
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    models = (data.models ?? []).map((row) => String(row.name ?? "")).filter(Boolean);
  } else if (provider === "copilot") {
    const session = await copilotSession(apiKey, signal);
    const response = await vendorFetch(
      `${session.base}/models`,
      { headers: { Authorization: `Bearer ${session.token}`, "Editor-Version": "Ensemble/0.1", "Copilot-Integration-Id": "vscode-chat" } },
      15_000,
      signal,
    );
    if (!response.ok) throw await httpFailure(response);
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    models = (data.data ?? []).map((row) => String(row.id ?? "")).filter(Boolean);
  }
  catalogCache.set(key, { expires: Date.now() / 1000 + 300, models });
  return models;
}

async function httpFailure(response: Response): Promise<Error> {
  const text = await response.text().catch(() => "");
  const error = new Error(`HTTP ${response.status}`);
  (error as Error & { status?: number; body?: string }).status = response.status;
  (error as Error & { body?: string }).body = text;
  return error;
}

export async function catalog(userId: string | null | undefined, ollamaUrl: string | null | undefined, signal?: AbortSignal): Promise<Json[]> {
  const out: Json[] = [];
  for (const provider of PROVIDERS) {
    const entry: Json = {
      provider,
      available: false,
      source: "none",
      models: [],
      chat: provider !== "cursor",
      cheapest: CHEAPEST[provider] ?? null,
      error: null,
    };
    let cred: Credential;
    try {
      cred = await resolveCredential(userId, provider);
    } catch (error) {
      if (error instanceof ModelAuthError) entry.error = error.message.slice(0, 200);
      else entry.error = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      out.push(entry);
      continue;
    }
    entry.source = cred.source;
    if (provider !== "ollama" && !cred.secret) {
      out.push(entry);
      continue;
    }
    try {
      entry.models = await listModels(provider, userId, ollamaUrl, null, signal);
      entry.available = Boolean((entry.models as string[]).length) || provider !== "ollama";
    } catch (error) {
      entry.error = provider === "ollama" ? null : (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }
    out.push(entry);
  }
  return out;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
