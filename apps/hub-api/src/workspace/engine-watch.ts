/**
 * Keeps a coding agent's run (Claude Code, Codex, Cursor, GitHub Copilot) going through what passes,
 * and ends it at what does not:
 * - quiet for `STALL_MS` with no tool call running and nobody being asked: the engine is stuck. It
 *   is stopped and its own session carries on with a message saying why;
 * - a failure that passes (the network, the provider's servers, a locked keychain right after a
 *   restart, the engine's process dying): wait, then carry on in the same session;
 * - the run's minutes used up (waiting on Needs me does not count): it ends as a limit, work kept.
 * At most `ENGINE_RETRIES` carry-ons per run, so a broken engine still ends with its own error.
 */
import { lastLive } from "./live-log.js";
import { EngineTransientError, SessionGoneError, SIGNED_OUT, UNREACHABLE } from "./engines/registry.js";

export const STALL_MS = 10 * 60_000;
/** One tool call (a build, a test suite) may run quietly this long before the engine counts as stuck. */
export const STALL_IN_TOOL_MS = 60 * 60_000;
export const ENGINE_RETRIES = 3;
export const RETRY_DELAYS_MS = [15_000, 60_000, 120_000];
const TICK_MS = 15_000;

export type WatchReason = "stalled" | "time";

export type EngineWatch = { signal: AbortSignal; reason: () => WatchReason | null; stop: () => void };

export function watchEngine(input: {
  jobId: string;
  parent: AbortSignal;
  openCalls: () => number;
  waiting: () => boolean;
  remainingMs: () => number;
  now?: () => number;
  tickMs?: number;
  stallMs?: number;
}): EngineWatch {
  const now = input.now ?? Date.now;
  const controller = new AbortController();
  const started = now();
  let reason: WatchReason | null = null;
  const forward = () => controller.abort(input.parent.reason);
  if (input.parent.aborted) forward();
  else input.parent.addEventListener("abort", forward, { once: true });
  const timer = setInterval(() => {
    if (controller.signal.aborted || input.waiting()) return;
    if (input.remainingMs() <= 0) reason = "time";
    else {
      const quiet = now() - Math.max(lastLive(input.jobId), started);
      if (quiet > (input.openCalls() > 0 ? STALL_IN_TOOL_MS : (input.stallMs ?? STALL_MS))) reason = "stalled";
    }
    if (reason) controller.abort(new DOMException(reason, "AbortError"));
  }, input.tickMs ?? TICK_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    reason: () => reason,
    stop: () => {
      clearInterval(timer);
      input.parent.removeEventListener("abort", forward);
    },
  };
}

/** The engine's process ended under it, or its connection broke: its session can carry on. */
const PROCESS_DIED = /\bstopped\. |stopped unexpectedly|exited with (137|139|143|null)|SIGKILL|SIGSEGV|EPIPE|connection (closed|reset)|stream (ended|closed)|overloaded|internal server error|\b500\b|temporarily|try again later/i;

/** A failure the same engine session can carry on from, rather than one to report. */
export function passingFailure(error: unknown): boolean {
  if (error instanceof EngineTransientError) return true;
  if (error instanceof SessionGoneError || !(error instanceof Error)) return false;
  if (SIGNED_OUT.test(error.message)) return false;
  return UNREACHABLE.test(error.message) || PROCESS_DIED.test(error.message);
}

/** The message that carries an engine on in its own session after it stopped. */
export function continuePrompt(reason: string): string {
  return [
    `(Ensemble: your previous turn stopped before it finished — ${reason}.`,
    "Carry on with the same task from where you left off. First check the current state of the files and git; do not redo work that is already done. Then finish the task and summarise it as usual.)",
  ].join(" ");
}

/** A new task in an agent session that already holds earlier, related work: the whole brief, after a note that it is a new task. */
export function sessionTaskPrompt(brief: string): string {
  return [
    "(Ensemble: a new task, continuing in this session. What you did earlier in this conversation is related context, not the task. The folder may have changed since, so check the files and git before relying on what you remember. This task's rules and brief follow, and they replace any earlier ones.)",
    "",
    brief,
  ].join("\n");
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
