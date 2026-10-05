/** OpenAI-compatible and Anthropic request/response mapping. No network. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkText } from "../lib/text.js";
import { CONNECTION_DROPPED_NOTICE, isAbortError, isTransportDrop } from "../lib/stream-drop.js";
import { ProviderError } from "./errors.js";

export const CHEAPEST: Record<string, string> = {
  google: "gemini-3.5-flash-lite",
  openai: "gpt-4.1-mini",
  anthropic: "claude-haiku-4-5-20251001",
  cursor: "composer-2.5",
  openrouter: "openrouter/auto",
  copilot: "gpt-4.1",
  mistral: "mistral-small-latest",
  kimi: "moonshot-v1-8k",
  qwen: "qwen-flash",
};

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
export const BASES: Record<string, string> = {
  google: GEMINI_BASE,
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  mistral: "https://api.mistral.ai/v1",
  kimi: "https://api.moonshot.ai/v1",
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
};

export const JSON_PROVIDERS = new Set(["google", "openai", "openrouter", "mistral", "kimi", "qwen"]);
export const BACKOFF_SECONDS = [0.4, 1.2, 3.0];
export const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const FIXTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;
const FIXTURE_TAG = /\[\[fixture:([A-Za-z0-9][A-Za-z0-9_.-]{0,80})\]\]/;
const SKIP_GEMINI = /tts|image|robotics|computer-use|transcribe|omni|embedding|aqa|banana|lyria|research|antigravity|veo|imagen/;

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../agent-runtime/tests/fixtures");

export type Json = Record<string, unknown>;

export function inferProvider(model: string): string {
  const name = model.toLowerCase();
  if (name.startsWith("gemini") || name.startsWith("gemma")) return "google";
  if (name.startsWith("claude")) return "anthropic";
  if (["mistral", "ministral", "codestral", "pixtral", "open-mistral"].some((prefix) => name.startsWith(prefix))) return "mistral";
  if (name.startsWith("moonshot") || name.startsWith("kimi")) return "kimi";
  if (name.startsWith("qwen")) return "qwen";
  if (name.includes("/")) return "openrouter";
  if (name.startsWith("gpt") || name.startsWith("o1") || name.startsWith("o3") || name.startsWith("o4")) return "openai";
  return process.env.ENSEMBLE_LLM_PROVIDER || "google";
}

export function effortFor(provider: string, effort: string | null | undefined, model?: string | null): string | null {
  if (!effort || effort === "default") return null;
  if (provider === "google" && effort === "minimal" && !String(model ?? "").startsWith("gemini-3")) return "low";
  return effort;
}

export function retryPlan(error: ProviderError, attempt: number, random = Math.random): number | null {
  if (error.kind === "quota" || !RETRY_STATUSES.has(error.status)) return null;
  // A 429 with no retry hint is not retried. Quota and RESOURCE_EXHAUSTED never are.
  if (error.status === 429 && error.retryAfterSeconds == null) return null;
  const extra = error.status === 429 || error.status === 503 ? 3 : 2;
  if (attempt >= extra) return null;
  if (error.retryAfterSeconds != null) return Math.min(60, Math.max(0, Number(error.retryAfterSeconds)));
  const base = BACKOFF_SECONDS[Math.min(Math.max(attempt, 0), BACKOFF_SECONDS.length - 1)] ?? 3;
  return base + random() * 0.25;
}

/** Silent cross-model fallback is off. A lite model must never become flash on its own. */
export function canCrossModelFallback(_error: { status: number }, _fallback: unknown, _model: string): boolean {
  return false;
}

function thoughtSignature(call: Json): string | null {
  const extra = call.extra_content;
  if (!extra || typeof extra !== "object") return null;
  const google = (extra as Json).google;
  if (!google || typeof google !== "object") return null;
  const signature = (google as Json).thought_signature;
  return typeof signature === "string" && signature ? signature : null;
}

export function textOf(content: unknown): string {
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === "object" ? String((part as Json).text ?? "") : String(part))).join("");
  }
  return String(content ?? "");
}

