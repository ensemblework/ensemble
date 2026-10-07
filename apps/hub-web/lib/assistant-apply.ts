/** Patch the open thread so Apply does not keep showing the old prompt until a reload. */

export type AppliedReply = {
  id: string;
  content: string;
  toolCalls: Array<{ id: string; state?: string; summary?: string; [key: string]: unknown }>;
};

export function applyRepliesToCache<T extends { messages: Array<{ id: string; content: string; toolCalls: AppliedReply["toolCalls"] }> }>(
  current: T | undefined,
  replies: AppliedReply[] | undefined,
): T | undefined {
  if (!current || !replies?.length) return current;
  const byId = new Map(replies.map((reply) => [reply.id, reply]));
  let changed = false;
  const messages = current.messages.map((message) => {
    const next = byId.get(message.id);
    if (!next) return message;
    changed = true;
    return { ...message, content: next.content, toolCalls: next.toolCalls };
  });
  if (!changed) return current;
  return { ...current, messages };
}

/** One call of an Apply batch that did not land. `attempted` is false when it was never sent. */
export type ApplyFailure = { callId: string | null; name: string; error: string; attempted: boolean };

/** The toast after Apply: what landed, and when a batch only partly landed, what did not. */
export function applyNotice(result: { summary?: string; partial?: boolean; failed?: ApplyFailure[] }): { text: string; tone: "ok" | "error" } {
  const summary = result.summary?.trim() ?? "";
  if (!result.partial || !result.failed?.length) return { text: summary || "Applied.", tone: "ok" };
  const missed = result.failed.map((row) => row.error.trim().replace(/^Not applied:\s*/i, "").replace(/[.\s]+$/, "")).join("; ");
  return { text: `${summary ? `${summary} ` : ""}Not applied: ${missed}.`, tone: "error" };
}
