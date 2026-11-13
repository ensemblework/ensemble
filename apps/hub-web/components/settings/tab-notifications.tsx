"use client";

import type { Settings } from "@ensemble/shared-types";
import { NudgesSection, QuickCaptureSection, QuietHoursSection, RemindersSection, RoutinesSection } from "./sections";

type Plain = Record<string, unknown>;

/** Settings › Notifications: where notices show, when they wait, and what sends them. */
export function NotificationsTab({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  const props = { settings, patch };
  return (
    <>
      <div id="reminders" className="scroll-mt-6"><RemindersSection {...props} /></div>
      <div id="quiet" className="scroll-mt-6"><QuietHoursSection {...props} /></div>
      <div id="nudges" className="scroll-mt-6"><NudgesSection {...props} /></div>
      <div id="routines" className="scroll-mt-6"><RoutinesSection {...props} /></div>
      <div id="capture" className="scroll-mt-6"><QuickCaptureSection /></div>
    </>
  );
}
