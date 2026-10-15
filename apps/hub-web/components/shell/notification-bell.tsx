"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Bell, BellOff, Orbit, CalendarClock, Check, CheckCheck, CircleAlert, Eye, Share2, Sun, Timer, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type HubNotification } from "@/lib/api";
import { relative } from "@/lib/format";
import { placeAnchoredPanel, type Side } from "@/lib/place-layer";
import { useModalFocus } from "@/lib/modal-focus";
import { SkeletonRows } from "../ui";

const KIND: Record<string, { icon: LucideIcon; label: string; tone: string }> = {
  agent: { icon: Orbit, label: "Agent", tone: "violet" }, decision: { icon: CircleAlert, label: "Needs you", tone: "amber" },
  morning_brief: { icon: Sun, label: "Morning brief", tone: "teal" }, stale_nudge: { icon: Timer, label: "Nudge", tone: "amber" },
  reminder: { icon: CalendarClock, label: "Reminder", tone: "blue" }, share: { icon: Share2, label: "Sharing", tone: "teal" },
  watcher: { icon: Eye, label: "Watcher", tone: "blue" }, default: { icon: Bell, label: "Ensemble", tone: "blue" },
};
export type NotificationFilter = "all" | "unread" | "requests" | "agent" | "reminders" | "sharing";
const FILTERS: Array<[NotificationFilter, string]> = [["all", "All activity"], ["unread", "Unread"], ["requests", "Needs you"], ["agent", "Agent"], ["reminders", "Reminders"], ["sharing", "Sharing"]];
export function filterNotifications(rows: HubNotification[], filter: NotificationFilter) {
  return rows.filter((r) => filter === "all" || filter === "unread" && !r.readAt || filter === "requests" && r.kind === "decision" || filter === "agent" && ["agent", "watcher"].includes(r.kind) || filter === "reminders" && ["reminder", "stale_nudge", "morning_brief"].includes(r.kind) || filter === "sharing" && r.kind === "share");
}
export function groupNotifications(rows: HubNotification[], now = new Date()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const yesterday = new Date(start); yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<string, HubNotification[]>();
  for (const r of [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    const time = Date.parse(r.createdAt), label = time >= start.getTime() ? "Today" : time >= yesterday.getTime() ? "Yesterday" : "Earlier";
    groups.set(label, [...(groups.get(label) ?? []), r]);
  }
  return [...groups].map(([label, rows]) => ({ label, rows }));
}

export function NotificationContent({ rows, loading, error, busy, onRead, onReadAll, onRetry, onClose }: { rows: HubNotification[]; loading: boolean; error?: string; busy: boolean; onRead: (id: string) => void; onReadAll: () => void; onRetry: () => void; onClose: () => void }) {
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const unread = rows.filter((r) => !r.readAt).length;
  const requests = rows.filter((r) => !r.readAt && r.kind === "decision").length;
  const shown = filterNotifications(rows, filter);
  return <div className="notification-center">
    <header className="notification-heading"><div><span className="notification-eyebrow">YOUR WORK, IN THE LOOP</span><h2>Notifications</h2></div><button type="button" className="icon-btn" aria-label="Close notifications" onClick={onClose}><X size={16} /></button></header>
    <div className="notification-summary"><button type="button" aria-pressed={filter === "unread"} onClick={() => setFilter("unread")}><span className="notification-summary-icon"><Bell size={16} /></span><span><strong>{loading ? "—" : unread}</strong><small>unread updates</small></span></button><button type="button" aria-pressed={filter === "requests"} onClick={() => setFilter("requests")}><span className="notification-summary-icon request"><CircleAlert size={16} /></span><span><strong>{loading ? "—" : requests}</strong><small>unread requests</small></span></button></div>
    <div className="notification-filters" aria-label="Notification filters">{FILTERS.map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</div>
    <div className="notification-feed">
      {loading ? <div className="p-4"><SkeletonRows count={3} rowClassName="h-16" /></div> : error ? <div className="notification-empty" role="alert"><CircleAlert size={24} /><strong>Couldn't load your updates</strong><p>{error}</p><button type="button" className="btn" onClick={onRetry}>Try again</button></div> : !shown.length ? <div className="notification-empty"><span><BellOff size={24} /></span><strong>{filter === "unread" ? "You're all caught up" : rows.length ? "Nothing in this view" : "A little quiet is a good thing"}</strong><p>{rows.length ? "Try another filter to see more activity." : "Agent updates, requests, reminders, and shared work will arrive here."}</p></div> : groupNotifications(shown).map((group) => <section key={group.label}><h3>{group.label}<span>{group.rows.length}</span></h3><ul>{group.rows.map((row) => {
        const kind = KIND[row.kind] ?? KIND.default!;
        const Icon = kind.icon;
        const content = <><span className="notification-kind-icon" data-tone={row.urgent && !row.readAt ? "amber" : kind.tone}><Icon size={16} /></span><span className="notification-message"><span className="notification-meta"><span>{kind.label}{row.urgent && !row.readAt ? " · Priority" : ""}</span><time dateTime={row.createdAt} title={new Date(row.createdAt).toLocaleString()}>{relative(row.createdAt)}</time></span><strong>{row.title}</strong>{row.body && <span className="notification-body">{row.body}</span>}{row.url && <small>Open<ArrowUpRight size={11} /></small>}</span></>;
        return <li key={row.id} data-unread={!row.readAt || undefined}>{row.url ? <Link href={row.url} className="notification-entry" onClick={() => { if (!row.readAt && !busy) onRead(row.id); onClose(); }}>{content}</Link> : <div className="notification-entry">{content}</div>}{!row.readAt && <button type="button" className="notification-read" disabled={busy} aria-label={`Mark "${row.title}" as read`} onClick={() => onRead(row.id)}><Check size={13} /></button>}</li>;
      })}</ul></section>)}
    </div>
    <footer><span>{unread ? `${unread} unread` : "All read"}</span><button type="button" disabled={!unread || busy || loading} onClick={onReadAll}><CheckCheck size={14} />Mark all as read</button></footer>
  </div>;
}

