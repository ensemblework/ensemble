/**
 * Model adapters ported from apps/agent-runtime/ensemble_agent/models.py.
 * hub-api calls these in-process on the desktop. Hosted Ensemble still uses Python.
 *
 * There is no embeddings call in hub-api. Settings stores models.embedding, and
 * the schema has an embedding column, but nothing in this tree requests vectors.
 */
import { INCLUDED_PROVIDER } from "@ensemble/shared-types";
import { ModelUnreachableError } from "../lib/model-reach.js";
import { HostedAccessError, canUseHostCredentials, requireHostAccess, requireVerifiedUser } from "../lib/hosted-access.js";
import { CONNECTION_DROPPED_NOTICE, normalizeTransportError } from "../lib/stream-drop.js";
import { truncateText } from "../lib/text.js";
import { IncludedLimitError } from "../included/errors.js";
import { COPILOT_CLASSIC_TOKEN, ModelAuthError, ProviderError, noKeyMessage, parseProviderError } from "./errors.js";
import { PROVIDERS, resolveCredential, type Credential } from "./credentials.js";
import { postWithRetry, readJsonObject, sendJson, vendorFetch } from "./http.js";
import { includedTurn } from "./included.js";
import { parseModelJson } from "./model-json.js";
import { apiFor, buildResponsesPayload, cleanItems, itemsFromChat, learn, learnFromListing, otherEndpoint, toolsFor, turnFromResponse, turnFromStream, type Api } from "./responses-api.js";
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
  providerForCall,
  raiseFixtureError,
  readFixture,
  canCrossModelFallback,
  effortFor,
  readSseStream,
  retryPlan,
  sse,
  textChunks,
  type Json,
} from "./payload.js";

export { resetBuckets };
export { postWithRetry, setRuntimeFetchForTests } from "./http.js";

export interface CallOptions {
  signal?: AbortSignal;
}

const catalogCache = new Map<string, { expires: number; models: string[]; meta: ModelMetaMap }>();

/** What a provider's model list says about each model that the settings need: its thinking levels, and Copilot's endpoints. */
export type ModelMetaMap = Record<string, { efforts?: string[]; reasoning?: boolean; endpoints?: string[] }>;

/** Anthropic: `capabilities.effort`, with `supported` at each level. */
export function anthropicMeta(rows: Array<{ id?: string; capabilities?: unknown }>): ModelMetaMap {
  const out: ModelMetaMap = {};
  for (const row of rows) {
    const effort = (row.capabilities as { effort?: Record<string, { supported?: boolean } | boolean> } | undefined)?.effort;
    if (!row.id || !effort || typeof effort !== "object") continue;
    const supported = (effort as { supported?: boolean }).supported !== false;
    out[row.id] = { efforts: supported ? ["low", "medium", "high", "xhigh", "max"].filter((level) => (effort[level] as { supported?: boolean } | undefined)?.supported === true) : [] };
  }
  return out;
}

/**
 * Copilot: `capabilities.supports.reasoning_effort`, a list per model; a model without it has no
 * setting. `supported_endpoints`, where listed, says whether the model answers on /responses only.
 */
export function copilotMeta(rows: Array<{ id?: string; capabilities?: unknown; supported_endpoints?: unknown }>): ModelMetaMap {
  const out: ModelMetaMap = {};
  for (const row of rows) {
    if (!row.id) continue;
    const listed = (row.capabilities as { supports?: { reasoning_effort?: unknown } } | undefined)?.supports?.reasoning_effort;
    out[row.id] = {
      efforts: Array.isArray(listed) ? listed.map(String) : [],
      ...(Array.isArray(row.supported_endpoints) ? { endpoints: row.supported_endpoints.map(String) } : {}),
    };
  }
  return out;
}

/** OpenRouter: whether `supported_parameters` has `reasoning`. */
export function openRouterMeta(rows: Array<{ id?: string; supported_parameters?: unknown }>): ModelMetaMap {
  const out: ModelMetaMap = {};
  for (const row of rows) {
    if (row.id && Array.isArray(row.supported_parameters)) out[row.id] = { reasoning: row.supported_parameters.includes("reasoning") };
  }
  return out;
}

