"use client";

import type { QueryClient } from "@tanstack/react-query";
import { isWidgetId, type WidgetId } from "@ensemble/shared-types/widgets";
import { api, type PreferenceRecord } from "./api";

export const DESK_ADDED_KEY = "desk.added";

type Prefs = { preferences: PreferenceRecord[] };

export function readAdded(preferences: Array<{ key: string; value: unknown }> | undefined): WidgetId[] {
  const row = preferences?.find((item) => item.key === DESK_ADDED_KEY);
  if (!Array.isArray(row?.value)) return [];
  return row.value.filter((item): item is WidgetId => typeof item === "string" && isWidgetId(item));
}

function mergePreference(current: Prefs | undefined, preference: PreferenceRecord): Prefs {
  const list = current?.preferences ?? [];
  return { preferences: [...list.filter((item) => item.key !== preference.key), preference] };
}

async function writeAdded(client: QueryClient, ids: WidgetId[]): Promise<void> {
  const saved = await api.putPreference(DESK_ADDED_KEY, ids);
  client.setQueryData<Prefs>(["preferences"], (current) => mergePreference(current, saved.preference));
}

export async function appendDeskTile(client: QueryClient, id: WidgetId): Promise<void> {
  const current = client.getQueryData<Prefs>(["preferences"]) ?? (await api.preferences());
  const ids = readAdded(current.preferences);
  if (!ids.includes(id)) ids.push(id);
  if (!client.getQueryData(["preferences"])) client.setQueryData(["preferences"], current);
  await writeAdded(client, ids);
}

export async function removeDeskTile(client: QueryClient, id: WidgetId): Promise<void> {
  const current = client.getQueryData<Prefs>(["preferences"]) ?? (await api.preferences());
  const ids = readAdded(current.preferences).filter((item) => item !== id);
  if (!client.getQueryData(["preferences"])) client.setQueryData(["preferences"], current);
  await writeAdded(client, ids);
}