/** Gemini function-response turn: no empty parts, every call has a response, signatures kept. */
export function sanitizeChatMessages(messages: Json[]): Json[] {
  const prepared: Json[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (!message || message.role === "tool") {
      index += 1;
      continue;
    }
    const calls = message.tool_calls;
    if (message.role !== "assistant" || !Array.isArray(calls) || calls.length === 0) {
      prepared.push(message);
      index += 1;
      continue;
    }
    const signed: Json[] = calls.map((call) => (call && typeof call === "object" ? { ...(call as Json) } : { id: "", type: "function", function: {} }));
    const donor = signed.find((call) => thoughtSignature(call));
    const signature = donor ? thoughtSignature(donor) : null;
    if (signature) {
      for (const call of signed) {
        if (thoughtSignature(call)) continue;
        const extra = { ...((call.extra_content as Json | undefined) ?? {}) };
        const google = { ...((extra.google as Json | undefined) ?? {}), thought_signature: signature };
        extra.google = google;
        call.extra_content = extra;
      }
    }
    const text = message.content;
    prepared.push({
      ...message,
      content: typeof text === "string" && text.trim() ? text : null,
      tool_calls: signed,
    });
    const results = new Map<string, Json>();
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]?.role === "tool") {
      const row = messages[cursor]!;
      results.set(String(row.tool_call_id ?? ""), row);
      cursor += 1;
    }
    index = cursor;
    for (const call of signed) {
      const callId = String(call.id ?? "");
      const fn = call.function && typeof call.function === "object" ? (call.function as Json) : {};
      const name = String(fn.name ?? "");
      const found = results.get(callId);
      let content = found?.content;
      if (typeof content !== "string" || !content.trim()) content = JSON.stringify({ error: "The tool did not return a result." });
      prepared.push({
        role: "tool",
        tool_call_id: callId,
        name: String(found?.name || name),
        content,
      });
    }
  }
  return prepared;
}

export function buildChatPayload(
  model: string,
  provider: string,
  messages: Json[],
  options: {
    tools?: Json[] | null;
    reasoningEffort?: string | null;
    temperature?: number | null;
    jsonMode?: boolean;
    stream?: boolean;
  } = {},
): Json {
  const payload: Json = { model, messages: sanitizeChatMessages(messages) };
  if (options.tools && options.tools.length) {
    payload.tools = options.tools;
    payload.tool_choice = "auto";
  }
  const effort = effortFor(provider, options.reasoningEffort, model);
  if (effort) payload.reasoning_effort = effort;
  if (options.temperature != null && !model.startsWith("gemini-3")) payload.temperature = options.temperature;
  if (options.jsonMode && JSON_PROVIDERS.has(provider)) payload.response_format = { type: "json_object" };
  if (options.stream) payload.stream = true;
  return payload;
}

/** Normal endings only. Anything else, including a missing reason, is a cut-off. */
const FINISH_ALLOW: Record<string, ReadonlySet<string>> = {
  openai: new Set(["stop", "tool_calls", "function_call"]),
  anthropic: new Set(["end_turn", "tool_use", "stop_sequence"]),
  gemini: new Set(["STOP"]),
  ollama: new Set(["stop"]),
};

export function finishIsCutOff(reason: string | null, family: string): boolean {
  if (!reason) return true;
  const allowed = FINISH_ALLOW[family];
  if (!allowed) return true;
  return !allowed.has(reason);
}

function cleanReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const cleaned = reason.trim();
  return cleaned || null;
}

/** A choice that never says how it finished is left alone. A stream always records the key. */
export function finishFields(choice: Json): { finishReason: string | null; cutOff: boolean } {
  if (!("finish_reason" in choice) && !("finish_family" in choice)) return { finishReason: null, cutOff: false };
  const finishReason = cleanReason(choice.finish_reason);
  const family = cleanReason(choice.finish_family) ?? "openai";
  return { finishReason, cutOff: finishIsCutOff(finishReason, family) };
}

function stopFields(data: Json, key: string, family: string): { finishReason: string | null; cutOff: boolean } {
  if (!(key in data)) return { finishReason: null, cutOff: false };
  const finishReason = cleanReason(data[key]);
  return { finishReason, cutOff: finishIsCutOff(finishReason, family) };
}

