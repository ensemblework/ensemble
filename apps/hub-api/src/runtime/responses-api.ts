/**
 * OpenAI's Responses API, for the models a provider serves only there. Port of
 * apps/agent-runtime/ensemble_agent/responses_api.py.
 *
 * GitHub Copilot answers `model "gpt-5.4-mini" is not accessible via the /chat/completions endpoint`
 * for some models (gpt-5.4, gpt-5.4-mini, the gpt-5.x codex models); they take `POST /responses`.
 * This builds that request from the runtime's history and tools and reads the reply and its stream
 * into the same turn a chat completion gives, so callers see one kind of turn whichever endpoint
 * answered. Which endpoint a model takes: what the provider's model list said
 * (`supported_endpoints`), else what a refusal taught this process, else gpt-5 and o-series names go
 * to /responses first.
 */
import { hasAttachmentParts, responsesUserContent } from "./content-parts.js";
import { ProviderError } from "./errors.js";
import type { Json } from "./payload.js";

/** Providers whose models may need /responses. Other OpenAI-compatible providers stay on chat. */
export const RESPONSES_PROVIDERS = new Set(["copilot"]);

export type Api = "chat" | "responses";

let responsesFirst = /^(gpt-5|o[1-9]\b|o[1-9]-|codex)/i;
const learned = new Map<string, Api>();
const slot = (provider: string, model: string) => `${provider}\u0000${model}`;

export function apiFor(provider: string, model: string): Api {
  if (!RESPONSES_PROVIDERS.has(provider)) return "chat";
  const known = learned.get(slot(provider, model));
  if (known) return known;
  return responsesFirst.test(model || "") ? "responses" : "chat";
}

export function learn(provider: string, model: string, api: Api): void {
  if (RESPONSES_PROVIDERS.has(provider) && model) learned.set(slot(provider, model), api);
}

/** A model list that says which endpoints each model takes settles it for those models. */
export function learnFromListing(provider: string, rows: ReadonlyArray<{ id?: unknown; supported_endpoints?: unknown }>): void {
  for (const row of rows) {
    if (typeof row.id !== "string" || !Array.isArray(row.supported_endpoints)) continue;
    const names = new Set(row.supported_endpoints.map(String));
    if (names.has("/chat/completions")) learn(provider, row.id, "chat");
    else if (names.has("/responses")) learn(provider, row.id, "responses");
  }
}

export function forgetLearnedForTests(pattern?: RegExp): void {
  learned.clear();
  if (pattern) responsesFirst = pattern;
  else responsesFirst = /^(gpt-5|o[1-9]\b|o[1-9]-|codex)/i;
}

/** The endpoint to use instead, when the provider refused the model on the one called. */
export function otherEndpoint(error: ProviderError): Api | null {
  if (![400, 404, 422].includes(error.status)) return null;
  const text = error.message.toLowerCase();
  if (!["not accessible", "not supported", "unsupported", "does not support"].some((word) => text.includes(word))) return null;
  if (text.includes("/chat/completions") || text.includes("chat completions")) return "responses";
  if (text.includes("/responses") || text.includes("responses api")) return "chat";
  return null;
}

function textOf(content: unknown): string {
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" ? String((part as Json).text ?? "") : String(part))).join("");
  return content == null ? "" : String(content);
}

function argumentsOf(value: unknown): string {
  if (typeof value === "string") return value || "{}";
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

/** Chat-completion history → Responses input items. */
export function itemsFromChat(messages: Json[]): Json[] {
  const items: Json[] = [];
  for (const message of messages) {
    const role = message.role;
    if (role === "tool") {
      items.push({ type: "function_call_output", call_id: String(message.tool_call_id ?? ""), output: textOf(message.content) });
      continue;
    }
    const text = textOf(message.content);
    if (role === "assistant") {
      if (text.trim()) items.push({ role: "assistant", content: text });
      for (const call of Array.isArray(message.tool_calls) ? (message.tool_calls as Json[]) : []) {
        const fn = (call.function ?? {}) as Json;
        items.push({ type: "function_call", call_id: String(call.id ?? ""), name: String(fn.name ?? ""), arguments: argumentsOf(fn.arguments) });
      }
      continue;
    }
    if (role === "user") items.push({ role, content: responsesUserContent(message.content) });
    else if (role === "system" || role === "developer") items.push({ role, content: text });
  }
  return items;
}

const same = (a: Json | undefined, b: Json) => Boolean(a) && a!.role === b.role && a!.content === b.content && !a!.type;

/**
 * hub-api's Responses-shaped history, made safe to send with `store: false`: reasoning items and
 * provider item ids point at stored responses, which are not kept, so they are dropped; an earlier
 * reply's message item becomes a plain assistant message.
 */
export function cleanItems(items: unknown[]): Json[] {
  const out: Json[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Json;
    const kind = item.type;
    if (kind === "reasoning") continue;
    if (kind === "message") {
      const text = textOf(item.content);
      if (!text.trim()) continue;
      const entry = { role: String(item.role ?? "assistant"), content: text };
      if (!same(out[out.length - 1], entry)) out.push(entry);
      continue;
    }
    if (kind === "function_call") {
      out.push({ type: "function_call", call_id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), arguments: argumentsOf(item.arguments) });
      continue;
    }
    if (kind === "function_call_output") {
      out.push({ type: "function_call_output", call_id: String(item.call_id ?? ""), output: typeof item.output === "string" ? item.output : argumentsOf(item.output) });
      continue;
    }
    const role = item.role;
    if (role === "user" && hasAttachmentParts(item.content)) {
      out.push({ role, content: responsesUserContent(item.content) });
      continue;
    }
    if (role === "system" || role === "developer" || role === "user" || role === "assistant") {
      const text = textOf(item.content);
      if (role === "assistant" && !text.trim()) continue;
      const entry = { role, content: text };
      if (!same(out[out.length - 1], entry)) out.push(entry);
    }
  }
  return out;
}

