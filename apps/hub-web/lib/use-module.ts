"use client";

import { useQuery } from "@tanstack/react-query";
import { hasModule, type OptionalModule } from "@ensemble/shared-types/modules";
import { api, inItemView } from "./api";

/** True, false, or null while the shell is still loading. */
export function useModuleState(id: OptionalModule): boolean | null {
  // A shared item or public link has no shell to ask; modules stay unknown there.
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000, enabled: !inItemView() });
  if (!shell.data || inItemView()) return null;
  return hasModule(shell.data.modules, id);
}

/**
 * True when this account has the optional module on. False until the shell
 * loads, so a gated control never fires a request the API would refuse.
 */
export function useModuleOn(id: OptionalModule): boolean {
  return useModuleState(id) === true;
}
