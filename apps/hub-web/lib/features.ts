"use client";

import type { QueryClient } from "@tanstack/react-query";
import type { OptionalModule } from "@ensemble/shared-types/modules";
import { FEATURES } from "@ensemble/shared-types/features";
import { api } from "./api";

type ShellCache = { modules?: string | null };

export function featureCopy(id: OptionalModule) {
  if (id === "workspace") return { ...FEATURES[id], label: "Agent queue", line: "Assign and manage live work in Runs." };
  if (id === "runs") return { ...FEATURES[id], line: "Run history, steps, models and cost." };
  return FEATURES[id];
}

/** Writes the module set onto the shell cache so the sidebar updates without a reload. */
export async function setFeature(client: QueryClient, id: OptionalModule, on: boolean): Promise<string> {
  await client.cancelQueries({ queryKey: ["shell"] });
  const result = await api.setModules(id, on);
  client.setQueryData<ShellCache>(["shell"], (current) => (current ? { ...current, modules: result.modules } : current));
  void client.invalidateQueries({ queryKey: ["shell"] });
  if (id === "plots") void client.invalidateQueries({ queryKey: ["plot-workspace"] });
  return result.modules;
}
