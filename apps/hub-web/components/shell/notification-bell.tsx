"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AgentIcon as Orbit } from "@/components/agent-icon";
import { Bell, CalendarClock, CircleAlert, Eye, Share2, Sparkles, Sun, Timer, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type HubNotification } from "@/lib/api";
import { relative } from "@/lib/format";
import { placeAnchoredPanel, type Side } from "@/lib/place-layer";
import { useModalFocus } from "@/lib/modal-focus";
import { SkeletonRows } from "../ui";

const KIND: Record<string, { icon: LucideIcon; tone: string }> = {
  agent: { icon: Orbit, tone: "amber" }, decision: { icon: CircleAlert, tone: "amber" },
  morning_brief: { icon: Sun, tone: "teal" }, stale_nudge: { icon: Timer, tone: "blue" },
  reminder: { icon: CalendarClock, tone: "blue" }, share: { icon: Share2, tone: "teal" },
  watcher: { icon: Eye, tone: "blue" }, skill_mining: { icon: Sparkles, tone: "violet" }, default: { icon: Bell, tone: "blue" },
};

/** The bell lists unread notifications only; reading one removes it. */
export type NotificationFilter = "unread" | "needs" | "reminders" | "sharing";
const TABS: Array<[NotificationFilter, string]> = [["unread", "Unread"], ["needs", "Needs me"], ["reminders", "Reminders"], ["sharing", "Sharing"]];
const EMPTY: Record<NotificationFilter, [string, string]> = {
  unread: ["You're all caught up", "New updates will show up here."],
  needs: ["Nothing needs you", "Questions and stuck runs land here."],
  reminders: ["No reminders", "Due reminders and nudges show up here."],
  sharing: ["Nothing shared", "Work people share with you shows up here."],
};
export function filterNotifications(rows: HubNotification[], filter: NotificationFilter) {
  return rows.filter((r) => !r.readAt && (filter === "unread"
    || filter === "needs" && ["decision", "agent"].includes(r.kind)
    || filter === "reminders" && ["reminder", "stale_nudge", "morning_brief"].includes(r.kind)
    || filter === "sharing" && r.kind === "share"));
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

const reduced = () => typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.reduceMotion === "true");

/** One notification: tap opens it, × or a sideways swipe dismisses it. */
function NotificationRow({ row, leaving, onOpen, onDismiss }: { row: HubNotification; leaving: boolean; onOpen: () => void; onDismiss: (button: HTMLElement | null) => void }) {
  const kind = KIND[row.kind] ?? KIND.default!;
  const Icon = kind.icon;
  const [dx, setDx] = useState(0);
  const swipe = useRef<{ x: number; y: number; id: number; moved: boolean } | null>(null);
  const swiped = useRef(false);
  const content = <>
    <span className="nc-icon" data-tone={row.urgent ? "amber" : kind.tone} aria-hidden><Icon size={15} /></span>
    <span className="nc-text">
      <span className="nc-line"><strong>{row.title}</strong><time dateTime={row.createdAt} title={new Date(row.createdAt).toLocaleString()}>{relative(row.createdAt)}</time></span>
      {row.body ? <span className="nc-body">{row.body}</span> : null}
    </span>
  </>;
  return <li data-note-id={row.id} className="nc-row" data-leaving={leaving || undefined}>
    <div
      className="nc-card"
      data-urgent={row.urgent || undefined}
      style={dx ? { transform: `translateX(${dx}px)`, opacity: Math.max(0.2, 1 - Math.abs(dx) / 220), transition: "none" } : undefined}
      onPointerDown={(event) => { swiped.current = false; if (event.pointerType !== "mouse") swipe.current = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false }; }}
      onPointerMove={(event) => {
        const start = swipe.current; if (!start || start.id !== event.pointerId) return;
        const x = event.clientX - start.x, y = event.clientY - start.y;
        if (!start.moved && Math.abs(x) > 10 && Math.abs(x) > Math.abs(y) * 1.5) start.moved = true;
        if (start.moved) setDx(x);
      }}
      onPointerUp={() => { const moved = Boolean(swipe.current?.moved); swipe.current = null; swiped.current = moved; if (moved && Math.abs(dx) > 90) onDismiss(null); else setDx(0); }}
      onPointerCancel={() => { swipe.current = null; setDx(0); }}
      onClickCapture={(event) => { if (swiped.current) { swiped.current = false; event.preventDefault(); event.stopPropagation(); } }}
    >
      {row.url ? <Link href={row.url} className="nc-entry" onClick={onOpen}>{content}</Link> : <div className="nc-entry">{content}</div>}
      <button type="button" className="nc-dismiss" aria-label={`Dismiss "${row.title}"`} title="Dismiss" onClick={(event) => onDismiss(event.currentTarget)}><X size={13} /></button>
    </div>
  </li>;
}

