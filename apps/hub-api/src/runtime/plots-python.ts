/**
 * Matplotlib preview and export stay on the person's own python3.
 * One long-lived worker draws every figure. Binary table parse still uses a
 * fresh interpreter. Ensemble does not bundle Python.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CallError } from "./errors.js";
import { PlotWorkerUnavailable, resetPlotWorker, submitPlot, type PlotWorkerJob, type PlotWorkerResult } from "./plot-worker.js";
import { currentPython, spawnPython, type SpawnPythonResult } from "./python-spawn.js";

export { matplotlibCacheDir } from "./plot-worker.js";

export const PLOT_RUNTIME_UNAVAILABLE = "The plot runtime is not available.";
/** Queued too long for a free plot slot. Not a missing interpreter. */
export const PLOT_EXPORTS_BUSY = "Plot exports are busy. Try again.";
/** Internal marker. The route helper turns this into the file-open sentence on desktop. */
export const PARSE_PYTHON_UNAVAILABLE = "The table parser is not available.";

/** Later runs. The font cache already exists. */
export const PLOT_TIMEOUT_MS = 12_000;
/** First run. Matplotlib rebuilds its font cache and can pass 12 seconds. */
export const FIRST_PLOT_TIMEOUT_MS = 45_000;

let fontCacheReady = false;

export function resetPlotWarmupForTests(): void {
  fontCacheReady = false;
  resetPlotWorker();
}

export function plotTimeoutMs(): number {
  return fontCacheReady ? PLOT_TIMEOUT_MS : FIRST_PLOT_TIMEOUT_MS;
}

export type PlotRunnerJob = PlotWorkerJob & { timeoutMs: number };

let runnerForTests: ((job: PlotRunnerJob) => Promise<PlotWorkerResult>) | null = null;

/** Unit tests stand in for the worker. A null runner uses the real interpreter. */
export function setPlotRunnerForTests(run: ((job: PlotRunnerJob) => Promise<PlotWorkerResult>) | null): void {
  runnerForTests = run;
}

function present(result: PlotWorkerResult, timeoutMs: number): Record<string, unknown> {
  if (result.missing === "matplotlib" || result.missing === "python") {
    fontCacheReady = false;
    throw new CallError(PLOT_RUNTIME_UNAVAILABLE, 503);
  }
  if (result.timeout) {
    fontCacheReady = false;
    const seconds = Math.round(timeoutMs / 1000);
    return {
      error: `The script ran longer than ${seconds} seconds.`,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      line: null,
    };
  }
  fontCacheReady = true;
  const payload: Record<string, unknown> = {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    png: result.png ?? null,
    svg: result.svg ?? null,
    pdf: result.pdf ?? null,
    eps: result.eps ?? null,
    line: result.line ?? null,
  };
  if (result.error) payload.error = result.error;
  return payload;
}

export async function runPlot(
  code: string,
  datasets: Array<Record<string, unknown>>,
  format = "all",
  dpi = 200,
): Promise<Record<string, unknown>> {
  const timeoutMs = plotTimeoutMs();
  const job: PlotRunnerJob = { code, datasets, format, dpi, timeout: timeoutMs / 1000, timeoutMs };
  if (runnerForTests) return present(await runnerForTests(job), timeoutMs);
  const python = currentPython();
  if (!python) throw new CallError(PLOT_RUNTIME_UNAVAILABLE, 503);
  try {
    const result = await submitPlot(python, job);
    return present(result, timeoutMs);
  } catch (error) {
    if (error instanceof PlotWorkerUnavailable || (error instanceof CallError && error.statusCode === 503)) {
      throw new CallError(PLOT_RUNTIME_UNAVAILABLE, 503);
    }
    const message = error instanceof Error ? error.message : "plot worker stopped";
    if (message === "plot worker did not start that export") {
      throw new CallError(PLOT_EXPORTS_BUSY, 503);
    }
    if (message === "plot worker timed out") {
      fontCacheReady = false;
      const seconds = Math.round(timeoutMs / 1000);
      return { error: `The script ran longer than ${seconds} seconds.`, stdout: "", stderr: "", line: null };
    }
    throw new CallError(message.slice(0, 300), 503);
  }
}

const PARSE_DRIVER = `
import base64, json, sys
from parse_table import parse_table
raw = json.load(sys.stdin)
try:
    data = base64.b64decode(raw.get("contentBase64") or "")
except Exception:
    print(json.dumps({"error": "The file was not valid base64.", "status": 400}))
    raise SystemExit(0)
try:
    print(json.dumps(parse_table(str(raw.get("filename") or "table"), data, str(raw.get("sheet") or ""))))
except ValueError as exc:
    print(json.dumps({"error": str(exc), "status": 400}))
except Exception as exc:
    print(json.dumps({"error": ("Could not read that file. " + str(exc))[:300], "status": 400}))
`;

function parseTableSource(): string {
  const bundled = fileURLToPath(new URL("./py/parse_table.py", import.meta.url));
  const live = fileURLToPath(new URL("../../../agent-runtime/ensemble_agent/plots/parse_table.py", import.meta.url));
  return readFileSync(existsSync(live) ? live : bundled, "utf8");
}

export async function parseTable(filename: string, contentBase64: string, sheet: string): Promise<Record<string, unknown>> {
  let data: Buffer;
  try {
    data = Buffer.from(contentBase64, "base64");
  } catch {
    throw new CallError("The file was not valid base64.", 400);
  }
  if (data.length > 32 * 1024 * 1024) throw new CallError("That file is larger than 32 MB.", 400);
  const root = await mkdtemp(join(tmpdir(), "ensemble-parse-"));
  try {
    await writeFile(join(root, "parse_table.py"), parseTableSource());
    await writeFile(join(root, "driver.py"), PARSE_DRIVER);
    const result = await spawnPython({
      args: [join(root, "driver.py")],
      cwd: root,
      env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: root },
      timeoutMs: 60_000,
      input: JSON.stringify({ filename, contentBase64, sheet }),
    });
    if (result.missing) throw new CallError(PARSE_PYTHON_UNAVAILABLE, 503);
    return parsedTable(result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parsedTable(result: SpawnPythonResult): Record<string, unknown> {
  if (result.timedOut) throw new CallError("Could not read that file. The parser timed out.", 400);
  const text = result.stdout.toString("utf8").trim();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.error === "string") throw new CallError(parsed.error, Number(parsed.status) || 400);
    return parsed;
  } catch (error) {
    if (error instanceof CallError) throw error;
    const detail = result.stderr.toString("utf8").trim().split("\n").pop() ?? "Could not read that file.";
    throw new CallError(`Could not read that file. ${detail}`.slice(0, 300), 400);
  }
}
