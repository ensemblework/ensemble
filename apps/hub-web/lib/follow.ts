"use client";

import { useSyncExternalStore } from "react";

/**
 * Follow mode: one click to go wherever someone else in the shared space is, and keep going
 * with them (their route, and on a diagram their view) until you stop or move yourself.
 */
type FollowState = { accountId: string; name: string; color: string } | null;

let state: FollowState = null;
const listeners = new Set<() => void>();

export const followStore = {
  start(person: NonNullable<FollowState>): void {
    state = person;
    for (const listener of listeners) listener();
  },
  stop(): void {
    if (!state) return;
    state = null;
    for (const listener of listeners) listener();
  },
  get(): FollowState {
    return state;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useFollowing(): FollowState {
  return useSyncExternalStore(followStore.subscribe, followStore.get, () => null);
}
