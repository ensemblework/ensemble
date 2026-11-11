"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CircleAlert, History } from "lucide-react";
import { Dialog, InfoTip, Skeleton, SkeletonRows } from "../ui";
import { dateTime, relative, startOfDay } from "@/lib/format";

export type SavedVersion = { id: string; title: string; createdAt: string; author?: string };

const DAY = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short" });
const DAY_YEAR = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const TIME = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" });

/** "Today", "Yesterday", then "Mon, 9 Nov" (with the year when it is not this one). */
export function dayLabel(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const days = Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return (date.getFullYear() === now.getFullYear() ? DAY : DAY_YEAR).format(date);
}

/** Versions in the order given, grouped by the day they were saved. */
export function byDay(versions: readonly SavedVersion[], now = new Date()): Array<{ day: string; versions: SavedVersion[] }> {
  const groups: Array<{ day: string; versions: SavedVersion[] }> = [];
  for (const version of versions) {
    const day = dayLabel(version.createdAt, now);
    const last = groups.at(-1);
    if (last?.day === day) last.versions.push(version);
    else groups.push({ day, versions: [version] });
  }
  return groups;
}

const time = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : TIME.format(date);
};

/** Lines standing in for a preview while it loads. */
export function PreviewSkeleton() {
  return (
    <div className="vh-skeleton" aria-hidden>
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-3.5 w-full" index={1} />
      <Skeleton className="h-3.5 w-11/12" index={2} />
      <Skeleton className="h-3.5 w-4/5" index={3} />
      <Skeleton className="mt-3 h-3.5 w-full" index={4} />
      <Skeleton className="h-3.5 w-2/3" index={5} />
    </div>
  );
}

/**
 * Shared history browser for documents and diagrams; fetch only the selected preview. The list is a
 * listbox (arrow keys, Home and End move the selection), grouped by day. Restore asks once, in place.
 */
export function VersionHistoryDialog({ open, onClose, title, versions, selected, onSelect, preview, onRestore, restoring, restoreDisabled, loading, error, onRetry }: {
  open: boolean; onClose: () => void; title: string; versions: SavedVersion[]; selected: string | null; onSelect: (id: string) => void;
  preview: ReactNode; onRestore: () => void; restoring: boolean; restoreDisabled?: boolean; loading?: boolean; error?: string | null; onRetry?: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const noun = title.toLowerCase();
  const groups = useMemo(() => byDay(versions), [versions]);
  const current = versions.find((version) => version.id === selected) ?? null;
  const option = (id: string) => [...(list.current?.querySelectorAll<HTMLElement>("[data-version-id]") ?? [])].find((node) => node.dataset.versionId === id);

  useEffect(() => {
    if (!open) focused.current = false;
    setConfirming(false);
  }, [open, selected]);
  useEffect(() => {
    if (!restoring && error) setConfirming(false);
  }, [restoring, error]);
  // Arrow keys work as soon as the list is there: it takes focus once per opening.
  useEffect(() => {
    if (!open || focused.current || !selected) return;
    const row = option(selected);
    if (!row) return;
    focused.current = true;
    row.focus({ preventScroll: true });
  }, [open, selected, versions]);
  useEffect(() => {
    if (!selected) return;
    option(selected)?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = versions.findIndex((version) => version.id === selected);
    const last = versions.length - 1;
    const next = event.key === "ArrowDown" ? Math.min(last, at + 1) : event.key === "ArrowUp" ? Math.max(0, at - 1) : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
    if (next < 0 || !versions[next]) return;
    event.preventDefault();
    const id = versions[next]!.id;
    onSelect(id);
    option(id)?.focus();
  };

  return (
    <Dialog open={open} onClose={onClose} title={`${title} · Version history`} width={980} bodyClassName="!p-0">
      <div className="vh">
        <div className="vh-side">
          <div className="vh-side-head">
            <span>Saved versions</span>
            <InfoTip label="About version history" text={`Ensemble saves a version as you work and keeps the most recent ones. Restore replaces the ${noun} with the version you chose; your current work is kept as another version first.`} />
          </div>
          {loading ? (
            <SkeletonRows count={5} rowClassName="h-12" className="space-y-1.5 px-3 pb-3" />
          ) : !versions.length ? (
            <div className="vh-empty">
              <History size={18} aria-hidden />
              <p className="vh-empty-title">No earlier versions yet</p>
              <p>They appear as you keep editing.</p>
            </div>
          ) : (
            <div ref={list} role="listbox" aria-label="Saved versions" className="vh-list" onKeyDown={move}>
              {groups.map((group) => (
                <div key={group.day} role="group" aria-label={group.day} className="vh-group">
                  <div className="vh-day" aria-hidden>{group.day}</div>
                  {group.versions.map((version) => {
                    const chosen = version.id === selected;
                    return (
                      <button
                        key={version.id}
                        type="button"
                        role="option"
                        aria-selected={chosen}
                        tabIndex={chosen || (!selected && version === versions[0]) ? 0 : -1}
                        data-version-id={version.id}
                        className="vh-row"
                        onClick={() => onSelect(version.id)}
                        title={dateTime(version.createdAt)}
                      >
                        <span className="vh-row-top">
                          <span className="vh-time">{time(version.createdAt)}</span>
                          <span className="vh-ago">{relative(version.createdAt)}</span>
                        </span>
                        <span className="vh-row-sub">{[version.author, version.title].filter(Boolean).join(" · ")}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <section className="vh-main" aria-label="Selected version">
          <header className="vh-main-head">
            <div className="min-w-0 flex-1">
              {current ? (
                <>
                  <p className="vh-when">{dateTime(current.createdAt)}</p>
                  <p className="vh-by">{[current.author, relative(current.createdAt)].filter(Boolean).join(" · ")}</p>
                </>
              ) : (
                <p className="vh-by">{loading ? "Loading versions…" : versions.length ? "Choose a version to preview it." : "Nothing to restore yet."}</p>
              )}
            </div>
            {confirming ? (
              <div
                role="group"
                aria-label="Restore this version?"
                className="vh-confirm"
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || restoring) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setConfirming(false);
                }}
              >
                <span className="vh-confirm-text">Replace the {noun} with this version?</span>
                <button type="button" className="btn-ghost" onClick={() => setConfirming(false)} disabled={restoring}>Cancel</button>
                <button type="button" className="btn-primary" autoFocus onClick={onRestore} disabled={restoring || restoreDisabled}>
                  {restoring ? "Restoring…" : "Restore"}
                </button>
              </div>
            ) : !loading && !versions.length ? null : (
              <button type="button" className="btn-primary" disabled={!selected || restoring || restoreDisabled} onClick={() => setConfirming(true)}>
                Restore this version
              </button>
            )}
          </header>
          {error ? (
            <div role="alert" className="vh-error">
              <CircleAlert size={14} aria-hidden className="shrink-0 text-danger" />
              <span className="min-w-0 flex-1">{error}</span>
              {onRetry ? <button type="button" className="btn" onClick={onRetry}>Retry</button> : null}
            </div>
          ) : null}
          <div className="vh-preview" aria-label="Version preview" tabIndex={0}>
            {preview}
          </div>
        </section>
      </div>
    </Dialog>
  );
}
