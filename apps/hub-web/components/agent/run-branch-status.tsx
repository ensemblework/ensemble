"use client";

import { Lock } from "lucide-react";
import { InfoTip, cx } from "@/components/ui";
import { computerName } from "@/lib/device-copy";
import { computerPullRequestBases } from "@/lib/pull-request";

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

/** Read-only: the branches a paired computer opens pull requests into. Only that computer changes them. */
export function PullRequestBases({ capabilities, device }: { capabilities: unknown; device?: string | null }) {
  const bases = computerPullRequestBases(capabilities);
  const name = computerName(device);
  return (
    <span
      className="inline-flex max-w-full flex-wrap items-center gap-1.5 text-[12px] text-muted"
      data-pull-request-bases={bases ? bases.join(",") : "unsupported"}
    >
      <Lock size={12} className="shrink-0 text-faint" aria-hidden />
      {bases ? (
        <>
          Pull requests into:
          {bases.length ? (
            bases.map((base) => (
              <span key={base} className="rounded-full bg-raised px-1.5 py-px font-mono text-[11px] font-semibold text-muted">
                {base}
              </span>
            ))
          ) : (
            <span className="rounded-full bg-raised px-1.5 py-px text-[11px] font-semibold text-faint">None</span>
          )}
        </>
      ) : (
        "Pull requests: update Ensemble there first"
      )}
      <InfoTip
        text={
          bases
            ? `Runs on ${name} may end in a pull request into these branches. Only ${name} changes the list: \`ensemble git bases add <branch>\` there. Never main, master, production or testing-live.`
            : `Ensemble on ${name} is too old to open pull requests. Update it there (\`ensemble update\`).`
        }
      />
    </span>
  );
}
