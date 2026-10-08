"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Bot, CalendarClock, Check, CheckCheck, CircleAlert, Eye, Share2, Sun, Timer, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Held } from "@/components/motion/held";
import { SkeletonRows, cx } from "@/components/ui";
import { api, type HubNotification } from "@/lib/api";
import { relative } from "@/lib/format";
import { placeAnchoredPanel, type Side } from "@/lib/place-layer";

const KIND: Record<string, { icon: LucideIcon; label: string }> = {
  agent: { icon: Bot, label: "Agent" },
  decision: { icon: CircleAlert, label: "Needs you" },
  morning_brief: { icon: Sun, label: "Morning brief" },
  stale_nudge: { icon: Timer, label: "Nudge" },
  reminder: { icon: CalendarClock, label: "Reminder" },
  share: { icon: Share2, label: "Sharing" },
  watcher: { icon: Eye, label: "Watcher" },
  default: { icon: Bell, label: "Ensemble" },
};

function groupByDay(rows: HubNotification[]): Array<{ label: string; rows: HubNotification[] }> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const yesterday = today - 86_400_000;
  const groups: Array<{ label: string; rows: HubNotification[] }> = [];
  for (const row of rows) {
    const at = new Date(row.createdAt).getTime();
    const label = at >= today ? "Today" : at >= yesterday ? "Yesterday" : "Earlier";
    const last = groups[groups.length - 1];
    if (last?.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

export function NotificationBell() {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [box, setBox] = useState<{ top: number; right: number; maxHeight: number } | null>(null);
  const side = useRef<Side | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const notes = useQuery({ queryKey: ["notifications"], queryFn: api.notifications, refetchInterval: open ? 15_000 : 60_000 });
  const unread = (notes.data?.notifications ?? []).filter((row) => !row.readAt).length;
  const read = useMutation({
    mutationFn: (id: string) => api.readNotification(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["notifications"] }),
  });

  useEffect(() => {
    if (!open) {
      side.current = null;
      setBox(null);
      return;
    }
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!rect) return;
      const next = placeAnchoredPanel({
        anchor: rect,
        panelWidth: Math.min(400, window.innerWidth - 16),
        panelHeight: Math.min(panel?.scrollHeight || 280, 420),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        align: "right",
        previousSide: side.current,
        gap: 6,
      });
      side.current = next.side;
      const right = Math.max(8, window.innerWidth - (next.left + next.width));
      setBox((prev) =>
        prev && prev.top === next.top && prev.right === right && prev.maxHeight === next.maxHeight
          ? prev
          : { top: next.top, right, maxHeight: Math.min(next.maxHeight, 420) },
      );
    };
    place();
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const rows = notes.data?.notifications ?? [];
  const shown = filter === "unread" ? rows.filter((row) => !row.readAt) : rows;
  const panel =
    open && box && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Notifications"
            className="note-panel fixed w-[min(400px,calc(100vw-16px))] overflow-hidden rounded-lg pt-1.5"
            style={{ top: box.top, right: box.right, maxHeight: box.maxHeight }}
          >
            <div className="flex items-center gap-2 border-b border-line px-3 pb-2 pt-1.5">
              <div className="flex-1 text-[13.5px] font-semibold">Notifications</div>
              <div className="flex rounded-md bg-hover p-0.5 text-[12px]" role="tablist" aria-label="Show">
                {(["all", "unread"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={filter === value}
                    className={cx("rounded px-2 py-0.5 capitalize", filter === value ? "bg-raised text-ink shadow-sm" : "text-muted hover:text-ink")}
                    onClick={() => setFilter(value)}
                  >
                    {value}
                    {value === "unread" && unread ? <span className="ml-1 text-faint">{unread}</span> : null}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="icon-btn"
                title="Mark all as read"
                aria-label="Mark all as read"
                disabled={!unread}
                onClick={() => {
                  void api.readNotifications().then(() => client.invalidateQueries({ queryKey: ["notifications"] }));
                }}
              >
                <CheckCheck size={15} />
              </button>
            </div>
            <div className="max-h-[400px] overflow-y-auto px-1.5 pb-1.5">
              <Held
                pending={notes.isLoading && !notes.data}
                fallback={
                  <div className="px-2 py-2">
                    <SkeletonRows count={2} rowClassName="h-8" />
                  </div>
                }
              >
                {shown.length === 0 ? (
                  <div className="flex flex-col items-center px-6 py-9 text-center">
                    <span className="mb-2.5 grid h-9 w-9 place-items-center rounded-lg bg-hover text-muted">
                      <BellOff size={16} />
                    </span>
                    <div className="text-[13px] font-medium">{filter === "unread" && rows.length ? "You're all caught up" : "Nothing yet"}</div>
                    <p className="mt-1 max-w-[30ch] text-[12px] leading-5 text-muted">
                      {filter === "unread" && rows.length ? "New notes show up here as they arrive." : "Your morning brief, agent updates and shares land here."}
                    </p>
                  </div>
                ) : (
                  groupByDay(shown).map((group) => (
                    <section key={group.label} aria-label={group.label}>
                      <div className="px-2 pb-1 pt-2.5 text-2xs font-medium uppercase tracking-wide text-faint">{group.label}</div>
                      <ul>
                        {group.rows.map((row) => {
                          const kind = KIND[row.kind] ?? KIND.default!;
                          const body = (
                            <>
                              <span title={kind.label} className={cx("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md", row.urgent && !row.readAt ? "bg-[var(--prio-critical-bg)] text-[var(--prio-critical-fg)]" : "bg-hover text-muted")}>
                                <kind.icon size={14} />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex items-baseline gap-2">
                                  <span className={cx("min-w-0 flex-1 truncate text-[13px] leading-5", row.readAt ? "text-muted" : "font-medium text-ink")}>{row.title}</span>
                                  <span className="shrink-0 text-[11px] text-faint">{relative(row.createdAt)}</span>
                                </span>
                                {row.body ? <span className="line-clamp-2 block whitespace-pre-wrap text-[12px] leading-[18px] text-muted">{row.body}</span> : null}
                              </span>
                            </>
                          );
                          return (
                            <li key={row.id} className="group relative">
                              {row.readAt ? null : <span className="absolute left-0.5 top-[18px] h-1.5 w-1.5 rounded-full bg-[rgb(var(--accent-rgb))]" aria-label="Unread" />}
                              {row.url ? (
                                <Link
                                  href={row.url}
                                  className="flex gap-2.5 rounded-md py-2 pl-3 pr-8 hover:bg-hover"
                                  onClick={() => {
                                    setOpen(false);
                                    if (!row.readAt) read.mutate(row.id);
                                  }}
                                >
                                  {body}
                                </Link>
                              ) : (
                                <div className="flex gap-2.5 rounded-md py-2 pl-3 pr-8 hover:bg-hover">{body}</div>
                              )}
                              {row.readAt ? null : (
                                <button
                                  type="button"
                                  className="icon-btn absolute right-1 top-1.5 h-6 w-6 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                                  title="Mark as read"
                                  aria-label={`Mark "${row.title}" as read`}
                                  onClick={() => read.mutate(row.id)}
                                >
                                  <Check size={13} />
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ))
                )}
              </Held>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn relative"
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={15} />
        {unread ? <span className="absolute right-0.5 top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-danger px-[3px] text-[9px] font-semibold leading-none text-white">{unread > 9 ? "9+" : unread}</span> : null}
      </button>
      {panel}
    </div>
  );
}
