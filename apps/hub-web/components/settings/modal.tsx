"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => !node.closest("[inert]") && node.getAttribute("aria-hidden") !== "true");
}

/** The dialog opened last is the one on top: portals append to <body> in order. */
function isTopmost(node: HTMLElement | null): boolean {
  if (!node) return false;
  const open = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
  return open[open.length - 1] === node;
}

/**
 * A modal for Settings and the connector store. Escape and a click on the
 * backdrop close only the topmost one; Tab stays inside it; focus returns to
 * whatever opened it. Nothing is ever locked: the close button is always there.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  width = 560,
  height,
  children,
  footer,
  header,
  initialFocus,
  bodyClassName = "p-4",
  scroll = true,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  width?: number;
  /** CSS height for big dialogs, e.g. "min(80vh, 760px)". Without it the dialog grows with its content. */
  height?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Replaces the default title row (the title stays as the accessible name). */
  header?: React.ReactNode;
  initialFocus?: React.RefObject<HTMLElement | null>;
  bodyClassName?: string;
  /** False when the body lays out its own scrolling panes. */
  scroll?: boolean;
  testId?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    const node = panel.current;
    const frame = window.requestAnimationFrame(() => {
      if (!node || node.contains(document.activeElement)) return;
      const target = initialFocus?.current ?? node.querySelector<HTMLElement>("[data-autofocus]") ?? null;
      (target ?? node).focus({ preventScroll: true });
    });
    const onKey = (event: KeyboardEvent) => {
      if (!isTopmost(panel.current)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const list = focusables(panel.current);
      if (!list.length) {
        event.preventDefault();
        panel.current.focus();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === panel.current || !panel.current.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !panel.current.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      const back = opener.current;
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
    // initialFocus is a ref; reading .current at open time is what we want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="settings-modal-backdrop fixed inset-0 z-[70] flex items-end justify-center bg-black/50 sm:items-center sm:p-6"
      onMouseDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === event.currentTarget) onCloseRef.current();
        pressedBackdrop.current = false;
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        className="pop-in flex max-h-[calc(100dvh-1rem)] w-full flex-col overflow-hidden rounded-t-xl bg-raised shadow-pop outline-none sm:max-h-[calc(100dvh-3rem)] sm:rounded-xl"
        style={{ maxWidth: width, ...(height ? { height } : {}) }}
      >
        {header ? (
          <>
            <h2 id={titleId} className="sr-only">
              {title}
            </h2>
            {header}
          </>
        ) : (
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <h2 id={titleId} className="text-[15px] font-semibold">
                {title}
              </h2>
              {description ? <p className="mt-0.5 text-[12.5px] leading-[18px] text-muted">{description}</p> : null}
            </div>
            <button type="button" className="icon-btn -mr-1 shrink-0" onClick={() => onCloseRef.current()} aria-label="Close">
              <X size={15} />
            </button>
          </div>
        )}
        <div className={`min-h-0 flex-1 ${scroll ? "overflow-y-auto" : "overflow-hidden"} ${bodyClassName}`}>{children}</div>
        {footer ? <div className="shrink-0 border-t border-line px-4 py-3">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
