/**
 * Assistant turns the web hands this computer (docs/25 §4.7): the person chose one of their own
 * AI subscriptions as the model, and this computer has that agent. The turn is read with the
 * device token, run by the agent here (subscriptions/agents.ts) with the files attached to the
 * person's message downloaded from the web, its tool calls go back to the web where the account's
 * data is, and its reply text is sent in small batches as it is written.
 *
 * A dropped connection loses nothing (`assistantRelay` 1): each reply batch is kept until the web has it and sent
 * again with its own number, the turn's end is sent again until the web has it, and, where the web says it takes
 * them (the spec's `relay`), each tool call goes with its own id and is sent again with it until the web answers,
 * so it runs once. A call whose answer never comes is answered here as one that may already have happened, and
 * the agent's same call again goes with that call's id, so the web gives that call's answer instead of running it.
 */
import { randomUUID } from "node:crypto";
import { withAiContext } from "../lib/ai-activity.js";
import { z } from "zod";
import { SUBSCRIPTION_PROVIDERS } from "@ensemble/shared-types";
import { AgentTurnError, PARK_STOP, runAgentTurn, type AgentTurnResult, type AgentTurnSpec } from "../subscriptions/agents.js";
import { OwnAnswerShape, type OwnAnswer, type OwnToolEvent, type ToolAnswer } from "../subscriptions/bridge.js";
import { TURN_FILES_MAX, TurnFileShape } from "../subscriptions/turn-files.js";
import { SESSION_KEY } from "../subscriptions/turn-sessions.js";
import { noAnswer, RemoteError, type HostedClient } from "./client.js";

/** Turns at once on one computer; more are refused with a reason. */
export const MAX_TURNS_AT_ONCE = 3;
const FLUSH_MS = 200;
/** While one of the agent's own calls runs (a long build), the web hears from the turn this often: a call that runs is not silence. */
const KEEPALIVE_MS = 60_000;
/** A download may run this far past the size the turn gave. */
const FILE_SLACK = 64 * 1024;
/** Waits between tries of a request the web did not answer (the connection dropped), the last one repeating. */
const RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
/** How long a tool call is sent again before the agent hears that its outcome is unknown. */
const TOOL_RETRY_MS = 90_000;
/** How long the turn's end is sent again: as long as the web waits for a turn that says nothing (subscriptions/relay.ts `QUIET_MS`). */
const DONE_RETRY_MS = 10 * 60_000;
const retry = { delaysMs: RETRY_MS as readonly number[], toolForMs: TOOL_RETRY_MS, doneForMs: DONE_RETRY_MS };

/** Tests shorten the waits; null puts the shipped values back. */
export function setRelayRetryForTests(value: { delaysMs?: number[]; toolForMs?: number; doneForMs?: number } | null): void {
  retry.delaysMs = value?.delaysMs ?? RETRY_MS;
  retry.toolForMs = value?.toolForMs ?? TOOL_RETRY_MS;
  retry.doneForMs = value?.doneForMs ?? DONE_RETRY_MS;
}

/** What the agent hears for a call the web never answered: it may have run there. */
export const LOST_CALL =
  "Ensemble on the web did not answer this call (the connection to it was lost), so its outcome is unknown: it may already have happened. Check whether it took effect before you call it again.";

/** The web may not have had the request, or its answer did not get here: the connection dropped, or a gateway in front of it had no answer. */
function unanswered(error: unknown): boolean {
  return error instanceof RemoteError && (error.status === 0 || noAnswer(error.status));
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** A call's input as one string, keys sorted: the same input written another way is the same call. */
function canonical(value: unknown): string {
  return JSON.stringify(value ?? {}, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item,
  );
}

/** `work` again while the web cannot be reached, waiting longer each time, for at most `forMs`; never once `signal` stops it. */
async function persist<T>(work: () => Promise<T>, forMs: number, signal?: AbortSignal): Promise<T> {
  const start = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const wait = retry.delaysMs[Math.min(attempt, retry.delaysMs.length - 1)]!;
      if (!unanswered(error) || signal?.aborted || Date.now() - start + wait > forMs) throw error;
      await pause(wait, signal);
      if (signal?.aborted) throw error;
    }
  }
}

