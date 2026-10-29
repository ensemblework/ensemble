/**
 * Assistant turns the web hands this computer (docs/25 §4.7): the person chose one of their own
 * AI subscriptions as the model, and this computer has that agent. The turn is read with the
 * device token, run by the agent here (subscriptions/agents.ts) with the files attached to the
 * person's message downloaded from the web, its tool calls go back to the web where the account's
 * data is, and its reply text is sent in small batches as it is written.
 */
import { z } from "zod";
import { SUBSCRIPTION_PROVIDERS } from "@ensemble/shared-types";
import { AgentTurnError, runAgentTurn, type AgentTurnSpec } from "../subscriptions/agents.js";
import type { ToolAnswer } from "../subscriptions/bridge.js";
import { TURN_FILES_MAX, TurnFileShape } from "../subscriptions/turn-files.js";
import { SESSION_KEY } from "../subscriptions/turn-sessions.js";
import type { HostedClient } from "./client.js";

/** Turns at once on one computer; more are refused with a reason. */
export const MAX_TURNS_AT_ONCE = 3;
const FLUSH_MS = 200;
/** A download may run this far past the size the turn gave. */
const FILE_SLACK = 64 * 1024;

const ToolSpecShape = z.object({ name: z.string().min(1).max(200), description: z.string().max(8000).default(""), inputSchema: z.record(z.string(), z.unknown()).default({ type: "object" }) });
const Spec = z.object({
  agent: z.enum(SUBSCRIPTION_PROVIDERS),
  model: z.string().max(120).nullable(),
  effort: z.string().max(20).nullable(),
  system: z.string().max(400_000),
  prompt: z.string().max(400_000),
  tools: z.array(ToolSpecShape).max(300),
  maxTurns: z.number().int().min(1).max(64),
  /** GitHub Copilot's long context window, when the tier chose it. Older servers omit it. */
  context: z.enum(["default", "long_context"]).nullish(),
  /** Files attached to the person's message (`assistantTurns` 2). Older servers omit it. */
  files: z.array(TurnFileShape).max(TURN_FILES_MAX).optional(),
  /** The chat's session on this computer (`assistantTurns` 3). Older servers fold the chat into `prompt`. */
  session: z.object({ key: z.string().regex(SESSION_KEY), history: z.string().max(400_000), position: z.number().int().min(0).optional() }).nullish(),
});
const Answer = z.object({ text: z.string(), isError: z.boolean().optional(), tools: z.array(ToolSpecShape).optional() });

const running = new Map<string, AbortController>();

function turnId(data: unknown): string {
  return typeof data === "object" && data !== null && typeof (data as { id?: unknown }).id === "string" ? (data as { id: string }).id.slice(0, 80) : "";
}

export async function answerAssistantTurn(client: HostedClient, data: unknown, run: typeof runAgentTurn = runAgentTurn): Promise<void> {
  const id = turnId(data);
  if (!id || running.has(id)) return;
  if (running.size >= MAX_TURNS_AT_ONCE) {
    await client.assistantDone(id, { error: { problem: "failed", message: `This computer is already answering ${MAX_TURNS_AT_ONCE} assistant messages. Try again in a moment.` } });
    return;
  }
  const controller = new AbortController();
  running.set(id, controller);
  let timer: NodeJS.Timeout | null = null;
  try {
    const body = (await client.assistantTurn(id)) as { spec?: unknown } | null;
    if (!body) return;
    const parsed = Spec.safeParse(body.spec);
    if (!parsed.success) {
      await client.assistantDone(id, { error: { problem: "failed", message: "Update Ensemble on this computer: it could not read this assistant turn." } });
      return;
    }
    const spec: AgentTurnSpec = parsed.data;
    let seq = 0;
    let pending = "";
    let flushing: Promise<void> | null = null;
    const flush = async () => {
      if (!pending) return;
      const text = pending;
      pending = "";
      seq += 1;
      const answer = await client.assistantStream(id, { seq, text });
      if (answer.stop) controller.abort();
    };
    const flushOnce = () => (flushing ??= flush().catch(() => undefined).finally(() => (flushing = null)));
    timer = setInterval(() => void flushOnce(), FLUSH_MS);
    try {
      const result = await run(spec, {
        async call(name, input): Promise<ToolAnswer> {
          const raw = await client.assistantTool(id, { name, input });
          const answer = Answer.safeParse(raw);
          return answer.success ? answer.data : { text: "Ensemble's answer could not be read.", isError: true };
        },
        onDelta(text) {
          pending += text;
        },
        signal: controller.signal,
        async readFile(fileId) {
          const file = spec.files?.find((row) => row.id === fileId);
          return file ? client.assistantFile(id, fileId, { maxBytes: file.size + FILE_SLACK, signal: controller.signal }) : null;
        },
      });
      clearInterval(timer);
      await flushing;
      await flush().catch(() => undefined);
      await client.assistantDone(id, { result });
    } catch (error) {
      clearInterval(timer);
      const stopped = controller.signal.aborted;
      const problem = error instanceof AgentTurnError ? error.problem : "failed";
      const message = stopped ? "Stopped." : error instanceof Error ? error.message : String(error);
      await client.assistantDone(id, { error: { problem, message: message.slice(0, 2000) } }).catch(() => undefined);
    }
  } finally {
    if (timer) clearInterval(timer);
    running.delete(id);
  }
}

/** The person pressed Stop on the web, or the turn ended there. */
export function stopAssistantTurn(data: unknown): void {
  running.get(turnId(data))?.abort();
}

export function stopAllAssistantTurns(): void {
  for (const controller of running.values()) controller.abort();
}
