"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { WIDGET_REGISTRY, type Placement, type Size, type WidgetId } from "@ensemble/shared-types/widgets";
import type { LayoutPayload } from "@/lib/server-layout";
import { ArtifactsGlance, GraphGlance, MeetingsGlance, PeopleGlance, RecentLinks, ReposGlance } from "./glances";
import { WidgetCanvas } from "./canvas";

const LensTile = dynamic(() => import("./lenses").then((mod) => mod.LensTile), { ssr: false });

function renderWidget(type: WidgetId, size: Size, placement?: Placement) {
  if (type === "people") return <PeopleGlance size={size} />;
  if (type === "meetings") return <MeetingsGlance size={size} />;
  if (type === "repos") return <ReposGlance size={size} />;
  if (type === "artifacts") return <ArtifactsGlance size={size} />;
  if (type === "graph") return <GraphGlance size={size} />;
  if (type === "recent-links") return <RecentLinks size={size} />;
  if (WIDGET_REGISTRY[type].blurb) return <LensTile type={type} config={placement?.config} />;
  return null;
}

export function ContextCanvas({ initialLayout = null, belowHeader }: { initialLayout?: LayoutPayload | null; belowHeader?: ReactNode }) {
  return <WidgetCanvas surface="context" title="Context" initialLayout={initialLayout} belowHeader={belowHeader} render={renderWidget} />;
}
