/**
 * A node's `computer_run` on this computer (docs/25 §4.10): one program and its arguments, checked
 * as a coding agent's commands are (`workspace/guard.ts`: the never-list, git against the ceiling)
 * and run under this computer's OS sandbox, writing only in its folder, with keys, Ensemble's data and
 * the browser profile denied. Named secrets go into that command's environment only. A short command's
 * output comes back in the answer (64 KB at most, the rest follows on `ROUTES.toolOutput`); one still
 * going after a minute answers at once and runs on in the background, and its end wakes the node.
 * The output is redacted for saved secret values and key shapes before it leaves this computer.
 */
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { redactText } from "../lib/redact.js";
import { referenceSecrets, runSecretEnv } from "../lib/run-secrets.js";
import { loadSettings as loadHubSettings } from "../lib/settings.js";
import { sliceBytes } from "../lib/text.js";
import { checkGit, checkProgram, gitHardening, GuardError, jailPath, parseCommand, sandboxAvailable } from "../workspace/guard.js";
import { killGroup, runCommand } from "../workspace/runner.js";
import type { HostedClient } from "../remote/client.js";
import { NODE_TOOL_FOREGROUND_MS, NODE_TOOL_INLINE_BYTES, NODE_TOOL_OUTPUT_BYTES, TERMINAL_CHUNK_BYTES, type CodeAnswer, type NodeToolRequest } from "../remote/contract.js";
import { nodeToolDenies, type ToolFolder } from "./folders.js";

type RunRequest = Extract<NodeToolRequest, { tool: "run" }>;
type App = Pick<FastifyInstance, "prisma">;

const userId = () => env.ENSEMBLE_DEV_USER_ID;
const FLUSH_MS = 300;
/** Commands running for nodes, by run id: stopped when the remote loop ends. */
const running = new Map<string, AbortController>();

/** Tests shorten the foreground minute. */
let foregroundMs = NODE_TOOL_FOREGROUND_MS;
export function setForegroundMsForTests(ms: number | null): void {
  foregroundMs = ms ?? NODE_TOOL_FOREGROUND_MS;
}

/** The output a node is shown: secret values and key shapes hidden. */
export function cleanOutput(text: string): string {
  return redactText(text);
}

/** Head and tail of a long output, within `max` bytes, with what was left out said in the middle. */
export function clipOutput(text: string, max = NODE_TOOL_INLINE_BYTES): { text: string; clipped: boolean } {
  if (Buffer.byteLength(text) <= max) return { text, clipped: false };
  const half = Math.floor((max - 200) / 2);
  const head = sliceBytes(text, half);
  const tailStart = Math.max(head.length, text.length - half);
  let tail = text.slice(tailStart);
  while (Buffer.byteLength(tail) > half) tail = tail.slice(Math.ceil(tail.length / 10));
  return { text: `${head}\n…[${Buffer.byteLength(text) - Buffer.byteLength(head) - Buffer.byteLength(tail)} bytes left out; the whole output is kept for computer_run_output]…\n${tail}`, clipped: true };
}

/**
 * Sends a command's output to the server in order, cut at line ends so a redaction never meets half a
 * secret, at most 1 MB in all. `finish` sends the last chunk with the exit code.
 */
