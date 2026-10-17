/**
 * Why an included call did not run. hub-api answers 429 (credits or the shared budget used up)
 * or 503 (not set up), and the sentence is not stored as something the assistant said.
 */
import {
  INCLUDED_CREDITS_USED,
  INCLUDED_PAUSED,
  INCLUDED_UNAVAILABLE,
  includedResetsAt,
  type IncludedErrorBody,
  type IncludedErrorCode,
} from "@ensemble/shared-types";
import { RuntimeError } from "../lib/runtime-error.js";

function day(at: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(at);
}

export function includedMessage(code: IncludedErrorCode, resetsAt: Date | null, detail?: { need?: number; left?: number }): string {
  const when = resetsAt ? day(resetsAt) : "";
  if (code === INCLUDED_PAUSED) {
    return `Ensemble's included AI is paused for everyone until ${when}: this month's shared budget is used up, even for accounts with credits left. Your own API keys and AI plans still work (Settings → Models).`;
  }
  if (code === INCLUDED_CREDITS_USED) {
    if (detail?.need && detail.left != null && detail.left > 0) {
      return `This reply could use up to ${Math.ceil(detail.need).toLocaleString("en-US")} Ensemble credits and you have ${Math.floor(detail.left).toLocaleString("en-US")} left this month. Pick a lighter included model, or wait until credits reset on ${when}.`;
    }
    return `You've used this month's Ensemble credits. They reset on ${when}. To keep going now, add your own API key or AI plan in Settings → Models.`;
  }
  return "Included AI is not set up on this server. Add your own API key or AI plan in Settings → Models.";
}

export class IncludedLimitError extends RuntimeError {
  readonly code: IncludedErrorCode;
  readonly resetsAt: string | null;

  constructor(code: IncludedErrorCode, message?: string, resetsAt?: string | null) {
    const reset = code === INCLUDED_UNAVAILABLE ? null : (resetsAt ?? includedResetsAt().toISOString());
    super(message ?? includedMessage(code, reset ? new Date(reset) : null), code === INCLUDED_UNAVAILABLE ? 503 : 429, false, code === INCLUDED_UNAVAILABLE ? "auth" : "credits");
    this.name = "IncludedLimitError";
    this.code = code;
    this.resetsAt = reset;
  }

  toJSON(): IncludedErrorBody {
    return { code: this.code, error: this.message, message: this.message, resetsAt: this.resetsAt, status: this.statusCode === 503 ? 503 : 429 };
  }
}

/** A runtime error body or SSE frame that carries an included code, as an IncludedLimitError. */
export function includedErrorFrom(value: unknown): IncludedLimitError | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { code?: unknown; message?: unknown; resetsAt?: unknown; detail?: unknown };
  if (record.detail && typeof record.detail === "object") return includedErrorFrom(record.detail);
  const code = record.code;
  if (code !== INCLUDED_CREDITS_USED && code !== INCLUDED_PAUSED && code !== INCLUDED_UNAVAILABLE) return null;
  return new IncludedLimitError(code, typeof record.message === "string" && record.message ? record.message : undefined, typeof record.resetsAt === "string" ? record.resetsAt : null);
}
