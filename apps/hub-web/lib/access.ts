"use client";

import { useQuery } from "@tanstack/react-query";
import { api, inItemView } from "./api";

/**
 * What you may do in the open space. In your own space: everything. In a space shared with
 * you: viewers read, editors write, and the owner's private surfaces are not there.
 */
export function useSpaceAccess(): { ready: boolean; guest: boolean; canEdit: boolean; owner: string | null; role: "owner" | "viewer" | "editor" } {
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000, enabled: !inItemView() });
  const shared = shell.data?.space?.shared ?? null;
  return {
    /** False until the shell says whose space this is. */
    ready: Boolean(shell.data),
    guest: Boolean(shared),
    canEdit: shared?.role !== "viewer",
    owner: shared?.owner.name ?? null,
    role: shared ? shared.role : "owner",
  };
}
