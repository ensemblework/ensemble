"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { useId, type CSSProperties, type SVGProps } from "react";
import { svgBody } from "@ensemble/brand";

export type LogoTone = "auto" | "dark" | "light" | "mono";
type MarkProps = Omit<SVGProps<SVGSVGElement>, "fill"> & { size?: number; tone?: LogoTone; title?: string };

/** Satin Gold stays independent of the user's interface accent. */
export function EnsembleMark({ size = 24, tone = "auto", title, ...rest }: MarkProps) {
  const id = useId();
  const color = tone === "dark" ? "#FFFFFF" : tone === "light" ? "#1C1915" : "currentColor";
  return <svg width={size} height={size} viewBox="0 0 320 320" data-brand-tone={tone} color={color} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false" {...rest}
    dangerouslySetInnerHTML={{ __html: svgBody({ id, tone: tone === "auto" ? "auto" : "mono", micro: size <= 20 }) }} />;
}

export function EnsembleLogo({ size = 24, tone = "auto", className, style, wordmark = true }: { size?: number; tone?: LogoTone; className?: string; style?: CSSProperties; wordmark?: boolean }) {
  return <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * .4), ...style }}>
    <EnsembleMark size={size} tone={tone} title={wordmark ? undefined : "Ensemble"} />
    {wordmark ? <span style={{ fontWeight: 600, fontSize: Math.max(14, size * .75), letterSpacing: "-.01em", lineHeight: 1 }}>Ensemble</span> : null}
  </span>;
}
