"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { api, type PreferenceRecord } from "./api";

export type Preferences = { preferences: PreferenceRecord[] };

/** The preference list with `key` set to `value`, or without it when `value` is null. */
export function withPreference(data: Preferences | undefined, key: string, value: unknown, saved?: PreferenceRecord): Preferences {
  const rows = data?.preferences ?? [];
  const old = rows.find((row) => row.key === key);
  const rest = rows.filter((row) => row.key !== key);
  if (value === null) return { preferences: rest };
  const row: PreferenceRecord = saved ?? { id: old?.id ?? `pending-${key}`, key, value, source: "me", confidence: 1, evidence: old?.evidence ?? [] };
  return { preferences: [...rest, { ...row, value }] };
}

/**
 * Writes one preference the way a layout needs: drawn at once, sent in order (`api.putPreference`
 * queues writes to one key), and put back if the save fails. A failed save still throws.
 */
export async function writePreference(client: QueryClient, key: string, value: unknown, isLatest: () => boolean): Promise<void> {
  const before = client.getQueryData<Preferences>(["preferences"]);
  // Drawn now, so a quick second edit starts from this one. A list read already on its way would land
  // after it and draw the older layout again: cancelling puts back the latest data set here, not the old copy.
  client.setQueryData<Preferences>(["preferences"], (old) => withPreference(old, key, value));
  void client.cancelQueries({ queryKey: ["preferences"] });
  try {
    if (value === null) await api.deletePreference(key);
    else {
      const { preference } = await api.putPreference(key, value);
      if (isLatest()) client.setQueryData<Preferences>(["preferences"], (old) => withPreference(old, key, preference.value, preference));
    }
  } catch (error) {
    if (isLatest()) {
      if (before) client.setQueryData(["preferences"], before);
      void client.invalidateQueries({ queryKey: ["preferences"] });
    }
    throw error;
  }
}

/** `writePreference` for one key from a component. Only the newest write reconciles or rolls back the list. */
export function usePreferenceWrite(key: string) {
  const client = useQueryClient();
  const latest = useRef(0);
  return useCallback((value: unknown) => {
    const ticket = ++latest.current;
    return writePreference(client, key, value, () => ticket === latest.current);
  }, [client, key]);
}
