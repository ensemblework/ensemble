"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/**
 * Names the person whose computer runs a job in a shared space ("Ben"), from the space's
 * members. Null runner means the space's owner. Never names the computer itself.
 */
export function useRunnerName(): (runnerAccountId: string | null | undefined) => string {
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const space = shell.data?.space;
  const collaborative = Boolean(space && ((space.collaborators ?? 0) > 0 || space.shared));
  const members = useQuery({
    queryKey: ["space-members", space?.id ?? ""],
    queryFn: () => api.spaceMembers(space!.id),
    enabled: collaborative,
    staleTime: 60_000,
  });
  return (runner) => {
    const owner = members.data?.owner;
    const person = runner ? members.data?.members.find((row) => row.id === runner) : owner;
    const first = person?.name.split(" ")[0];
    return first || (runner ? "Someone" : "The owner");
  };
}
