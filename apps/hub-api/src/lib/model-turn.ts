/**
 * One question to agent-runtime (docs/11).
 *
 * hub-api owns the tools; the runtime owns the model credential. This module
 * is the hop between them: encode the history in both provider shapes, POST
 * /api/chat/tools, and parse a RuntimeTurn.
 */
import { z } from "zod";
import { env } from "../config.js";
import { unreachableFromFrame, MODEL_UNREACHABLE, ModelUnreachableError } from "./model-reach.js";
import { isQuotaFailure, ModelQuotaError, quotaResetInstant } from "./model-quota.js";
import { friendlyModelError, parseRuntimeBody, type ModelFailure } from "./model-error.js";
import { RuntimeError } from "./runtime.js";
import { truncateText } from "./text.js";
import { DecryptError, ModelAuthError, ProviderError, statusForProvider } from "../runtime/errors.js";
import { completeWithTools, streamWithTools } from "../runtime/models.js";
import { useInProcessRuntime } from "../runtime/mode.js";
import type { Json } from "../runtime/payload.js";
import { keysFor } from "../sharing/context.js";

export const RuntimeTurn = z.object({
  text: z.string(),
  toolCalls: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      arguments: z.string(),
    }),
  ),
  model: z.string(),
  credits: z.number().nonnegative().nullable(),
  tokensIn: z.number().int().nonnegative().nullable().default(null),
  tokensOut: z.number().int().nonnegative().nullable().default(null),
  reasoning: z.string().default(""),
  raw: z.record(z.string(), z.unknown()).default({}),
  /** Raw provider finish reason. Null when the stream closed without one. */
  finishReason: z.string().nullable().optional().default(null),
  /** True when the finish reason is outside that provider's allowlist, or missing on a stream. */
  cutOff: z.boolean().optional().default(false),
});
export type RuntimeTurn = z.infer<typeof RuntimeTurn>;

export type ModelMessage = Record<string, unknown>;

export function assistantEcho(turn: RuntimeTurn): ModelMessage {
  const output = turn.raw.output;
  const chat = z
    .object({
      choices: z.array(z.object({ message: z.record(z.string(), z.unknown()) })),
    })
    .safeParse(turn.raw);
  const nativeMessage = chat.success ? chat.data.choices[0]?.message : undefined;
  const nativeCalls = nativeMessage?.tool_calls;
  return {
    role: "assistant",
    content: turn.text,
    tool_calls: Array.isArray(nativeCalls)
      ? nativeCalls
      : turn.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
    ...(typeof nativeMessage?.reasoning_content === "string"
      ? { reasoning_content: nativeMessage.reasoning_content }
      : {}),
    _responses: Array.isArray(output)
      ? output
      : turn.toolCalls.map((call) => ({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
  };
}

export function toolResult(id: string, name: string, payload: unknown): ModelMessage {
  const content = JSON.stringify(payload);
  return {
    role: "tool",
    tool_call_id: id,
    name,
    content,
    _responses: [{ type: "function_call_output", call_id: id, output: content }],
  };
}

function thoughtSignature(call: Record<string, unknown>): string | undefined {
  const extra = call.extra_content;
  if (!extra || typeof extra !== "object") return undefined;
  const google = (extra as { google?: { thought_signature?: unknown } }).google;
  return typeof google?.thought_signature === "string" && google.thought_signature ? google.thought_signature : undefined;
}

/** Gemini rejects an empty assistant part and a function response with no matching call. */
export function prepareProviderMessages(messages: ModelMessage[]): ModelMessage[] {
  const prepared: ModelMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role === "tool") continue;
    const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
    if (message.role !== "assistant" || calls.length === 0) {
      prepared.push(message);
      continue;
    }
    const text = typeof message.content === "string" ? message.content.trim() : "";
    const signed = calls.map((call) => ({ ...call }));
    const donor = signed.find((call) => thoughtSignature(call));
    const signature = donor ? thoughtSignature(donor) : undefined;
    if (signature) {
      for (let callIndex = 0; callIndex < signed.length; callIndex += 1) {
        const call = signed[callIndex];
        if (!call || thoughtSignature(call)) continue;
        const extra = { ...((call.extra_content as Record<string, unknown> | undefined) ?? {}) };
        const google = { ...((extra.google as Record<string, unknown> | undefined) ?? {}), thought_signature: signature };
        signed[callIndex] = { ...call, extra_content: { ...extra, google } };
      }
    }
    prepared.push({ ...message, content: text ? message.content : null, tool_calls: signed });
    const results = new Map<string, ModelMessage>();
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]?.role === "tool") {
      const row = messages[cursor];
      if (row) results.set(String(row.tool_call_id ?? ""), row);
      cursor += 1;
    }
    index = cursor - 1;
    for (const call of signed) {
      const id = String(call.id ?? "");
      const fn = call.function as { name?: string } | undefined;
      const name = String(fn?.name ?? "");
      const found = results.get(id);
      const content =
        found && typeof found.content === "string" && found.content.trim()
          ? found.content
          : JSON.stringify({ error: "The tool did not return a result." });
      prepared.push({
        role: "tool",
        tool_call_id: id,
        name: String(found?.name || name),
        content,
        _responses: [{ type: "function_call_output", call_id: id, output: content }],
      });
    }
  }
  return prepared;
}