const ToolSpecShape = z.object({ name: z.string().min(1).max(200), description: z.string().max(8000).default(""), inputSchema: z.record(z.string(), z.unknown()).default({ type: "object" }) });
const Spec = z.object({
  agent: z.enum(SUBSCRIPTION_PROVIDERS),
  model: z.string().max(120).nullable(),
  effort: z.string().max(20).nullable(),
  system: z.string().max(400_000),
  prompt: z.string().max(400_000),
  tools: z.array(ToolSpecShape).max(300),
  /** The most turns the agent takes; absent, no limit (`assistantTurns` 5). Older servers send at most 64. */
  maxTurns: z.number().int().min(1).optional(),
  /** GitHub Copilot's long context window, when the tier chose it. Older servers omit it. */
  context: z.enum(["default", "long_context"]).nullish(),
  /** Files attached to the person's message (`assistantTurns` 2). Older servers omit it. */
  files: z.array(TurnFileShape).max(TURN_FILES_MAX).optional(),
  /** The chat's session on this computer (`assistantTurns` 3). Older servers fold the chat into `prompt`. */
  session: z
    .object({
      key: z.string().regex(SESSION_KEY),
      history: z.string().max(400_000),
      position: z.number().int().min(0).optional(),
      /** An Ensemble Node's project folder for its chats (0.7.6). Older servers omit it. */
      group: z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(200) }).optional(),
      keepDays: z.number().int().min(1).max(90).optional(),
      /** A new session's name in the agent's own app (0.7.17). Older servers omit it. */
      title: z.string().max(200).optional(),
      /** Another message of the turn that took this session (`assistantTurns` 6): it goes on there or not at all. Older servers omit it. */
      resume: z.literal("only").optional(),
    })
    .nullish(),
  /** The agent's own web search and page reading (0.7.6). Older servers omit it. */
  ownWeb: z.boolean().optional(),
  /** All the agent's own tools, judged by the hard floor (0.7.15, own-tools.ts). Older servers omit it. */
  ownTools: z.boolean().optional(),
  /** An Ensemble Node's turn with the agent's own tools: its folder policy here (`assistantTurns` 5, node-own-tools.ts). Older servers omit it. */
  node: z
    .object({
      id: z.string().min(1).max(80),
      slug: z.string().max(80),
      mission: z.string().min(1).max(200),
      attended: z.boolean(),
      sudo: z.boolean(),
      folders: z.array(z.string().min(1).max(4096)).max(20).optional(),
    })
    .optional(),
  /** The web takes this turn's tool calls with their own ids (`assistantRelay` 1): one sent again with its id runs once. Older servers omit it. */
  relay: z.number().int().min(0).optional(),
});
const Answer = z.object({ text: z.string(), isError: z.boolean().optional(), tools: z.array(ToolSpecShape).optional() });

const running = new Map<string, AbortController>();
/** Ends every wait to send again when this computer stops its remote work (`stopAllAssistantTurns`). */
let closing = new AbortController();

function turnId(data: unknown): string {
  return typeof data === "object" && data !== null && typeof (data as { id?: unknown }).id === "string" ? (data as { id: string }).id.slice(0, 80) : "";
}

/**
 * Answers one turn. "taken": the web gave it to another runtime of this computer that read it first (two
 * runtimes on one computer), so this one left it alone.
 */
