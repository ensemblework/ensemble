"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import * as morphNamespace from "./ensemble-morph";
import type { MorphController, MorphState, MorphStyle, MorphKind } from "./ensemble-morph";
import { AI_SHOW_DELAY_MS } from "@/lib/motion/delay";

type MorphApi = typeof import("./ensemble-morph");

function morphApi(): MorphApi {
  const record = morphNamespace as MorphApi & { default?: MorphApi };
  return typeof record.mount === "function" ? record : record.default!;
}

export const MORPH_DELAY_MS = AI_SHOW_DELAY_MS;
export const MORPH_ONCE_MS = morphApi().BASE.once * 1000;
export const MORPH_LOOP_MS = morphApi().BASE.loop * 1000;
export const MORPH_SETTLE_MS = morphApi().BASE.settle * 1000;

export const AI_MARK = {
  focused: { size: 64, kind: "infinity" },
  inline: { size: 32, kind: "threadline" },
  peripheral: { size: 24, kind: "beacon" },
  run: { size: 28, kind: "relay" },
} as const;

export function BrandMorph({
  size: requestedSize = 20,
  state = "idle",
  loader = false,
  label,
  style,
  className,
  motionStyle,
  kind: requestedKind = "infinity",
  purpose,
  flat = false,
  onIdle,
}: {
  size?: number;
  state?: MorphState;
  loader?: boolean;
  label?: string;
  style?: CSSProperties;
  className?: string;
  motionStyle?: MorphStyle;
  kind?: MorphKind;
  purpose?: keyof typeof AI_MARK;
  flat?: boolean;
  onIdle?: () => void;
}) {
  const size = purpose ? AI_MARK[purpose].size : requestedSize;
  const kind = purpose ? AI_MARK[purpose].kind : requestedKind;
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const ctl = useRef<MorphController | null>(null);
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    ctl.current = morphApi().mount(el, { size, kind, flat });
    const onRest = () => onIdleRef.current?.();
    el.addEventListener("ensemble:morph-idle", onRest);
    return () => {
      el.removeEventListener("ensemble:morph-idle", onRest);
      ctl.current?.destroy();
      ctl.current = null;
    };
    // Kind changes retarget the existing controller below, preserving its current pose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, flat]);
  useEffect(() => {
    const apply = () => {
      const m = ctl.current;
      if (!m) return;
      if (state === "loop") m.loop({ delay: loader ? MORPH_DELAY_MS : 0, kind });
      else if (state === "once") void m.once();
      else if (state === "settle") void m.settle();
      else m.idle();
    };
    apply();
  }, [state, loader, size, kind, flat]);
  return (
    <span
      ref={ref}
      className={`u-morph${className ? ` ${className}` : ""}`}
      data-motion-slot="brand.morph"
      data-size={size}
      data-style={motionStyle}
      data-loader={loader ? "" : undefined}
      data-label={label}
      data-flat={flat ? "true" : undefined}
      role={label ? "img" : undefined}
      aria-label={label}
      style={{ width: flat ? "100%" : size, height: flat ? 8 : size, ...style }}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: morphApi().staticSVG(size, { id, label, tone: "auto" }) }}
    />
  );
}

/**
 * Sidebar logo. One mark → ∞ → mark only on a real navigation home.
 * Modified clicks and clicks that are already home stay still.
 * `railSize` paints the compact rail mark; CSS shows one size at a time
 * so the collapse does not need React state.
 */
export function HomeLogoLink({
  href = "/today",
  size = 16,
  railSize,
  wordmark = true,
  className,
  wordmarkClassName = "sidebar-label",
  title = "Ensemble",
}: {
  href?: string;
  size?: 16 | 20 | 24 | 32;
  railSize?: 16 | 20 | 24 | 32;
  wordmark?: boolean;
  className?: string;
  wordmarkClassName?: string;
  title?: string;
}) {
  const pathname = usePathname();
  const [state, setState] = useState<MorphState>("idle");
  const navigating = useRef(false);
  useEffect(() => {
    if (navigating.current && pathname === href) {
      navigating.current = false;
      setState("idle");
    }
  }, [pathname, href]);
  return (
    <Link
      href={href}
      prefetch={href === "/today" ? true : undefined}
      className={className}
      aria-label="Ensemble home"
      title={title}
      onClick={(event) => {
        if (pathname === href || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        navigating.current = true;
        setState("once");
      }}
    >
      <span className={railSize ? "sidebar-brand-expanded" : undefined}>
        <BrandMorph size={size} state={state} />
      </span>
      {railSize ? (
        <span className="sidebar-brand-rail">
          <BrandMorph size={railSize} state={state} />
        </span>
      ) : null}
      {wordmark ? <span className={wordmarkClassName}>Ensemble</span> : null}
    </Link>
  );
}
