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
