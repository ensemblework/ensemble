/**
 * Client for the long-lived plot worker.
 *
 * The worker source lives in agent-runtime. A packaged desktop app has no
 * apps/agent-runtime tree, so it runs the checked-in copy next to this file.
 * Those two files are kept identical.
 */
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";
import { stopProcessGroup } from "../lib/process-group.js";
import { capabilities, startSandboxed } from "../workspace/sandbox/spawn.js";
import { parsePlotConcurrency } from "./plot-concurrency.js";
import { openPython } from "./python-spawn.js";

/** Shells a plot must not exec. Same list as workspace/sandbox/cli.ts. */
const PLOT_SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/bash", "/usr/bin/zsh", "/bin/dash"];

/** Stable matplotlib config so the font cache survives the temp plot directory. */
export function matplotlibCacheDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const chosen = env.ENSEMBLE_MPLCONFIGDIR?.trim() || env.MPLCONFIGDIR?.trim();
  const path = chosen
    ? chosen
    : platform === "win32"
      ? join(env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"), "Ensemble", "Cache", "matplotlib")
      : platform === "darwin"
        ? join(homedir(), "Library", "Caches", "Ensemble", "matplotlib")
        : join(env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "ensemble", "matplotlib");
  mkdirSync(path, { recursive: true });
  return path;
}

export class PlotWorkerUnavailable extends Error {
  constructor() {
    super("The plot runtime is not available.");
    this.name = "PlotWorkerUnavailable";
  }
}

export interface PlotWorkerJob {
  code: string;
  datasets: Array<Record<string, unknown>>;
  format: string;
  dpi: number;
  /** Seconds. The worker kills the child when this elapses. */
  timeout: number;
}

export interface PlotWorkerResult {
  stdout?: string;
  stderr?: string;
  png?: string | null;
  svg?: string | null;
  pdf?: string | null;
  eps?: string | null;
  line?: number | null;
  error?: string;
  timeout?: boolean;
  missing?: string;
  ready?: boolean;
  started?: boolean;
  id?: string;
}

interface Pending {
  resolve: (result: PlotWorkerResult) => void;
  reject: (error: Error) => void;
  onStarted: () => void;
  /** Seconds. The limit this export was given, not the one waiting behind it. */
  timeout: number;
}

/** Extra seconds to notice that a queued export has started. */
export const PLOT_QUEUE_SLACK_S = 5;
/**
 * Total seconds a queued export may wait, including slack. Vercel and Caddy
 * cut hosted requests at 120s, and Node fetch gives up on a silent body at
 * 300s. Each export ahead still counts at its own limit; this only caps the sum.
 */
export const PLOT_QUEUE_WAIT_CAP_S = 110;

let queueSlackForTests: number | null = null;
let queueWaitCapForTests: number | null = null;

/** Unit tests shrink the queue slack. Null restores the 5 second default. */
export function setPlotQueueSlackForTests(seconds: number | null): void {
  queueSlackForTests = seconds;
}

/** Unit tests shrink the total queue wait. Null restores the 110 second cap. */
export function setPlotQueueWaitCapForTests(seconds: number | null): void {
  queueWaitCapForTests = seconds;
}

/**
 * Seconds until one more export can start. `limits` are the exports ahead,
 * oldest first, each at the limit it is actually running under. With a cap,
 * a new export starts when the earliest slot is free after those jobs are placed.
 */
export function queueStartDelay(limits: number[], cap: number): number {
  if (limits.length === 0) return 0;
  const slots = Array.from({ length: Math.max(1, cap) }, () => 0);
  for (const limit of limits) {
    let earliest = 0;
    for (let index = 1; index < slots.length; index += 1) {
      if (slots[index]! < slots[earliest]!) earliest = index;
    }
    slots[earliest] = (slots[earliest] ?? 0) + limit;
  }
  return Math.min(...slots);
}

let workerPathForTests: string | null = null;

/** Unit tests stand in for worker.py. A null path uses the real file. */
export function setPlotWorkerPathForTests(path: string | null): void {
  workerPathForTests = path;
}

/** Checked-in copy used when the agent-runtime tree is not on disk (the .dmg). */
export function plotWorkerPath(): string {
  if (workerPathForTests) return workerPathForTests;
  const bundled = fileURLToPath(new URL("./py/plot_worker.py", import.meta.url));
  const live = fileURLToPath(new URL("../../../agent-runtime/ensemble_agent/plots/worker.py", import.meta.url));
  return existsSync(live) ? live : bundled;
}

export function plotConcurrency(): number {
  return parsePlotConcurrency(process.env.ENSEMBLE_PLOT_CONCURRENCY);
}

