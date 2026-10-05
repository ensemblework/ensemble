"use client";

import { Lock } from "lucide-react";
import { cx } from "@/components/ui";
import { computerName } from "@/lib/device-copy";

/** Read-only. The computer publishes this; the page cannot change it. */
export function RunBranchStatus({ on, device }: { on: boolean; device?: string | null }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 text-[12px] text-muted" data-run-branch={on ? "on" : "off"}>
      <Lock size={12} className="shrink-0 text-faint" aria-hidden />
      <span className={cx("rounded-full px-1.5 py-px text-[11px] font-semibold", on ? "bg-[var(--tag-green-bg)] text-[var(--tag-green-fg)]" : "bg-raised text-faint")}>
        {on ? "On" : "Off"}
      </span>
      <span className="truncate">set on {computerName(device)}</span>
    </span>
  );
}
