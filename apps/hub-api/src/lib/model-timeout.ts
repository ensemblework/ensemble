/**
 * How long one model call may take (docs/11 §2): `ENSEMBLE_MODEL_CALL_TIMEOUT_MS`, 15 minutes by
 * default, between 30 seconds and 30 minutes. hub-api starts the clock (lib/model-turn.ts) and sends
 * what it allows in the request as `timeoutMs`; the runtime that calls the provider (in-process, or the
 * Python runtime's ensemble_agent/model_timeout.py) waits a few seconds longer, so hub-api always cuts
 * first and says why in words.
 */
import { includedModel } from "@ensemble/shared-types";
import { RuntimeError } from "./runtime-error.js";

export const MODEL_CALL_TIMEOUT_DEFAULT_MS = 15 * 60_000;
export const MODEL_CALL_TIMEOUT_MIN_MS = 30_000;
export const MODEL_CALL_TIMEOUT_MAX_MS = 30 * 60_000;
/** The runtime's margin past hub-api's limit. */
export const RUNTIME_GRACE_MS = 10_000;

export function modelCallTimeoutMs(source: NodeJS.ProcessEnv = process.env): number {
  const raw = source.ENSEMBLE_MODEL_CALL_TIMEOUT_MS?.trim();
  const value = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) return MODEL_CALL_TIMEOUT_DEFAULT_MS;
  return Math.min(MODEL_CALL_TIMEOUT_MAX_MS, Math.max(MODEL_CALL_TIMEOUT_MIN_MS, Math.round(value)));
}

/** One call's limit: the caller's when it is shorter (a vision check, a checklist), else the setting. */
export function callLimitMs(requested?: number | null, source: NodeJS.ProcessEnv = process.env): number {
  const setting = modelCallTimeoutMs(source);
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? Math.min(requested, setting) : setting;
}

/** What a runtime waits for a provider: hub-api's `timeoutMs` and the grace, else the setting. */
export function runtimeCallTimeoutMs(body: { timeoutMs?: unknown }, source: NodeJS.ProcessEnv = process.env): number {
  const asked = body.timeoutMs;
  if (typeof asked === "number" && Number.isFinite(asked) && asked >= 1_000) return Math.min(asked, MODEL_CALL_TIMEOUT_MAX_MS) + RUNTIME_GRACE_MS;
  return modelCallTimeoutMs(source);
}

/** "15 minutes", "1 minute", "45 seconds". */
export function durationWords(ms: number): string {
  if (ms < 90_000 && ms % 60_000 !== 0) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** The name people see: "GPT-6.1 Sol" for an included model, else the model id. */
export function modelLabel(model: string): string {
  return includedModel(model)?.label ?? (model.trim() || "The model");
}

export function modelTimeoutMessage(model: string, ms: number): string {
  return `${modelLabel(model)} did not answer within ${durationWords(ms)}, so I stopped waiting. Ask again, or try a narrower question.`;
}

/** A model call that ran past its limit; its message is what the chat shows. */
export class ModelTimeoutError extends RuntimeError {
  constructor(
    readonly model: string,
    readonly limitMs: number,
  ) {
    super(modelTimeoutMessage(model, limitMs), 504, false, "timeout");
    this.name = "ModelTimeoutError";
  }
}

/** The error a fetch or stream read throws when an `AbortSignal.timeout` fired. */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}