/** Chat-completion tool specs → Responses tool specs (a spec already in that shape stays). */
export function toolsFor(tools: Json[] | null | undefined): Json[] {
  const out: Json[] = [];
  for (const tool of tools ?? []) {
    const fn = tool.function as Json | undefined;
    const source = fn && typeof fn === "object" ? fn : tool.name ? tool : null;
    if (!source) continue;
    out.push({
      type: "function",
      name: String(source.name ?? ""),
      strict: false,
      ...(source.description ? { description: source.description } : {}),
      parameters: source.parameters ?? { type: "object", properties: {} },
    });
  }
  return out;
}

/** A Responses request. No temperature: the reasoning models that need this endpoint refuse it. */
export function buildResponsesPayload(
  model: string,
  items: Json[],
  options: { tools?: Json[] | null; effort?: string | null; jsonMode?: boolean; stream?: boolean } = {},
): Json {
  const payload: Json = { model, input: items, store: false };
  if (options.tools?.length) {
    payload.tools = options.tools;
    payload.tool_choice = "auto";
  }
  if (options.effort) payload.reasoning = { effort: options.effort };
  if (options.jsonMode) payload.text = { format: { type: "json_object" } };
  if (options.stream) payload.stream = true;
  return payload;
}

/** A Responses reply → the runtime's turn (text, tool calls, tokens, finish). */
export function turnFromResponse(data: Json, model: string): Json {
  const texts: string[] = [];
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  const reasoning: string[] = [];
  const output = Array.isArray(data.output) ? (data.output as unknown[]).filter((item): item is Json => !!item && typeof item === "object") : [];
  for (const item of output) {
    if (item.type === "message") {
      for (const part of Array.isArray(item.content) ? (item.content as Json[]) : []) {
        if (part && (part.type === "output_text" || part.type === "text")) texts.push(String(part.text ?? ""));
      }
    } else if (item.type === "function_call") {
      calls.push({ id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), arguments: argumentsOf(item.arguments) });
    } else if (item.type === "reasoning") {
      for (const part of Array.isArray(item.summary) ? (item.summary as Json[]) : []) {
        if (part?.text) reasoning.push(String(part.text));
      }
    }
  }
  if (!texts.length && typeof data.output_text === "string") texts.push(data.output_text);
  const usage = (data.usage && typeof data.usage === "object" ? data.usage : {}) as Json;
  const status = data.status;
  const incomplete = (data.incomplete_details && typeof data.incomplete_details === "object" ? data.incomplete_details : {}) as Json;
  const done = status === "completed" || status == null;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null);
  return {
    text: texts.join(""),
    toolCalls: calls,
    model: String(data.model || model),
    credits: null,
    tokensIn: number(usage.input_tokens),
    tokensOut: number(usage.output_tokens),
    reasoning: reasoning.join("\n"),
    finishReason: done ? (calls.length ? "tool_calls" : "stop") : String(incomplete.reason ?? status),
    cutOff: !done,
    raw: { output: output.filter((item) => item.type !== "reasoning"), model: String(data.model || model), status: status ?? null, api: "responses" },
  };
}

function failureMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as Json;
    return String(record.message ?? record.code ?? "The model reply failed.");
  }
  return String(error ?? "The model reply failed.");
}

/**
 * SSE lines of a Responses stream → `{kind: "delta"}` … then `{kind: "done"}` with the turn. A
 * stream that ends without `response.completed` keeps what arrived and is marked cut off.
 */
export async function* turnFromStream(lines: AsyncIterable<string>, model: string): AsyncGenerator<{ kind: "delta"; text: string } | { kind: "done"; turn: Json }> {
  const pieces: string[] = [];
  let final: Json | null = null;
  for await (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event: Json;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      event = parsed as Json;
    } catch {
      continue;
    }
    const kind = event.type;
    if (kind === "response.output_text.delta") {
      const delta = String(event.delta ?? "");
      if (delta) {
        pieces.push(delta);
        yield { kind: "delta", text: delta };
      }
    } else if (kind === "response.completed" || kind === "response.incomplete") {
      if (event.response && typeof event.response === "object") final = event.response as Json;
    } else if (kind === "response.failed") {
      const response = (event.response && typeof event.response === "object" ? event.response : {}) as Json;
      throw new ProviderError(502, "other", failureMessage(response.error));
    } else if (kind === "error") {
      throw new ProviderError(Number(event.status) || 502, "other", failureMessage(event.error ?? event));
    }
  }
  if (!final) {
    yield {
      kind: "done",
      turn: turnFromResponse({ output: [{ type: "message", content: [{ type: "output_text", text: pieces.join("") }] }], status: "incomplete", incomplete_details: { reason: "stream ended" } }, model),
    };
    return;
  }
  const turn = turnFromResponse(final, model);
  if (!turn.text && pieces.length) turn.text = pieces.join("");
  yield { kind: "done", turn };
}
