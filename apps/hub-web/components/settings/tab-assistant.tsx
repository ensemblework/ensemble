"use client";

import type { Settings } from "@ensemble/shared-types";
import { AssistantSection, WatchersSection } from "./assistant";
import { ModelsSection } from "./models";
import { AutonomySection, OrchestrationSection, PromptsSection, QuietHoursSection } from "./sections";

type Plain = Record<string, unknown>;

export function AssistantTab({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  const props = { settings, patch };
  return (
    <>
      <div id="assistant" className="scroll-mt-6"><AssistantSection {...props} /></div>
      <div id="models" className="scroll-mt-6"><ModelsSection {...props} /></div>
      <WatchersSection />
      <div id="autonomy" className="scroll-mt-6"><AutonomySection {...props} /></div>
      <div id="orchestration" className="scroll-mt-6"><OrchestrationSection {...props} /></div>
      <div id="quiet" className="scroll-mt-6"><QuietHoursSection {...props} /></div>
      <div id="prompts" className="scroll-mt-6"><PromptsSection /></div>
    </>
  );
}