export function NotificationBell() {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [box, setBox] = useState<{ top: number; right: number; maxHeight: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null), overlayRef = useRef<HTMLDivElement>(null);
  const side = useRef<Side | null>(null);
  const id = useId();
  const notes = useQuery({ queryKey: ["notifications"], queryFn: api.notifications, refetchInterval: open ? 15_000 : 60_000 });
  const rows = notes.data?.notifications ?? [], unread = rows.filter((r) => !r.readAt).length;
  const read = useMutation({
    mutationFn: (id: string | null) => id ? api.readNotification(id) : api.readNotifications(),
    onMutate: () => setError(""),
    onError: (e) => setError(e.message),
    onSuccess: () => client.invalidateQueries({ queryKey: ["notifications"] }),
  });
  useEffect(() => {
    if (!open) { setBox(null); side.current = null; return; }
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect(); if (!rect) return;
      const next = placeAnchoredPanel({ anchor: rect, panelWidth: Math.min(480, window.innerWidth - 24), panelHeight: Math.min(640, window.innerHeight - 24), viewport: { width: window.innerWidth, height: window.innerHeight }, align: "right", previousSide: side.current, gap: 8 });
      side.current = next.side;
      setBox({ top: next.top, right: Math.max(12, window.innerWidth - next.left - next.width), maxHeight: Math.min(next.maxHeight, 640) });
    };
    place(); window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  useModalFocus(overlayRef, open && Boolean(box), () => setOpen(false));
  return <><button ref={buttonRef} type="button" className="icon-btn relative" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}><Bell size={15} />{unread > 0 && <span className="notification-badge">{unread > 9 ? "9+" : unread}</span>}</button>
    {open && box && typeof document !== "undefined" && createPortal(<div ref={overlayRef} className="notification-overlay" data-modal-layer={id} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Notifications" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}><div className="note-panel notification-panel" style={{ top: box.top, right: box.right, height: box.maxHeight }}><NotificationContent rows={rows} loading={notes.isPending} error={notes.isError ? notes.error.message : undefined} busy={read.isPending} onRead={(id) => read.mutate(id)} onReadAll={() => read.mutate(null)} onRetry={() => void notes.refetch()} onClose={() => setOpen(false)} />{error && <p className="notification-write-error" role="alert">Couldn't mark as read. {error}</p>}</div></div>, document.body)}
  </>;
}
