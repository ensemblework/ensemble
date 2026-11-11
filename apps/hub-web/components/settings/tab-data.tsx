"use client";

import { useClientPlatform } from "@/lib/platform";
import type { Settings } from "@ensemble/shared-types";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SectionCard, SettingRow } from "../ui";
import { SpaceExportSection } from "./space-export";
import { DeleteAccountSection } from "./account";
import { DeleteDataSection, RetentionSection } from "./sections";

type Plain = Record<string, unknown>;

/** Settings › Data: take it with you, how long it is kept, where finished and deleted work is, and the danger zone. */
export function DataTab({ settings, patch }: { settings: Settings; patch: (value: Plain) => void }) {
  const props = { settings, patch };
  const { native } = useClientPlatform();
  const open = (href: string, label: string) => (
    <Link href={href} target={native ? undefined : "_blank"} rel="noopener" className="btn">
      {label} <ArrowUpRight size={14} />
    </Link>
  );
  return (
    <>
      <div id="export" className="scroll-mt-6"><SpaceExportSection /></div>
      <div id="retention" className="scroll-mt-6"><RetentionSection {...props} /></div>
      <div id="completed" className="scroll-mt-6">
        <span id="trash" className="block scroll-mt-6" aria-hidden />
        <span id="deleted" className="block scroll-mt-6" aria-hidden />
        <SectionCard title="Completed and Trash" description="Finished work and deleted items, each on a page of its own.">
          <div className="divide-y divide-[var(--line)]">
            <SettingRow title="Completed" description="Everything finished, including older tasks hidden from the board.">
              {open("/completed", "Open Completed")}
            </SettingRow>
            <SettingRow title="Trash" description="Restore or empty deleted pages, files, tasks and comments.">
              {open("/trash", "Open Trash")}
            </SettingRow>
          </div>
        </SectionCard>
      </div>
      <div id="danger" className="scroll-mt-6">
        <DeleteDataSection settings={settings}>
          <DeleteAccountSection />
        </DeleteDataSection>
      </div>
    </>
  );
}
