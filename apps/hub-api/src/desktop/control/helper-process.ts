/**
 * The desktop helper as a child process of this runtime: started on first use with the session's bus and
 * display variables (never the runtime's secrets), asked one request at a time, and started again after it
 * crashes, at most `maxRestarts` times in `restartWindowMs`. A request the helper does not answer in time is
 * answered here as failed and the helper is killed, so it can never act on that request later.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { HELPER_PROTOCOL, HelperError, helperErrorOf, type HelloResult, type HelperEvent, type Ran } from "./protocol.js";

export type HelperCommand = { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string };

export type HelperOptions = {
  /** How to start the helper here, or why it cannot run (no Python, not Linux). */
  spawn: () => HelperCommand | { unavailable: string };
  log?: (message: string) => void;
  maxRestarts?: number;
  restartWindowMs?: number;
  helloTimeoutMs?: number;
  now?: () => number;
};

/** The time a helper request gets less than its caller's wait, so the helper gives up first. */
export const HELPER_MARGIN_MS = 1_500;

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout; effects: boolean; method: string };

export type HelperHealth = {
  state: "stopped" | "starting" | "ready" | "failed" | "unavailable";
  pid: number | null;
  version: string | null;
  restarts: number;
  crashes: number;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  reason: string | null;
};

export class HelperProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private crashTimes: number[] = [];
  private stopping = false;
  private stderrTail = "";
  private hello: HelloResult | null = null;
  private state: HelperHealth["state"] = "stopped";
  private reason: string | null = null;
  private lastExit: HelperHealth["lastExit"] = null;
  private lastExitExpected = true;
  /** Starts after a crash (not after an idle stop). */
  restarts = 0;
  crashes = 0;

  constructor(private readonly options: HelperOptions) {
    super();
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  get running(): boolean {
    return this.child !== null && this.state === "ready";
  }

  health(): HelperHealth {
    return { state: this.state, pid: this.child?.pid ?? null, version: this.hello?.version ?? null, restarts: this.restarts, crashes: this.crashes, lastExit: this.lastExit, reason: this.reason };
  }

  /** The last lines the helper wrote to stderr, for a diagnosis; never logged whole. */
  stderr(): string {
    return this.stderrTail;
  }

  private crashedTooOften(): boolean {
    const window = this.options.restartWindowMs ?? 10 * 60_000;
    this.crashTimes = this.crashTimes.filter((at) => this.now - at < window);
    return this.crashTimes.length > (this.options.maxRestarts ?? 5);
  }

  async start(): Promise<void> {
    if (this.child && this.state === "ready") return;
    if (this.starting) return this.starting;
    if (this.crashedTooOften()) {
      this.state = "failed";
      throw new HelperError("gone", `The desktop helper stopped ${this.crashTimes.length} times in a few minutes; it rests until it has been quiet for a while.`, "no", true);
    }
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<void> {
    const spec = this.options.spawn();
    if ("unavailable" in spec) {
      this.state = "unavailable";
      this.reason = spec.unavailable;
      throw new HelperError("unavailable", spec.unavailable, "no");
    }
    this.state = "starting";
    this.stopping = false;
    const child = spawn(spec.command, spec.args, { env: spec.env, cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    if (this.lastExit && !this.lastExitExpected) this.restarts += 1;
    child.stdin!.on("error", () => undefined);
    child.stderr!.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2_000);
    });
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on("line", (line) => this.onLine(line));
    child.once("error", (error) => this.onExit(child, null, null, error));
    child.once("exit", (code, signal) => this.onExit(child, code, signal, null));
    try {
      const hello = await this.send<HelloResult>("hello", {}, { timeoutMs: this.options.helloTimeoutMs ?? 15_000, effects: false, started: true });
      if (hello.unavailable) {
        this.reason = hello.unavailable;
        await this.stop();
        this.state = "unavailable";
        throw new HelperError("unavailable", hello.unavailable, "no");
      }
      if (hello.protocol !== HELPER_PROTOCOL) {
        await this.stop();
        this.state = "failed";
        this.reason = `The desktop helper speaks protocol ${hello.protocol}, this runtime ${HELPER_PROTOCOL}.`;
        throw new HelperError("unavailable", this.reason, "no");
      }
      this.hello = hello;
      this.state = "ready";
      this.reason = null;
    } catch (error) {
      if (this.child === child && this.state === "starting") {
        this.state = "failed";
        this.reason = error instanceof Error ? error.message : "The desktop helper did not start.";
        child.kill("SIGKILL");
      }
      throw error;
    }
  }

  private onLine(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: unknown; method?: unknown; params?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.method === "event" && message.params && typeof message.params === "object") {
      this.emit("event", message.params as HelperEvent);
      return;
    }
    if (typeof message.id !== "number") return;
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) waiting.reject(helperErrorOf(message.error as { code?: unknown; message?: unknown; data?: unknown }, waiting.effects ? "maybe" : "no"));
    else waiting.resolve(message.result);
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null, error: Error | null): void {
    if (this.child !== child) return;
    this.child = null;
    const expected = this.stopping;
    this.lastExit = { code, signal, at: new Date(this.now).toISOString() };
    this.lastExitExpected = expected;
    if (!expected) {
      this.crashes += 1;
      this.crashTimes.push(this.now);
      this.options.log?.(`desktop helper ended (${error ? error.message : signal ?? `exit ${code}`})`);
    }
    if (this.state !== "unavailable") this.state = expected ? "stopped" : "failed";
    if (!expected && error) this.reason = error.message;
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(new HelperError("gone", "The desktop helper stopped before it answered.", waiting.effects ? "maybe" : "no", true));
    }
    this.emit("exit", { code, signal, expected });
  }

  /** One request. `effects`: it acts on the desktop, so a lost answer means it may have run. */
  async call<T>(method: string, params: Record<string, unknown>, options: { timeoutMs: number; effects?: boolean }): Promise<T> {
    await this.start();
    return this.send<T>(method, params, { timeoutMs: options.timeoutMs, effects: options.effects ?? false, started: false });
  }

  private send<T>(method: string, params: Record<string, unknown>, options: { timeoutMs: number; effects: boolean; started: boolean }): Promise<T> {
    const child = this.child;
    if (!child || !child.stdin) return Promise.reject(new HelperError("gone", "The desktop helper is not running.", "no", true));
    const id = (this.nextId += 1);
    const deadline = Math.max(500, options.timeoutMs - HELPER_MARGIN_MS);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new HelperError("deadline", `The desktop helper did not answer ${method} in time.`, options.effects ? "maybe" : "no", true));
        // Killed so it can never act on this request later; the next request starts it again.
        if (this.child === child) child.kill("SIGKILL");
      }, options.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, effects: options.effects, method });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, deadline_ms: deadline } })}\n`);
    });
  }

  /** Tells the helper to stop a running request between its steps (it still answers). */
  cancel(id: number): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "cancel", params: { id } })}\n`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      if (this.state !== "unavailable" && this.state !== "failed") this.state = "stopped";
      return;
    }
    this.stopping = true;
    child.stdin?.end();
    const ended = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 4_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!ended) {
      child.kill("SIGTERM");
      const killed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2_000);
        timer.unref?.();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!killed) child.kill("SIGKILL");
    }
  }
}

export function ranOf(error: unknown, fallback: Ran = "maybe"): Ran {
  return error instanceof HelperError ? error.ran : fallback;
}