export function encodeMessages(messages: ModelMessage[]): {
  chat: ModelMessage[];
  responses: ModelMessage[];
} {
  const ready = prepareProviderMessages(messages);
  return {
    chat: ready.map(({ _responses, ...rest }) => rest),
    responses: ready.flatMap((message) => {
      const { _responses: expanded, tool_calls: _calls, ...rest } = message;
      if (!Array.isArray(expanded)) return [rest];
      const entries = expanded.filter(
        (item): item is ModelMessage => typeof item === "object" && item !== null && !Array.isArray(item),
      );
      const hasText = entries.some((item) => item.type === "message");
      return [...(rest.role === "assistant" && rest.content && hasText ? [rest] : []), ...entries];
    }),
  };
}

function chatBody(args: {
  messages: ModelMessage[];
  model: string;
  provider?: string;
  ollamaUrl?: string;
  reasoningEffort?: string;
  userId: string;
  activityId: string;
  chatTools: ModelMessage[];
  responsesTools: ModelMessage[];
  fallbackModel?: string;
  stream?: boolean;
}): Json {
  const { chat, responses } = encodeMessages(args.messages);
  return {
    messages: chat,
    responsesMessages: responses,
    model: args.model,
    provider: args.provider,
    ollamaUrl: args.ollamaUrl,
    reasoningEffort: args.reasoningEffort,
    userId: keysFor(args.userId),
    activityId: args.activityId,
    role: "coder",
    chatTools: args.chatTools,
    responsesTools: args.responsesTools,
    fallbackModel: args.fallbackModel,
    stream: args.stream,
  };
}

function inProcessChatError(error: unknown, model: string): RuntimeError {
  if (error instanceof ModelUnreachableError) return error;
  if (error instanceof ModelQuotaError) return error;
  if (error instanceof ProviderError) {
    const status = statusForProvider(error.status);
    const raw = JSON.stringify({
      detail: { message: error.message, kind: error.kind, retryAfterSeconds: error.retryAfterSeconds, quotaId: error.quotaId },
    });
    return runtimeFailureFromBody(status, raw, model);
  }
  if (error instanceof DecryptError) return new RuntimeError(error.message, 409);
  if (error instanceof ModelAuthError) return runtimeFailureFromBody(503, JSON.stringify({ detail: error.message }));
  const text = error instanceof Error ? error.message : String(error);
  return new RuntimeError(text.includes("://") ? "The model provider could not be reached." : truncateText(text, 500), 502);
}

function unreachableFromRaw(raw: string, model: string): ModelUnreachableError | null {
  try {
    const body = JSON.parse(raw) as { detail?: unknown; code?: unknown };
    const detail = body && typeof body.detail === "object" && body.detail ? body.detail : body;
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
    if ((detail as { code?: unknown }).code !== MODEL_UNREACHABLE) return null;
    return unreachableFromFrame(detail as { message?: string; provider?: string; model?: string; host?: string; reason?: string }, model);
  } catch {
    return null;
  }
}

export function runtimeFailureFromBody(status: number, raw: string, model = "that model"): RuntimeError {
  const unreachable = unreachableFromRaw(raw, model);
  if (unreachable) return unreachable;
  const failure = parseRuntimeBody(status, truncateText(raw, 2000));
  return failureToError(failure, model);
}

function failureToError(failure: ModelFailure, model: string): RuntimeError {
  if (isQuotaFailure(failure)) {
    const retry = failure.retryAfterSeconds != null && failure.retryAfterSeconds > 0 ? failure.retryAfterSeconds : null;
    return new ModelQuotaError(model, quotaResetInstant(new Date(), retry), retry);
  }
  const httpStatus = failure.status === 503 || failure.status === 400 || failure.status === 429 || failure.status === 404 ? failure.status : 502;
  return new RuntimeError(friendlyModelError(failure), httpStatus);
}

/** Map one runtime SSE error frame. Quota stays 429; other failures keep their status. */
export function errorFromStreamFrame(
  data: {
    message?: string;
    kind?: string;
    status?: number;
    retryAfterSeconds?: number;
    quotaId?: string;
    code?: string;
    provider?: string;
    model?: string;
    host?: string;
    reason?: string;
  },
  model: string,
  now = new Date(),
): RuntimeError {
  if (data.code === MODEL_UNREACHABLE) return unreachableFromFrame(data, model);
  const failure = parseRuntimeBody(typeof data.status === "number" ? data.status : 502, JSON.stringify({ detail: data }));
  if (isQuotaFailure(failure)) {
    const retry = failure.retryAfterSeconds != null && failure.retryAfterSeconds > 0 ? failure.retryAfterSeconds : null;
    return new ModelQuotaError(model, quotaResetInstant(now, retry), retry);
  }
  const httpStatus = failure.status === 503 || failure.status === 400 || failure.status === 429 || failure.status === 404 ? failure.status : 502;
  return new RuntimeError(friendlyModelError(failure), httpStatus);
}

