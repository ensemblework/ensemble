"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { SHORTCUTS, applyShortcutOverrides, type ShortcutBinding, type ShortcutOverrides } from "@ensemble/shared-types";
import { api } from "./api";

/** Preference key for a person's chords. UI state, so it is hidden from the Preferences list the agent learns from. */
export const SHORTCUTS_PREFERENCE = "ui.shortcuts";

let current: readonly ShortcutBinding[] = SHORTCUTS;
const listeners = new Set<() => void>();

/** Bindings in effect now. Key listeners read this so they never close over stale React state. */
export function activeShortcuts(): readonly ShortcutBinding[] {
  return current;
}

export function setShortcutOverrides(overrides: unknown): void {
  current = applyShortcutOverrides(overrides);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readOverrides(preferences: Array<{ key: string; value: unknown }> | undefined): ShortcutOverrides {
  const value = preferences?.find((row) => row.key === SHORTCUTS_PREFERENCE)?.value;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ShortcutOverrides) : {};
}

/** Loads the person's chords into the shared store and re-renders when they change. */
export function useShortcuts(): { bindings: readonly ShortcutBinding[]; overrides: ShortcutOverrides } {
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences, staleTime: 60_000 });
  const overrides = useMemo(() => readOverrides(prefs.data?.preferences), [prefs.data]);
  const key = JSON.stringify(overrides);
  useEffect(() => setShortcutOverrides(overrides), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const bindings = useSyncExternalStore(subscribe, activeShortcuts, () => SHORTCUTS);
  return { bindings, overrides };
}
