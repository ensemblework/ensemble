"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { FileUp, LayoutGrid, Plus } from "lucide-react";
import type { CatalogEntry } from "@/lib/api-connectors";
import { relative } from "@/lib/format";
import { QueryError, SectionCard, SkeletonRows } from "../ui";
import { BrandLogo } from "./brand-logo";
import { entryStatus, featuredEntries, isConnected } from "./catalog-view";
import { StatusBadge } from "./connector-detail";
import { useCatalog } from "./use-connectors";

function lastSync(entry: CatalogEntry): string | null {
  const times = Object.values(entry.state.sources ?? {})
    .map((source) => source.lastSyncAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  return times[times.length - 1] ?? null;
}

const ACTION: Record<ReturnType<typeof entryStatus>, string> = {
  connected: "Manage",
  attention: "Fix",
  pending: "Continue",
  available: "Connect",
  not_set_up: "Details",
  soon: "Details",
};

/** Settings → Connections: the five apps most people connect, and the way into everything else. */
export function ConnectionsOverview({
  onOpenConnector,
  onBrowse,
  onImport,
  onCustom,
}: {
  onOpenConnector: (id: string) => void;
  onBrowse: (category?: string) => void;
  onImport: () => void;
  onCustom: () => void;
}) {
  const catalog = useCatalog();
  const entries = catalog.data?.entries ?? [];
  const featured = featuredEntries(entries);
  const featuredIds = new Set(featured.map((entry) => entry.id));
  const others = entries.filter((entry) => !featuredIds.has(entry.id) && isConnected(entry));
  return (
    <SectionCard
      title="Connections"
      description="The apps Ensemble reads and, after your Apply, changes. Everything else is in Browse connectors."
    >
      {catalog.isLoading ? (
        <SkeletonRows count={5} rowClassName="h-12" />
      ) : catalog.error ? (
        <QueryError error={catalog.error as Error} retry={() => void catalog.refetch()} />
      ) : (
        <ul className="-my-1 divide-y divide-[var(--line)]" data-testid="featured-connectors">
          {featured.map((entry) => {
            const status = entryStatus(entry);
            const synced = isConnected(entry) ? lastSync(entry) : null;
            return (
              <li key={entry.id} className="flex items-center gap-3 py-2.5" data-connector={entry.id}>
                <BrandLogo id={entry.logo} name={entry.name} size={32} decorative />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium">{entry.name}</div>
                  <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted">
                    <StatusBadge entry={entry} plain />
                    {synced ? <span className="text-faint">synced {relative(synced)}</span> : null}
                  </div>
                </div>
                <button
                  type="button"
                  className={status === "available" ? "btn shrink-0" : "btn-ghost shrink-0"}
                  aria-label={`${ACTION[status]} ${entry.name}`}
                  aria-haspopup="dialog"
                  onClick={() => onOpenConnector(entry.id)}
                >
                  {ACTION[status]}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {others.length ? (
        <p className="mt-3 text-[12.5px] text-muted">
          Also connected: {others.map((entry) => entry.name).join(", ")}.{" "}
          <button type="button" className="text-accent hover:underline" onClick={() => onBrowse("connected")}>
            See all
          </button>
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
        <button type="button" className="btn-primary" aria-haspopup="dialog" onClick={() => onBrowse()}>
          <LayoutGrid size={12} /> Browse connectors
        </button>
        <button type="button" className="btn" aria-haspopup="dialog" onClick={onImport}>
          <FileUp size={12} /> Import from other apps
        </button>
        <button type="button" className="btn-ghost" aria-haspopup="dialog" onClick={onCustom}>
          <Plus size={12} /> Add custom connector (MCP URL)
        </button>
      </div>
    </SectionCard>
  );
}
