"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { friendlyDateTime } from "@/lib/format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PauseCircle } from "lucide-react";
import type { Settings } from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { plural } from "@/lib/format";
import { FetchGlyph } from "@/components/motion/slot";
import { useToast } from "../toast";
import { SectionCard, SettingRow, Toggle } from "../ui";

type Patch = (patch: Record<string, unknown>) => void;

/**
 * Scheduled fetching is paused product-wide until routines replace it, so this
 * card has no schedule: Sync people, how far back a sync reads, and whether new
 * items become proposed todos.
 */
export function FetchSection({ settings, patch }: { settings: Settings; patch: Patch }) {
  const client = useQueryClient();
  const toast = useToast();
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const syncAll = useMutation({
    mutationFn: api.fetchNow,
    onSuccess: (result) => {
      const failed = result.results.filter((row) => !row.ok);
      toast(result.message ?? (failed.length ? `${plural(failed.length, "source")} failed: ${failed[0]!.message}` : `Synced ${plural(result.results.length, "source")}.`), {
        tone: failed.length ? "error" : "ok",
      });
      void client.invalidateQueries();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const fetch = settings.fetch;
  const last = connections.data?.connections.some(row => row.enabled) ? connections.data.lastFetch : null;
  return (
    <SectionCard
      title="Sync people"
      actions={
        <button type="button" className="btn-primary" onClick={() => syncAll.mutate()} disabled={syncAll.isPending}>
          <FetchGlyph active={syncAll.isPending} slot="connector.sync" size={12} /> Sync people
        </button>
      }
    >
      <div role="note" className="-mt-1 flex items-start gap-2 rounded-lg border border-line bg-raised px-3 py-2 text-[12.5px] text-muted" data-testid="fetch-paused">
        <PauseCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          <span className="font-medium text-ink">Sync when you need it.</span> Sync people reads contact details from your connected apps. Messages, files and other items are saved only when you ask the assistant or upload them. {last && new Date(last).getTime() <= Date.now() ? `Last synced ${friendlyDateTime(last)}.` : "No sync completed yet."}
        </span>
      </div>
      <div className="mt-1 divide-y divide-[var(--line)]">
        <SettingRow title="Look back" description="How far back a sync reads after a gap.">
          <select aria-label="Fetch look-back days" value={fetch.lookbackDays} onChange={(event) => patch({ fetch: { lookbackDays: Number(event.target.value) } })} className="field">
            {[1, 2, 3, 7, 14, 30].map((days) => (
              <option key={days} value={days}>
                {days} day{days === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </SettingRow>

      </div>
    </SectionCard>
  );
}
