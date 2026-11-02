/**
 * A node's commands on a paired computer that outgrow their answer (B9, docs/25 §4.10): output past
 * 64 KB, and commands still going after a minute, which run on in the background. The computer posts
 * their output here in order; it is kept in Redis for a few hours under the run's id (never in the
 * database), read with `computer_run_output`, and when a background command ends its node is woken
 * once with how it ended, with a hint for a failure it knows (node/sign-in-hints.ts). It is not woken
 * for a run it stopped (`computer_run_stop`), for a sign-in a newer attempt replaced, or for a sign-in
 * that ran out of time (its card already says so). The server keeps nothing else of a command.
 */
import { createHash } from "node:crypto";
import type { Device } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CodeAnswer, NODE_TOOL_OUTPUT_BYTES, NODE_TOOLS_RUN_STOP, TERMINAL_CHUNK_BYTES } from "../remote/contract.js";
import { deviceOnline } from "./constants.js";
import { askDeviceFor } from "./file-relay.js";
import { enqueueTurn } from "../node/queue.js";
import { recoverNodeToolDecisions } from "../node/device-tool-decisions.js";
import { recoverSudoCards, sudoRunEnded } from "../node/sudo.js";
import { signInHints } from "../node/sign-in-hints.js";

type Redisish = { get(key: string): Promise<string | null>; set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>; del(...keys: string[]): Promise<unknown>; mget(...keys: string[]): Promise<Array<string | null>> };

/** One command a node started on a computer, while its output is kept. */
export type ToolRunState = {
  deviceId: string;
  deviceName: string;
  ownerId: string;
  nodeId: string;
  roomId: string;
  private: boolean;
  planId: string | null;
  planStep: string | null;
  command: string;
  folder: string;
  startedAt: string;
  /** A command run as the administrator: its approval card, which says how it ended (node/sudo.ts). */
  cardId?: string | null;
  /** A CLI sign-in (`az login`): which one, by program and subcommand; one attempt at a time per node and computer. */
  signIn?: string | null;
  /** Its time limit on the computer. */
  timeoutSec?: number;
  next: number;
  bytes: number;
  done: boolean;
  exitCode: number | null;
};

/** Longer than the longest command (15 minutes) and a while after, to read its output. */
export const TOOL_RUN_TTL_SECONDS = 6 * 3600;

const runKey = (runId: string) => `ensemble:nodetool:run:${runId}`;
const chunkKey = (runId: string, seq: number) => `ensemble:nodetool:out:${runId}:${seq}`;
const wokenKey = (runId: string) => `ensemble:nodetool:woken:${runId}`;
const quietKey = (runId: string) => `ensemble:nodetool:quiet:${runId}`;
const signInKey = (nodeId: string, deviceId: string, which: string) => `ensemble:nodetool:signin:${nodeId}:${deviceId}:${createHash("sha256").update(which).digest("hex").slice(0, 32)}`;
/** A sign-in killed this close to its limit, and not successful, ran out of time. */
const RAN_OUT_MARGIN_MS = 15_000;

const ToolChunk = z.object({
  seq: z.number().int().min(0).max(100_000),
  text: z.string().max(TERMINAL_CHUNK_BYTES),
  done: z.boolean().default(false),
  exitCode: z.number().int().min(-1).max(1_000_000).nullish(),
  /** The command's result was not in its answer: its end wakes the node. */
  wake: z.boolean().default(false),
  /** It was killed at its time limit. */
  timedOut: z.boolean().optional(),
});

export async function openToolRun(redis: Redisish, runId: string, state: Omit<ToolRunState, "next" | "bytes" | "done" | "exitCode">): Promise<void> {
  const full: ToolRunState = { ...state, next: 0, bytes: 0, done: false, exitCode: null };
  await redis.set(runKey(runId), JSON.stringify(full), "EX", TOOL_RUN_TTL_SECONDS);
}

