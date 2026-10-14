/**
 * The Code tab and terminal on Ensemble on the web, for a paired computer (protocol 4, docs/16,
 * docs/25 §4.8). The web's review page, source control and terminal make the same calls they make to
 * Ensemble on the computer; this server passes each one to that computer's event stream and returns
 * its answer (`devices/file-relay.ts`). It keeps nothing: requests, answers and terminal output live in
 * Redis for at most an hour.
 *
 * Only the person whose computer it is, signed in in a browser (no API key, agent, MCP client or the
 * assistant), and only the calls in `CODE_CALLS`; the computer checks them again with its own switches.
 * The terminal also needs the passkey unlock (`devices/web-unlock.ts`).
 */
import { randomUUID } from "node:crypto";
import type { Device } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { accountIdOf } from "../lib/auth.js";
import { appendLedger } from "../lib/ledger.js";
import { CodeAnswer, codeCall, TerminalChunk, TERMINAL_OUTPUT_BYTES } from "../remote/contract.js";
import { deviceOnline } from "./constants.js";
import { askDeviceFor, storeAnswer } from "./file-relay.js";
import { fileAnswers, publishFileAnswer } from "./revoke-notify.js";
import { ownDevice } from "./routes.js";
import { rememberRun, requireUnlocked, requireWebPerson, webUnlockRoutes } from "./web-unlock.js";

const ASK_MS = 20_000;
const SLOW_MS = 55_000;
const OUTPUT_WAIT_MS = 20_000;
const RUN_TTL_SECONDS = 3600;

type Redisish = { get(key: string): Promise<string | null>; set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>; del(...keys: string[]): Promise<unknown>; mget(...keys: string[]): Promise<Array<string | null>> };
type RunState = { deviceId: string; userId: string; next: number; done: boolean; exitCode: number | null; bytes: number; stopped?: boolean };

const runKey = (runId: string) => `ensemble:webterm:run:${runId}`;
const chunkKey = (runId: string, seq: number) => `ensemble:webterm:out:${runId}:${seq}`;

