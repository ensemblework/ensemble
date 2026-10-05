"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/** Solid panel. Opacity is only on the backdrop, so the page never shows through the dialog. */
export function PlotDialog({
  open,
  onClose,
  title,
  children,
  width = 640,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useRef(`plot-dialog-${title.replace(/\s+/g, "-").toLowerCase()}`);
  useEffect(() => {
    if (!open) return;
    const previously = document.activeElement as HTMLElement | null;
    const focusable = ref.current?.querySelector<HTMLElement>("button, [href], input, select, textarea");
    focusable?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previously?.focus();
    };
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="plot-dialog-root fixed inset-0 z-[90] flex items-start justify-center px-4 pt-[10vh]" role="presentation">
      <button type="button" className="plot-dialog-backdrop absolute inset-0 cursor-default border-0" aria-label="Close dialog" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        className="plot-dialog-panel relative flex max-h-[min(880px,90vh)] flex-col overflow-hidden rounded-xl border border-line shadow-pop"
        style={{ width, background: "var(--panel)" }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
          <h3 id={titleId.current} className="text-[15px] font-semibold">{title}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          <div className="max-h-[min(760px,74vh)] overflow-auto p-4 pb-12">{children}</div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10" style={{ background: "linear-gradient(to bottom, transparent, var(--panel))" }} data-dialog-fade />
        </div>
      </div>
      <style>{`
        .plot-dialog-backdrop { background: rgb(var(--bg-rgb) / 0.72); animation: plot-veil 160ms linear; }
        .plot-dialog-panel { animation: plot-dialog-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
        @keyframes plot-veil { from { opacity: 0; } to { opacity: 1; } }
        @keyframes plot-dialog-in { from { transform: translateY(8px) scale(0.98); } to { transform: none; } }
        @media (prefers-reduced-motion: reduce) {
          .plot-dialog-backdrop, .plot-dialog-panel { animation: none; }
        }
      `}</style>
    </div>,
    document.body,
  );
}
