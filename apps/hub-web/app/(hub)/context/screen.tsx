"use client";

import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { ContextDesk } from "@/components/context/desk";
import { ContextLens } from "@/components/desk/context-lens";
import { deskIdFromTemplate } from "@/components/desk/desks";
import { api, type BoardPayload } from "@/lib/api";
import type { LayoutPayload } from "@/lib/server-layout";

const WidgetLayout = dynamic(() => import("./widgets-screen").then((mod) => mod.WidgetLayout));
const Utility = dynamic(() => import("./widgets-screen").then((mod) => mod.Utility));

export function ContextScreen({ initialLayout, initialBoard }: { initialLayout: LayoutPayload | null; initialBoard: BoardPayload | null }) {
  const params = useSearchParams();
  const requested = params.get("tab");
  const view = params.get("view");
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences, staleTime: 15_000 });
  if (view === "widgets") return <WidgetLayout initialLayout={initialLayout} />;
  // board, grid, list, and graph force that view. desk opens the old surface and keeps the saved view.
  if (view === "board" || view === "grid" || view === "list" || view === "graph" || view === "desk") return <ContextDesk initial={initialBoard} />;
  if (requested === "preferences" || requested === "sources") return <Utility tab={requested} />;
  const deskId = deskIdFromTemplate(shell.data?.activeTemplateId);
  const sample = prefs.data?.preferences.some((row) => row.key === "desk.sample" && row.value === true) === true;
  if (!requested && deskId) {
    return <ContextLens deskId={deskId} state={sample ? "populated" : "empty"} />;
  }
  return <ContextDesk initial={initialBoard} />;
}
