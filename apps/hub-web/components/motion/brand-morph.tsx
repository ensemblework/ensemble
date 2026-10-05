"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * brand.morph for React / Next. The still, hinted mark is the server render, so
 * there is no layout shift before hydration. The morph only runs for a real
 * event: a home navigation (`once`) or a load that is still going (`loop`).
 *
 *   <BrandMorph size={20} state={working ? "loop" : "idle"} />
 *   <BrandMorph size={40} loader state={slow ? "loop" : "idle"} />
 *   <HomeLogoLink href="/today" size={16} railSize={20} />
 *
 * state="idle" while it is moving means settle: it eases back to the mark in
 * MORPH_SETTLE_MS, from wherever it is. It does not wait for the loop to finish.
 * Every motion style plays this one Expressive ribbon. motionStyle is only a
 * data attribute. Reduced motion stays on the still mark.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import * as morphNamespace from "./ensemble-morph";
import type { MorphController, MorphState, MorphStyle } from "./ensemble-morph";

type MorphApi = typeof import("./ensemble-morph");

function morphApi(): MorphApi {
  const record = morphNamespace as MorphApi & { default?: MorphApi };
  return typeof record.mount === "function" ? record : record.default!;
}

export const MORPH_DELAY_MS = 180;
export const MORPH_ONCE_MS = 1500;
export const MORPH_LOOP_MS = 2700;
export const MORPH_SETTLE_MS = 380;

export function BrandMorph({
  size = 20,
  state = "idle",
  loader = false,
  label,
  style,
  className,
  motionStyle,
  onIdle,
}: {
  size?: number;
  state?: MorphState;
  loader?: boolean;
  label?: string;
  style?: CSSProperties;
  className?: string;
  motionStyle?: MorphStyle;
  onIdle?: () => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const ctl = useRef<MorphController | null>(null);
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    ctl.current = morphApi().mount(el, { size });
    const onRest = () => onIdleRef.current?.();
    el.addEventListener("ensemble:morph-idle", onRest);
    return () => {
      el.removeEventListener("ensemble:morph-idle", onRest);
      ctl.current?.destroy();
      ctl.current = null;
    };
  }, [size]);
  useEffect(() => {
    const apply = () => {
      const m = ctl.current;
      if (!m) return;
      if (state === "loop") m.loop({ delay: loader ? MORPH_DELAY_MS : 0 });
      else if (state === "once") void m.once();
      else void m.settle();
    };
    apply();
    const root = document.documentElement;
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ["data-reduce-motion"] });
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    media.addEventListener("change", apply);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", apply);
    };
  }, [state, loader]);
  return (
    <span
      ref={ref}
      className={`u-morph${className ? ` ${className}` : ""}`}
      data-motion-slot="brand.morph"
      data-size={size}
      data-style={motionStyle}
      data-loader={loader ? "" : undefined}
      data-label={label}
      style={style}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: morphApi().staticSVG(size, { label }) }}
    />
  );
}

/**
 * Sidebar logo. One mark → ∞ → mark only on a real navigation home.
 * Modified clicks and clicks that are already home stay still.
 * `railSize` paints the hinted rail mark; CSS shows one size at a time
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
