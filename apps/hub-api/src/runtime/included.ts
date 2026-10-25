/**
 * Included AI on the in-process runtime: the transport apps/agent-runtime/ensemble_agent/included.py
 * runs for hosted Ensemble. Every call reserves its worst case in the credits ledger before Azure
 * sees it and settles the reservation with the real usage after (docs/33). Each model answers on
 * the OpenAI v1 endpoint of the Foundry host it is documented at, on the Responses or the Chat
 * Completions API; Foundry's Anthropic Messages endpoint is supported too, though no model in the
 * catalog uses it. The Azure key comes from the environment only: it is never a credential, never
 * listed, and never returned. Hosted Ensemble also runs here the included calls of the desktop
 * apps and CLIs connected to an account (routes/included.ts).
 */
import { INCLUDED_PROVIDER, INCLUDED_UNAVAILABLE, includedModelName, type IncludedEffort, type IncludedModel } from "@ensemble/shared-types";
import { reserveIncluded, settleIncluded } from "../included/budget.js";
import { anthropicBase, includedConfig, openaiBase, type IncludedConfig } from "../included/config.js";
import { deviceIncludedTurn, onDevice } from "../included/device.js";
import { IncludedLimitError } from "../included/errors.js";
import type { IncludedTokens } from "../included/pricing.js";
import { ModelUnreachableError } from "../lib/model-reach.js";
import { isAbortError } from "../lib/stream-drop.js";
import { ProviderError } from "./errors.js";
import { postWithRetry, readJsonObject, sendJson } from "./http.js";
import { pace } from "./pace.js";
import { anthropicTools, buildChatPayload, effortFor, fromAnthropic, fromOpenAi, toAnthropic, type Json } from "./payload.js";
import { buildResponsesPayload, cleanItems, itemsFromChat, toolsFor, turnFromResponse } from "./responses-api.js";


/** How a Claude model answers without thinking, at effort high or below. */
const THINKING_OFF: Record<string, Json> = {
  "claude-haiku-5-5": { type: "disabled" },
  "claude-sonnet-5-5": { type: "between_tools" },
};

const NO_USAGE: IncludedTokens = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
const THINKING_CACHE_SIZE = 2000;
/** (user, first tool_use id) → the content Claude returned for that turn, thinking blocks and signatures included. */
const thinking = new Map<string, Json[]>();

export function clearIncludedThinkingForTests(): void {
  thinking.clear();
}

function configured(model: string): { config: IncludedConfig; entry: IncludedModel } {
  const config = includedConfig();
  if (!config) throw new IncludedLimitError(INCLUDED_UNAVAILABLE);
  const entry = config.models.find((item) => item.id === model);
  if (!entry) throw new IncludedLimitError(INCLUDED_UNAVAILABLE, `${includedModelName(model)} is not offered on this server. Pick another included model in Settings → Models.`);
  return { config, entry };
}

/** Input tokens reserved per picture: providers charge a few thousand at most (OpenAI's largest ≈2,500, Anthropic's ≈1,600). */
export const IMAGE_INPUT_ALLOWANCE = 8_000;

/**
 * The UTF-8 bytes of the request as sent: a byte-level BPE tokenizer never makes more tokens than
 * bytes, so a reservation is never short on input. A picture's base64 is not tokenized as text, so
 * each counts as IMAGE_INPUT_ALLOWANCE instead of its length.
 */
export function estimateInputTokens(payload: Json): number {
  let images = 0;
  const text = JSON.stringify(payload, (_key, value: unknown) => {
    if (typeof value === "string" && /^data:image\//i.test(value)) {
      images += 1;
      return "";
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const source = value as Json;
      if (source.type === "base64" && typeof source.data === "string" && /^image\//i.test(String(source.media_type ?? ""))) {
        images += 1;
        return { ...source, data: "" };
      }
    }
    return value;
  });
  return Buffer.byteLength(text, "utf8") + images * IMAGE_INPUT_ALLOWANCE;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Anthropic counts cache reads and writes outside `input_tokens`; the ledger wants every input token. */
export function anthropicUsage(usage: unknown): IncludedTokens {
  const row = (usage && typeof usage === "object" ? usage : {}) as Json;
  const read = count(row.cache_read_input_tokens);
  const write = count(row.cache_creation_input_tokens);
  return { inputTokens: count(row.input_tokens) + read + write, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: count(row.output_tokens) };
}

/** Chat Completions counts cache reads in `prompt_tokens_details`; DeepSeek's own field is `prompt_cache_hit_tokens`. */
export function chatUsage(usage: unknown): IncludedTokens {
  const row = (usage && typeof usage === "object" ? usage : {}) as Json;
  const details = (row.prompt_tokens_details && typeof row.prompt_tokens_details === "object" ? row.prompt_tokens_details : {}) as Json;
  const cached = details.cached_tokens != null ? details.cached_tokens : row.prompt_cache_hit_tokens;
  return { inputTokens: count(row.prompt_tokens), cacheReadTokens: count(cached), cacheWriteTokens: 0, outputTokens: count(row.completion_tokens) };
}

export function responsesUsage(usage: unknown): IncludedTokens {
  const row = (usage && typeof usage === "object" ? usage : {}) as Json;
  const details = (row.input_tokens_details && typeof row.input_tokens_details === "object" ? row.input_tokens_details : {}) as Json;
  return { inputTokens: count(row.input_tokens), cacheReadTokens: count(details.cached_tokens), cacheWriteTokens: count(details.cache_write_tokens), outputTokens: count(row.output_tokens) };
}

function firstToolUse(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content as Json[]) {
    if (block && block.type === "tool_use" && block.id) return String(block.id);
  }
  return null;
}

