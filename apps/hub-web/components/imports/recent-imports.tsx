"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ACTIVE_IMPORT, importsApi, type ImportJobRecord } from "@/lib/api-imports";
import { BrandLogo } from "../connectors/brand-logo";
import { countsLine, ImportSummary, summaryTitle } from "./import-summary";

function when(value: string): string {
  const date = new Date(value);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** A compact list of this person's recent imports, with details and undo. Settings places it under Connections. */
export function RecentImports({ limit = 5, onImport }: { limit?: number; onImport?: () => void }) {
  const client = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const jobs = useQuery({
    queryKey: ["imports"],
    queryFn: importsApi.jobs,
    refetchInterval: (query) => (query.state.data?.jobs.some((job) => ACTIVE_IMPORT.has(job.status)) ? 2000 : false),
  });
  const list = (jobs.data?.jobs ?? []).slice(0, limit);
  const replace = (fresh: ImportJobRecord) => {
    client.setQueryData<{ jobs: ImportJobRecord[] }>(["imports"], (current) => (current ? { jobs: current.jobs.map((job) => (job.id === fresh.id ? fresh : job)) } : current));
    void client.invalidateQueries();
  };
  return (
    <section aria-label="Recent imports" className="space-y-2 text-[13px]">
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-medium">Recent imports</h4>
        {onImport ? (
          <button type="button" className="btn" onClick={onImport}>
            Import from other apps
          </button>
        ) : null}
      </div>
      {jobs.isLoading ? <p className="text-muted">Loading…</p> : null}
      {jobs.isError ? <p className="text-danger">Could not load recent imports.</p> : null}
      {!jobs.isLoading && !list.length ? <p className="text-muted">No imports yet.</p> : null}
      <ul className="space-y-1">
        {list.map((job) => {
          const expanded = open === job.id;
          return (
            <li key={job.id} className="rounded-md border border-line">
              <button
                type="button"
                className="row-tile flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : job.id)}
              >
                <BrandLogo id={job.source} name={job.sourceLabel} size={20} decorative />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {summaryTitle(job)}
                    {job.fileName ? <span className="text-muted"> · {job.fileName}</span> : null}
                  </span>
                  <span className="block truncate text-[12px] text-muted">
                    {ACTIVE_IMPORT.has(job.status) ? `${job.progress.written.toLocaleString()} done so far` : countsLine(job)}
                  </span>
                </span>
                <span className="shrink-0 text-[12px] text-faint">{when(job.createdAt)}</span>
              </button>
              {expanded ? (
                <div className="border-t border-line p-2">
                  <ImportSummary job={job} onChange={replace} />
                  {ACTIVE_IMPORT.has(job.status) ? (
                    <button type="button" className="btn mt-2" onClick={() => void importsApi.cancel(job.id).then(({ job: fresh }) => replace(fresh))}>
                      Cancel import
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