export async function toolRunOf(redis: Pick<Redisish, "get">, runId: string): Promise<ToolRunState | null> {
  const raw = await redis.get(runKey(runId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ToolRunState;
  } catch {
    return null;
  }
}

/** The run's output from chunk `from` on, at most `maxBytes`; `next` is where to go on from. */
export async function toolRunOutput(redis: Redisish, runId: string, options: { from?: number; maxBytes: number }): Promise<{ text: string; next: number; done: boolean; exitCode: number | null; more: boolean } | null> {
  const run = await toolRunOf(redis, runId);
  if (!run) return null;
  const from = Math.max(0, options.from ?? 0);
  const seqs = Array.from({ length: Math.max(0, run.next - from) }, (_, index) => from + index).slice(0, 256);
  const texts = seqs.length ? await redis.mget(...seqs.map((seq) => chunkKey(runId, seq))) : [];
  let text = "";
  let next = from;
  for (const part of texts) {
    const piece = part ?? "";
    if (text && Buffer.byteLength(text) + Buffer.byteLength(piece) > options.maxBytes) break;
    text += piece;
    next += 1;
  }
  return { text, next, done: run.done && next >= run.next, exitCode: run.done ? run.exitCode : null, more: next < run.next || !run.done };
}

/** The last chunks of a run's output, for the note that wakes its node. */
async function recentOutput(redis: Redisish, runId: string, run: ToolRunState): Promise<string> {
  const seqs = Array.from({ length: Math.min(run.next, 8) }, (_, index) => run.next - 1 - index).filter((seq) => seq >= 0).reverse();
  const texts = seqs.length ? await redis.mget(...seqs.map((seq) => chunkKey(runId, seq))) : [];
  return texts.map((part) => part ?? "").join("");
}

const tailOf = (text: string, bytes = 3000) => (text.length > bytes ? `…${text.slice(-bytes)}` : text);

/** A run whose end must not wake its node: one it stopped, a sign-in a newer attempt replaced, or one its owner declined or let expire on its card. */
export async function quietRun(redis: Pick<Redisish, "set">, runId: string, why: "stopped" | "replaced" | "declined" | "expired"): Promise<void> {
  await redis.set(quietKey(runId), why, "EX", TOOL_RUN_TTL_SECONDS);
}

/** Records `runId` as this node's attempt at a sign-in on a computer; answers the attempt it replaces, if any. */
export async function swapSignInRun(redis: Pick<Redisish, "get" | "set">, nodeId: string, deviceId: string, which: string, runId: string): Promise<string | null> {
  const key = signInKey(nodeId, deviceId, which);
  const before = await redis.get(key);
  await redis.set(key, runId, "EX", TOOL_RUN_TTL_SECONDS);
  return before && before !== runId ? before : null;
}

/** How asking a computer to stop a run went. */
export type StopOutcome = "stopped" | "not_running" | "offline" | "older" | "no_answer";

/**
 * Asks the run's computer to stop it and what it started (`run_stop`, nodeTools 3). An older computer
 * cannot: its run ends at its time limit.
 */
export async function stopRunOnComputer(app: Pick<FastifyInstance, "redis">, device: Pick<Device, "id" | "lastSeenAt" | "capabilities">, nodeId: string, runId: string): Promise<StopOutcome> {
  const level = (device.capabilities as { nodeTools?: unknown } | null)?.nodeTools;
  if (!(typeof level === "number" && level >= NODE_TOOLS_RUN_STOP)) return "older";
  if (!deviceOnline(device.lastSeenAt)) return "offline";
  const raw = await askDeviceFor(app.redis as never, { deviceId: device.id, event: "node.tool.request", data: { tool: "run_stop", runId, nodeId, mission: `run:${runId}`, attended: true, grants: [] } }, 20_000);
  if (!raw) return "no_answer";
  const answer = CodeAnswer.safeParse(raw);
  return answer.success && answer.data.status === 200 && (answer.data.body as { stopped?: unknown } | null)?.stopped === true ? "stopped" : "not_running";
}

/** Whether a run's end wakes its node: not when it was stopped or replaced, nor for a sign-in that ran out of time. */
async function wakesNode(redis: Redisish, runId: string, run: ToolRunState, timedOut: boolean | undefined): Promise<boolean> {
  if (await redis.get(quietKey(runId))) return false;
  if (!run.signIn || run.exitCode === 0) return true;
  const ranOut = timedOut === true || Date.now() - Date.parse(run.startedAt) >= (run.timeoutSec ?? 900) * 1000 - RAN_OUT_MARGIN_MS;
  return !ranOut;
}

function duration(from: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(from)) / 1000));
  return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