class Refused extends Error {
  readonly expose = true;
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** What the web needs before it asks a computer anything. */
function codeCapable(device: Device): { code: boolean; codeApi: number; webEdit: boolean; webTerminal: boolean; browseFiles: boolean } {
  const caps = (device.capabilities ?? {}) as { code?: unknown; codeApi?: unknown; webEdit?: unknown; webTerminal?: unknown; browseFiles?: unknown };
  return { code: caps.code === true, codeApi: typeof caps.codeApi === "number" ? caps.codeApi : caps.code === true ? 1 : 0, webEdit: caps.webEdit !== false, webTerminal: caps.webTerminal !== false, browseFiles: caps.browseFiles !== false };
}

async function readRun(redis: Redisish, runId: string): Promise<RunState | null> {
  const raw = await redis.get(runKey(runId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

export async function deviceCodeRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;
  const redis = app.redis as unknown as Redisish;
  await webUnlockRoutes(app);

  /** The person's own computer, paired, online and new enough; or why not. */
  async function computer(request: FastifyRequest, want: "code" | "terminal"): Promise<Device> {
    requireWebPerson(request);
    const { id } = request.params as { id: string };
    const device = await prisma.device.findFirst({ where: { id, userId: accountIdOf(request), revokedAt: null } });
    if (!device) throw new Refused(404, "That computer is not paired with your account.");
    const caps = codeCapable(device);
    if (!caps.code) throw new Refused(409, `Update Ensemble on ${device.name} to use the Code tab from here (the CLI 0.3.8 or the desktop app 0.3.5).`);
    if (!deviceOnline(device.lastSeenAt)) throw new Refused(409, `${device.name} is offline. Open Ensemble there, or start it with \`ensemble runner start\`.`);
    if (!caps.browseFiles) throw new Refused(409, `Showing code on the web is turned off on ${device.name}. Turn it on there with \`ensemble browse on\`.`);
    if (want === "terminal" && !caps.webTerminal) throw new Refused(409, `The terminal from the web is turned off on ${device.name}. Turn it on there with \`ensemble web terminal on\`.`);
    return device;
  }

  async function relay(reply: FastifyReply, device: Device, event: "code.request" | "terminal.request", data: Record<string, unknown>, timeoutMs: number, id?: string) {
    const raw = await askDeviceFor(app.redis, { deviceId: device.id, event, data, id }, timeoutMs);
    if (!raw) return { answered: false as const, send: () => reply.code(504).send({ error: `${device.name} did not answer. It may be asleep or busy; try again.` }) };
    const answer = CodeAnswer.safeParse(raw);
    if (!answer.success) return { answered: false as const, send: () => reply.code(502).send({ error: `${device.name} sent an answer that could not be read.` }) };
    return { answered: true as const, answer: answer.data, send: () => reply.code(answer.data.status).send(answer.data.body ?? {}) };
  }

  // One call to the computer's own Code API: reviews, diffs, files, accept/reject, edit, source control.
  app.post("/api/devices/:id/code", async (request, reply) => {
    const device = await computer(request, "code");
    const body = z
      .object({ method: z.enum(["GET", "POST", "PUT"]), path: z.string().min(1).max(300), query: z.record(z.string().max(100), z.string().max(4096)).default({}), body: z.unknown().optional() })
      .parse(request.body);
    const entry = codeCall(body.method, body.path);
    if (!entry) return reply.code(403).send({ error: "That is not a Code call the web may make." });
    if (entry.since && codeCapable(device).codeApi < entry.since) return reply.code(409).send({ error: `Update Ensemble on ${device.name} to use the full editor from here (the CLI 0.3.9 or the desktop app 0.3.6).` });
    if (entry.write && !codeCapable(device).webEdit) return reply.code(409).send({ error: `Changing code from the web is turned off on ${device.name}. Turn it on there with \`ensemble web edit on\`.` });
    const result = await relay(reply, device, "code.request", { method: body.method, path: body.path, query: body.query, ...(body.body === undefined ? {} : { body: body.body }) }, entry.slow ? SLOW_MS : ASK_MS);
    if (entry.write && result.answered && result.answer.status < 400) {
      await appendLedger({ userId: accountIdOf(request), actor: "me", action: "code.web", payload: { deviceId: device.id, call: `${body.method} ${body.path}` } });
    }
    return result.send();
  });

  // The terminal on that computer: status, cd, run (output follows), kill. Unlocked with a passkey first.
  app.post("/api/devices/:id/terminal", async (request, reply) => {
    const unlocked = await requireUnlocked(app.redis as never, request);
    const device = await computer(request, "terminal");
    const body = z
      .object({ op: z.enum(["status", "cd", "run", "kill"]), cwd: z.string().max(4096).optional(), path: z.string().max(4096).optional(), line: z.string().min(1).max(4000).optional(), confirmed: z.boolean().default(false), runId: z.string().max(100).optional() })
      .parse(request.body);
    const userId = accountIdOf(request);
    if (body.op === "kill") {
      const run = body.runId ? await readRun(redis, body.runId) : null;
      if (!run || run.userId !== userId || run.deviceId !== device.id) return reply.code(404).send({ error: "That command is not running." });
      await redis.set(runKey(body.runId!), JSON.stringify({ ...run, stopped: true }), "EX", RUN_TTL_SECONDS);
    }
    if (body.op === "run" && !body.line) return reply.code(400).send({ error: "Type a command." });
    const runId = body.op === "run" ? randomUUID() : undefined;
    if (runId) {
      const state: RunState = { deviceId: device.id, userId, next: 0, done: false, exitCode: null, bytes: 0 };
      await redis.set(runKey(runId), JSON.stringify(state), "EX", RUN_TTL_SECONDS);
    }
    const result = await relay(reply, device, "terminal.request", { op: body.op, cwd: body.cwd, path: body.path, line: body.line, confirmed: body.confirmed, runId: body.runId }, ASK_MS, runId);
    if (runId) {
      if (result.answered && result.answer.status === 202) {
        await rememberRun(app.redis as never, unlocked, { deviceId: device.id, runId });
        await appendLedger({ userId, actor: "me", action: "terminal.web.run", payload: { deviceId: device.id, program: (body.line ?? "").trim().split(/\s+/)[0]?.slice(0, 40) ?? "" } });
      } else {
        await redis.del(runKey(runId));
      }
    }
    return result.send();
  });

  // A command's output after `after` (a sequence number), waiting up to 20 s for more.
  app.get("/api/devices/:id/terminal/output", async (request, reply) => {
    await requireUnlocked(app.redis as never, request);
    const { id } = request.params as { id: string };
    const query = z.object({ run: z.string().min(1).max(100), after: z.coerce.number().int().min(-1).default(-1) }).parse(request.query);
    const userId = accountIdOf(request);
    const deadline = Date.now() + OUTPUT_WAIT_MS;
    for (;;) {
      const run = await readRun(redis, query.run);
      if (!run || run.userId !== userId || run.deviceId !== id) return reply.code(404).send({ error: "That command's output is gone." });
      if (run.next > query.after + 1 || run.done || Date.now() >= deadline) {
        const seqs = Array.from({ length: Math.max(0, run.next - (query.after + 1)) }, (_, index) => query.after + 1 + index).slice(0, 64);
        const texts = seqs.length ? await redis.mget(...seqs.map((seq) => chunkKey(query.run, seq))) : [];
        const chunks = seqs.map((seq, index) => ({ seq, text: texts[index] ?? "" }));
        const last = chunks.length ? chunks[chunks.length - 1]!.seq : query.after;
        return { chunks, done: run.done && last >= run.next - 1, exitCode: run.done && last >= run.next - 1 ? run.exitCode : null };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(500, Math.max(0, deadline - Date.now())));
        function done() {
          clearTimeout(timer);
          fileAnswers.off(`term:${query.run}`, done);
          resolve();
        }
        fileAnswers.once(`term:${query.run}`, done);
      });
    }
  });

  // ── what the computer posts back ──────────────────────────────────────

  // Its answer to a code.request or terminal.request.
  app.post("/api/devices/self/code-requests/:id", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const { id } = request.params as { id: string };
    const answer = CodeAnswer.parse(request.body);
    const stored = await storeAnswer(app.redis, device.id, id, answer);
    if (stored === "unknown") return reply.code(410).send({ error: "Nobody is waiting for this answer." });
    return { ok: true };
  });

