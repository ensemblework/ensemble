/**
 * Why an agent session was not continued, and reopening a Codex thread the ChatGPT app holds (docs/41 §1, §4).
 *
 * The ChatGPT app runs its own Codex app-server. A thread it has loaded (open in the app, or only looked at)
 * has an active writer there (`~/.codex/thread-writer-locks`), and a second app-server cannot resume it
 * until the app lets go: `thread/resume` answers `-32600 thread <id> already has an active writer`. That
 * thread is not lost, so Ensemble waits and tries again, and starts a new thread only after the limit.
 */

/**
 * `busy`: the agent's app held the session (Codex: the ChatGPT app); `gone`: the agent could not reopen it;
 * `touched`: someone used it in the agent's app; `instructions`: most of Ensemble's instructions changed;
 * `rotated`: the chat carried `ROTATE_MESSAGES` messages in it; `moved`: the chat went on elsewhere (another
 * model or computer) since its last turn; `expired`: unused for its keeping days.
 */
export type RestartReason = "busy" | "gone" | "touched" | "instructions" | "rotated" | "moved" | "expired";
/** A new agent session started in place of one that could have continued: why, and what the agent said. */
export type Restart = { reason: RestartReason; error?: string };

export const RESTART_REASONS: readonly RestartReason[] = ["busy", "gone", "touched", "instructions", "rotated", "moved", "expired"];

/** What a restart records: the agent's words, one line, short. */
export const restartOf = (reason: RestartReason, error?: unknown): Restart => {
  const said = error === undefined ? "" : (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 300);
  return said ? { reason, error: said } : { reason };
};

/**
 * The agent said it no longer has this session: deleted, expired, or never saved (Codex: "no rollout found for
 * thread id", "thread not found"; Claude Code: "No conversation found with session ID"; the ACP agents:
 * "Session not found"). Anything else (a refusal, a crash, a busy thread) may pass, so the session is kept to
 * be deleted with the chat.
 */
export function provenGone(message: string): boolean {
  return /no rollout found|no conversation found|(?:session|thread|conversation)(?:\s+["']?[\w-]+["']?)?\s+(?:was\s+)?not found|(?:session|thread) not found|(?:session|thread)[^.\n]{0,60}does not exist|no such (?:session|thread)|no longer has session|resource not found:/i.test(message);
}

/** The ChatGPT app has the Codex thread loaded: busy, not gone. */
export const ACTIVE_WRITER = /already has an active writer|thread-store conflict/i;

/** The ChatGPT app held the thread for the whole wait. */
export class CodexThreadBusy extends Error {
  constructor(
    message: string,
    readonly waitedMs: number,
  ) {
    super(message);
    this.name = "CodexThreadBusy";
  }
}

/** How often to try again while the ChatGPT app holds a thread, and for how long: a chat waits less than a task. */
export const BUSY_WAIT = {
  chat: { everyMs: 10_000, limitMs: 2 * 60_000 },
  task: { everyMs: 30_000, limitMs: 10 * 60_000 },
};

/** What a chat shows while it waits, and what a task's run card says. */
export const BUSY_STATUS = "Waiting for the ChatGPT app…";
export const BUSY_CARD = "Waiting for the ChatGPT app to let go of this conversation. Switch to another chat in the app, or quit the app.";

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    if (signal.aborted) return fail(signal.reason ?? new DOMException("Stopped", "AbortError"));
    const stop = () => {
      clearTimeout(timer);
      fail(signal.reason ?? new DOMException("Stopped", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      done();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * `thread/resume`, tried again every `everyMs` while the ChatGPT app holds the thread, until `limitMs` has
 * passed: then `CodexThreadBusy`. `waiting` hears each wait (how long so far); any other refusal is thrown
 * as it came.
 */
export async function resumeCodexThread<T>(
  request: (method: string, params: unknown) => Promise<T>,
  params: { threadId: string } & Record<string, unknown>,
  options: { signal: AbortSignal; everyMs: number; limitMs: number; waiting?: (waitedMs: number) => unknown },
): Promise<T> {
  const started = Date.now();
  for (;;) {
    try {
      return await request("thread/resume", params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!ACTIVE_WRITER.test(message)) throw error;
      const waited = Date.now() - started;
      const left = options.limitMs - waited;
      if (left <= 0) throw new CodexThreadBusy(message, waited);
      await options.waiting?.(waited);
      await pause(Math.min(options.everyMs, left), options.signal);
    }
  }
}