export function fromOpenAi(data: Json, model: string): Json {
  const choice = ((data.choices as Json[] | undefined)?.[0] ?? {}) as Json;
  const message = (choice.message ?? {}) as Json;
  const calls: Json[] = [];
  for (const call of (message.tool_calls as Json[] | undefined) ?? []) {
    const fn = (call.function ?? {}) as Json;
    const argumentsValue = fn.arguments ?? "{}";
    calls.push({
      id: String(call.id ?? ""),
      name: String(fn.name ?? ""),
      arguments: typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue),
    });
  }
  const usage = (data.usage ?? {}) as Json;
  const finish = finishFields(choice);
  return {
    text: textOf(message.content),
    toolCalls: calls,
    model: String(data.model || model),
    credits: null,
    tokensIn: usage.prompt_tokens ?? null,
    tokensOut: usage.completion_tokens ?? null,
    reasoning: String(message.reasoning_content ?? ""),
    finishReason: finish.finishReason,
    cutOff: finish.cutOff,
    raw: data,
  };
}

export function toAnthropic(messages: Json[]): { system: string; messages: Json[] } {
  const system: string[] = [];
  const out: Json[] = [];
  for (const message of messages) {
    const role = message.role;
    if (role === "system") {
      system.push(textOf(message.content));
      continue;
    }
    if (role === "tool") {
      const block = { type: "tool_result", tool_use_id: message.tool_call_id, content: textOf(message.content) };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as Json[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (role === "assistant") {
      const blocks: Json[] = [];
      const text = textOf(message.content);
      if (text) blocks.push({ type: "text", text });
      for (const call of (message.tool_calls as Json[] | undefined) ?? []) {
        const fn = (call.function ?? {}) as Json;
        let args: unknown = {};
        try {
          args = JSON.parse(String(fn.arguments ?? "{}"));
        } catch {
          args = {};
        }
        blocks.push({ type: "tool_use", id: call.id, name: fn.name, input: args });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
      continue;
    }
    out.push({ role: "user", content: textOf(message.content) });
  }
  return { system: system.join("\n\n"), messages: out };
}

export function anthropicTools(body: Json): Json[] {
  const tools = Array.isArray(body.chatTools) ? (body.chatTools as Json[]) : [];
  return tools
    .filter((tool) => tool.type === "function")
    .map((tool) => {
      const fn = (tool.function ?? {}) as Json;
      return {
        name: fn.name,
        description: fn.description ?? "",
        input_schema: fn.parameters ?? { type: "object", properties: {} },
      };
    });
}

export function anthropicPayload(body: Json, model: string, messages: Json[]): Json {
  const converted = toAnthropic(messages);
  const tools = anthropicTools(body);
  const payload: Json = { model, max_tokens: Number(body.maxTokens ?? 4096), messages: converted.messages };
  if (converted.system) payload.system = converted.system;
  if (tools.length) payload.tools = tools;
  const effort = effortFor("anthropic", typeof body.reasoningEffort === "string" ? body.reasoningEffort : null, model);
  if (effort && effort !== "minimal") payload.output_config = { effort };
  return payload;
}

export function fromAnthropic(data: Json, model: string): Json {
  const content = Array.isArray(data.content) ? (data.content as Json[]) : [];
  const text = content.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("");
  const calls = content
    .filter((block) => block.type === "tool_use")
    .map((block) => ({ id: String(block.id ?? ""), name: String(block.name ?? ""), arguments: JSON.stringify(block.input ?? {}) }));
  const usage = (data.usage ?? {}) as Json;
  const finish = stopFields(data, "stop_reason", "anthropic");
  const choice: Json = {
    message: {
      role: "assistant",
      content: text,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    },
  };
  if ("stop_reason" in data) {
    choice.finish_reason = data.stop_reason ?? null;
    choice.finish_family = "anthropic";
  }
  const native = { choices: [choice] };
  return {
    text,
    toolCalls: calls,
    model: String(data.model || model),
    credits: null,
    tokensIn: usage.input_tokens ?? null,
    tokensOut: usage.output_tokens ?? null,
    reasoning: "",
    finishReason: finish.finishReason,
    cutOff: finish.cutOff,
    raw: native,
  };
}

export function newStreamState(): Json {
  return { content: [], reasoning: [], tools: {}, toolIndexes: {}, model: "", usage: {}, finishReason: null, finishFamily: null };
}

function noteFinish(state: Json, reason: unknown, family: string): void {
  const cleaned = cleanReason(reason);
  if (!cleaned) return;
  state.finishReason = cleaned;
  state.finishFamily = family;
}

function blankTool(): Json {
  return { id: "", type: "function", function: { name: "", arguments: "" } };
}

function nextToolIndex(tools: Record<string, Json>): number {
  const keys = Object.keys(tools)
    .map((key) => Number(key))
    .filter((key) => Number.isFinite(key));
  if (!keys.length) return 0;
  return Math.max(...keys) + 1;
}

/** First truthy id, so a blank functionCall id falls through to the part id. */
function joinedId(...values: unknown[]): string {
  for (const value of values) {
    if (value) return String(value);
  }
  return "";
}

function providerIndex(call: Json): number | null {
  if (!("index" in call)) return null;
  const raw = call.index;
  if (typeof raw === "boolean" || raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

function newTool(state: Json, providerIndexValue: number | null): Json {
  const tools = state.tools as Record<string, Json>;
  const indexes = (state.toolIndexes ??= {}) as Record<string, number>;
  const index = nextToolIndex(tools);
  const slot = blankTool();
  tools[index] = slot;
  if (providerIndexValue != null) indexes[index] = providerIndexValue;
  return slot;
}

/**
 * A non-empty id wins over index. A different id always starts a new call, even
 * at an index we already have. The same id returns that call. A chunk with no
 * id attaches to the most recent call at that index. With neither, a named call
 * starts a new one and a bare fragment continues the latest call.
 */
function toolSlot(state: Json, call: Json): Json {
  const tools = state.tools as Record<string, Json>;
  const indexes = (state.toolIndexes ??= {}) as Record<string, number>;
  const id = joinedId(call.id);
  const index = providerIndex(call);
  if (id) {
    for (const [key, slot] of Object.entries(tools)) {
      if (String(slot.id ?? "") === id) {
        if (index != null && indexes[key] == null) indexes[key] = index;
        return slot;
      }
    }
    return newTool(state, index);
  }
  if (index != null) {
    let match: Json | null = null;
    const keys = Object.keys(tools)
      .map((key) => Number(key))
      .filter((key) => Number.isFinite(key))
      .sort((a, b) => a - b);
    for (const key of keys) {
      if (indexes[key] === index) match = tools[key]!;
    }
    if (match) return match;
    return newTool(state, index);
  }
  const fn = (call.function ?? {}) as Json;
  if (fn.name) return newTool(state, null);
  const keys = Object.keys(tools)
    .map((key) => Number(key))
    .filter((key) => Number.isFinite(key));
  if (keys.length) return tools[Math.max(...keys)]!;
  return newTool(state, null);
}

/** Stream argument text. Objects use compact JSON, matching Python's json.dumps separators. */
function argumentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value);
  if (!value) return "";
  return String(value);
}

/** A proxy may resend one finished functionCall. The same name and arguments are not a new call. */
function repeatedWholeCall(state: Json, call: Json): Json | null {
  const rawIndex = "index" in call ? call.index : undefined;
  if (rawIndex !== undefined && rawIndex !== null && rawIndex !== "") return null;
  if (call.id) return null;
  const fn = (call.function ?? {}) as Json;
  const name = fn.name ? String(fn.name) : "";
  const argumentsValue = argumentText(fn.arguments);
  if (!name || !argumentsValue) return null;
  for (const slot of Object.values(state.tools as Record<string, Json>)) {
    const current = (slot.function ?? {}) as Json;
    if (String(current.name ?? "") === name && String(current.arguments ?? "") === argumentsValue) return slot;
  }
  return null;
}

function completeJsonObject(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** Both complete objects replace. An `{}` placeholder followed by a fragment is empty. Otherwise concatenate. */
function mergeArguments(existing: string, incoming: string, replaceComplete: boolean): string {
  if (replaceComplete && completeJsonObject(existing) && completeJsonObject(incoming)) return incoming;
  if (existing === "{}" && !completeJsonObject(incoming)) return incoming;
  return existing + incoming;
}

function mergeToolExtra(slot: Json, extra: unknown): void {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return;
  const merged = (slot.extra_content ??= {}) as Json;
  for (const [key, value] of Object.entries(extra as Json)) {
    if (value && typeof value === "object" && !Array.isArray(value) && merged[key] && typeof merged[key] === "object" && !Array.isArray(merged[key])) {
      Object.assign(merged[key] as Json, value);
    } else {
      merged[key] = value;
    }
  }
}

function accumulateToolCall(state: Json, call: Json | null | undefined): void {
  if (!call || typeof call !== "object" || Array.isArray(call)) return;
  const repeated = repeatedWholeCall(state, call);
  if (repeated) {
    mergeToolExtra(repeated, call.extra_content);
    return;
  }
  const slot = toolSlot(state, call);
  const id = joinedId(call.id);
  const sameId = Boolean(id) && String(slot.id ?? "") === id;
  if (id) slot.id = id;
  if (call.type) slot.type = String(call.type);
  mergeToolExtra(slot, call.extra_content);
  const fn = (call.function ?? {}) as Json;
  const slotFn = slot.function as Json;
  const incomingArgs = argumentText(fn.arguments);
  const existingArgs = String(slotFn.arguments ?? "");
  if (fn.name) {
    const newName = String(fn.name);
    const currentName = String(slotFn.name ?? "");
    const replaceName = sameId && currentName && completeJsonObject(existingArgs) && completeJsonObject(incomingArgs);
    if (replaceName) slotFn.name = newName;
    else if (!(sameId && currentName === newName)) slotFn.name = currentName + newName;
  }
  if (incomingArgs) slotFn.arguments = mergeArguments(existingArgs, incomingArgs, sameId);
}

function jsonArguments(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

/** Gemini's last stream chunk reports usageMetadata, not OpenAI usage. */
function geminiUsage(meta: unknown): Json | null {
  if (!meta || typeof meta !== "object") return null;
  const row = meta as Json;
  const num = (...names: string[]): number | null => {
    for (const name of names) {
      const value = row[name];
      if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
      if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Math.trunc(Number(value));
    }
    return null;
  };
  const prompt = num("promptTokenCount", "prompt_token_count");
  const completion = num("candidatesTokenCount", "candidates_token_count");
  if (prompt == null && completion == null) return null;
  const usage: Json = { prompt_tokens: prompt ?? 0, completion_tokens: completion ?? 0 };
  const total = num("totalTokenCount", "total_token_count");
  if (total != null) usage.total_tokens = total;
  return usage;
}

function consumeGeminiChunk(state: Json, event: Json): string {
  let text = "";
  for (const candidate of (event.candidates as Json[] | undefined) ?? []) {
    if (!candidate || typeof candidate !== "object") continue;
    noteFinish(state, candidate.finishReason ?? candidate.finish_reason, "gemini");
    const content = (candidate.content ?? {}) as Json;
    for (const part of (content.parts as Json[] | undefined) ?? []) {
      if (!part || typeof part !== "object") continue;
      const raw = (part.functionCall ?? part.function_call) as Json | undefined;
      if (raw && typeof raw === "object") {
        const argumentsValue =
          "args" in raw && raw.args != null ? jsonArguments(raw.args) : "arguments" in raw && raw.arguments != null ? jsonArguments(raw.arguments) : "{}";
        const built: Json = {
          id: joinedId(raw.id, part.id),
          type: "function",
          function: { name: String(raw.name ?? ""), arguments: argumentsValue },
        };
        const signature = part.thoughtSignature ?? part.thought_signature;
        if (typeof signature === "string" && signature) built.extra_content = { google: { thought_signature: signature } };
        accumulateToolCall(state, built);
        continue;
      }
      if (typeof part.text === "string" && part.text) {
        (state.content as string[]).push(part.text);
        text += part.text;
      }
    }
  }
  return text;
}

function consumeAnthropicChunk(state: Json, event: Json): string {
  if (event.type === "message_delta") {
    const stop = (event.delta ?? {}) as Json;
    noteFinish(state, stop.stop_reason, "anthropic");
    return "";
  }
  if (event.type === "message") noteFinish(state, event.stop_reason, "anthropic");
  if (event.type === "content_block_start") {
    const block = (event.content_block ?? {}) as Json;
    if (block.type !== "tool_use") return "";
    const rawInput = block.input;
    const argumentsValue =
      typeof rawInput === "string"
        ? rawInput
        : rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) && Object.keys(rawInput).length
          ? JSON.stringify(rawInput)
          : "";
    accumulateToolCall(state, {
      index: event.index,
      id: block.id ?? "",
      type: "function",
      function: { name: block.name ?? "", arguments: argumentsValue },
    });
    return "";
  }
  if (event.type !== "content_block_delta") return "";
  const delta = (event.delta ?? {}) as Json;
  if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
    (state.content as string[]).push(delta.text);
    return delta.text;
  }
  if (delta.type === "input_json_delta") {
    accumulateToolCall(state, { index: event.index, function: { arguments: String(delta.partial_json ?? "") } });
  }
  return "";
}

function usageHasCounts(usage: Json): boolean {
  return typeof usage.prompt_tokens === "number" || typeof usage.completion_tokens === "number";
}

export function applyStreamEvent(state: Json, event: Json): string {
  if (event.model) state.model = event.model;
  const meta = geminiUsage(event.usageMetadata) ?? geminiUsage(event.usage_metadata) ?? geminiUsage(event.usage);
  if (meta) state.usage = meta;
  else if (event.usage && typeof event.usage === "object" && usageHasCounts(event.usage as Json)) state.usage = event.usage;
  noteFinish(state, event.done_reason, "ollama");
  let deltaText = consumeGeminiChunk(state, event) + consumeAnthropicChunk(state, event);
  for (const choice of (event.choices as Json[] | undefined) ?? []) {
    if (!choice || typeof choice !== "object") continue;
    noteFinish(state, choice.finish_reason, "openai");
    const delta = (choice.delta ?? {}) as Json;
    noteFinish(state, delta.finish_reason, "openai");
    const piece = delta.content;
    if (typeof piece === "string" && piece) {
      (state.content as string[]).push(piece);
      deltaText += piece;
    } else if (Array.isArray(piece)) {
      const text = textOf(piece);
      if (text) {
        (state.content as string[]).push(text);
        deltaText += text;
      }
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      (state.reasoning as string[]).push(delta.reasoning_content);
    }
    for (const call of (delta.tool_calls as Json[] | undefined) ?? []) {
      accumulateToolCall(state, call);
    }
  }
  return deltaText;
}

export function streamStateToCompletion(state: Json, model: string): Json {
  const toolsMap = state.tools as Record<string, Json>;
  const tools = Object.keys(toolsMap)
    .map((key) => Number(key))
    .sort((a, b) => a - b)
    .map((index) => toolsMap[index]!);
  const message: Json = {
    role: "assistant",
    content: (state.content as string[]).join(""),
    tool_calls: tools,
  };
  const reasoning = (state.reasoning as string[]).join("");
  if (reasoning) message.reasoning_content = reasoning;
  const choice: Json = { message, finish_reason: state.finishReason ?? null };
  if (typeof state.finishFamily === "string" && state.finishFamily) choice.finish_family = state.finishFamily;
  return { model: state.model || model, choices: [choice], usage: state.usage ?? {} };
}

const DONE = Symbol("done");

function sseJson(line: string): Json | typeof DONE | null {
  const stripped = line.trim();
  if (!stripped.startsWith("data:")) return null;
  const data = stripped.slice(5).trim();
  if (data === "[DONE]") return DONE;
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

/**
 * How a thrown read of the provider body should finish.
 * "done" keeps the partial text (no finish reason, so the turn is cut off).
 * "notice" means nothing arrived: the caller must not surface the raw socket error.
 * "abort" is a user Stop and is left unchanged.
 */
export function onProviderStreamError(state: Json, error: unknown, signal?: AbortSignal): "done" | "notice" | "abort" | "rethrow" {
  if (signal?.aborted || isAbortError(error)) return "abort";
  if (!isTransportDrop(error)) return "rethrow";
  const text = Array.isArray(state.content) ? (state.content as string[]).join("") : "";
  return text.trim() ? "done" : "notice";
}

/** Read provider SSE lines. A transport drop after text becomes a completion; before text, the plain notice. */
export async function* readSseStream(
  lines: AsyncIterable<string>,
  model: string,
  signal?: AbortSignal,
): AsyncGenerator<{ kind: "delta"; text: string } | { kind: "done"; data: Json }> {
  const state = newStreamState();
  try {
    for await (const line of lines) {
      const item = sseJson(line);
      if (item === DONE) break;
      if (item) {
        const delta = applyStreamEvent(state, item);
        if (delta) yield { kind: "delta", text: delta };
      }
    }
  } catch (error) {
    const decision = onProviderStreamError(state, error, signal);
    if (decision === "done") {
      yield { kind: "done", data: streamStateToCompletion(state, model) };
      return;
    }
    if (decision === "notice") {
      const dropped = new Error(CONNECTION_DROPPED_NOTICE, { cause: error });
      dropped.name = "ConnectionDropped";
      throw dropped;
    }
    if (decision === "abort") {
      yield { kind: "done", data: streamStateToCompletion(state, model) };
    }
    throw error;
  }
  yield { kind: "done", data: streamStateToCompletion(state, model) };
}

export function feedSse(state: Json, block: string): string[] {
  const deltas: string[] = [];
  for (const line of block.split("\n")) {
    const item = sseJson(line);
    if (item === DONE) break;
    if (item && typeof item === "object") {
      const delta = applyStreamEvent(state, item);
      if (delta) deltas.push(delta);
    }
  }
  return deltas;
}

export function textChunks(text: string, size = 24): string[] {
  return chunkText(text, size > 0 ? size : 24);
}

export function sse(event: string, data: Json): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function filterCatalogModels(provider: string, models: string[]): string[] {
  if (provider === "openai") return models.filter((name) => ["gpt", "o1", "o3", "o4"].some((prefix) => name.startsWith(prefix)));
  if (provider === "mistral") {
    return models.filter((name) => !["voxtral", "mistral-ocr", "mistral-embed", "codestral-embed"].some((prefix) => name.startsWith(prefix)));
  }
  if (provider === "qwen") {
    return models.filter((name) => {
      const lower = name.toLowerCase();
      return lower.includes("qwen") && !lower.includes("embed") && !lower.includes("vl");
    });
  }
  return models;
}

export function filterGeminiRows(rows: Array<{ name?: string; supportedGenerationMethods?: string[] }>): string[] {
  return rows
    .filter((row) => {
      const name = row.name ?? "";
      return (
        (row.supportedGenerationMethods ?? []).includes("generateContent") &&
        (name.startsWith("models/gemini") || name.startsWith("models/gemma")) &&
        !SKIP_GEMINI.test(name)
      );
    })
    .map((row) => (row.name ?? "").replace(/^models\//, ""));
}

export function fixtureName(body: Json): string | null {
  const named = body.mockFixture;
  if (typeof named === "string" && named.trim()) return named.trim();
  const messages = body.messages;
  if (Array.isArray(messages)) {
    if (messages.some((message) => message && typeof message === "object" && (message as Json).role === "tool")) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || typeof message !== "object" || (message as Json).role !== "user") continue;
      const match = FIXTURE_TAG.exec(textOf((message as Json).content));
      return match?.[1] ?? null;
    }
  }
  if (typeof body.prompt === "string") {
    const match = FIXTURE_TAG.exec(body.prompt);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function readFixture(name: string): Json {
  const base = name.endsWith(".json") ? name.slice(0, -5) : name;
  if (!FIXTURE_NAME.test(base)) throw new ProviderError(400, "invalid", "Unknown mock fixture.");
  let raw: string;
  try {
    raw = readFileSync(join(FIXTURE_DIR, `${base}.json`), "utf8");
  } catch {
    throw new ProviderError(404, "not_found", `Unknown mock fixture '${base}'.`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new ProviderError(502, "other", `Mock fixture '${base}' is not valid JSON.`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ProviderError(502, "other", `Mock fixture '${base}' must be a JSON object.`);
  }
  return data as Json;
}

export function raiseFixtureError(data: Json): void {
  const err = data.error;
  if (!err || typeof err !== "object") return;
  const record = err as Json;
  const status = typeof record.status === "number" ? record.status : record.code;
  if (!("kind" in record) && typeof status !== "number") return;
  if ("details" in record && !("kind" in record) && typeof status !== "number") return;
  const retry = record.retryAfterSeconds ?? record.retry_after_seconds;
  const quota = record.quotaId ?? record.quota_id;
  const retryAfter = retry == null ? null : Number(retry);
  let kind = record.kind;
  if (typeof kind !== "string") kind = status === 503 ? "unavailable" : status === 429 ? "rate_limit" : "other";
  throw new ProviderError(
    Number(typeof status === "number" ? status : 502),
    String(kind),
    String(record.message || "Mock provider error."),
    quota ? String(quota) : null,
    retryAfter != null && Number.isFinite(retryAfter) ? retryAfter : null,
  );
}