/** Keep a tool-calling turn as Claude returned it. The history hub-api sends back has no thinking blocks. */
export function rememberTurn(userId: string, content: unknown): void {
  const first = firstToolUse(content);
  if (!first) return;
  const key = `${userId}\u0000${first}`;
  thinking.delete(key);
  thinking.set(key, structuredClone(content as Json[]));
  while (thinking.size > THINKING_CACHE_SIZE) thinking.delete(thinking.keys().next().value as string);
}

/** Anthropic-shaped history with each remembered tool-calling turn sent back exactly as Claude wrote it. */
function replayThinking(userId: string, messages: Json[]): Json[] {
  return messages.map((message) => {
    const first = message.role === "assistant" ? firstToolUse(message.content) : null;
    const key = first ? `${userId}\u0000${first}` : "";
    const cached = key ? thinking.get(key) : undefined;
    if (!cached) return message;
    thinking.delete(key);
    thinking.set(key, cached);
    return { role: "assistant", content: structuredClone(cached) };
  });
}

function thinkingRefused(error: unknown): boolean {
  if (!(error instanceof ProviderError) || error.status !== 400) return false;
  const text = error.message.toLowerCase();
  return text.includes("thinking") || text.includes("signature");
}

/** The same request with no thinking blocks in its history and thinking off for this reply. */
export function withoutThinking(payload: Json): Json {
  const messages = (Array.isArray(payload.messages) ? (payload.messages as Json[]) : []).map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
    const kept = (message.content as Json[]).filter((block) => !(block && (block.type === "thinking" || block.type === "redacted_thinking")));
    return { ...message, content: kept.length ? kept : [{ type: "text", text: "" }] };
  });
  return { ...payload, messages, thinking: { ...(THINKING_OFF[String(payload.model ?? "")] ?? { type: "disabled" }) } };
}

/** No temperature or top_p (these models refuse them) and no `thinking`: adaptive thinking is their default. */
function claudePayload(userId: string, model: string, messages: Json[], tools: Json[], effort: string | null, maxTokens: number): Json {
  const converted = toAnthropic(messages);
  const payload: Json = { model, max_tokens: maxTokens, messages: replayThinking(userId, converted.messages) };
  if (converted.system) payload.system = converted.system;
  if (tools.length) payload.tools = tools;
  if (effort) payload.output_config = { effort };
  return payload;
}

/** No temperature, top_p or reasoning_effort: the chat model takes no thinking level. */
function chatPayload(model: string, messages: Json[], tools: Json[] | null, jsonMode: boolean, maxTokens: number): Json {
  const payload = buildChatPayload(model, INCLUDED_PROVIDER, messages, { tools });
  payload.max_completion_tokens = maxTokens;
  if (jsonMode) payload.response_format = { type: "json_object" };
  return payload;
}

function responsesPayload(model: string, messages: Json[], items: unknown[] | null, tools: Json[] | null, effort: string | null, jsonMode: boolean, maxTokens: number): Json {
  const history = items?.length ? cleanItems(items) : itemsFromChat(messages);
  const payload = buildResponsesPayload(model, history, { tools: tools?.length ? toolsFor(tools) : null, effort, jsonMode });
  payload.max_output_tokens = maxTokens;
  return payload;
}