type Gate = { ownDevice: (app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) => Promise<Device | null> };

export async function nodeToolRoutes(app: FastifyInstance, gate: Gate): Promise<void> {
  const redis = app.redis as unknown as Redisish;

  // Answers the owner gave while the server was down reach their nodes, and waiting cards are followed again.
  if (process.env.ENSEMBLE_DESKTOP !== "1") {
    app.addHook("onReady", async () => {
      await recoverNodeToolDecisions(app).catch((error: unknown) => app.log.warn({ err: error }, "could not resume node tool questions"));
      await recoverSudoCards(app).catch((error: unknown) => app.log.warn({ err: error }, "could not resume sudo cards"));
    });
  }

  // A node command's output, one chunk at a time, in order. 410: nobody reads it any more.
  app.post("/api/devices/self/tool-runs/:runId/output", async (request, reply) => {
    const device = await gate.ownDevice(app, request, reply);
    if (!device) return;
    const { runId } = z.object({ runId: z.string().min(1).max(100) }).parse(request.params);
    const chunk = ToolChunk.parse(request.body);
    const run = await toolRunOf(redis, runId);
    if (!run || run.deviceId !== device.id) return reply.code(410).send({ error: "Nobody is reading this output." });
    if (chunk.seq !== run.next) return reply.code(409).send({ error: `Expected chunk ${run.next}.` });
    const bytes = run.bytes + Buffer.byteLength(chunk.text);
    if (bytes > NODE_TOOL_OUTPUT_BYTES + 64 * 1024) return reply.code(413).send({ error: "That command printed more than the web keeps." });
    await redis.set(chunkKey(runId, chunk.seq), chunk.text, "EX", TOOL_RUN_TTL_SECONDS);
    const next: ToolRunState = { ...run, next: chunk.seq + 1, bytes, done: chunk.done, exitCode: chunk.done ? (chunk.exitCode ?? null) : null };
    await redis.set(runKey(runId), JSON.stringify(next), "EX", TOOL_RUN_TTL_SECONDS);
    // A command that ran on in the background wakes its node once, when it ends.
    if (chunk.done && chunk.wake && (await redis.set(wokenKey(runId), "1", "EX", TOOL_RUN_TTL_SECONDS, "NX")) === "OK") {
      if (run.cardId) await sudoRunEnded(app, run.cardId, next.exitCode).catch((error: unknown) => request.log.warn({ err: error }, "could not update the sudo card"));
      if (!(await wakesNode(redis, runId, next, chunk.timedOut))) return { ok: true };
      const recent = await recentOutput(redis, runId, next);
      const tail = tailOf(recent).trim();
      await enqueueTurn(app, {
        nodeId: run.nodeId,
        roomId: run.roomId,
        reason: "tool",
        note: [
          `Your command \`${run.command}\` in ${run.folder} on ${run.deviceName} ended after ${duration(run.startedAt)}, exit code ${next.exitCode ?? "unknown"}.`,
          tail ? `Its output ends:\n${tail}` : "It printed nothing.",
          ...signInHints(recent).map((hint) => `Hint: ${hint}`),
          `The whole output: computer_run_output with run ${runId}. Tell whoever asked what came of it.`,
        ].join("\n"),
        private: run.private,
        ...(run.planId ? { planId: run.planId, planStep: run.planStep } : {}),
      }).catch((error: unknown) => request.log.warn({ err: error }, "could not wake the node for its command"));
    }
    return { ok: true };
  });
}
