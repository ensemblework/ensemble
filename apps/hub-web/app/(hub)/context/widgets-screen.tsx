"use client";

import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Tabs } from "@/components/ui";
import { WidgetShell } from "@/components/widgets/shell";
import { defaultLayout } from "@ensemble/shared-types/widgets";
import type { LayoutPayload } from "@/lib/server-layout";

const PeopleTab = dynamic(() => import("@/components/context/people").then((mod) => mod.PeopleTab));
const ProjectsTab = dynamic(() => import("@/components/context/projects").then((mod) => mod.ProjectsTab));
const ReposTab = dynamic(() => import("@/components/context/repos-prefs").then((mod) => mod.ReposTab));
const PreferencesTab = dynamic(() => import("@/components/context/repos-prefs").then((mod) => mod.PreferencesTab));
const SourcesTab = dynamic(() => import("@/components/context/sources").then((mod) => mod.SourcesTab));
const ArtifactsTab = dynamic(() => import("@/components/context/artifacts").then((mod) => mod.ArtifactsTab));
const GraphTab = dynamic(() => import("@/components/context/graph").then((mod) => mod.GraphTab), {
  loading: () => <div className="skeleton h-[420px] w-full" />,
});

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "people", label: "People" },
  { id: "projects", label: "Projects" },
  { id: "repos", label: "Repos" },
  { id: "preferences", label: "Preferences" },
  { id: "sources", label: "Sources" },
  { id: "artifacts", label: "Artifacts & sync" },
  { id: "graph", label: "Graph" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function Utility({ tab }: { tab: "preferences" | "sources" }) {
  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-24 pt-8 sm:px-10">
      <a href="/context" className="text-[13px] text-accent hover:underline">
        Back to Context
      </a>
      <div className="mt-4">{tab === "preferences" ? <PreferencesTab /> : <SourcesTab />}</div>
    </div>
  );
}

export function WidgetLayout({ initialLayout }: { initialLayout: LayoutPayload | null }) {
  const [Canvas, setCanvas] = useState<ComponentType<{ initialLayout: LayoutPayload | null; belowHeader?: ReactNode; panelId?: string }> | null>(null);
  useEffect(() => {
    let live = true;
    void import("@/components/widgets/context-canvas").then((mod) => {
      if (live) setCanvas(() => mod.ContextCanvas);
    });
    return () => {
      live = false;
    };
  }, []);
  const params = useSearchParams();
  const router = useRouter();
  const requested = params.get("tab");
  const overview = !requested || requested === "overview";
  const tab = (TABS.find((row) => row.id === requested)?.id ?? "overview") as TabId;
  const search = params.get("search") ?? "";
  const who = params.get("who") ?? "";
  const ids = params.get("ids") ?? "";
  const wide = tab === "graph";
  const tabs = (
    <div className="sticky top-0 z-20 -mx-4 mb-3 bg-bg/90 px-4 py-2 backdrop-blur-md sm:-mx-10 sm:px-10">
      <Tabs
        label="Context sections"
        panelId="context-panel"
        tabs={[...TABS]}
        value={overview ? "overview" : tab}
        onChange={(value) => router.replace(value === "overview" ? "/context?view=widgets" : `/context?view=widgets&tab=${value}`, { scroll: false })}
      />
    </div>
  );
  if (overview) {
    return Canvas ? (
      <Canvas initialLayout={initialLayout} belowHeader={tabs} panelId="context-panel" />
    ) : (
      <div className="mx-auto min-w-0 max-w-[1180px] px-4 pb-24 pt-8 sm:px-10">
        <div className="mb-3 flex items-end justify-between gap-3">
          <h1 className="display mt-1 text-[32px] leading-none">Context</h1>
          <button type="button" className="btn" disabled>
            Edit layout
          </button>
        </div>
        {tabs}
        <div id="context-panel" role="tabpanel" aria-label="Overview"><WidgetShell document={initialLayout?.document ?? defaultLayout("context")} /></div>
      </div>
    );
  }
  return (
    <div className={wide ? "min-w-0 px-4 pb-16 pt-6 sm:px-8" : "mx-auto max-w-[1180px] px-4 pb-24 pt-6 sm:px-10"}>
      {tabs}
      <div id="context-panel" role="tabpanel" aria-label={TABS.find((item) => item.id === tab)?.label} tabIndex={0}>
      {tab === "people" ? <PeopleTab key={`${search}|${who}`} initialSearch={search} who={who} /> : null}
      {tab === "projects" ? <ProjectsTab key={ids} ids={ids} /> : null}
      {tab === "repos" ? <ReposTab /> : null}
      {tab === "preferences" ? <PreferencesTab /> : null}
      {tab === "sources" ? <SourcesTab /> : null}
      {tab === "artifacts" ? <ArtifactsTab /> : null}
      {tab === "graph" ? <GraphTab /> : null}
      </div>
    </div>
  );
}