function outputStream(client: HostedClient, runId: string, onStop: () => void, clean: (text: string) => string = cleanOutput) {
  let seq = 0;
  let pending = "";
  let sent = 0;
  let cut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const post = (text: string, done = false, exitCode: number | null = null, wake = false) => {
    const chunk = { seq: seq++, text, done, exitCode, wake };
    chain = chain.then(async () => {
      const listening = await client.toolOutput(runId, chunk).catch(() => true);
      if (!listening) onStop();
    });
    return chain;
  };
  const flush = (all = false) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const end = all ? pending.length : pending.lastIndexOf("\n") + 1;
    // A long line with no end yet goes once it is large, so output keeps moving.
    const upTo = end > 0 ? end : Buffer.byteLength(pending) >= TERMINAL_CHUNK_BYTES / 2 ? pending.length : 0;
    if (!upTo) return;
    let text = clean(pending.slice(0, upTo));
    pending = pending.slice(upTo);
    while (Buffer.byteLength(text) > TERMINAL_CHUNK_BYTES) {
      const part = sliceBytes(text, TERMINAL_CHUNK_BYTES);
      void post(part);
      text = text.slice(part.length);
    }
    if (text) void post(text);
  };
  return {
    write(text: string) {
      if (cut) return;
      if (sent + Buffer.byteLength(text) > NODE_TOOL_OUTPUT_BYTES) {
        cut = true;
        pending += `\n[output cut at ${NODE_TOOL_OUTPUT_BYTES / 1024 / 1024} MB; the command keeps running]\n`;
        flush(true);
        return;
      }
      sent += Buffer.byteLength(text);
      pending += text;
      if (Buffer.byteLength(pending) >= TERMINAL_CHUNK_BYTES / 2) flush();
      else if (!timer) timer = setTimeout(() => flush(), FLUSH_MS);
    },
    async finish(tail: string, exitCode: number, wake: boolean) {
      flush(true);
      await post(clean(tail), true, exitCode, wake);
      await chain;
    },
  };
}

/** The command, checked: its argv, git with hardening and the ceiling, and the folder it runs in. */
async function prepare(app: App, request: RunRequest, folder: ToolFolder, sandboxed: boolean): Promise<{ argv: string[]; program: string; cwd: string }> {
  const argv = parseCommand(request.command);
  const program = checkProgram(argv, { who: "agent", sandboxed, network: request.network });
  if (program === "git") {
    const { sub, action } = checkGit(argv, { delivery: request.delivery, sandboxed });
    if (action === "push" || (action === "network" && sub !== "clone")) {
      throw new GuardError(`git ${sub} needs the owner's sign-in, which a node's command never has. Start an agent session for it (node_session_start): Ensemble runs ${sub} there with their sign-in.`);
    }
    const author = (await loadHubSettings(app.prisma, userId()).catch(() => null))?.terminal.commitAuthor ?? "";
    return { argv: ["git", ...gitHardening(false, author || "Ensemble Node <node@ensemble.local>"), ...argv.slice(1)], program, cwd: await jailPath(folder.path, request.cwd ?? ".", true) };
  }
  return { argv, program, cwd: await jailPath(folder.path, request.cwd ?? ".", true) };
}

/** A command as `deliverCommand` runs it: started with where its output goes and what stops it. */
export type CommandStart = (sink: { onChunk: (text: string) => void; signal: AbortSignal }) => Promise<{ exitCode: number; timedOut: boolean }>;

export type Delivered = { exitCode: number; ms: number; timedOut: boolean; background: boolean; output: string };

/**
 * Runs a node's command and answers the way every one answers: inline when it ends within the
 * minute (and fits), else 202 with the output so far, the rest following as chunks; `background`
 * answers at once. The run's last chunk says whether to wake the node (when its result was not in the
 * answer). `clean` hides what must not leave this computer (default: saved secrets and key shapes);
 * `inline` adds to the inline answer's body; `stop` ends what is left of the command afterwards.
 */
