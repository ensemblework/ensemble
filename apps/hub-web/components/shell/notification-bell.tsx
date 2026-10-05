"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Held } from "@/components/motion/held";
import { SkeletonRows } from "@/components/ui";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";
import { placeAnchoredPanel, type Side } from "@/lib/place-layer";

export function NotificationBell() {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
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
        panelWidth: Math.min(380, window.innerWidth - 16),
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
  const panel =
    open && box && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Notifications"
            className="note-panel fixed w-[min(380px,calc(100vw-16px))] overflow-auto rounded-xl p-2"
            style={{ top: box.top, right: box.right, maxHeight: box.maxHeight }}
          >
            <div className="flex items-center justify-between px-2 py-1">
              <div className="text-[13px] font-medium">In Ensemble</div>
              <button
                type="button"
                className="btn-ghost py-0 text-[12px]"
                disabled={!unread}
                onClick={() => {
                  void api.readNotifications().then(() => client.invalidateQueries({ queryKey: ["notifications"] }));
                }}
              >
                Mark read
              </button>
            </div>
            <ul className="max-h-[360px] overflow-y-auto">
              <Held
                pending={notes.isLoading && !notes.data}
                fallback={
                  <li className="px-2 py-2">
                    <SkeletonRows count={2} rowClassName="h-8" />
                  </li>
                }
              >
                {rows.length === 0 ? (
                  <li className="px-2 py-4 text-[13px] text-muted">No notes yet. The morning brief lands here.</li>
                ) : (
                  rows.map((row) => (
                    <li key={row.id} className="rounded-lg px-2.5 py-2.5 hover:bg-hover">
                      <div className="flex items-start justify-between gap-3">
                        <div className={row.readAt ? "min-w-0 flex-1 text-[13px] leading-5 text-muted" : "min-w-0 flex-1 text-[13px] font-medium leading-5"}>{row.title}</div>
                        <span className="shrink-0 pt-0.5 text-[11px] leading-4 text-faint">{relative(row.createdAt)}</span>
                      </div>
                      {row.body ? <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-5 text-muted">{row.body}</p> : null}
                      <div className="mt-2.5 flex gap-3">
                        {row.url ? (
                          <Link
                            href={row.url}
                            className="text-[12px] font-medium text-accent"
                            onClick={() => {
                              setOpen(false);
                              if (!row.readAt) read.mutate(row.id);
                            }}
                          >
                            Open
                          </Link>
                        ) : null}
                        {row.readAt ? null : (
                          <button type="button" className="text-[12px] text-muted" onClick={() => read.mutate(row.id)}>
                            Dismiss
                          </button>
                        )}
                      </div>
                    </li>
                  ))
                )}
              </Held>
            </ul>
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
        {unread ? <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-danger" /> : null}
      </button>
      {panel}
    </div>
  );
}