export function NotificationContent({ rows, loading, error, busy, onRead, onClear, onRetry, onClose }: { rows: HubNotification[]; loading: boolean; error?: string; busy: boolean; onRead: (id: string) => void; onClear: (ids: string[]) => void; onRetry: () => void; onClose: () => void }) {
  const [filter, setFilter] = useState<NotificationFilter>("unread");
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const shown = filterNotifications(rows, filter);
  const feed = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const tabId = useId();
  const dismiss = (id: string, button: HTMLElement | null) => {
    if (leaving.has(id)) return;
    // The row goes away: keep keyboard focus in the list, on the next row.
    if (button) {
      const items = [...(feed.current?.querySelectorAll<HTMLLIElement>("li[data-note-id]") ?? [])];
      const at = items.findIndex((item) => item.contains(button));
      const next = [...items.slice(at + 1), ...items.slice(0, Math.max(0, at)).reverse()].map((item) => item.querySelector<HTMLElement>(".nc-dismiss")).find(Boolean);
      (next ?? tabs.current?.querySelector<HTMLElement>("[aria-selected='true']"))?.focus();
    }
    if (reduced()) { onRead(id); return; }
    setLeaving((current) => new Set(current).add(id));
    window.setTimeout(() => onRead(id), 180);
  };
  const [title, line] = EMPTY[filter];
  return <div className="nc">
    <header className="nc-head">
      <h2>Notifications</h2>
      {shown.length > 1 ? <button type="button" className="nc-clear" disabled={busy} onClick={() => onClear(shown.map((row) => row.id))}>Clear {filter === "unread" ? "all" : "these"}</button> : null}
      <button type="button" className="icon-btn" aria-label="Close notifications" onClick={onClose}><X size={15} /></button>
    </header>
    <div ref={tabs} className="nc-tabs" role="tablist" aria-label="Notification views" onKeyDown={(event) => {
      const at = TABS.findIndex(([key]) => key === filter);
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = TABS[(at + step + TABS.length) % TABS.length]![0];
      setFilter(next);
      tabs.current?.querySelector<HTMLElement>(`[data-tab='${next}']`)?.focus();
    }}>
      {TABS.map(([key, label]) => {
        const count = filterNotifications(rows, key).length;
        return <button key={key} type="button" role="tab" id={`${tabId}-${key}`} data-tab={key} aria-selected={filter === key} aria-controls={`${tabId}-panel`} tabIndex={filter === key ? 0 : -1} onClick={() => setFilter(key)}>
          {label}{count && !loading ? <span className="nc-count" data-tone={key === "needs" ? "amber" : undefined}>{count > 99 ? "99+" : count}</span> : null}
        </button>;
      })}
    </div>
    <div ref={feed} className="nc-feed" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${filter}`}>
      {loading ? <div className="px-3 py-2"><SkeletonRows count={3} rowClassName="h-12" /></div>
        : error ? <div className="nc-empty" role="alert"><CircleAlert size={18} /><strong>Couldn't load notifications</strong><p>{error}</p><button type="button" className="btn" onClick={onRetry}>Try again</button></div>
        : !shown.length ? <div className="nc-empty"><Bell size={18} /><strong>{title}</strong><p>{line}</p></div>
        : groupNotifications(shown).map((group) => <section key={group.label}>
          <h3>{group.label}</h3>
          <ul>{group.rows.map((row) => <NotificationRow key={row.id} row={row} leaving={leaving.has(row.id)} onOpen={() => { onRead(row.id); onClose(); }} onDismiss={(button) => dismiss(row.id, button)} />)}</ul>
        </section>)}
    </div>
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
  const rows = (notes.data?.notifications ?? []).filter((r) => !r.readAt);
  const unread = rows.length, needs = filterNotifications(rows, "needs").length;
  const read = useMutation({
    mutationFn: (ids: string[]) => ids.length === 1 ? api.readNotification(ids[0]!) : api.readNotifications(ids),
    // Read rows leave at once; a failed write brings them back.
    onMutate: async (ids) => {
      setError("");
      await client.cancelQueries({ queryKey: ["notifications"] });
      const before = client.getQueryData<{ notifications: HubNotification[] }>(["notifications"]);
      if (before) client.setQueryData(["notifications"], { notifications: before.notifications.filter((row) => !ids.includes(row.id)) });
      return { before };
    },
    onError: (e, _ids, context) => { setError(e.message); if (context?.before) client.setQueryData(["notifications"], context.before); },
    onSettled: () => client.invalidateQueries({ queryKey: ["notifications"] }),
  });
  useEffect(() => {
    if (!open) { setBox(null); side.current = null; return; }
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect(); if (!rect) return;
      const next = placeAnchoredPanel({ anchor: rect, panelWidth: Math.min(400, window.innerWidth - 24), panelHeight: Math.min(560, window.innerHeight - 24), viewport: { width: window.innerWidth, height: window.innerHeight }, align: "right", previousSide: side.current, gap: 8 });
      side.current = next.side;
      setBox({ top: next.top, right: Math.max(12, window.innerWidth - next.left - next.width), maxHeight: Math.min(next.maxHeight, 560) });
    };
    place(); window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  useModalFocus(overlayRef, open && Boolean(box), () => setOpen(false));
  return <><button ref={buttonRef} type="button" className="icon-btn relative" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}><Bell size={15} />{unread > 0 && <span className="notification-badge" data-tone={needs ? "amber" : undefined}>{unread > 9 ? "9+" : unread}</span>}</button>
    {open && box && typeof document !== "undefined" && createPortal(<div ref={overlayRef} className="notification-overlay" data-modal-layer={id} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Notifications" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}><div className="note-panel notification-panel" style={{ top: box.top, right: box.right, maxHeight: box.maxHeight }}><NotificationContent rows={rows} loading={notes.isPending} error={notes.isError ? notes.error.message : undefined} busy={read.isPending} onRead={(id) => read.mutate([id])} onClear={(ids) => read.mutate(ids)} onRetry={() => void notes.refetch()} onClose={() => setOpen(false)} />{error && <p className="notification-write-error" role="alert">Couldn't update notifications. {error}</p>}</div></div>, document.body)}
  </>;
}
