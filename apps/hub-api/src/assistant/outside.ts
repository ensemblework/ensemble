/**
 * What the person did in an agent's own app, brought into an Ensemble chat (docs/41 §5). Before Ensemble's
 * next message in a chat's session, its computer reads the exchanges added in the agent's app since
 * Ensemble's last turn (subscriptions/outside.ts) and goes on in the same session. They are saved here as
 * the chat's own messages just before that message, each marked with where it was said (`outside`), so the
 * chat shows them and a new session would get them with the chat so far. They are not part of the session's
 * position in the chat (`sessionPosition`): the session already has them.
 */
import type { PrismaClient } from "@prisma/client";
import { logAi } from "../lib/ai-activity.js";
import type { Outside } from "../subscriptions/outside.js";

/** On a message brought in: where it was said ("the Claude app"), when (ISO), and on the first one how many earlier exchanges were left out. */
export type OutsideMark = { app: string; at?: string; earlier?: number };

export function outsideMarkOf(value: unknown): OutsideMark | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const mark = value as Partial<OutsideMark>;
  return typeof mark.app === "string" && mark.app ? { app: mark.app, ...(typeof mark.at === "string" ? { at: mark.at } : {}), ...(typeof mark.earlier === "number" && mark.earlier > 0 ? { earlier: mark.earlier } : {}) } : null;
}

/** How a message brought in reads in the chat's history for a model: where it was said, then the words. */
export function outsideHistoryText(role: string, content: string, mark: OutsideMark): string {
  return role === "user" ? `(Said in ${mark.app}, outside Ensemble) ${content}` : `(Answered in ${mark.app}, outside Ensemble) ${content}`;
}

/**
 * Saves the exchanges a turn brought in as the chat's messages, just before the turn's own message (`before`,
 * else now), in order, and records the import in the person's AI activity (`agent.outside`). Their own
 * times stay on `outside.at`: a computer's clock may not match this one. Returns how many were saved.
 */
export async function saveOutside(
  prisma: Pick<PrismaClient, "assistantMessage">,
  input: { userId: string; conversationId: string; before?: string; agent: string; session: string; outside: Outside },
): Promise<number> {
  const { app, earlier } = input.outside;
  const rows: Array<{ role: "user" | "assistant"; content: string; outside: OutsideMark }> = [];
  for (const [index, turn] of input.outside.turns.entries()) {
    const at = turn.at && !Number.isNaN(Date.parse(turn.at)) ? { at: turn.at } : {};
    if (turn.prompt.trim()) rows.push({ role: "user", content: turn.prompt.trim(), outside: { app, ...at, ...(index === 0 && earlier > 0 ? { earlier } : {}) } });
    const answer = [turn.answer.trim(), turn.tools ? `_${turn.tools}._` : ""].filter(Boolean).join("\n\n");
    if (answer) rows.push({ role: "assistant", content: answer, outside: { app, ...at } });
  }
  if (!rows.length) return 0;
  const anchor = input.before ? (await prisma.assistantMessage.findUnique({ where: { id: input.before }, select: { createdAt: true } }))?.createdAt : null;
  const end = (anchor ?? new Date()).getTime();
  await prisma.assistantMessage.createMany({
    data: rows.map((row, index) => ({ conversationId: input.conversationId, userId: input.userId, role: row.role, content: row.content, outside: row.outside, createdAt: new Date(end - (rows.length - index)) })),
  });
  logAi({
    kind: "agent.outside",
    userId: input.userId,
    app: input.agent,
    purpose: `Brought in from ${app}`,
    output: input.outside.turns,
    refs: { conversation: input.conversationId, session: input.session, ...(input.before ? { message: input.before } : {}) },
    meta: { app, prompts: rows.filter((row) => row.role === "user").length, answers: rows.filter((row) => row.role === "assistant").length, earlier },
  });
  return rows.length;
}
