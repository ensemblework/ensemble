/**
 * The 503 body for plot preview and export.
 *
 * Hosted Ensemble keeps main's 503 contract (#33): `retry: true`, and when the
 * Python runtime cannot be reached at all, main's sentence. Any other runtime
 * failure passes its own, more specific message through.
 * On the in-process path, a missing python3 or matplotlib is not a stopped
 * agent runtime. The sentence says to install them, and retry is false so
 * the UI does not tell the person to start the agent runtime.
 *
 * routes/plots.ts sends this object.
 */
import { RuntimeError } from "../lib/runtime.js";
import { useInProcessRuntime } from "./mode.js";
import { PARSE_PYTHON_UNAVAILABLE, PLOT_EXPORTS_BUSY, PLOT_RUNTIME_UNAVAILABLE } from "./plots-python.js";

export const PLOTS_NEED_PYTHON =
  "Plots need Python 3 with matplotlib on this computer. Install it, then try again.";

export const OPENING_NEEDS_PYTHON =
  "Opening this file type needs Python 3 on this computer. Install it, then try again.";

export type PlotFailureBody = { error: string; retry?: boolean };

/** Main's hosted sentence when hub-api cannot reach the plot runtime. */
export const HOSTED_PLOT_RUNTIME_DOWN = "The plot runtime is not available. Start the agent runtime, then try again.";

/** A finished plot body that carries an error. Busy is a 503, not a bad figure. */
export function plotExportErrorReply(error: string, retry?: boolean): { statusCode: number; error: string; retry?: boolean } {
  if (retry === true || error === PLOT_EXPORTS_BUSY || error === PLOT_RUNTIME_UNAVAILABLE) return { statusCode: 503, error, retry: true };
  return { statusCode: 400, error };
}

export function plotRenderFailure(error: unknown): PlotFailureBody {
  if (useInProcessRuntime()) {
    if (missingLocalPlots(error)) return { error: PLOTS_NEED_PYTHON, retry: false };
    const message = error instanceof RuntimeError ? error.message : PLOT_RUNTIME_UNAVAILABLE;
    return { error: message };
  }
  if (error instanceof RuntimeError) {
    return { error: error.unreachable ? HOSTED_PLOT_RUNTIME_DOWN : error.message, retry: true };
  }
  return { error: PLOT_RUNTIME_UNAVAILABLE, retry: true };
}

/** 503 for a spreadsheet or other binary table. Hosted keeps the runtime's sentence. */
export function tableParseFailure(error: unknown): PlotFailureBody {
  if (useInProcessRuntime() && missingLocalParser(error)) {
    return { error: OPENING_NEEDS_PYTHON, retry: false };
  }
  const message = error instanceof RuntimeError ? error.message : "Could not read that file.";
  return { error: message };
}

export function datasetErrorReply(error: unknown): { statusCode: number; error: string; retry?: boolean } {
  if (error instanceof RuntimeError) {
    return { statusCode: error.statusCode, ...tableParseFailure(error) };
  }
  const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 400;
  const message = error instanceof Error ? error.message : "Could not read that file.";
  const retry = (error as { retry?: boolean }).retry;
  return retry === undefined ? { statusCode, error: message } : { statusCode, error: message, retry };
}

function missingLocalPlots(error: unknown): boolean {
  return error instanceof RuntimeError && error.statusCode === 503 && error.message === PLOT_RUNTIME_UNAVAILABLE;
}

function missingLocalParser(error: unknown): boolean {
  return error instanceof RuntimeError && error.statusCode === 503 && error.message === PARSE_PYTHON_UNAVAILABLE;
}