export async function answerAssistantTurn(client: HostedClient, data: unknown, run: typeof runAgentTurn = runAgentTurn): Promise<"taken" | void> {
  const id = turnId(data);
  if (!id || running.has(id)) return;
  // The turn's end goes again until the web has it; one it refuses (or never hears) it ends by itself.
  const stopping = closing.signal;
  const end = async (body: unknown, until = Date.now() + retry.doneForMs) => persist(() => client.assistantDone(id, body), Math.max(0, until - Date.now()), stopping);
  if (running.size >= MAX_TURNS_AT_ONCE) {
    await end({ error: { problem: "failed", message: `This computer is already answering ${MAX_TURNS_AT_ONCE} assistant messages. Try again in a moment.` } }).catch(() => undefined);
    return;
  }
  const controller = new AbortController();
  running.set(id, controller);
  let timer: NodeJS.Timeout | null = null;
  try {
    let body: { spec?: unknown } | null;
    try {
      body = (await client.assistantTurn(id)) as { spec?: unknown } | null;
    } catch (error) {
      if (error instanceof RemoteError && error.status === 409) return "taken";
      throw error;
    }
    if (!body) return;
    const parsed = Spec.safeParse(body.spec);
    if (!parsed.success) {
      await end({ error: { problem: "failed", message: "Update Ensemble on this computer: it could not read this assistant turn." } }).catch(() => undefined);
      return;
    }
    const spec: AgentTurnSpec = parsed.data;
    // The web takes this turn's calls with their own ids: one whose answer was lost is sent again with its id, and runs once there.
    const relay = (spec.relay ?? 0) >= 1;
    // A call whose answer never came, by its name and input: the agent's same call again is that call, with its id (the web gives its answer).
    const lost = new Map<string, string>();
    let seq = 0;
    let pending = "";
    // A status line goes with the next batch, in order with the text (a server before 0.8.0 ignores it).
    let status: string | null = null;
    // A node's chat shows the agent's own calls: they go with the batches too (a server before `assistantTurns` 5 ignores them).
    const ownCalls: OwnToolEvent[] = [];
    let openCalls = 0;
    let posted = Date.now();
    let flushing: Promise<void> | null = null;
    // A batch the web has not taken yet: sent again with its own number until it is (the web drops a number it already has).
    let unsent: { seq: number; text: string; status?: string; tools?: OwnToolEvent[] } | null = null;
    let failures = 0;
    let resendAt = 0;
    const flush = async () => {
      if (unsent && Date.now() < resendAt) return;
      if (!unsent) {
        const keepalive = openCalls > 0 && Date.now() - posted >= KEEPALIVE_MS;
        if (!pending && !status && !ownCalls.length && !keepalive) return;
        const calls = ownCalls.splice(0, 50);
        seq += 1;
        unsent = { seq, text: pending, ...(status ? { status } : {}), ...(calls.length ? { tools: calls } : {}) };
        pending = "";
        status = null;
      }
      try {
        const answer = await client.assistantStream(id, unsent);
        unsent = null;
        failures = 0;
        posted = Date.now();
        if (answer.stop) controller.abort();
      } catch (error) {
        // Refused: dropped, as the web will not take it. Not answered: kept, and sent again a little later.
        if (!unanswered(error)) unsent = null;
        else resendAt = Date.now() + retry.delaysMs[Math.min((failures += 1) - 1, retry.delaysMs.length - 1)]!;
        throw error;
      }
    };
    const flushOnce = () => (flushing ??= flush().catch(() => undefined).finally(() => (flushing = null)));
    timer = setInterval(() => void flushOnce(), FLUSH_MS);
    let ended: { result: AgentTurnResult } | { error: { problem: string; message: string } };
    try {
      // The agent's own tool calls go in the person's AI activity under this turn (lib/ai-activity.ts).
      const result = await withAiContext({ refs: { turn: id, session: spec.session?.key } }, () => run(spec, {
        async call(name, input): Promise<ToolAnswer> {
          const same = `${name}\n${canonical(input)}`;
          const callId = relay ? (lost.get(same) ?? randomUUID()) : undefined;
          try {
            const raw = await persist(() => client.assistantTool(id, { name, input, ...(callId ? { callId } : {}) }), relay ? retry.toolForMs : 0, controller.signal);
            lost.delete(same);
            const answer = Answer.safeParse(raw);
            return answer.success ? answer.data : { text: "Ensemble's answer could not be read.", isError: true };
          } catch (error) {
            if (!unanswered(error)) throw error;
            if (callId) lost.set(same, callId);
            return { text: JSON.stringify({ error: LOST_CALL, uncertain: true }), isError: true };
          }
        },
        onDelta(text) {
          pending += text;
        },
        onStatus(text) {
          status = text;
        },
        onOwnTool(event) {
          openCalls = Math.max(0, openCalls + (event.phase === "start" ? 1 : -1));
          if (spec.node && ownCalls.length < 500) ownCalls.push(event);
        },
        ...(spec.node
          ? {
              async ask(request): Promise<OwnAnswer> {
                try {
                  // The web asks the owner once per question: the same ask again finds that question and its answer.
                  const raw = await persist(() => client.assistantAsk(id, request), relay ? retry.toolForMs : 0, controller.signal);
                  const answer = OwnAnswerShape.safeParse(raw);
                  return answer.success ? answer.data : { decision: "deny", message: "Ensemble's answer could not be read, so this call was not run." };
                } catch (error) {
                  if (!unanswered(error)) throw error;
                  return { decision: "deny", message: "Ensemble on the web could not be reached to ask your owner, so this call was not run." };
                }
              },
            }
          : {}),
        signal: controller.signal,
        async readFile(fileId) {
          const file = spec.files?.find((row) => row.id === fileId);
          return file ? client.assistantFile(id, fileId, { maxBytes: file.size + FILE_SLACK, signal: controller.signal }) : null;
        },
      }));
      ended = { result };
    } catch (error) {
      const stopped = controller.signal.aborted;
      const problem = error instanceof AgentTurnError ? error.problem : "failed";
      const message = stopped ? "Stopped." : error instanceof Error ? error.message : String(error);
      ended = { error: { problem, message: message.slice(0, 2000) } };
    }
    clearInterval(timer);
    // What is left of the reply goes first, then the end, each again until the web has it.
    const until = Date.now() + retry.doneForMs;
    await flushing;
    while (Date.now() < until && !stopping.aborted && (unsent || pending || status || ownCalls.length)) {
      if (unsent && Date.now() < resendAt) await pause(Math.min(resendAt, until) - Date.now(), stopping);
      else await flush().catch(() => undefined);
    }
    try {
      await end(ended, until);
    } catch (error) {
      // The web refused the answer itself: it hears why instead. One it never heard, it ends by itself.
      if ("result" in ended && !unanswered(error)) await end({ error: { problem: "failed", message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) } }, until).catch(() => undefined);
    }
  } finally {
    if (timer) clearInterval(timer);
    running.delete(id);
  }
}

/**
 * The person pressed Stop on the web, or the turn ended there. `park`: an Ensemble Node's turn parked on its
 * owner's answer, so the chat keeps the agent's session for the turn their answer wakes (agents.ts PARK_STOP).
 */
export function stopAssistantTurn(data: unknown): void {
  const park = typeof data === "object" && data !== null && (data as { park?: unknown }).park === true;
  running.get(turnId(data))?.abort(park ? PARK_STOP : undefined);
}

export function stopAllAssistantTurns(): void {
  for (const controller of running.values()) controller.abort();
  closing.abort();
  closing = new AbortController();
}
