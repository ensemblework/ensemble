import type { AssistantToolCallRecord } from "../../lib/api";

export type EnsembleLive = {
  text: string;
  status: "streaming" | "open" | "error";
  /** Real server status, when the stream sent one. Playful verbs stay a fallback. */
  note?: string;
  model?: string;
  tier?: string;
  error?: string;
  toolCalls?: AssistantToolCallRecord[];
  conversationId?: string;
};

const bus = new Map<string, EnsembleLive>();
const listeners = new Map<string, Set<() => void>>();
const activePages = new Map<string, number>();

export function isPageEnsembleBusy(kind: string, id: string): boolean {
  return (activePages.get(JSON.stringify([kind, id])) ?? 0) > 0;
}

export function beginPageEnsemble(kind: string, id: string): () => void {
  const key = JSON.stringify([kind, id]);
  activePages.set(key, (activePages.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activePages.get(key) ?? 1) - 1;
    if (remaining) activePages.set(key, remaining);
    else activePages.delete(key);
  };
}

export function readEnsemble(id: string): EnsembleLive | undefined {
  return bus.get(id);
}

export function publishEnsemble(id: string, next: EnsembleLive): void {
  bus.set(id, next);
  listeners.get(id)?.forEach((fn) => fn());
}

export function subscribeEnsemble(id: string, fn: () => void): () => void {
  const set = listeners.get(id) ?? new Set();
  set.add(fn);
  listeners.set(id, set);
  return () => set.delete(fn);
}