function cacheKey(provider: string, userId: string | null | undefined, secret: string | null | undefined, ollamaUrl: string | null | undefined): string {
  return [provider, userId ?? "", secret ? secret.slice(-6) : "", ollamaUrl ?? ""].join("\0");
}

export function clearCatalogCache(): void {
  catalogCache.clear();
}

/**
 * Copilot takes the person's own GitHub token as a bearer token: a fine-grained token with the
 * account permission "Copilot requests" (GitHub's documented way to make Copilot requests for a
 * user), or an OAuth or GitHub App user token. GitHub refuses classic `ghp_` tokens for Copilot.
 * The integration id is the Copilot SDK runtime's default; an operator with their own sets
 * COPILOT_INTEGRATION_ID.
 */
export function copilotEndpoint(githubToken: string, allowHostConfig = false): { base: string; headers: Record<string, string> } {
  if (githubToken.startsWith("ghp_")) throw new ModelAuthError(COPILOT_CLASSIC_TOKEN);
  const base = ((allowHostConfig ? process.env.COPILOT_API_BASE : null) || "https://api.githubcopilot.com").replace(/\/$/, "");
  const integration = (allowHostConfig ? process.env.COPILOT_INTEGRATION_ID : null) || "copilot-developer-cli";
  return {
    base,
    headers: { Authorization: `Bearer ${githubToken}`, "Editor-Version": "Ensemble/0.1", "Copilot-Integration-Id": integration },
  };
}

