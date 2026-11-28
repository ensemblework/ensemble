"use client";

import type { QueryClient } from "@tanstack/react-query";
import type { OptionalModule } from "@ensemble/shared-types/modules";
import { FEATURES } from "@ensemble/shared-types/features";
import { api } from "./api";

type ShellCache = { modules?: string | null };

export function featureCopy(id: OptionalModule) {
  if (id === "workspace") return { ...FEATURES[id], label: "Agent queue", line: "Assign and manage live work in Runs." };
  if (id === "runs") return { ...FEATURES[id], line: "The agent queue and run history." };
  return FEATURES[id];
}

/**
 * Writes the module set onto the shell cache so the sidebar updates without a reload. Runs is one
 * switch for the Runs page: it turns the agent queue (`workspace`) on or off with the run history.
 */
export async function setFeature(client: QueryClient, id: OptionalModule, on: boolean): Promise<string> {
  await client.cancelQueries({ queryKey: ["shell"] });
  try {
    let result = await api.setModules(id, on);
    if (id === "runs") result = await api.setModules("workspace", on);
    client.setQueryData<ShellCache>(["shell"], (current) => (current ? { ...current, modules: result.modules } : current));
    if (id === "plots") void client.invalidateQueries({ queryKey: ["plot-workspace"] });
    return result.modules;
  } finally {
    // Also after a failed second write: the first one may have changed the modules.
    void client.invalidateQueries({ queryKey: ["shell"] });
  }
}
