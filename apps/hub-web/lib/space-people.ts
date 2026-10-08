"use client";

import { useQuery } from "@tanstack/react-query";
import { api, inItemView } from "./api";
import { personInitials } from "./initials";

export type SpacePerson = { id: string; name: string; initials: string; avatar: string | null };

/**
 * Everyone in the open space (its owner and members), and who you are. In a space nobody else
 * is in, just you. Used to show who a task is with: "Me" for you, initials for anyone else.
 */
export function useSpacePeople(): { me: string | null; ownerId: string | null; shared: boolean; people: SpacePerson[]; byId: Map<string, SpacePerson> } {
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000, enabled: !inItemView() });
  const space = shell.data?.space;
  const shared = Boolean(space && ((space.members ?? 0) > 0 || space.shared));
  const members = useQuery({
    queryKey: ["space-members", space?.id ?? ""],
    queryFn: () => api.spaceMembers(space!.id),
    enabled: shared && !inItemView(),
    staleTime: 60_000,
  });
  const me = shell.data?.user.id ?? null;
  const people: SpacePerson[] = [];
  if (members.data) {
    const owner = members.data.owner;
    people.push({ id: owner.id, name: owner.name, initials: personInitials(owner.name), avatar: owner.avatar ?? null });
    for (const row of members.data.members) people.push({ id: row.id, name: row.name, initials: personInitials(row.name), avatar: row.avatar ?? null });
  } else if (shell.data) {
    people.push({ id: shell.data.user.id, name: shell.data.user.name, initials: personInitials(shell.data.user.name, shell.data.user.email), avatar: shell.data.user.avatar ?? null });
  }
  const ownerId = members.data?.owner.id ?? (space?.shared ? space.shared.owner.id : me);
  return { me, ownerId, shared, people, byId: new Map(people.map((row) => [row.id, row])) };
}

/** Who a "me" task is with: its assignee, or the space's owner. */
export function taskPersonId(task: { owner: string; assigneeAccountId?: string | null }, ownerId: string | null): string | null {
  if (task.owner !== "me") return null;
  return task.assigneeAccountId ?? ownerId;
}