/** The credits the call cost, or null when the ledger could not be told (it charges the reservation later). */
async function settleQuietly(id: string, usage: IncludedTokens | null, answeredBy?: string | null): Promise<number | null> {
  try {
    return (await settleIncluded({ id, usage, answeredBy: answeredBy || null })).credits;
  } catch (error) {
    console.warn(`included settle of ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Runs one call under its reservation and settles it exactly once. A request Azure refused (or never
 * received) is not billed, so it settles at zero. Anything that may have been billed without a usage
 * report settles with no usage, and the ledger charges the reservation. A cancelled call does not
 * wait for its settlement.
 */
async function settled(
  id: string,
  send: () => Promise<Response>,
  read: (response: Response) => Promise<{ turn: Json; usage: IncludedTokens }>,
  signal?: AbortSignal,
): Promise<Json> {
  const failed = async (error: unknown, usage: IncludedTokens | null): Promise<never> => {
    if (signal?.aborted || isAbortError(error)) void settleQuietly(id, null);
    else await settleQuietly(id, usage);
    throw error;
  };
  let response: Response;
  try {
    response = await send();
  } catch (error) {
    return failed(error, error instanceof ProviderError || error instanceof ModelUnreachableError ? { ...NO_USAGE } : null);
  }
  let result: { turn: Json; usage: IncludedTokens };
  try {
    result = await read(response);
  } catch (error) {
    return failed(error, null);
  }
  result.turn.credits = await settleQuietly(id, result.usage, String(result.turn.model ?? ""));
  return result.turn;
}

/**
 * One turn on an included model, in the runtime's turn shape, with `credits` from the ledger. In the
 * desktop app and the CLI, which hold no Azure key, Ensemble's server runs it (included/device.ts).
 */
export async function includedTurn(
  body: Json,
  model: string,
  messages: Json[],
  options: { items?: unknown[] | null; jsonMode?: boolean; signal?: AbortSignal; timeoutMs: number },
): Promise<Json> {
  if (onDevice()) return deviceIncludedTurn(body, model, messages, options);
  const { config, entry } = configured(model);
  const userId = typeof body.userId === "string" && body.userId ? body.userId : null;
  if (!userId) throw new IncludedLimitError(INCLUDED_UNAVAILABLE, "A signed-in account is required to use included models.");
  const level = effortFor(INCLUDED_PROVIDER, typeof body.reasoningEffort === "string" ? body.reasoningEffort : null, model);
  const effort = level && entry.efforts.includes(level as IncludedEffort) ? level : null;
  const chatTools = Array.isArray(body.chatTools) && body.chatTools.length ? (body.chatTools as Json[]) : null;
  const specs = Array.isArray(body.responsesTools) && body.responsesTools.length ? (body.responsesTools as Json[]) : chatTools;
  const cap = config.maxOutputTokens;
  const jsonMode = Boolean(options.jsonMode);
  let url = `${openaiBase(config.resource, entry.host)}/responses`;
  let headers: Record<string, string> = { "api-key": config.apiKey };
  let request: Json;
  if (entry.api === "anthropic") {
    url = `${anthropicBase(config.resource)}/v1/messages`;
    headers = { ...headers, "anthropic-version": "2023-06-01" };
    request = claudePayload(userId, model, messages, anthropicTools(body), effort, cap);
  } else if (entry.api === "chat") {
    url = `${openaiBase(config.resource, entry.host)}/chat/completions`;
    request = chatPayload(model, messages, chatTools, jsonMode, cap);
  } else {
    request = responsesPayload(model, messages, options.items ?? null, specs, effort, jsonMode, cap);
  }
  const post = (payload: Json) => postWithRetry((current) => sendJson(url, headers, current, options.timeoutMs, options.signal, { provider: INCLUDED_PROVIDER, model, url }), payload);
  const send = async () => {
    try {
      return await post(request);
    } catch (error) {
      if (entry.api !== "anthropic" || !thinkingRefused(error)) throw error;
      return post(withoutThinking(request));
    }
  };
  const read = async (response: Response) => {
    const data = await readJsonObject(response);
    if (entry.api === "anthropic") rememberTurn(userId, data.content);
    const usage = entry.api === "anthropic" ? anthropicUsage(data.usage) : entry.api === "chat" ? chatUsage(data.usage) : responsesUsage(data.usage);
    const turn = entry.api === "anthropic" ? fromAnthropic(data, model) : entry.api === "chat" ? fromOpenAi(data, model) : turnFromResponse(data, model);
    return { turn: { ...turn, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens }, usage };
  };
  await pace(userId, INCLUDED_PROVIDER);
  const reservation = await reserveIncluded({
    userId,
    model,
    inputTokens: estimateInputTokens(request),
    maxOutputTokens: cap,
    purpose: typeof body.purpose === "string" ? body.purpose : null,
  });
  return settled(reservation.id, send, read, options.signal);
}
