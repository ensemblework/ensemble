export type EnsembleLive = {
  text: string;
  status: "streaming" | "open" | "error";
  /** Real server status, when the stream sent one. Playful verbs stay a fallback. */
  note?: string;
  model?: string;
  tier?: string;
  error?: string;
  toolCalls?: Array<{ id: string; name: string; summary?: string; state?: string; input?: Record<string, unknown> }>;
};

const bus = new Map<string, EnsembleLive>();
const listeners = new Map<string, Set<() => void>>();

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