export async function askRuntime(args: {
  messages: ModelMessage[];
  model: string;
  provider?: string;
  ollamaUrl?: string;
  reasoningEffort?: string;
  userId: string;
  activityId: string;
  chatTools: ModelMessage[];
  responsesTools: ModelMessage[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<RuntimeTurn> {
  const limit = args.timeoutMs ?? 300_000;
  const timeout = AbortSignal.timeout(limit);
  const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
  const body = chatBody(args);
  if (useInProcessRuntime()) {
    try {
      return RuntimeTurn.parse(await completeWithTools(body, { signal }));
    } catch (error) {
      if (args.signal?.aborted) throw args.signal.reason ?? error;
      if (timeout.aborted) {
        throw new Error(
          `The model request timed out after ${Math.round(limit / 60_000) || 1} minute${limit >= 120_000 ? "s" : ""}.`,
        );
      }
      throw inProcessChatError(error, args.model);
    }
  }
  let response: Response;
  try {
    response = await fetch(`${env.AGENT_RUNTIME_URL}/api/chat/tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ensemble-internal": env.ENSEMBLE_INTERNAL_TOKEN },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (args.signal?.aborted) throw args.signal.reason;
    if (timeout.aborted) {
      throw new Error(
        `The model request timed out after ${Math.round(limit / 60_000) || 1} minute${limit >= 120_000 ? "s" : ""}.`,
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimeError(
      `The model runtime could not be reached. Start it with pnpm dev (or pnpm dev:agent). ${detail}`,
      503,
    );
  }
  if (!response.ok) throw await runtimeFailure(response, args.model);
  return RuntimeTurn.parse(await response.json());
}

export async function runtimeFailure(response: Response, model = "that model"): Promise<RuntimeError> {
  const raw = await response.text();
  if (raw.includes("MODEL_STOPPED")) return new RuntimeError("Stopped.", 499);
  return runtimeFailureFromBody(response.status, raw, model);
}

export interface StreamTurnHandlers {
  onDelta?: (text: string) => void;
  onStatus?: (text: string) => void;
}

/** Streams tokens from the runtime, then returns the assembled turn. */
async function inProcessStream(body: Json, signal: AbortSignal): Promise<Response> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of streamWithTools(body, { signal })) controller.enqueue(encoder.encode(frame));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let streamForTests: ((args: Parameters<typeof askRuntime>[0] & StreamTurnHandlers & { fallbackModel?: string }) => Promise<RuntimeTurn>) | null = null;

export function setAskRuntimeStreamForTests(
  fn: ((args: Parameters<typeof askRuntime>[0] & StreamTurnHandlers & { fallbackModel?: string }) => Promise<RuntimeTurn>) | null,
): void {
  streamForTests = fn;
}

export async function askRuntimeStream(args: Parameters<typeof askRuntime>[0] & StreamTurnHandlers & { fallbackModel?: string }): Promise<RuntimeTurn> {
  if (streamForTests) return streamForTests(args);
  const limit = args.timeoutMs ?? 300_000;
  const timeout = AbortSignal.timeout(limit);
  const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
  const body = chatBody({ ...args, stream: true });
  let response: Response;
  try {
    if (useInProcessRuntime()) {
      response = await inProcessStream(body, signal);
    } else {
      response = await fetch(`${env.AGENT_RUNTIME_URL}/api/chat/tools/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ensemble-internal": env.ENSEMBLE_INTERNAL_TOKEN, Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal,
      });
    }
  } catch (error) {
    if (args.signal?.aborted) throw args.signal.reason ?? error;
    return askRuntime(args);
  }
  if (!response.ok || !response.body) {
    if (!response.ok) throw await runtimeFailure(response, args.model);
    return askRuntime(args);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let turn: RuntimeTurn | null = null;
  let streamError: RuntimeError | null = null;
  try {
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = /event: ([^\n]+)/.exec(frame)?.[1]?.trim();
      const dataLine = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!event || !dataLine) continue;
      const data = JSON.parse(dataLine) as { text?: string; message?: string; kind?: string; status?: number; retryAfterSeconds?: number; quotaId?: string };
      if (event === "delta" && data.text) args.onDelta?.(data.text);
      if (event === "status" && data.text) args.onStatus?.(data.text);
      if (event === "error") streamError = errorFromStreamFrame(data, args.model);
      if (event === "turn") turn = RuntimeTurn.parse(data);
    }
  }
  } catch (error) {
    if (turn && (args.signal?.aborted || (error instanceof Error && error.name === "AbortError"))) return turn;
    throw error;
  }
  if (streamError && !turn) throw streamError;
  if (!turn) throw new RuntimeError("The model stream ended without a turn.", 502);
  return turn;
}
