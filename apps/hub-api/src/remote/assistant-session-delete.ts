/**
 * The person deleted an assistant chat on the web: this computer deletes the agent session behind
 * it (docs/30 §8), the way an old session is dropped, with the agent's own history of it.
 */
import { z } from "zod";
import { chatSettled } from "../subscriptions/agents.js";
import { dropSession, SESSION_KEY } from "../subscriptions/turn-sessions.js";
import type { HostedClient } from "./client.js";
import type { CodeAnswer } from "./contract.js";

const Request = z.object({ id: z.string().min(1).max(100), key: z.string().regex(SESSION_KEY) }).strict();
/** A turn still running for the chat is stopped by the web first; this waits for it at most this long. */
const SETTLE_MS = 20_000;

/** Deletes the chat's session here once its last turn has ended. True when there was one. */
export async function dropAssistantSession(key: string): Promise<boolean> {
  await Promise.race([chatSettled(key), new Promise((done) => setTimeout(done, SETTLE_MS))]);
  return dropSession(key);
}

export async function answerAssistantSessionDelete(client: Pick<HostedClient, "answerCode">, input: unknown): Promise<void> {
  const parsed = Request.safeParse(input);
  const id = parsed.success ? parsed.data.id : typeof input === "object" && input && "id" in input && typeof input.id === "string" ? input.id : null;
  if (!id) return;
  let answer: CodeAnswer;
  try {
    if (!parsed.success) throw new Error("Invalid chat session deletion request.");
    answer = { status: 200, body: { deleted: true, found: await dropAssistantSession(parsed.data.key) } };
  } catch (error) {
    answer = { status: 409, body: { error: error instanceof Error ? error.message : "This computer could not delete the chat's agent session." } };
  }
  await client.answerCode(id, answer);
}
