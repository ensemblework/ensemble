"use client";

import type { ReactNode } from "react";

/** Shared writing surface for standalone pages, task pages and meeting notes. */
export function PageContent({ status, error = false, actions, before, children, onBlur }: {
  status: ReactNode; error?: boolean; actions?: ReactNode; before?: ReactNode; children: ReactNode; onBlur?: () => void;
}) {
  return <>
    <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[12px] text-muted">
      <span className="font-medium">Page content</span>
      <span role="status" className={error ? "text-danger" : undefined}>{status}</span>
      {actions}
    </div>
    {before}
    <div className="mt-4" data-focus-keep onBlur={onBlur}>{children}</div>
  </>;
}
