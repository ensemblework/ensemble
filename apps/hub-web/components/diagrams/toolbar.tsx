"use client";

import { SHORTCUTS, formatBinding } from "@ensemble/shared-types";
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { isApplePlatform } from "@/lib/platform";

/** The keys for a diagram shortcut, as this platform writes them (⌥⇧N, Alt+Shift+N). */
export function shortcutLabel(id: string): string | null {
  const binding = SHORTCUTS.find((item) => item.id === id);
  if (!binding) return null;
  return formatBinding(binding, isApplePlatform()) || null;
}

type TipSide = "top" | "bottom";

export type ToolButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  /** The accessible name, and the tooltip text. */
  label: string;
  /** Tooltip text when it should differ from the accessible name. */
  hint?: string;
  shortcut?: string | null;
  /** Where the tooltip shows. False hides it (the button already shows its words). */
  tip?: TipSide | false;
  /** Align the tooltip to the button's start or end edge, near a container edge. */
  tipAlign?: "center" | "start" | "end";
  active?: boolean;
  /** The button shows words beside its icon. */
  text?: boolean;
  children: ReactNode;
};

/** A 32 px tool with its tooltip and shortcut. Used by every floating bar on the diagram canvas. */
export const ToolButton = forwardRef<HTMLButtonElement, ToolButtonProps>(function ToolButton(
  { label, hint, shortcut, tip = "bottom", tipAlign = "center", active, text, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      data-active={active || undefined}
      className={["dg-tool", text ? "has-text" : "", className ?? ""].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
      {tip ? (
        <span className="dg-tip" data-side={tip} data-align={tipAlign} aria-hidden>
          {hint ?? label}
          {shortcut ? <kbd>{shortcut}</kbd> : null}
        </span>
      ) : null}
    </button>
  );
});

export function ToolDivider() {
  return <span className="dg-sep" aria-hidden />;
}

/**
 * A menu drawn inside the canvas, not portalled: Canvas only puts the canvas in the browser's
 * full screen, where only its own subtree shows. Up and Down move between items.
 */
export function FloatMenu({
  label,
  side = "top",
  align = "center",
  className,
  children,
}: {
  label: string;
  side?: TipSide;
  align?: "center" | "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("[role^=menuitem]:not([disabled])");
    // Opened from the keyboard: focus the first item. A pointer leaves focus where it was.
    if (first && document.activeElement?.matches(":focus-visible")) first.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role^=menuitem]:not([disabled])") ?? []);
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <div ref={ref} role="menu" aria-label={label} className={["dg-menu", className ?? ""].filter(Boolean).join(" ")} data-side={side} data-align={align} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
