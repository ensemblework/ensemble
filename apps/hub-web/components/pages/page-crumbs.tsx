"use client";

import { ArrowLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export type Crumb = { label: string; href: string };

/**
 * The top-left of a page or task: a small back arrow to where it sits, then the way there as links
 * (Pages / Parent / …), the same shape as a task's "Task / to do". Long titles shorten; a deep path
 * keeps its first and last steps.
 */
export function PageCrumbs({ crumbs, back = true, children }: { crumbs: Crumb[]; back?: boolean; children?: ReactNode }) {
  const parent = crumbs.at(-1);
  // A deep path keeps where it starts and the page just above; the middle folds into "…" (its links stay in the title).
  const shown = crumbs.length > 2 ? [crumbs[0]!, null, crumbs.at(-1)!] : crumbs;
  const hidden = crumbs.slice(1, -1).map((crumb) => crumb.label).join(" / ");
  return (
    <nav aria-label="Where this is" className="flex min-w-0 flex-[1_1_16rem] items-center gap-1 text-[12.5px] text-muted" data-page-crumbs>
      {back && parent ? (
        <Link href={parent.href} className="icon-btn -ml-1.5 h-7 w-7 shrink-0" aria-label={`Back to ${parent.label}`} title={`Back to ${parent.label}`}>
          <ArrowLeft size={15} aria-hidden />
        </Link>
      ) : null}
      <ol className="flex min-w-0 items-center gap-0.5">
        {shown.map((crumb, index) => (
          <li key={crumb ? crumb.href : `gap-${index}`} className={crumb && index === 0 ? "flex shrink-0 items-center gap-0.5" : "flex min-w-0 items-center gap-0.5"}>
            {index > 0 ? <ChevronRight size={12} className="shrink-0 text-faint" aria-hidden /> : null}
            {crumb ? (
              <Link href={crumb.href} className="row-tile block min-w-0 max-w-[16rem] truncate rounded px-1 py-0.5 hover:text-ink" title={crumb.label}>
                {crumb.label}
              </Link>
            ) : (
              <span className="px-0.5 text-faint" title={hidden} aria-label={`Also inside ${hidden}`}>…</span>
            )}
          </li>
        ))}
        {children ? (
          <li className="flex min-w-0 items-center gap-0.5">
            <ChevronRight size={12} className="shrink-0 text-faint" aria-hidden />
            {children}
          </li>
        ) : null}
      </ol>
    </nav>
  );
}
