/**
 * Hosted plot export.
 *
 * The agent writes a `started` line when the child begins, then the result.
 * The run budget starts at that line. Waiting for a free slot uses a separate
 * limit, so a queued export is not reported as a missing runtime.
 */
import { env } from "../config.js";
import { RuntimeError } from "../lib/runtime.js";
import { errorFromRuntimeBody } from "./errors.js";
import { PLOT_EXPORTS_BUSY } from "./plots-python.js";

/** After the child has started. Same budget the route used to apply from the request. */
export const PLOT_RUN_LIMIT_MS = 50_000;
/**
 * Before the child starts. Vercel and Caddy cut a hosted request at 120s, and
 * Node fetch gives up on a silent body at 300s. A queued export has to end
 * with the busy 503 before either of those. Each export ahead still counts at
 * its own limit; this is only the total wait.
 */
export const PLOT_QUEUE_LIMIT_MS = 110_000;

export type PlotRunLimits = { queueLimitMs: number; runLimitMs: number };

const DEFAULT_LIMITS: PlotRunLimits = { queueLimitMs: PLOT_QUEUE_LIMIT_MS, runLimitMs: PLOT_RUN_LIMIT_MS };

export async function fetchHostedPlotRun(
  json: unknown,
  limits: PlotRunLimits = DEFAULT_LIMITS,
  runtimeUrl = env.AGENT_RUNTIME_URL,
): Promise<Record<string, unknown>> {
  // Headers come back as soon as the agent accepts. The queue budget covers
  // that wait. The body reader starts the run budget at the started line.
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), limits.queueLimitMs);
  let response: Response;
  try {
    response = await fetch(`${runtimeUrl}/api/plots/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ensemble-internal": env.ENSEMBLE_INTERNAL_TOKEN,
      },
      body: JSON.stringify(json),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new RuntimeError(PLOT_EXPORTS_BUSY, 503);
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimeError(`The model runtime is not running. Start it with pnpm dev (or pnpm dev:agent). ${detail}`, 503, true);
  } finally {
    clearTimeout(killer);
  }
  if (!response.ok) {
    const text = await response.text();
    const failure = errorFromRuntimeBody(response.status, text);
    throw new RuntimeError(failure.message, failure.statusCode);
  }
  return readPlotRunStream(response.body, limits);
}

export async function readPlotRunStream(
  body: ReadableStream<Uint8Array> | null,
  limits: PlotRunLimits,
): Promise<Record<string, unknown>> {
  if (!body) throw new RuntimeError("The plot runtime could not draw that figure.", 502);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let started = false;
  const opened = Date.now();
  let runningSince = 0;

  const expired = (): RuntimeError => {
    if (!started) return new RuntimeError(PLOT_EXPORTS_BUSY, 503);
    const seconds = Math.max(1, Math.round(limits.runLimitMs / 1000));
    return new RuntimeError(`The script ran longer than ${seconds} seconds. Try again.`, 503);
  };

  const accept = (line: string): Record<string, unknown> | null => {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      message = parsed as Record<string, unknown>;
    } catch {
      throw new RuntimeError("The plot runtime could not draw that figure.", 502);
    }
    if (message.started === true && message.stdout === undefined && message.error === undefined && message.timeout === undefined) {
      if (!started) {
        started = true;
        runningSince = Date.now();
      }
      return null;
    }
    return message;
  };

  const consume = (eof: boolean): Record<string, unknown> | null => {
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        if (!eof) return null;
        const tail = buffer.trim();
        buffer = "";
        return tail ? accept(tail) : null;
      }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = accept(line);
      if (message) return message;
    }
  };

  try {
    while (true) {
      const deadline = started ? runningSince + limits.runLimitMs : opened + limits.queueLimitMs;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw expired();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reading = reader.read();
      reading.catch(() => undefined);
      const chunk = await Promise.race([
        reading,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), remaining);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (chunk === "timeout") throw expired();
      if (chunk.done) {
        buffer += decoder.decode();
        const message = consume(true);
        if (message) return message;
        throw new RuntimeError("The plot runtime could not draw that figure.", 502);
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const message = consume(false);
      if (message) return message;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // cancel already released it
    }
  }
}
