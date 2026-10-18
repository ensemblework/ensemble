/**
 * Why an included call did not run. hub-api answers 429 (credits or the shared budget used up),
 * 503 (not set up) or 403 (a local-only desktop app or CLI), and the sentence is not stored as
 * something the assistant said.
 */
import {
  INCLUDED_CREDITS_USED,
  INCLUDED_LOCAL_ONLY,
  INCLUDED_PAUSED,
  INCLUDED_UNAVAILABLE,
  includedResetsAt,
  isIncludedErrorCode,
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
  if (code === INCLUDED_LOCAL_ONLY) {
    return "Included models need this computer connected to your Ensemble account: they run on Ensemble's server and use your account's credits. Connect it in Settings → Account → This computer, or use your own API key or AI plan (Settings → Models).";
  }
  return "Included AI is not set up on this server. Add your own API key or AI plan in Settings → Models.";
}

const STATUS: Record<IncludedErrorCode, 403 | 429 | 503> = {
  [INCLUDED_CREDITS_USED]: 429,
  [INCLUDED_PAUSED]: 429,
  [INCLUDED_UNAVAILABLE]: 503,
  [INCLUDED_LOCAL_ONLY]: 403,
};

/** Codes that have no reset time: the call cannot run until something is set up. */
function resets(code: IncludedErrorCode): boolean {
  return code === INCLUDED_CREDITS_USED || code === INCLUDED_PAUSED;
}

export class IncludedLimitError extends RuntimeError {
  readonly code: IncludedErrorCode;
  readonly resetsAt: string | null;

  constructor(code: IncludedErrorCode, message?: string, resetsAt?: string | null) {
    const reset = resets(code) ? (resetsAt ?? includedResetsAt().toISOString()) : null;
    super(message ?? includedMessage(code, reset ? new Date(reset) : null), STATUS[code], false, resets(code) ? "credits" : "auth");
    this.name = "IncludedLimitError";
    this.code = code;
    this.resetsAt = reset;
  }

  toJSON(): IncludedErrorBody {
    return { code: this.code, error: this.message, message: this.message, resetsAt: this.resetsAt, status: STATUS[this.code] };
  }
}

/** A runtime error body or SSE frame that carries an included code, as an IncludedLimitError. */
export function includedErrorFrom(value: unknown): IncludedLimitError | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { code?: unknown; message?: unknown; resetsAt?: unknown; detail?: unknown };
  if (record.detail && typeof record.detail === "object") return includedErrorFrom(record.detail);
  const code = record.code;
  if (!isIncludedErrorCode(code)) return null;
  return new IncludedLimitError(code, typeof record.message === "string" && record.message ? record.message : undefined, typeof record.resetsAt === "string" ? record.resetsAt : null);
}
