import { useQuery, type QueryClient } from "@tanstack/react-query";
import { INCLUDED_LABEL, INCLUDED_MODELS, INCLUDED_PROVIDER, includedModel, includedModelName, isIncludedErrorCode, type IncludedUsage } from "@ensemble/shared-types";
import { api } from "./api";

export const INCLUDED_USAGE_KEY = ["included-usage"] as const;

/** This account's Ensemble credits this month. Nothing about credits is shown unless `data.available`. */
export function useIncludedUsage(enabled = true) {
  return useQuery({ queryKey: INCLUDED_USAGE_KEY, queryFn: api.includedUsage, enabled, retry: false, staleTime: 60_000 });
}

/** A tier's model as people read it: an included model's name with its version, any other model's id. */
export function tierModelName(provider: string | null | undefined, model: string): string {
  return provider === INCLUDED_PROVIDER ? includedModelName(model) : model;
}

/** "Included with Ensemble · Grok 4.7" for an included tier, the model id otherwise. */
export function tierModelLabel(tier: { provider?: string | null; model: string } | null | undefined): string | null {
  if (!tier) return null;
  return tier.provider === INCLUDED_PROVIDER ? `${INCLUDED_LABEL} · ${includedModelName(tier.model)}` : tier.model;
}

/** "Nov 1": credits reset at 00:00 UTC, so the day is the UTC one. */
export function resetDay(at: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(at));
}

/** Whole credits, rounded down: "12,345". */
export function wholeCredits(value: number): string {
  return Math.floor(Math.max(0, value)).toLocaleString("en-US");
}

/** "0.4 credits" under 10, "1,530 credits" from 10 up. */
export function creditAmount(value: number): string {
  if (value > 0 && value < 0.05) return "under 0.1 credits";
  const text = value.toLocaleString("en-US", { maximumFractionDigits: value < 10 ? 1 : 0 });
  return `${text} ${text === "1" ? "credit" : "credits"}`;
}

/** "1.2M", "85K", "940". */
export function tokenCount(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** Included calls cannot run now: the shared budget is paused, or this account's credits are used. */
export function includedBlocked(usage: IncludedUsage): boolean {
  return usage.paused || usage.remaining <= 0;
}

/** The provider menu's note: "12,345 credits left", or "paused until Nov 1". */
export function includedNote(usage: IncludedUsage): string {
  return usage.paused ? `paused until ${resetDay(usage.resetsAt)}` : `${wholeCredits(usage.remaining)} credits left`;
}

const BASELINE = INCLUDED_MODELS.find((model) => model.relativeCost === 1) ?? INCLUDED_MODELS[0]!;

/** The cost badge on an included model: "20×", with what it is measured against. */
export function relativeCost(id: string): { badge: string; title: string } | null {
  const model = includedModel(id);
  if (!model) return null;
  const title =
    model.id === BASELINE.id
      ? `A typical turn on ${BASELINE.label} is the credit baseline for included models.`
      : `A typical turn uses about ${model.relativeCost}× the credits of ${BASELINE.label}.`;
  return { badge: `${model.relativeCost}×`, title };
}

/** The sentence to show for an included refusal (HTTP body or SSE error frame), or null for any other error. */
export function includedRefusal(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { code?: unknown; message?: unknown; error?: unknown };
  if (!isIncludedErrorCode(record.code)) return null;
  for (const text of [record.message, record.error]) if (typeof text === "string" && text.trim()) return text.trim();
  return "Included AI could not run this call.";
}

/** After an included refusal the credits, the pause and the model list may all have changed. */
export function refreshIncluded(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: INCLUDED_USAGE_KEY });
  void client.invalidateQueries({ queryKey: ["models"] });
}