export async function endpoint(
  provider: string,
  userId: string | null | undefined,
  ollamaUrl: string | null | undefined,
  _signal?: AbortSignal,
): Promise<{ base: string; headers: Record<string, string>; source: string }> {
  await requireVerifiedUser(userId);
  if (provider === "mock") return { base: "mock://local", headers: {}, source: "you" };
  const cred = await resolveCredential(userId, provider);
  if (provider === "ollama") {
    await requireHostAccess(userId, "Host Ollama and custom model proxies");
    const base = (cred.baseUrl || ollamaUrl || process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
    return { base: `${base}/v1`, headers: {}, source: "local" };
  }
  if (!cred.secret) {
    throw new ModelAuthError(noKeyMessage(provider));
  }
  if (provider === "copilot") return { ...copilotEndpoint(cred.secret, await canUseHostCredentials(userId)), source: cred.source };
  if (!BASES[provider]) throw new ModelAuthError(`${provider} is not a chat provider.`);
  const base = (cred.baseUrl || BASES[provider]).replace(/\/$/, "");
  if (cred.baseUrl) await requireHostAccess(userId, "Custom model proxies");
  const headers: Record<string, string> = { Authorization: `Bearer ${cred.secret}` };
  if (provider === "openrouter") headers["X-Title"] = "Ensemble";
  return { base, headers, source: cred.source };
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
  const current: Json = { ...payload, stream: true };
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

async function* responsesEvents(
  provider: string,
  payload: Json,
  userId: string | null | undefined,
  ollamaUrl: string | null | undefined,
  timeoutMs: number,
  options: { retry?: boolean; signal?: AbortSignal } = {},
): AsyncGenerator<{ kind: "delta"; text: string } | { kind: "done"; turn: Json }> {
  const target = await endpoint(provider, userId, ollamaUrl, options.signal);
  const url = `${target.base}/responses`;
  const model = String(payload.model ?? "");
  const where = { provider, model, url };
  if (!payload.stream) {
    const response = await postWithRetry((current) => sendJson(url, target.headers, current, timeoutMs, options.signal, where), payload, { retry: options.retry !== false });
    yield { kind: "done", turn: turnFromResponse(await readJsonObject(response), model) };
    return;
  }
  let attempt = 0;
  const retry = options.retry !== false;
  while (true) {
    const response = await sendJson(url, target.headers, payload, timeoutMs, options.signal, where);
    if (!response.ok) {
      const failure = parseProviderError(response.status, await response.text(), response.headers);
      const delay = retry ? retryPlan(failure, attempt) : null;
      if (delay == null) throw failure;
      await runtimeSleep(delay);
      attempt += 1;
      continue;
    }
    try {
      yield* turnFromStream(readLines(response), model);
      return;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw normalizeTransportError(error, where);
    }
  }
}

async function responsesTurn(
  provider: string,
  payload: Json,
  userId: string | null | undefined,
  ollamaUrl: string | null | undefined,
  timeoutMs: number,
  options: { retry?: boolean; signal?: AbortSignal } = {},
): Promise<Json> {
  await pace(userId, provider);
  let result: Json | null = null;
  for await (const event of responsesEvents(provider, payload, userId, ollamaUrl, timeoutMs, options)) {
    if (event.kind === "done") result = event.turn;
  }
  if (!result) throw new ProviderError(502, "other", "The model stream ended without a completion.");
  return result;
}

/** The Responses request for one turn: hub-api's Responses-shaped history when it sent one. */
function responsesPayload(
  body: Json,
  model: string,
  provider: string,
  messages: Json[],
  options: { tools?: Json[] | null; jsonMode?: boolean; stream?: boolean; items?: unknown[] | null; responsesTools?: Json[] | null },
): Json {
  const history = options.items?.length ? cleanItems(options.items) : itemsFromChat(messages);
  const specs = options.responsesTools?.length ? options.responsesTools : options.tools;
  return buildResponsesPayload(model, history, {
    tools: specs?.length ? toolsFor(specs) : null,
    effort: effortFor(provider, typeof body.reasoningEffort === "string" ? body.reasoningEffort : null, model),
    jsonMode: options.jsonMode,
    stream: options.stream,
  });
}

/** Calls the endpoint this model takes. A refusal that names the other endpoint switches once, and is remembered. */
async function eitherApi<T>(provider: string, model: string, chat: () => Promise<T>, responses: () => Promise<T>): Promise<T> {
  const first: Api = apiFor(provider, model);
  try {
    return await (first === "responses" ? responses() : chat());
  } catch (error) {
    const other = error instanceof ProviderError ? otherEndpoint(error) : null;
    if (!other || other === first) throw error;
    learn(provider, model, other);
    return other === "responses" ? responses() : chat();
  }
}

const itemsOf = (body: Json): unknown[] | null => (Array.isArray(body.responsesMessages) && body.responsesMessages.length ? (body.responsesMessages as unknown[]) : null);
const responsesToolsOf = (body: Json): Json[] | null => (Array.isArray(body.responsesTools) && body.responsesTools.length ? (body.responsesTools as Json[]) : null);

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
  if (!cred.secret) throw new ModelAuthError(noKeyMessage("anthropic"));
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
  options: {
    tools?: Json[] | null;
    temperature?: number | null;
    jsonMode?: boolean;
    stream?: boolean;
    signal?: AbortSignal;
    responsesItems?: unknown[] | null;
    responsesTools?: Json[] | null;
  } = {},
): Promise<Json> {
  const userId = typeof body.userId === "string" ? body.userId : null;
  const ollamaUrl = typeof body.ollamaUrl === "string" ? body.ollamaUrl : null;
  const call = async (chosen: string, allowRetry: boolean) =>
    eitherApi(
      provider,
      chosen,
      async () => {
        const payload = buildChatPayload(chosen, provider, messages, {
          tools: options.tools,
          reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : null,
          temperature: options.temperature,
          jsonMode: options.jsonMode,
          stream: options.stream,
        });
        const data = await openaiChat(provider, payload, userId, ollamaUrl, timeoutMs, { retry: allowRetry, signal: options.signal });
        return fromOpenAi(data, chosen);
      },
      async () => {
        const payload = responsesPayload(body, chosen, provider, messages, {
          tools: options.tools,
          jsonMode: options.jsonMode,
          stream: options.stream,
          items: options.responsesItems,
          responsesTools: options.responsesTools,
        });
        return responsesTurn(provider, payload, userId, ollamaUrl, timeoutMs, { retry: allowRetry, signal: options.signal });
      },
    );
  return withModelFallback(body, model, call);
}

function toolsOf(body: Json): Json[] | null {
  return Array.isArray(body.chatTools) && body.chatTools.length ? (body.chatTools as Json[]) : null;
}

export async function completeWithTools(body: Json, options: CallOptions = {}): Promise<Json> {
  await requireVerifiedUser(stringOrNull(body.userId));
  const model = String(body.model || inferProviderModel("coder"));
  const provider = providerForCall(body.provider, model);
  if (provider === "mock") return mockTurn(body, model);
  if (provider === "cursor") throw cursorChatError();
  if (provider === INCLUDED_PROVIDER) return includedTurn(body, model, asMessages(body.messages), { items: itemsOf(body), signal: options.signal, timeoutMs: 300_000 });
  if (provider === "anthropic") return anthropicChat(body, model, stringOrNull(body.userId), 300_000, options.signal);
  return openaiTurn(body, model, provider, asMessages(body.messages), 300_000, {
    tools: toolsOf(body),
    stream: Boolean(body.stream),
    signal: options.signal,
    responsesItems: itemsOf(body),
    responsesTools: responsesToolsOf(body),
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
  await requireVerifiedUser(stringOrNull(body.userId));
  const model = String(body.model || CHEAPEST.google);
  const provider = providerForCall(body.provider, model);
  const messages: Json[] = [];
  if (body.system) messages.push({ role: "system", content: body.system });
  messages.push({ role: "user", content: body.prompt ?? "" });
  let result: Json;
  if (provider === "mock") {
    result = mockTurn({ ...body, messages }, model);
  } else if (provider === "cursor") {
    throw new ModelAuthError("Cursor is not a completion provider. Pick another provider for this tier.");
  } else if (provider === INCLUDED_PROVIDER) {
    result = await includedTurn(body, model, messages, { jsonMode: Boolean(body.json), signal: options.signal, timeoutMs: 120_000 });
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
  const out: Json = { text: result.text, model: result.model, tokensIn: result.tokensIn ?? null, tokensOut: result.tokensOut ?? null, credits: result.credits ?? null };
  if (result.fallbackFrom) out.fallbackFrom = result.fallbackFrom;
  if (body.json) {
    const shape = body.jsonShape === "triage" || body.jsonShape === "plan" ? body.jsonShape : undefined;
    out.json = parseModelJson(String(result.text ?? ""), shape);
  }
  return out;
}

function publicFailure(error: unknown): Json {
  if (error instanceof IncludedLimitError) return { message: error.message, kind: "credits", status: error.statusCode, code: error.code, resetsAt: error.resetsAt };
  if (error instanceof HostedAccessError) return { message: error.message, kind: "auth", status: 403 };
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
  const provider = providerForCall(body.provider, model);
  if (provider === "mock") {
    const result = mockTurn(body, model);
    for (const piece of textChunks(String(result.text ?? ""))) yield sse("delta", { text: piece });
    yield sse("turn", result);
    return;
  }
  if (provider === "cursor") throw cursorChatError();
  if (provider === INCLUDED_PROVIDER) {
    const result = await includedTurn(body, model, asMessages(body.messages), { items: itemsOf(body), signal, timeoutMs: 300_000 });
    for (const piece of textChunks(String(result.text ?? ""))) yield sse("delta", { text: piece });
    yield sse("turn", result);
    return;
  }
  if (provider === "anthropic") {
    const result = await anthropicChat(body, model, stringOrNull(body.userId), 300_000, signal);
    for (const piece of textChunks(String(result.text ?? ""))) yield sse("delta", { text: piece });
    yield sse("turn", result);
    return;
  }
  if (apiFor(provider, model) === "responses") {
    yield* yieldResponsesFrames(provider, body, model, signal);
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
    if (error instanceof ProviderError && !emitted && otherEndpoint(error) === "responses") {
      learn(provider, model, "responses");
      yield* yieldResponsesFrames(provider, body, model, signal);
      return;
    }
    if (!(error instanceof ProviderError) || emitted || !canFallback(error, body.fallbackModel, model)) throw error;
    const alt = buildChatPayload(String(body.fallbackModel), provider, asMessages(body.messages), {
      tools: toolsOf(body),
      reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : null,
      stream: true,
    });
    yield* yieldOpenAiFrames(provider, alt, body, String(body.fallbackModel), { retry: false, fallbackFrom: model, signal });
  }
}

/** The same SSE frames as a chat stream, from a Responses stream. */
async function* yieldResponsesFrames(provider: string, body: Json, model: string, signal?: AbortSignal): AsyncGenerator<string> {
  const userId = stringOrNull(body.userId);
  const payload = responsesPayload(body, model, provider, asMessages(body.messages), {
    tools: toolsOf(body),
    stream: true,
    items: itemsOf(body),
    responsesTools: responsesToolsOf(body),
  });
  const delay = await takeToken(userId, provider);
  if (delay > 0) {
    yield sse("status", { text: "Waiting for the rate limit…" });
    await runtimeSleep(delay);
  }
  for await (const event of responsesEvents(provider, payload, userId, typeof body.ollamaUrl === "string" ? body.ollamaUrl : null, 300_000, { retry: true, signal })) {
    if (event.kind === "delta") yield sse("delta", { text: event.text });
    else yield sse("turn", event.turn);
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
  return (await listModelsWithMeta(provider, userId, ollamaUrl, secret ?? null, signal)).models;
}

/** The provider's model list and what it says about each model. Cached five minutes per key. */
export async function listModelsWithMeta(
  provider: string,
  userId: string | null | undefined,
  ollamaUrl: string | null | undefined,
  secret: string | null = null,
  signal?: AbortSignal,
): Promise<{ models: string[]; meta: ModelMetaMap }> {
  await requireVerifiedUser(userId);
  if (provider === "ollama") await requireHostAccess(userId, "Host Ollama and custom model proxies");
  const key = cacheKey(provider, userId, secret, ollamaUrl);
  const cached = catalogCache.get(key);
  if (cached && cached.expires > Date.now() / 1000) return { models: cached.models, meta: cached.meta };
  const cred = await resolveCredential(userId, provider);
  const apiKey = secret || cred.secret || "";
  let models: string[] = [];
  let meta: ModelMetaMap = {};
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
    const data = (await response.json()) as { data?: Array<{ id?: string; supported_parameters?: unknown }> };
    models = filterCatalogModels(provider, (data.data ?? []).map((row) => String(row.id ?? "")).filter(Boolean).sort());
    if (provider === "openrouter") meta = openRouterMeta(data.data ?? []);
  } else if (provider === "anthropic") {
    const response = await vendorFetch(
      "https://api.anthropic.com/v1/models?limit=1000",
      { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } },
      15_000,
      signal,
    );
    if (!response.ok) throw await httpFailure(response);
    const data = (await response.json()) as { data?: Array<{ id?: string; capabilities?: unknown }> };
    models = (data.data ?? []).map((row) => String(row.id ?? "")).filter(Boolean);
    meta = anthropicMeta(data.data ?? []);
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
    const copilot = copilotEndpoint(apiKey, await canUseHostCredentials(userId));
    const response = await vendorFetch(`${copilot.base}/models`, { headers: copilot.headers }, 15_000, signal);
    if (!response.ok) throw await httpFailure(response);
    const data = (await response.json()) as { data?: Array<{ id?: string; capabilities?: unknown; supported_endpoints?: unknown }> };
    // Chat models only: Copilot's list also has embedding models, which cannot answer.
    const rows = (data.data ?? []).filter((row) => row.id && [undefined, null, "chat"].includes((row.capabilities as { type?: string } | undefined)?.type));
    models = rows.map((row) => String(row.id ?? "")).filter(Boolean);
    meta = copilotMeta(rows);
    learnFromListing("copilot", rows);
  }
  catalogCache.set(key, { expires: Date.now() / 1000 + 300, models, meta });
  return { models, meta };
}

async function httpFailure(response: Response): Promise<Error> {
  const text = await response.text().catch(() => "");
  const error = new Error(`HTTP ${response.status}`);
  (error as Error & { status?: number; body?: string }).status = response.status;
  (error as Error & { body?: string }).body = text;
  return error;
}

/** The model list of each provider (or only `only`), with what each provider says about its models. */
export async function catalog(userId: string | null | undefined, ollamaUrl: string | null | undefined, signal?: AbortSignal, only?: readonly string[] | null): Promise<Json[]> {
  const out: Json[] = [];
  for (const provider of PROVIDERS) {
    if (only?.length && !only.includes(provider)) continue;
    const entry: Json = {
      provider,
      available: false,
      source: "none",
      models: [],
      meta: {},
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
      const listed = await listModelsWithMeta(provider, userId, ollamaUrl, null, signal);
      entry.models = listed.models;
      entry.meta = listed.meta;
      entry.available = Boolean(listed.models.length) || provider !== "ollama";
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
