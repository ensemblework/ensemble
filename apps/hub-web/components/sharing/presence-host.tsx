"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { api, withShare, type ShareKind } from "@/lib/api";
import { presenceStore, tabId } from "@/lib/presence";

const HEARTBEAT_MS = 15_000;

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
 * Silent (no requests) in a space nobody else can open.
 */
export function PresenceHost() {
  const pathname = usePathname() ?? "/";
  const search = useSearchParams();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const space = shell.data?.space;
  const active = Boolean(space && ((space.collaborators ?? 0) > 0 || space.shared));
  const spaceId = space?.id ?? null;
  const route = `${pathname}${search?.toString() ? `?${search.toString()}` : ""}`;
  const last = useRef<string>("");

  useEffect(() => {
    presenceStore.setMe(shell.data?.user.id ?? null);
  }, [shell.data?.user.id]);

  // Joining: who is already here.
  useEffect(() => {
    if (!active || !spaceId) {
      presenceStore.clear();
      return;
    }
    let live = true;
    void api
      .presence()
      .then((data) => {
        if (live) presenceStore.reset(data.people, data.you);
      })
      .catch(() => undefined);
    const sweep = window.setInterval(() => presenceStore.sweep(), 10_000);
    return () => {
      live = false;
      window.clearInterval(sweep);
    };
  }, [active, spaceId]);

  // Where you are now, then a heartbeat while the tab is visible.
  useEffect(() => {
    if (!active) return;
    const send = () => {
      if (document.visibilityState === "hidden") return;
      void api.sendPresence({ tabId: tabId(), route, resource: resourceOf(pathname, search, spaceId) }).catch(() => undefined);
    };
    if (last.current !== route) {
      last.current = route;
      send();
    }
    const beat = window.setInterval(send, HEARTBEAT_MS);
    const onVisible = () => document.visibilityState === "visible" && send();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(beat);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, route, pathname, search, spaceId]);

  // Leaving: the others see you go at once instead of after the timeout.
  useEffect(() => {
    if (!active) return;
    // Never under a share header: a shared item may be mounting as this unmounts.
    const leave = () => void withShare(null, () => api.sendPresence({ tabId: tabId(), leave: true }, true)).catch(() => undefined);
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [active, spaceId]);

  return null;
}
