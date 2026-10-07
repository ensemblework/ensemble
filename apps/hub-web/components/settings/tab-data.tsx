"use client";

import type { Settings } from "@ensemble/shared-types";
import { CompletedList } from "@/components/housekeeping/completed-list";
import { TrashList } from "@/components/housekeeping/trash-list";
import { DeleteDataSection, DeletedSection, FailedJobsSection, RetentionSection, TerminalSection } from "./sections";

type Plain = Record<string, unknown>;

export function DataTab({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  const props = { settings, patch };
  return (
    <>
      <div id="retention" className="scroll-mt-6"><RetentionSection {...props} /></div>
      <div id="completed" className="scroll-mt-6"><CompletedList embedded /></div>
      <div id="trash" className="scroll-mt-6"><TrashList embedded /></div>
      <div id="terminal" className="scroll-mt-6"><TerminalSection {...props} /></div>
      <div id="danger" className="scroll-mt-6 space-y-5">
        <div id="failed" className="scroll-mt-6"><FailedJobsSection /></div>
        <div id="deleted" className="scroll-mt-6"><DeletedSection /></div>
        <DeleteDataSection settings={settings} />
      </div>
    </>
  );
}
