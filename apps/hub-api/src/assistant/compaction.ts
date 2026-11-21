/**
 * Keeps a long turn of Ensemble's own loop inside its model's context window, without a model call
 * (docs/11, Turn limits). The request is estimated at four characters a token. Past the limit, older
 * replies in the history give way to a placeholder, then older tool results of this turn shrink to their
 * one-line summaries (the whole result stays readable with read_tool_output), oldest first, until it
 * fits. The last `keepExchanges` replies of the model and what came after them go last: only when the
 * rest is not enough do their results shrink too, then their history replies, oldest first. Every user
 * message, and the newest exchange (the model's last reply with its results), stays word for word.
 */
import type { ModelMessage } from "../lib/model-turn.js";

export const CHARS_PER_TOKEN = 4;
/** A picture or file sent to the model counts as this many characters (about 1,500 tokens), whatever its encoded size. */
const ATTACHMENT_CHARS = 6_000;

export const HISTORY_LEFT_OUT = "(An earlier reply is left out here to keep this conversation within the model's context.)";

export function messageChars(message: ModelMessage): number {
  let chars = 16;
  const content = message.content;
  if (typeof content === "string") chars += content.length;
  else if (Array.isArray(content)) {
    for (const part of content as Array<Record<string, unknown>>) chars += part?.type === "text" ? String(part.text ?? "").length : ATTACHMENT_CHARS;
  }
  if (Array.isArray(message.tool_calls)) chars += JSON.stringify(message.tool_calls).length;
  return chars;
}

export function estimateTokens(messages: readonly ModelMessage[], tools: readonly unknown[] = []): number {
  let chars = tools.length ? JSON.stringify(tools).length : 0;
  for (const message of messages) chars += messageChars(message);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface Compaction {
  /** History replies left out, and tool results shortened, by this pass. */
  rows: number;
  results: number;
  /** Estimated tokens before and after. */
  before: number;
  after: number;
}

export interface CompactOptions {
  tools: readonly unknown[];
  limitTokens: number;
  keepExchanges: number;
  /** Where the history rows are in the messages: from `start` up to the turn's own message at `end`. */
  history: { start: number; end: number };
  /** The short form of an earlier tool result of this turn, or undefined to leave it whole. */
  shorten: (callId: string, message: ModelMessage) => ModelMessage | undefined;
}

/** Shortens `messages` in place when the request is over the limit; null when nothing changed. */
export function compactMessages(messages: ModelMessage[], options: CompactOptions): Compaction | null {
  const before = estimateTokens(messages, options.tools);
  if (before <= options.limitTokens) return null;
  const limitChars = options.limitTokens * CHARS_PER_TOKEN;
  let chars = before * CHARS_PER_TOKEN;
  const tail = tailStart(messages, options.keepExchanges);
  const newest = tailStart(messages, 1);
  let rows = 0;
  let results = 0;
  const leaveOut = (from: number, to: number) => {
    for (let index = from; index < to && chars > limitChars; index += 1) {
      const message = messages[index]!;
      if (message.role !== "assistant" || message.content === HISTORY_LEFT_OUT) continue;
      const placeholder: ModelMessage = { role: "assistant", content: HISTORY_LEFT_OUT };
      chars -= messageChars(message) - messageChars(placeholder);
      messages[index] = placeholder;
      rows += 1;
    }
  };
  // A shorter result keeps its tool_call_id, so it still answers its request.
  const shorten = (from: number, to: number) => {
    for (let index = from; index < to && chars > limitChars; index += 1) {
      const message = messages[index]!;
      if (message.role !== "tool") continue;
      const shorter = options.shorten(String(message.tool_call_id ?? ""), message);
      if (!shorter) continue;
      chars -= messageChars(message) - messageChars(shorter);
      messages[index] = shorter;
      results += 1;
    }
  };
  const turnStart = options.history.end + 1;
  leaveOut(options.history.start, Math.min(options.history.end, tail));
  shorten(turnStart, tail);
  shorten(Math.max(tail, turnStart), newest);
  leaveOut(Math.max(tail, options.history.start), Math.min(options.history.end, newest));
  if (!rows && !results) return null;
  return { rows, results, before, after: Math.ceil(chars / CHARS_PER_TOKEN) };
}

/** The first message of the last `keep` exchanges (each starts at a reply of the model); 0 when there are fewer. */
function tailStart(messages: readonly ModelMessage[], keep: number): number {
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "assistant") continue;
    seen += 1;
    if (seen === keep) return index;
  }
  return 0;
}
