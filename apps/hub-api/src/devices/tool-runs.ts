/**
 * A node's commands on a paired computer that outgrow their answer (B9, docs/25 §4.10): output past
 * 64 KB, and commands still going after a minute, which run on in the background. The computer posts
 * their output here in order; it is kept in Redis for a few hours under the run's id (never in the
 * database), read with `computer_run_output`, and when a background command ends its node is woken
 * once with how it ended. The server keeps nothing else of a command.
 */
import type { Device } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { NODE_TOOL_OUTPUT_BYTES, TERMINAL_CHUNK_BYTES } from "../remote/contract.js";
import { enqueueTurn } from "../node/queue.js";
import { recoverNodeToolDecisions } from "../node/device-tool-decisions.js";
import { recoverSudoCards, sudoRunEnded } from "../node/sudo.js";

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

const ToolChunk = z.object({
  seq: z.number().int().min(0).max(100_000),
  text: z.string().max(TERMINAL_CHUNK_BYTES),
  done: z.boolean().default(false),
  exitCode: z.number().int().min(-1).max(1_000_000).nullish(),
  /** The command's result was not in its answer: its end wakes the node. */
  wake: z.boolean().default(false),
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

/** The end of a run's output, for the note that wakes its node. */
async function tailOf(redis: Redisish, runId: string, run: ToolRunState, bytes = 3000): Promise<string> {
  const seqs = Array.from({ length: Math.min(run.next, 8) }, (_, index) => run.next - 1 - index).filter((seq) => seq >= 0).reverse();
  const texts = seqs.length ? await redis.mget(...seqs.map((seq) => chunkKey(runId, seq))) : [];
  const all = texts.map((part) => part ?? "").join("");
  return all.length > bytes ? `…${all.slice(-bytes)}` : all;
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
      const tail = (await tailOf(redis, runId, next)).trim();
      await enqueueTurn(app, {
        nodeId: run.nodeId,
        roomId: run.roomId,
        reason: "tool",
        note: [
          `Your command \`${run.command}\` in ${run.folder} on ${run.deviceName} ended after ${duration(run.startedAt)}, exit code ${next.exitCode ?? "unknown"}.`,
          tail ? `Its output ends:\n${tail}` : "It printed nothing.",
          `The whole output: computer_run_output with run ${runId}. Tell whoever asked what came of it.`,
        ].join("\n"),
        private: run.private,
        ...(run.planId ? { planId: run.planId, planStep: run.planStep } : {}),
      }).catch((error: unknown) => request.log.warn({ err: error }, "could not wake the node for its command"));
    }
    return { ok: true };
  });
}
