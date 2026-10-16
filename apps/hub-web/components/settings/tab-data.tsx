"use client";

import { useClientPlatform } from "@/lib/platform";
import type { Settings } from "@ensemble/shared-types";

import Link from "next/link";
import { ArrowUpRight, Trash2 } from "lucide-react";
import { SectionCard } from "../ui";
import { SpaceExportSection } from "./space-export";
import { DeleteDataSection, FailedJobsSection, RetentionSection, TerminalSection } from "./sections";

type Plain = Record<string, unknown>;

export function DataTab({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  const props = { settings, patch };
  const { native } = useClientPlatform();
  return (
    <>
      <div id="export" className="scroll-mt-6"><SpaceExportSection /></div>
      <div id="retention" className="scroll-mt-6"><RetentionSection {...props} /></div>
      <div id="completed" className="scroll-mt-6"><SectionCard title="Completed" description="Everything finished, including older tasks hidden from the board."><Link href="/completed" target={native ? undefined : "_blank"} rel="noopener" className="btn mt-2">Open Completed <ArrowUpRight size={14} /></Link></SectionCard></div>
      <div id="deleted" className="scroll-mt-6"><span id="trash" /><SectionCard title="Trash" description="Restore deleted pages and files, or remove them permanently."><Link href="/trash" target={native ? undefined : "_blank"} rel="noopener" className="btn mt-2"><Trash2 size={14} /> Open Trash <ArrowUpRight size={14} /></Link></SectionCard></div>
      <div id="terminal" className="scroll-mt-6"><TerminalSection {...props} /></div>
      <div id="danger" className="scroll-mt-6 space-y-5">
        <div id="failed" className="scroll-mt-6"><FailedJobsSection /></div>

        <DeleteDataSection settings={settings} />
      </div>
    </>
  );
}
