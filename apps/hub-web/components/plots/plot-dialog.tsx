"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/** Solid panel. Opacity is only on the backdrop, so the page never shows through the dialog. */
export function PlotDialog({
  open,
  onClose,
  title,
  description,
  children,
  width = 640,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** One line under the title. */
  description?: React.ReactNode;
  children: React.ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // The fade at the bottom only when there is more to scroll to.
  const [more, setMore] = useState(false);
  useEffect(() => {
    const node = body.current;
    if (!open || !node) return;
    const measure = () => setMore(node.scrollHeight - node.scrollTop - node.clientHeight > 4);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    if (node.firstElementChild) observer?.observe(node.firstElementChild);
    node.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer?.disconnect();
      node.removeEventListener("scroll", measure);
    };
  }, [open]);
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
    <div className="plot-dialog-root fixed inset-0 z-[90] flex items-start justify-center px-3 pt-[8vh] sm:px-4 sm:pt-[10vh]" role="presentation">
      <button type="button" className="plot-dialog-backdrop absolute inset-0 cursor-default border-0" aria-label="Close dialog" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        className="plot-dialog-panel relative flex max-h-[min(880px,90vh)] flex-col overflow-hidden"
        style={{ width: `min(${width}px, 100%)` }}
      >
        <div className="plot-dialog-head">
          <div className="min-w-0">
            <h3 id={titleId.current} className="plot-dialog-title">{title}</h3>
            {description ? <p className="plot-dialog-description">{description}</p> : null}
          </div>
          <button type="button" className="pl-icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          <div ref={body} className="max-h-[min(760px,74vh)] overflow-auto px-5 pb-5 pt-4">
            <div>{children}</div>
          </div>
          {more ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10" style={{ background: "linear-gradient(to bottom, transparent, var(--panel))" }} data-dialog-fade /> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
