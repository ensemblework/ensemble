/**
 * This computer's side of the web terminal (protocol 4, docs/16 §5, docs/25 §4.8). The person unlocks
 * it on Ensemble on the web with a passkey; the server sends `terminal.request` only for an unlocked
 * session. Here it is the same terminal as on this computer's own page (`workspace/terminal-exec.ts`):
 * the folders it may use, one allow-listed command at a time, git hardened, destructive commands
 * confirmed, under the OS sandbox. "Terminal from the web" (`webTerminal`) and Settings → Terminal on
 * this computer can each turn it off. The ledger here records each command (never its output).
 */
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings as loadHubSettings } from "../lib/settings.js";
import { GuardError, workspaceRoot } from "../workspace/guard.js";
import { killGroup, runCommand } from "../workspace/runner.js";
import { prepareRun, resolveCd, terminalRoots, webTerminalSandboxed } from "../workspace/terminal-exec.js";
import type { HostedClient } from "./client.js";
import { TERMINAL_CHUNK_BYTES, TERMINAL_OUTPUT_BYTES, TerminalRequest, type CodeAnswer } from "./contract.js";
import { loadSettings } from "./store.js";

type App = Pick<FastifyInstance, "prisma">;

const userId = () => env.ENSEMBLE_DEV_USER_ID;
const FLUSH_MS = 250;
const RUN_MS = 15 * 60_000;
/** Commands running for the web, by run id. */
const running = new Map<string, AbortController>();

const answer = (status: number, body: unknown): CodeAnswer => ({ status, body });

async function refusal(app: App): Promise<CodeAnswer | null> {
  if (!loadSettings().webTerminal) return answer(409, { error: "The terminal from the web is turned off on this computer. Turn it on there with `ensemble web terminal on`." });
  const hub = await loadHubSettings(app.prisma, userId());
  if (!hub.terminal.enabled) return answer(409, { error: "The terminal is turned off in Settings → Terminal and commits on this computer." });
  return null;
}

/** Runs one prepared command and sends its output to the web in order, batched. */
function start(app: App, client: HostedClient, runId: string, prepared: { argv: string[]; full: string[]; cwd: string; scope: string; sandboxed: boolean }): void {
  const controller = new AbortController();
  running.set(runId, controller);
  let seq = 0;
  let pending = "";
  let sent = 0;
  let cut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const send = (text: string, done = false, exitCode: number | null = null) => {
    const chunk = { seq: seq++, text, done, exitCode };
    chain = chain.then(async () => {
      const listening = await client.terminalOutput(runId, chunk).catch(() => true);
      if (!listening) controller.abort();
    });
    return chain;
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const text = pending;
    pending = "";
    void send(text);
  };
  const onChunk = (text: string) => {
    if (cut) return;
    if (sent + Buffer.byteLength(text) > TERMINAL_OUTPUT_BYTES) {
      cut = true;
      pending += "\n[output cut at 1 MB; the command keeps running]\n";
      flush();
      return;
    }
    sent += Buffer.byteLength(text);
    pending += text;
    if (Buffer.byteLength(pending) >= TERMINAL_CHUNK_BYTES / 2) flush();
    else if (!timer) timer = setTimeout(flush, FLUSH_MS);
  };
  void (async () => {
    let exitCode = 127;
    let tail = "";
    try {
      const result = await runCommand({
        userId: userId(),
        argv: prepared.full,
        cwd: prepared.cwd,
        root: prepared.scope,
        sandboxed: prepared.sandboxed,
        network: true,
        useCredentials: true,
        who: "human",
        timeoutMs: RUN_MS,
        signal: controller.signal,
        group: `web:${runId}`,
        onChunk,
      });
      exitCode = result.exitCode;
      if (result.timedOut) tail = "\n[stopped after 15 minutes]";
    } catch (error) {
      tail = `${error instanceof Error ? error.message : String(error)}\n`;
    } finally {
      running.delete(runId);
      flush();
      await send(tail, true, exitCode);
      await appendLedger({ userId: userId(), actor: "me", action: "terminal.run", payload: { argv: prepared.argv.slice(0, 20), cwd: prepared.cwd, exitCode, via: "web" } }).catch(() => undefined);
    }
  })();
}

/** The answer to one `terminal.request`. A `run` answers 202 at once; its output follows on `ROUTES.terminalOutput`. */
export async function terminalAnswerFor(app: App, client: HostedClient, request: TerminalRequest): Promise<CodeAnswer> {
  if (request.op === "kill") {
    const id = request.runId ?? "";
    running.get(id)?.abort();
    return answer(200, { killed: killGroup(`web:${id}`) });
  }
  const refused = await refusal(app);
  if (refused) return refused;
  try {
    const allowed = await terminalRoots(app.prisma as never, userId());
    const home = await workspaceRoot();
    if (request.op === "status") return answer(200, { roots: allowed, home, sandboxed: webTerminalSandboxed() });
    if (request.op === "cd") return answer(200, await resolveCd(allowed, request.cwd || home, request.path ?? ""));
    // From the web, commands run only under this computer's OS sandbox: files change only inside the folder.
    if (!webTerminalSandboxed()) return answer(409, { error: "The terminal from the web runs commands only inside this computer's sandbox, and it is not set up here. Run `ensemble sandbox setup` on the computer." });
    const hub = await loadHubSettings(app.prisma, userId());
    const prepared = await prepareRun({ allowed, cwd: request.cwd || home, line: request.line ?? "", confirmed: request.confirmed, commitAuthor: hub.terminal.commitAuthor, sandboxed: true });
    if (prepared.kind === "confirm") return answer(428, { confirm: prepared.message });
    start(app, client, request.id, prepared);
    return answer(202, { runId: request.id });
  } catch (error) {
    if (error instanceof GuardError) return answer(422, { error: error.message });
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return answer(404, { error: "That folder is not there any more." });
    return answer(500, { error: "This computer could not do that." });
  }
}

/** A `terminal.request` frame from the event stream: answer it. */
export async function answerTerminalRequest(app: App, client: HostedClient, data: unknown): Promise<void> {
  const parsed = TerminalRequest.safeParse(data);
  if (!parsed.success) {
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id) await client.answerCode(id, answer(400, { error: "That request could not be read." }));
    return;
  }
  await client.answerCode(parsed.data.id, await terminalAnswerFor(app, client, parsed.data));
}

/** Stops every command the web started here (the remote loop is ending). */
export function stopWebTerminal(): void {
  for (const [id, controller] of running) {
    controller.abort();
    killGroup(`web:${id}`);
  }
  running.clear();
}
