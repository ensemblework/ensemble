"use client";

import type { Settings } from "@ensemble/shared-types";
import { useSpaceAccess } from "@/lib/access";
import { RunProfilesSection } from "./run-profiles";
import { AgentSessionsSection, AutonomySection, SandboxSection, TaskLimitsSection, TerminalSection } from "./sections";

type Plain = Record<string, unknown>;

/** Settings › Agents: how delegated tasks run, from autonomy to the folders and git of the Code tab. */
export function AgentsTab({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  const props = { settings, patch };
  // Code folders and the terminal belong to the space's owner.
  const guest = useSpaceAccess().guest;
  return (
    <>
      <div id="autonomy" className="scroll-mt-6"><AutonomySection {...props} /></div>
      <div id="run-profiles" className="scroll-mt-6 empty:hidden"><RunProfilesSection {...props} /></div>
      <div id="orchestration" className="scroll-mt-6 space-y-5">
        <TaskLimitsSection {...props} />
        <SandboxSection {...props} />
        <AgentSessionsSection {...props} />
      </div>
      {guest ? null : <div id="terminal" className="scroll-mt-6 empty:hidden"><TerminalSection {...props} /></div>}
    </>
  );
}
