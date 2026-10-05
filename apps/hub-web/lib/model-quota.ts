"use client";

import { useSyncExternalStore } from "react";

/** A model the provider just refused for quota. The picker reads this before the next catalog fetch. */
export type QuotaMark = {
  model: string;
  resetsAt: string;
  message: string;
};

const EMPTY = new Map<string, QuotaMark>();
let marks = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function markModelOutOfQuota(mark: QuotaMark): void {
  const next = new Map(marks);
  next.set(mark.model, mark);
  marks = next;
  emit();
}

export function quotaFor(model: string | undefined, now = Date.now()): QuotaMark | null {
  if (!model) return null;
  const mark = marks.get(model);
  if (!mark) return null;
  if (Number.isNaN(Date.parse(mark.resetsAt)) || Date.parse(mark.resetsAt) <= now) return null;
  return mark;
}

export function subscribeQuota(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getQuotaSnapshot(): ReadonlyMap<string, QuotaMark> {
  return marks;
}

export function useQuotaMarks(): ReadonlyMap<string, QuotaMark> {
  return useSyncExternalStore(subscribeQuota, getQuotaSnapshot, () => EMPTY);
}

export function quotaSuffix(model: string | undefined, quotas: ReadonlyMap<string, QuotaMark>, now = Date.now()): string {
  const mark = model ? quotas.get(model) : undefined;
  if (!mark || Number.isNaN(Date.parse(mark.resetsAt)) || Date.parse(mark.resetsAt) <= now) return "";
  return " · out of quota";
}

export function quotaMessage(body: { code?: string; model?: string; resetsAt?: string; message?: string; error?: string }): QuotaMark | null {
  if (body.code !== "model_quota_exceeded" || !body.model || !body.resetsAt) return null;
  return {
    model: body.model,
    resetsAt: body.resetsAt,
    message: body.message || body.error || `${body.model} is out of quota.`,
  };
}
