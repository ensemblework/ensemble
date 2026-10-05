"use client";

import type { Settings } from "@ensemble/shared-types";
import dynamic from "next/dynamic";
import { useEffect } from "react";

const AgentSettings = dynamic(() => import("@/components/settings/below-agent").then((mod) => mod.AgentSettings), { ssr: false });
const ConnectionSettings = dynamic(() => import("@/components/settings/below-connections").then((mod) => mod.ConnectionSettings), { ssr: false });
const HouseSettings = dynamic(() => import("@/components/settings/below-house").then((mod) => mod.HouseSettings), { ssr: false });

type Plain = Record<string, unknown>;

/** The rest of Settings, still split so the first paint does not compile all of it. Chunks mount immediately. */
export function SettingsBelow({ settings, patch, focus }: { settings: Settings; patch: (value: Plain) => void; focus: string }) {
  useEffect(() => {
    if (!focus) return;
    const timer = window.setTimeout(() => document.getElementById(focus)?.scrollIntoView({ block: "start" }), 80);
    return () => window.clearTimeout(timer);
  }, [focus]);

  return (
    <>
      <AgentSettings settings={settings} patch={patch} />
      <ConnectionSettings settings={settings} patch={patch} />
      <HouseSettings settings={settings} patch={patch} />
    </>
  );
}