/** Allow-list. Forked plots inherit it, so tokens and API keys stay out. */
export function plotWorkerEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "PYTHONPATH", "PYTHONHOME", "PYTHONNOUSERSITE"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.MPLCONFIGDIR = matplotlibCacheDir();
  env.MPLBACKEND = "Agg";
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.ENSEMBLE_PLOT_CONCURRENCY = String(plotConcurrency());
  env.OPENBLAS_NUM_THREADS = "1";
  env.OMP_NUM_THREADS = "1";
  env.MKL_NUM_THREADS = "1";
  env.NUMEXPR_NUM_THREADS = "1";
  env.VECLIB_MAXIMUM_THREADS = "1";
  env.LANG ??= "C.UTF-8";
  const crash = process.env.ENSEMBLE_PLOT_TEST_CRASH;
  if (crash) env.ENSEMBLE_PLOT_TEST_CRASH = crash;
  if (process.platform === "darwin") {
    env.ENSEMBLE_OS_SANDBOX = capabilities().osSandbox ? "seatbelt" : "advisory";
  }
  return env;
}

class PlotWorker {
  private readonly pending = new Map<string, Pending>();
  private buffer = "";
  private readySettled = false;
  private readyResolve: ((line: PlotWorkerResult) => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  readonly python: string;
  readonly concurrency: number;

  constructor(
    private readonly proc: ChildProcess,
    python: string,
    concurrency: number,
  ) {
    this.python = python;
    this.concurrency = concurrency;
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr?.on("data", () => undefined);
    proc.on("error", () => this.fail(new PlotWorkerUnavailable()));
    proc.on("close", () => this.fail(new Error("plot worker stopped")));
  }

  get exited(): boolean {
    return this.proc.exitCode !== null || this.proc.signalCode !== null;
  }

  ready(): Promise<PlotWorkerResult> {
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** Limits of exports already submitted, oldest first. */
  pendingTimeouts(): number[] {
    return [...this.pending.values()].map((item) => item.timeout);
  }

  submit(job: PlotWorkerJob): { id: string; result: Promise<PlotWorkerResult>; started: Promise<boolean> } {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let markStarted: (didStart: boolean) => void = () => undefined;
    const started = new Promise<boolean>((resolve) => {
      markStarted = resolve;
    });
    const result = new Promise<PlotWorkerResult>((resolve, reject) => {
      if (this.exited || !this.proc.stdin) {
        markStarted(false);
        reject(new Error("plot worker stopped"));
        return;
      }
      this.pending.set(id, {
        resolve: (message) => {
          markStarted(false);
          resolve(message);
        },
        reject: (error) => {
          markStarted(false);
          reject(error);
        },
        onStarted: () => markStarted(true),
        timeout: job.timeout,
      });
      this.proc.stdin.write(`${JSON.stringify({ ...job, id })}\n`);
    });
    return { id, result, started };
  }

  /** Ask the worker to stop one export. The warm process stays up. */
  cancel(id: string): void {
    if (this.exited || !this.proc.stdin) return;
    this.proc.stdin.write(`${JSON.stringify({ id, cancel: true })}\n`);
  }

  kill(): void {
    // Own process group (detached). TERM, then KILL, on the whole group.
    void stopProcessGroup(this.proc, { stdinGraceMs: 500, termGraceMs: 500 });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: PlotWorkerResult & { id?: string; ready?: boolean };
    try {
      message = JSON.parse(line) as PlotWorkerResult & { id?: string; ready?: boolean };
    } catch {
      return;
    }
    if (!this.readySettled) {
      this.readySettled = true;
      this.readyResolve?.(message);
      return;
    }
    const id = message.id ?? "";
    const pending = this.pending.get(id);
    if (!pending) return;
    if (message.started === true && message.stdout === undefined && message.timeout === undefined && message.error === undefined) {
      pending.onStarted();
      return;
    }
    this.pending.delete(id);
    pending.resolve(message);
  }

  private fail(error: Error): void {
    if (!this.readySettled) {
      this.readySettled = true;
      this.readyReject?.(error);
    }
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

let worker: PlotWorker | null = null;
let starting: Promise<PlotWorker> | null = null;

export function resetPlotWorker(): void {
  worker?.kill();
  worker = null;
  starting = null;
}

/** Paths Seatbelt must allow. $HOME is denied unless a path is named. */
export function pythonReadPaths(python: string): string[] {
  const env = plotWorkerEnv();
  env.HOME = homedir();
  const probe = spawnSync(
    python,
    [
      "-c",
      [
        "import json, os, site, sys",
        "raw = [sys.prefix, sys.base_prefix, sys.exec_prefix]",
        "raw.extend(p for p in sys.path if p)",
        "try:",
        "    raw.extend(site.getsitepackages())",
        "except Exception:",
        "    pass",
        "try:",
        "    user = site.getusersitepackages()",
        "    if isinstance(user, str):",
        "        raw.append(user)",
        "except Exception:",
        "    pass",
        "seen = []",
        "for item in raw:",
        "    path = os.path.realpath(item)",
        "    if path not in seen and os.path.isdir(path):",
        "        seen.append(path)",
        "print(json.dumps(seen))",
      ].join("\n"),
    ],
    { encoding: "utf8", timeout: 10_000, env },
  );
  if (probe.status !== 0 || !probe.stdout) return [];
  try {
    const parsed = JSON.parse(probe.stdout) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function startProcess(python: string): ChildProcess | "missing" {
  const script = plotWorkerPath();
  const env = plotWorkerEnv();
  if (process.platform === "darwin") {
    const root = mkdtempSync(join(tmpdir(), "ensemble-plots-"));
    const home = homedir();
    const cache = String(env.MPLCONFIGDIR);
    try {
      const { child } = startSandboxed(
        {
          runId: "plot-worker",
          cwd: root,
          readWrite: [root, cache],
          readOnly: pythonReadPaths(python),
          deny: ["/etc/passwd", "/private/etc/passwd"],
          network: "none",
          env,
          who: "agent",
          home,
          ensembleSource: desktopDataDir({ platform: process.platform, home }),
          appDataDir: desktopDataDir({ platform: process.platform, home }),
          confined: true,
          advisoryOk: true,
          extraExecDeny: PLOT_SHELLS,
        },
        { program: python, args: [script] },
        { detached: true, stdin: "pipe" },
      );
      return child;
    } catch {
      return "missing";
    }
  }
  const opened = openPython({ bin: python, args: [script], env, detached: process.platform !== "win32" });
  if (opened.missing) return "missing";
  return opened.child;
}

async function ensureWorker(python: string): Promise<PlotWorker> {
  const cap = plotConcurrency();
  if (worker && !worker.exited && worker.python === python && worker.concurrency === cap) return worker;
  if (!starting) {
    starting = (async () => {
      worker?.kill();
      worker = null;
      const proc = startProcess(python);
      if (proc === "missing") throw new PlotWorkerUnavailable();
      const next = new PlotWorker(proc, python, cap);
      let ready: PlotWorkerResult;
      try {
        ready = await Promise.race([
          next.ready(),
          new Promise<PlotWorkerResult>((_, reject) => setTimeout(() => reject(new PlotWorkerUnavailable()), 45_000)),
        ]);
      } catch (error) {
        next.kill();
        throw error instanceof PlotWorkerUnavailable ? error : new PlotWorkerUnavailable();
      }
      if (ready.missing || ready.ready === false) {
        next.kill();
        throw new PlotWorkerUnavailable();
      }
      worker = next;
      return next;
    })().finally(() => {
      starting = null;
    });
  }
  return starting;
}

export async function submitPlot(python: string, job: PlotWorkerJob): Promise<PlotWorkerResult> {
  const current = await ensureWorker(python);
  const aheadLimits = current.pendingTimeouts();
  const { id, result, started } = current.submit(job);
  const cap = Math.max(1, current.concurrency);
  const slack = queueSlackForTests ?? PLOT_QUEUE_SLACK_S;
  const waitCapS = queueWaitCapForTests ?? PLOT_QUEUE_WAIT_CAP_S;
  // Waiting in the queue is not this plot's clock. Budget the exports ahead
  // at the limits they are running under, not at this export's own limit.
  // Never wait longer than the cap: the hosted proxy has dropped the request by then.
  const startAllowanceMs = Math.min((queueStartDelay(aheadLimits, cap) + slack) * 1000, waitCapS * 1000);
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  const gate = await Promise.race([
    started.then((didStart): "started" | "done" => (didStart ? "started" : "done")),
    new Promise<"late">((resolve) => {
      startTimer = setTimeout(() => resolve("late"), startAllowanceMs);
    }),
  ]);
  if (startTimer) clearTimeout(startTimer);
  if (gate === "done") return result;
  if (gate === "late") {
    current.cancel(id);
    void result.catch(() => undefined);
    throw new Error("plot worker did not start that export");
  }
  let runTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<PlotWorkerResult>((_, reject) => {
        runTimer = setTimeout(() => reject(new Error("plot worker timed out")), job.timeout * 1000 + 5_000);
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message === "plot worker timed out") {
      current.cancel(id);
      try {
        return await Promise.race([
          result,
          new Promise<PlotWorkerResult>((_, reject) => setTimeout(() => reject(error), 3_000)),
        ]);
      } catch (again) {
        void result.catch(() => undefined);
        throw again;
      }
    }
    throw error;
  } finally {
    if (runTimer) clearTimeout(runTimer);
  }
}
