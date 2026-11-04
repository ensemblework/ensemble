"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { api, withShare, type ShareKind } from "@/lib/api";
import { presenceStore, usePresence, usePresenceSession } from "@/lib/presence";

/** The item a Hub route is about, so people on the same page or diagram find each other. */
export function resourceOf(pathname: string, search: URLSearchParams | null, spaceId: string | null = null): { kind: ShareKind; id: string } | null {
  const [, first, id] = pathname.split("/");
  if (first === "pages" && id) return { kind: "page", id };
  if (first === "tasks" && id) return { kind: "task", id };
  if (first === "diagrams" && id) return { kind: "diagram", id };
  if (first === "plots" && id) return { kind: "plot_space", id };
  // The board is the space's; a shared board is named by the space id too.
  if (first === "board" && spaceId) return { kind: "board", id: spaceId };
  const peek = search?.get("peek");
  if (peek?.startsWith("task:")) return { kind: "task", id: peek.slice(5) };
  return null;
}

/**
 * Tells the others in a shared space where you are, and keeps the list of where they are.
 * Silent (no requests) in a space nobody else can open: no members, no shared items, no public
 * links and nobody arriving.
 */
export function PresenceHost() {
  const pathname = usePathname() ?? "/";
  const search = useSearchParams();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const space = shell.data?.space;
  // Someone on a public link made a moment ago is heard before the shell says the link exists.
  const arrived = usePresence().length > 0;
  const active = Boolean(space && ((space.collaborators ?? 0) > 0 || (space.publicLinks ?? 0) > 0 || space.shared || arrived));
  const spaceId = space?.id ?? null;
  const route = `${pathname}${search?.toString() ? `?${search.toString()}` : ""}`;

  useEffect(() => {
    presenceStore.setMe(shell.data?.user.id ?? null);
  }, [shell.data?.user.id]);

  usePresenceSession({
    active,
    room: spaceId,
    place: route,
    where: () => ({ route, resource: resourceOf(pathname, search, spaceId) }),
    // Never under a share header: a shared item may be mounting as this unmounts.
    scope: (fn) => withShare(null, fn),
  });

  return null;
}
