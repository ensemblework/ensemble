"use client";

import type { Settings } from "@ensemble/shared-types";
import { MorningBriefSection, QuickCaptureSection, RemindersSection, StaleSection } from "./sections";

type Plain = Record<string, unknown>;

export function NotificationsTab({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  const props = { settings, patch };
  return (
    <>
      <div id="brief" className="scroll-mt-6"><MorningBriefSection {...props} /></div>
      <div id="nudges" className="scroll-mt-6"><StaleSection {...props} /></div>
      <div id="reminders" className="scroll-mt-6"><RemindersSection {...props} /></div>
      <div id="capture" className="scroll-mt-6"><QuickCaptureSection /></div>
    </>
  );
}