  // Output of a command the web started there, one chunk at a time, in order. 410: stop sending.
  app.post("/api/devices/self/terminal-runs/:runId/output", async (request, reply) => {
    const device = await ownDevice(app, request, reply);
    if (!device) return;
    const { runId } = request.params as { runId: string };
    const chunk = TerminalChunk.parse(request.body);
    const run = await readRun(redis, runId);
    if (!run || run.deviceId !== device.id) return reply.code(410).send({ error: "Nobody is reading this output." });
    if (chunk.seq !== run.next) return reply.code(409).send({ error: `Expected chunk ${run.next}.` });
    const bytes = run.bytes + Buffer.byteLength(chunk.text);
    if (bytes > TERMINAL_OUTPUT_BYTES + 64 * 1024) return reply.code(413).send({ error: "That command printed more than the web keeps." });
    await redis.set(chunkKey(runId, chunk.seq), chunk.text, "EX", RUN_TTL_SECONDS);
    const next: RunState = { ...run, next: chunk.seq + 1, bytes, done: chunk.done, exitCode: chunk.done ? (chunk.exitCode ?? null) : null };
    await redis.set(runKey(runId), JSON.stringify(next), "EX", RUN_TTL_SECONDS);
    publishFileAnswer(`term:${runId}`);
    if (run.stopped && !chunk.done) return reply.code(410).send({ error: "Stopped from the web." });
    return { ok: true };
  });
}