export async function deliverCommand(
  client: HostedClient,
  input: { runId: string; background: boolean; timeoutSec: number; clean?: (text: string) => string; inline?: (result: { exitCode: number; output: string }) => Record<string, unknown>; stop?: () => void },
  start: CommandStart,
  answer: (reply: CodeAnswer) => Promise<void>,
): Promise<Delivered> {
  const clean = input.clean ?? cleanOutput;
  const controller = new AbortController();
  running.set(input.runId, controller);
  const stream = outputStream(client, input.runId, () => controller.abort(), clean);
  let collected = "";
  let answered = false;
  let streaming = input.background;
  const started = Date.now();
  const done = start({
    signal: controller.signal,
    onChunk: (text) => {
      if (streaming) stream.write(text);
      else if (Buffer.byteLength(collected) < NODE_TOOL_OUTPUT_BYTES) collected += text;
    },
  });
  const goBackground = async () => {
    if (answered) return;
    answered = true;
    streaming = true;
    // What it printed so far goes first, so the stored output is whole.
    if (collected) stream.write(collected);
    const shown = clipOutput(clean(collected));
    await answer({ status: 202, body: { runId: input.runId, background: true, output: shown.text, startedAt: new Date(started).toISOString() } });
  };
  if (input.background) await goBackground();
  const timer = input.background ? null : setTimeout(() => void goBackground().catch(() => undefined), foregroundMs);
  timer?.unref?.();
  let exitCode = 127;
  let tail = "";
  let timedOut = false;
  try {
    const result = await done;
    exitCode = result.exitCode;
    timedOut = result.timedOut;
    if (result.timedOut) tail = `\n[stopped after ${input.timeoutSec} s]`;
  } catch (error) {
    tail = `${error instanceof Error ? error.message : String(error)}\n`;
  } finally {
    if (timer) clearTimeout(timer);
    running.delete(input.runId);
    input.stop?.();
  }
  const ms = Date.now() - started;
  const background = streaming;
  if (!answered) {
    answered = true;
    const output = clean(collected + tail);
    const shown = clipOutput(output);
    await answer({ status: 200, body: { exitCode, output: shown.text, ms, timedOut, ...(shown.clipped ? { runId: input.runId, clipped: true } : {}), ...(input.inline?.({ exitCode, output }) ?? {}) } });
    // A long output is kept whole for computer_run_output; the node already has the result, so nothing wakes it.
    if (shown.clipped) {
      stream.write(collected);
      await stream.finish(tail, exitCode, false);
    }
  } else {
    await stream.finish(tail, exitCode, true);
  }
  return { exitCode, ms, timedOut, background, output: collected + tail };
}

/**
 * Runs the command under this computer's sandbox and answers (`deliverCommand`). The ledger keeps
 * its program, folder and exit code.
 */
export async function runNodeCommand(app: App, client: HostedClient, request: RunRequest, folder: ToolFolder, answer: (reply: CodeAnswer) => Promise<void>): Promise<void> {
  const sandboxed = sandboxAvailable();
  const prepared = await prepare(app, request, folder, sandboxed);
  const saved = request.secrets.length ? await runSecretEnv(app.prisma, userId(), request.secrets) : {};
  const missing = request.secrets.filter((name) => !(name in saved));
  if (missing.length) {
    // A secret with allowed destinations is used by reference only (credentials/secret-http.ts), never in a command's environment.
    const byReference = (await referenceSecrets(app.prisma, userId(), missing)).map((row) => row.name);
    if (byReference.length) throw new GuardError(`${byReference.join(", ")} ${byReference.length === 1 ? "is" : "are"} kept for use by reference only, never in a command's environment. Call the service with secret_http instead.`);
    throw new GuardError(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not saved on this computer. Ask your owner for ${missing.length === 1 ? "it" : "them"} with node_secret_request.`);
  }
  const group = `node-tool:${request.runId}`;
  const deny = await nodeToolDenies();
  const result = await deliverCommand(client, { runId: request.runId, background: request.background, timeoutSec: request.timeoutSec, stop: () => killGroup(group) }, ({ onChunk, signal }) =>
    runCommand({
      userId: userId(),
      argv: prepared.argv,
      cwd: prepared.cwd,
      root: folder.path,
      sandboxed,
      network: request.network,
      useCredentials: false,
      who: "agent",
      readWrite: [folder.path],
      deny,
      timeoutMs: request.timeoutSec * 1000,
      signal,
      group,
      extraEnv: saved,
      onChunk,
    }), answer);
  await appendLedger({
    userId: userId(),
    actor: "agent",
    action: "node.tool.run",
    payload: { nodeId: request.nodeId, program: prepared.program, folder: folder.label, exitCode: result.exitCode, ms: result.ms, timedOut: result.timedOut, background: result.background, operationId: request.operationId ?? null },
  }).catch(() => undefined);
}

/** Work for nodes that is not a command run (a terminal screen being captured), stopped with them. */
const others = new Map<string, () => void>();

/** Registers how to stop such work; the returned function forgets it once it is over. */
export function stopWithCommands(id: string, stop: () => void): () => void {
  others.set(id, stop);
  return () => {
    others.delete(id);
  };
}

/** Stops every command run for a node here (the remote loop is ending). */
export function stopNodeCommands(): void {
  for (const [id, controller] of running) {
    controller.abort();
    killGroup(`node-tool:${id}`);
  }
  running.clear();
  for (const stop of others.values()) stop();
  others.clear();
}
