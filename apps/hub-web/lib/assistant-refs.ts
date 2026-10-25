/**
 * What a reply in the dock may show instead of record ids (docs/11 §4.1): the records its tool
 * calls returned, the ones the server saved on it, and the mentions in the question it answers.
 * The text itself is formatted by `formatEntityText` from @ensemble/shared-types.
 */
import { asksForIds, type AssistantRef } from "@ensemble/shared-types";
import type { AssistantMessageRecord, AssistantToolCallRecord } from "./api";

const isRef = (value: unknown): value is AssistantRef =>
  Boolean(value) && typeof value === "object" && typeof (value as AssistantRef).id === "string" && typeof (value as AssistantRef).label === "string" && typeof (value as AssistantRef).kind === "string";

/** Records the calls returned, the latest call first: a renamed record shows its newest title. */
export function callRefs(calls: readonly AssistantToolCallRecord[] | null | undefined): AssistantRef[] {
  return [...(calls ?? [])].reverse().flatMap((call) => (Array.isArray(call.refs) ? call.refs.filter(isRef) : []));
}

export function savedRefs(value: unknown): AssistantRef[] {
  return Array.isArray(value) ? value.filter(isRef).filter((ref) => ref.kind !== "date") : [];
}

export type ReplyContext = { refs: AssistantRef[]; showIds: boolean };

/** The records and the id request that apply to `messages[index]`, read from the question before it. */
export function replyContext(messages: readonly AssistantMessageRecord[], index: number): ReplyContext {
  const message = messages[index];
  if (!message) return { refs: [], showIds: false };
  const question = messages.slice(0, index).reverse().find((row) => row.role === "user");
  return {
    refs: [...callRefs(message.toolCalls), ...savedRefs(message.mentions), ...savedRefs(question?.mentions)],
    showIds: asksForIds(question?.content),
  };
}
