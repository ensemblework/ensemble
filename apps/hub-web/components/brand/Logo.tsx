/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * Ensemble logo: the Two voices mark (violet = the agent, paper/ink = you). THE brand mark in every motion style.
 * Hand-hinted filled paths for 16 / 20 / 24 / 32 px (whole-pixel arms, concentric arcs); any other size falls back to
 * the stroked master. Colours are fixed brand colours, NOT --accent (the user's accent choice must not recolour the logo).
 *
 *   <EnsembleMark size={16} />                     two-colour, follows [data-theme] / prefers-color-scheme via CSS vars
 *   <EnsembleMark size={20} tone="mono" />         currentColor (menus, tooltips, single-colour contexts)
 *   <EnsembleLogo size={16} />                     mark + "Ensemble" wordmark (live text, inherits the app font)
 */
import type { CSSProperties, SVGProps } from "react";

type Size = 16 | 20 | 24 | 32;
export type LogoTone = "auto" | "dark" | "light" | "mono";

const HINTED: Record<Size, { o: string; i: string }> = {
  "16": {
    "o": "M2 1H4V8A4 4 0 0 0 12 8V1H14V8A6 6 0 0 1 2 8Z",
    "i": "M5 1H7V8A1 1 0 0 0 9 8V1H11V8A3 3 0 0 1 5 8Z"
  },
  "20": {
    "o": "M2 1H5V10A5 5 0 0 0 15 10V1H18V10A8 8 0 0 1 2 10Z",
    "i": "M6 1H8V10A2 2 0 0 0 12 10V1H14V10A4 4 0 0 1 6 10Z"
  },
  "24": {
    "o": "M3 2H6V13A6 6 0 0 0 18 13V2H21V13A9 9 0 0 1 3 13Z",
    "i": "M7 2H10V13A2 2 0 0 0 14 13V2H17V13A5 5 0 0 1 7 13Z"
  },
  "32": {
    "o": "M4 5A2 2 0 0 1 8 5V17A8 8 0 0 0 24 17V5A2 2 0 0 1 28 5V17A12 12 0 0 1 4 17Z",
    "i": "M10 5A1.5 1.5 0 0 1 13 5V17A3 3 0 0 0 19 17V5A1.5 1.5 0 0 1 22 5V17A6 6 0 0 1 10 17Z"
  }
};
const MASTER = { o: "M316 300 V540 A196 196 0 0 0 708 540 V300", i: "M426 300 V540 A86 86 0 0 0 598 540 V300" };

/* "auto" reads two CSS vars so one component works on both themes; brand-pages.css / the snippet in SWAP-LIST sets them. */
const FILL: Record<LogoTone, { o: string; i: string }> = {
  auto: { o: "var(--brand-agent, #9d8fff)", i: "var(--brand-you, #f3eee6)" },
  dark: { o: "#9d8fff", i: "#f3eee6" },
  light: { o: "#7c6af7", i: "#1c1915" },
  mono: { o: "currentColor", i: "currentColor" },
};

type MarkProps = Omit<SVGProps<SVGSVGElement>, "fill"> & { size?: number; tone?: LogoTone; title?: string };

export function EnsembleMark({ size = 16, tone = "auto", title, ...rest }: MarkProps) {
  const c = FILL[tone];
  const hinted = HINTED[size as Size];
  const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": true as const };
  if (hinted) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} {...a11y} {...rest}>
        {title ? <title>{title}</title> : null}
        <path fill={c.o} d={hinted.o} />
        <path fill={c.i} d={hinted.i} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="208 208 608 608" fill="none" strokeLinecap="round" {...a11y} {...rest}>
      {title ? <title>{title}</title> : null}
      <path stroke={c.o} strokeWidth={84} d={MASTER.o} />
      <path stroke={c.i} strokeWidth={64} d={MASTER.i} />
    </svg>
  );
}

const WORD: Record<Size, number> = { 16: 14, 20: 16, 24: 18, 32: 24 };

export function EnsembleLogo({ size = 16, tone = "auto", className, style, wordmark = true }: { size?: Size; tone?: LogoTone; className?: string; style?: CSSProperties; wordmark?: boolean }) {
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.5), ...style }}>
      <EnsembleMark size={size} tone={tone} title={wordmark ? undefined : "Ensemble"} style={{ flex: "none" }} />
      {wordmark ? (
        <span style={{ fontWeight: 600, fontSize: WORD[size], letterSpacing: "-0.01em", lineHeight: 1, color: tone === "mono" ? "currentColor" : tone === "light" ? "#1c1915" : tone === "dark" ? "#f3eee6" : "var(--brand-word, inherit)" }}>Ensemble</span>
      ) : null}
    </span>
  );
}

/* CSS for tone="auto" (paste into globals.css):
   :root, [data-theme="dark"] { --brand-agent: #9d8fff; --brand-you: #f3eee6; --brand-word: #f3eee6; }
   [data-theme="light"]       { --brand-agent: #7c6af7; --brand-you: #1c1915; --brand-word: #1c1915; } */
