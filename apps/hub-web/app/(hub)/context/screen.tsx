"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { ContextDesk } from "@/components/context/desk";
import { ContextRouteSkeleton } from "@/components/motion/skeletons";
import { ContextLens } from "@/components/desk/context-lens";
import { contextTabs, tabKey } from "@/components/desk/context-tabs";
import { deskIdFromTemplate } from "@/components/desk/desks";
import { api, type BoardPayload } from "@/lib/api";
import { cleanContextHref } from "@/lib/context-href";

const noSubscribe = () => () => undefined;
const PERSON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** False on the server and while hydrating, true after. */
function useHydrated(): boolean {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

export function ContextScreen({ initialBoard }: { initialBoard: BoardPayload | null }) {
  const params = useSearchParams();
  const requested = params.get("tab");
  const view = params.get("view");
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences, staleTime: 15_000 });
  const router = useRouter();
  const hydrated = useHydrated();
  // An old link to the widgets view or one of its tabs lands on Context itself (the server does it on the web).
  const moved = cleanContextHref(new URLSearchParams(params.toString()));
  useEffect(() => {
    if (moved) router.replace(moved, { scroll: false });
  }, [moved, router]);
  // A link to someone (`?tab=people&person=<id>`, the context graph's path for a person) opens them in the side peek.
  const person = params.get("person");
  useEffect(() => {
    if (!person || !PERSON_ID.test(person)) return;
    const next = new URLSearchParams(params.toString());
    next.delete("person");
    next.set("peek", person);
    next.set("kind", "person");
    router.replace(`/context?${next.toString()}`, { scroll: false });
  }, [person, params, router]);
  if (moved) return null;
  // board, grid, list, and graph force that view. desk opens the old surface and keeps the saved view.
  if (view === "board" || view === "grid" || view === "list" || view === "graph" || view === "desk") return <ContextDesk initial={initialBoard} />;
  // The template picks the lens or the desk, and a preference picks the lens's sample state.
  // Before they load, any choice is a guess that flashes the wrong layout on a cold load.
  // The server always renders the skeleton here. This boundary can hydrate after the shell
  // query has answered (the page streams in behind the layout), so hydrate the skeleton too.
  if (!hydrated || shell.isPending) return <ContextRouteSkeleton />;
  const deskId = deskIdFromTemplate(shell.data?.activeTemplateId) ?? "default";
  if (deskId && prefs.isPending) return <ContextRouteSkeleton />;
  const sample = prefs.data?.preferences.some((row) => row.key === "desk.sample" && row.value === true) === true;
  if (deskId) {
    return <ContextLens deskId={deskId} state={sample ? "populated" : "empty"} initialTab={requested} search={params.get("search") ?? ""} who={params.get("who") ?? ""} ids={params.get("ids") ?? ""} />;
  }
  return <ContextDesk initial={initialBoard} />;
}
