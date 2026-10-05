/**
 * A provider quota miss is its own error. The client gets HTTP 429 and a reset
 * time, and the sentence is not stored as something the assistant said.
 */
import { nextPacificMidnight } from "./clock.js";
import { RuntimeError } from "./runtime.js";

export const MODEL_QUOTA_EXCEEDED = "model_quota_exceeded" as const;

export type ModelQuotaBody = {
  code: typeof MODEL_QUOTA_EXCEEDED;
  error: string;
  message: string;
  model: string;
  resetsAt: string;
  status: 429;
};

export function quotaResetInstant(now: Date, retryAfterSeconds?: number | null): Date {
  if (retryAfterSeconds != null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return new Date(now.getTime() + retryAfterSeconds * 1000);
  }
  return nextPacificMidnight(now);
}

export function quotaExceededMessage(model: string, resetsAt: Date): string {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(resetsAt);
  return `${model} is out of quota until ${when}.`;
}

export class ModelQuotaError extends RuntimeError {
  readonly code = MODEL_QUOTA_EXCEEDED;
  readonly model: string;
  readonly resetsAt: string;
  readonly retryAfterSeconds: number | null;

  constructor(model: string, resetsAt: Date, retryAfterSeconds: number | null = null) {
    super(quotaExceededMessage(model, resetsAt), 429);
    this.name = "ModelQuotaError";
    this.model = model;
    this.resetsAt = resetsAt.toISOString();
    this.retryAfterSeconds = retryAfterSeconds;
  }

  toJSON(): ModelQuotaBody {
    return {
      code: this.code,
      error: this.message,
      message: this.message,
      model: this.model,
      resetsAt: this.resetsAt,
      status: 429,
    };
  }
}

export function isQuotaFailure(failure: { kind?: string; status?: number; message?: string }): boolean {
  if (failure.kind === "quota") return true;
  const message = failure.message ?? "";
  return failure.status === 429 && /resource_exhausted|resource exhausted/i.test(message);
}
