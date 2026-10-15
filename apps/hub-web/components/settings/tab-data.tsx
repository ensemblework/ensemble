"use client";

import type { Settings } from "@ensemble/shared-types";
import { CompletedList } from "@/components/housekeeping/completed-list";
import Link from "next/link";
import { ArrowUpRight, Trash2 } from "lucide-react";
import { SectionCard } from "../ui";
import { SpaceExportSection } from "./space-export";
import { DeleteDataSection, DeletedSection, FailedJobsSection, RetentionSection, TerminalSection } from "./sections";

type Plain = Record<string, unknown>;

export function DataTab({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  const props = { settings, patch };
  return (
    <>
      <div id="export" className="scroll-mt-6"><SpaceExportSection /></div>
      <div id="retention" className="scroll-mt-6"><RetentionSection {...props} /></div>
      <div id="completed" className="scroll-mt-6"><CompletedList embedded /></div>
      <div id="trash" className="scroll-mt-6"><SectionCard title="Trash" description="Restore deleted pages and files, or remove them permanently."><Link href="/trash" className="btn mt-2"><Trash2 size={14} /> Open Trash <ArrowUpRight size={14} /></Link></SectionCard></div>
      <div id="terminal" className="scroll-mt-6"><TerminalSection {...props} /></div>
      <div id="danger" className="scroll-mt-6 space-y-5">
        <div id="failed" className="scroll-mt-6"><FailedJobsSection /></div>
        <div id="deleted" className="scroll-mt-6"><DeletedSection /></div>
        <DeleteDataSection settings={settings} />
      </div>
    </>
  );
}
