"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
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

/** Writes to one key: the newest, how many are under way, and the row the Hub last confirmed (absent: none). */
type Writes = { latest: number; pending: number; confirmed: { row?: PreferenceRecord } | null };
const writesByClient = new WeakMap<QueryClient, Map<string, Writes>>();

function writesFor(client: QueryClient, key: string): Writes {
  let byKey = writesByClient.get(client);
  if (!byKey) writesByClient.set(client, (byKey = new Map()));
  let writes = byKey.get(key);
  if (!writes) byKey.set(key, (writes = { latest: 0, pending: 0, confirmed: null }));
  return writes;
}

/**
 * Writes one preference the way a layout needs: drawn at once, sent in order (`api.putPreference`
 * queues writes to one key), and, if the newest write fails, put back to what the Hub last saved,
 * never to an earlier edit that is still unsaved. A failed save still throws.
 */
export async function writePreference(client: QueryClient, key: string, value: unknown): Promise<void> {
  const writes = writesFor(client, key);
  const ticket = ++writes.latest;
  if (writes.pending++ === 0) writes.confirmed = { row: client.getQueryData<Preferences>(["preferences"])?.preferences.find((row) => row.key === key) };
  // Drawn now, so a quick second edit starts from this one. A list read already on its way would land
  // after it and draw the older layout again: cancelling puts back the latest data set here, not the old copy.
  client.setQueryData<Preferences>(["preferences"], (old) => withPreference(old, key, value));
  void client.cancelQueries({ queryKey: ["preferences"] });
  try {
    if (value === null) {
      await api.deletePreference(key);
      writes.confirmed = { row: undefined };
    } else {
      const { preference } = await api.putPreference(key, value);
      writes.confirmed = { row: preference };
      if (ticket === writes.latest) client.setQueryData<Preferences>(["preferences"], (old) => withPreference(old, key, preference.value, preference));
    }
  } catch (error) {
    const row = writes.confirmed?.row;
    if (ticket === writes.latest && writes.confirmed) client.setQueryData<Preferences>(["preferences"], (old) => withPreference(old, key, row ? row.value : null, row));
    throw error;
  } finally {
    if (--writes.pending === 0) writes.confirmed = null;
  }
}

/** `writePreference` for one key from a component. */
export function usePreferenceWrite(key: string) {
  const client = useQueryClient();
  return useCallback((value: unknown) => writePreference(client, key, value), [client, key]);
}
