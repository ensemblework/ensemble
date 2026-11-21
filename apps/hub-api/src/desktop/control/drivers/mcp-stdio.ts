/**
 * A Model Context Protocol client over a child process's stdin and stdout (JSON-RPC 2.0, one message per
 * line), for cua-driver (macos-cua.ts). Like HelperProcess it starts the child on first use with only the
 * environment it is given, refuses a server that is not the pinned version, gives every call a deadline and
 * kills the child when an answer comes too late (so it can never act on that call later), and starts it again
 * after a crash, at most `maxRestarts` times in `restartWindowMs`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { HelperCommand, HelperHealth } from "../helper-process.js";
import { HelperError, type Ran } from "../protocol.js";

/** The MCP revision asked for at `initialize`: cua-driver answers it without per-request metadata. */
export const MCP_PROTOCOL = "2025-06-18";

export type McpTool = { name: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } };
export type McpContent = { type: string; text?: string; data?: string; mimeType?: string };
export type McpResult = { content?: McpContent[]; structuredContent?: Record<string, unknown>; isError?: boolean };

export type McpOptions = {
  spawn: () => HelperCommand | { unavailable: string };
  /** The only server version used (`serverInfo.version`). */
  version: string;
  log?: (message: string) => void;
  maxRestarts?: number;
  restartWindowMs?: number;
  helloTimeoutMs?: number;
  stopGraceMs?: number;
  now?: () => number;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout; effects: boolean };

export class McpStdioClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private crashTimes: number[] = [];
  private stopping = false;
  private stderrTail = "";
  private state: HelperHealth["state"] = "stopped";
  private reason: string | null = null;
  private lastExit: HelperHealth["lastExit"] = null;
  private lastExitExpected = true;
  private serverVersion: string | null = null;
  /** The server's tools by name, with their input schemas, from its `tools/list`. */
  readonly tools = new Map<string, McpTool>();
  restarts = 0;
  crashes = 0;

  constructor(private readonly options: McpOptions) {
    super();
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  get running(): boolean {
    return this.child !== null && this.state === "ready";
  }

  health(): HelperHealth {
    return { state: this.state, pid: this.child?.pid ?? null, version: this.serverVersion, restarts: this.restarts, crashes: this.crashes, lastExit: this.lastExit, reason: this.reason };
  }

  /** The last lines the server wrote to stderr, for a diagnosis; never logged whole. */
  stderr(): string {
    return this.stderrTail;
  }

  /** Whether the live schema of `tool` takes `property`. */
  takes(tool: string, property: string): boolean {
    const properties = this.tools.get(tool)?.inputSchema?.properties;
    return Boolean(properties && Object.prototype.hasOwnProperty.call(properties, property));
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
      throw new HelperError("gone", `The macOS desktop driver stopped ${this.crashTimes.length} times in a few minutes; it rests until it has been quiet for a while.`, "no", true);
    }
    this.starting = this.reaped()
      .then(() => this.launch())
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  /** A server killed for a late answer is gone before the next one starts. */
  private async reaped(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async launch(): Promise<void> {
    const spec = this.options.spawn();
    if ("unavailable" in spec) {
      this.state = "unavailable";
      this.reason = spec.unavailable;
      throw new HelperError("unavailable", spec.unavailable, "no");
    }
    this.state = "starting";
    this.reason = null;
    this.stopping = false;
    this.tools.clear();
    const child = spawn(spec.command, spec.args, { env: spec.env, cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    if (this.lastExit && !this.lastExitExpected) this.restarts += 1;
    child.stdin!.on("error", () => undefined);
    child.stderr!.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2_000);
    });
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on("line", (line) => this.onLine(child, line));
    child.once("error", (error) => this.onExit(child, null, null, error));
    child.once("exit", (code, signal) => this.onExit(child, code, signal, null));
    const helloMs = this.options.helloTimeoutMs ?? 20_000;
    try {
      const hello = await this.request<{ serverInfo?: { version?: unknown } }>("initialize", { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "ensemble", version: "1" } }, { timeoutMs: helloMs, effects: false });
      const version = typeof hello?.serverInfo?.version === "string" ? hello.serverInfo.version : null;
      if (version !== this.options.version) {
        const reason = `The macOS desktop driver here is cua-driver ${version ?? "of an unknown version"}; this Ensemble uses ${this.options.version}. Update the Ensemble app.`;
        await this.stop();
        this.state = "unavailable";
        this.reason = reason;
        throw new HelperError("unavailable", reason, "no");
      }
      this.notify("notifications/initialized", {});
      let cursor: string | undefined;
      do {
        const page = await this.request<{ tools?: McpTool[]; nextCursor?: unknown }>("tools/list", cursor ? { cursor } : {}, { timeoutMs: helloMs, effects: false });
        for (const tool of page?.tools ?? []) if (tool && typeof tool.name === "string") this.tools.set(tool.name, tool);
        cursor = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
      } while (cursor);
      this.serverVersion = version;
      this.state = "ready";
    } catch (error) {
      if (this.child === child && this.state === "starting") {
        this.state = "failed";
        child.kill("SIGKILL");
      }
      if (this.state === "failed") this.reason ??= error instanceof Error ? error.message : "The macOS desktop driver did not start.";
      throw error;
    }
  }

  private onLine(child: ChildProcess, line: string): void {
    let message: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } | null; method?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.method === "string") {
      // A request of the server's own: only ping is answered, as this client offers nothing else.
      if (message.id !== undefined && message.id !== null) {
        const reply = message.method === "ping" ? { result: {} } : { error: { code: -32601, message: "Method not found" } };
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply })}\n`);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) {
      const code = typeof message.error.code === "number" ? message.error.code : 0;
      const text = typeof message.error.message === "string" ? message.error.message.slice(0, 500) : "The macOS desktop driver failed.";
      waiting.reject(new HelperError(code === -32602 ? "invalid_params" : code === -32601 ? "method_not_found" : "internal", text, "no"));
    } else waiting.resolve(message.result);
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
      this.options.log?.(`macOS desktop driver ended (${error ? error.message : signal ?? `exit ${code}`})`);
    }
    if (this.state !== "unavailable") this.state = expected ? "stopped" : "failed";
    if (!expected && error) this.reason = error.message;
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(new HelperError("gone", "The macOS desktop driver stopped before it answered.", waiting.effects ? "maybe" : "no", true));
    }
    this.emit("exit", { code, signal, expected });
  }

  /** One tool call. `effects`: it acts on the desktop, so a lost answer means it may have run. */
  async call(name: string, args: Record<string, unknown>, options: { timeoutMs: number; effects?: boolean }): Promise<McpResult> {
    await this.start();
    return this.request<McpResult>("tools/call", { name, arguments: args }, { timeoutMs: options.timeoutMs, effects: options.effects ?? false });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private request<T>(method: string, params: Record<string, unknown>, options: { timeoutMs: number; effects: boolean }): Promise<T> {
    const child = this.child;
    if (!child || !child.stdin) return Promise.reject(new HelperError("gone", "The macOS desktop driver is not running.", "no", true));
    const id = (this.nextId += 1);
    const late: Ran = options.effects ? "maybe" : "no";
    const what = method === "tools/call" ? String(params.name) : method;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new HelperError("deadline", `The macOS desktop driver did not answer ${what} in time.`, late, true));
        // Killed so it can never act on this call later; the next call starts it again.
        if (this.child === child) {
          this.state = "failed";
          child.kill("SIGKILL");
        }
      }, Math.max(1, options.timeoutMs));
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, effects: options.effects });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
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
      const timer = setTimeout(() => resolve(false), this.options.stopGraceMs ?? 4_000);
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
