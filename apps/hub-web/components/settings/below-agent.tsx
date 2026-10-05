"use client";

import type { Settings } from "@ensemble/shared-types";
import {
  AssistantSection,
  AutonomySection,
  FetchSection,
  OrchestrationSection,
  PromptsSection,
  QuietHoursSection,
} from "@/components/settings/sections";
import { DevicesSection } from "@/components/settings/devices";
import { RemoteMacSection } from "@/components/settings/remote-mac";
import { EditorsSection, ModelsSection } from "@/components/settings/setup";

type Plain = Record<string, unknown>;

export function AgentSettings({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  const props = { settings, patch };
  return (
    <>
      <div id="this-mac" className="scroll-mt-6"><RemoteMacSection /></div>
      <h2 className="page-kicker pt-2">The agent</h2>
      <div id="autonomy" className="scroll-mt-6"><AutonomySection {...props} /></div>
      <div id="orchestration" className="scroll-mt-6"><OrchestrationSection {...props} /></div>
      <div id="prompts" className="scroll-mt-6"><PromptsSection /></div>
      <div id="models" className="scroll-mt-6"><ModelsSection {...props} /></div>
      <div id="assistant" className="scroll-mt-6"><AssistantSection {...props} /></div>
      <div id="fetch" className="scroll-mt-6"><FetchSection {...props} /></div>
      <div id="quiet" className="scroll-mt-6"><QuietHoursSection {...props} /></div>
      <div id="editors" className="scroll-mt-6"><EditorsSection /></div>
      <div id="devices" className="scroll-mt-6"><DevicesSection /></div>
    </>
  );
}
