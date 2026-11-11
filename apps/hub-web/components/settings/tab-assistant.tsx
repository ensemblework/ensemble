"use client";

import type { Settings } from "@ensemble/shared-types";
import { AssistantSection, WatchersSection } from "./assistant";
import { ModelsSection } from "./models";
import { AutomationsSection } from "./automations";
import { PromptsSection } from "./sections";

type Plain = Record<string, unknown>;

/** Settings › Assistant: what it may do, the models behind it, and the work it does on its own. */
export function AssistantTab({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  const props = { settings, patch };
  return (
    <>
      <div id="assistant" className="scroll-mt-6"><AssistantSection {...props} /></div>
      <div id="models" className="scroll-mt-6"><ModelsSection {...props} /></div>
      <div id="automations" className="scroll-mt-6"><AutomationsSection {...props} /></div>
      <WatchersSection />
      <div id="prompts" className="scroll-mt-6"><PromptsSection /></div>
    </>
  );
}
