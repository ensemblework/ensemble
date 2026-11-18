"use client";

/**
 * Which machine Code shows (docs/16 §1): one at a time, picked here. Opening the list reads every
 * paired computer's state again, so a computer that came online since shows so without a reload.
 * With a single machine (this computer's own Ensemble) it is a plain label.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Laptop, Plus, Server } from "lucide-react";
import Link from "next/link";
import { Popover, Spinner, cx } from "@/components/ui";
import { api } from "@/lib/api";
import type { CodePlace } from "@/lib/code-home";
import { relative } from "@/lib/format";
import { OnlineDot } from "./ide-chrome";

/** One machine's state in a few words: online, or when it was last seen. */
export function machineState(online: boolean, lastSeenAt: string | null | undefined): string {
  if (online) return "Online";
  return lastSeenAt ? `Offline · seen ${relative(lastSeenAt)}` : "Offline";
}

export function MachineSwitcher({ places, current, onPick, className }: { places: CodePlace[]; current: CodePlace | null; onPick: (place: CodePlace) => void; className?: string }) {
  const client = useQueryClient();
  const remote = places.some((place) => place.target.kind === "device");
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, enabled: remote, staleTime: 30_000 });
  const seen = new Map((devices.data?.devices ?? []).map((row) => [row.id, row.lastSeenAt]));
  const Icon = current?.target.kind === "local" && current.name === "This server" ? Server : Laptop;
  if (!remote) {
    return current ? (
      <span className={cx("machine-switch is-static", className)} title={current.name}>
        <Icon size={13} className="shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{current.name}</span>
      </span>
    ) : null;
  }
  return (
    <Popover
      width={280}
      align="left"
      trigger={(open, toggle) => (
        <button
          type="button"
          className={cx("machine-switch", className)}
          aria-haspopup="listbox"
          aria-expanded={open}
          title="Choose the computer Code shows"
          onClick={() => {
            // The list shows each computer as it is now, not as it was when the page loaded.
            if (!open) void client.invalidateQueries({ queryKey: ["devices"] });
            toggle();
          }}
          data-testid="machine-switch"
        >
          <Icon size={13} className="shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-left">{current?.name ?? "Pick a computer"}</span>
          {current ? <OnlineDot online={current.online} /> : null}
          <ChevronsUpDown size={12} className="shrink-0 text-faint" aria-hidden />
        </button>
      )}
    >
      {(close) => (
        <div className="py-1" role="listbox" aria-label="Computers" data-testid="machine-list">
          <div className="flex items-center gap-2 px-3 pb-1 pt-0.5 text-[11.5px] text-faint">
            <span className="flex-1">Your computers</span>
            {devices.isFetching ? <Spinner size={11} /> : null}
          </div>
          {places.map((place) => {
            const on = place.key === current?.key;
            const id = place.target.kind === "device" ? place.target.deviceId : null;
            return (
              <button
                key={place.key}
                type="button"
                role="option"
                aria-selected={on}
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-hover"
                onClick={() => {
                  onPick(place);
                  close();
                }}
              >
                <Laptop size={14} className="shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{place.name}</span>
                  <span className="flex items-center gap-1.5 text-[11.5px] text-faint">
                    <OnlineDot online={place.online} /> {machineState(place.online, id ? seen.get(id) : null)}
                  </span>
                </span>
                {on ? <Check size={13} className="shrink-0 text-accent" aria-hidden /> : null}
              </button>
            );
          })}
          <div className="mt-1 border-t border-line pt-1">
            <Link href="/settings#devices" className="flex items-center gap-2.5 px-3 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-ink" onClick={close}>
              <Plus size={14} aria-hidden /> Pair a computer
            </Link>
          </div>
        </div>
      )}
    </Popover>
  );
}
