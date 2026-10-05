"use client";

import type { Settings } from "@ensemble/shared-types";
import { CompletedList } from "@/components/housekeeping/completed-list";
import { TrashList } from "@/components/housekeeping/trash-list";
import {
  DeleteDataSection,
  DeletedSection,
  FailedJobsSection,
  IdentitySection,
  MorningBriefSection,
  QuickCaptureSection,
  RemindersSection,
  RetentionSection,
  StaleSection,
  TerminalSection,
} from "@/components/settings/sections";

type Plain = Record<string, unknown>;

export function HouseSettings({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  const props = { settings, patch };
  return (
    <>
      <h2 className="page-kicker pt-2">Data & housekeeping</h2>
      <div id="retention" className="scroll-mt-6"><RetentionSection {...props} /></div>
      <div id="completed" className="scroll-mt-6"><CompletedList embedded /></div>
      <div id="trash" className="scroll-mt-6"><TrashList embedded /></div>
      <div id="brief" className="scroll-mt-6"><MorningBriefSection {...props} /></div>
      <div id="nudges" className="scroll-mt-6"><StaleSection {...props} /></div>
      <div id="capture" className="scroll-mt-6"><QuickCaptureSection /></div>
      <div id="reminders" className="scroll-mt-6"><RemindersSection {...props} /></div>
      <div id="terminal" className="scroll-mt-6"><TerminalSection {...props} /></div>
      <div id="you" className="scroll-mt-6"><IdentitySection {...props} /></div>
      <div id="danger" className="scroll-mt-6 space-y-5">
        <FailedJobsSection />
        <DeletedSection />
        <DeleteDataSection settings={settings} />
      </div>
    </>
  );
}
