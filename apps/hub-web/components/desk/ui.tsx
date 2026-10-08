"use client";

import { createContext, useContext, useId, type CSSProperties, type ReactNode } from "react";
import { ArrowUpRight, EyeOff, Plus, type LucideIcon } from "lucide-react";
import Link from "next/link";

export type State = "populated" | "skeleton" | "empty";

/**
 * An ancestor is already the link (a marketplace card, a preview inside one).
 * Tile must not render another anchor or button there: nested interactive
 * content is invalid HTML and breaks hydration.
 */
const DeskPreviewContext = createContext(false);
export function DeskPreviewProvider({ children }: { children: ReactNode }) {
  return <DeskPreviewContext.Provider value={true}>{children}</DeskPreviewContext.Provider>;
}
export type WP = { c?: number; r?: number; state?: State; mobile?: boolean; hover?: boolean; style?: CSSProperties; plots?: boolean };

export const ACCENTS = {
  indigo: { hex: "#7c6af7", rgb: "124 106 247", label: "Indigo" },
  orchid: { hex: "#cf9cf2", rgb: "207 156 242", label: "Orchid" },
  rose: { hex: "#f0a0b8", rgb: "240 160 184", label: "Rose" },
  ember: { hex: "#f0a36a", rgb: "240 163 106", label: "Ember" },
  brass: { hex: "#e4c56e", rgb: "228 197 110", label: "Brass" },
  moss: { hex: "#a9cc7e", rgb: "169 204 126", label: "Moss" },
  tide: { hex: "#5dcec6", rgb: "93 206 198", label: "Tide" },
  sky: { hex: "#82b3f5", rgb: "130 179 245", label: "Sky" },
} as const;
export type AccentId = keyof typeof ACCENTS;
export const accentVars = (id: AccentId): CSSProperties =>
  ({ "--accent": ACCENTS[id].hex, "--accent-rgb": ACCENTS[id].rgb } as CSSProperties);

export function Tile(props: {
  title: string; icon: LucideIcon; meta?: ReactNode; right?: ReactNode; c?: number; r?: number;
  hero?: boolean; hover?: boolean; add?: boolean; openHref?: string; onAdd?: () => void; children: ReactNode; style?: CSSProperties; className?: string; pad?: string; skel?: boolean; mark?: string;
  ghost?: { label: string; sub?: string; action?: string; kind?: string; onAction?: () => void } | false;
  /** Layout controls from LiveBoard: a move grip before the title, hide in the actions, a resize corner. */
  deskKey?: string; grip?: ReactNode; onHide?: () => void; corner?: ReactNode; attrs?: Record<string, string | undefined>;
}) {
  const { title, icon: Icon, c = 4, r = 3, hero, hover, style, className, pad, skel, ghost, mark } = props;
  const preview = useContext(DeskPreviewContext);
  const widget = mark ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const meta = ghost ? undefined : props.meta;
  const right = ghost ? undefined : props.right;
  const children = ghost ? <Ghost {...ghost}>{props.children}</Ghost> : props.children;
  return (
    <section
      {...props.attrs}
      data-widget={widget || undefined}
      data-desk-key={props.deskKey}
      data-desk-tile={ghost ? "ghost" : "live"}
      className={`tile${hero ? " hero" : ""}${hover ? " hover" : ""}${skel ? " skel" : ""}${className ? " " + className : ""}`}
      style={{ gridColumn: `span ${c}`, gridRow: `span ${r}`, ...(pad ? { padding: pad } : {}), ...style }}
    >
      <header className="th">
        {props.grip}
        <span className="ti"><Icon size={12} strokeWidth={2.2} /></span>
        <span className="tt">{title}</span>
        {meta != null && <span className="tm">{meta}</span>}
        {right != null && <span className="tright">{right}</span>}
        {props.onAdd || props.openHref || (props.onHide && !preview) ? (
          <span className="tacts">
            {props.onAdd ? (
              preview ? (
                <span title="Add" aria-hidden="true">
                  <Plus size={12} />
                </span>
              ) : (
                <button type="button" title="Add" aria-label={`Add to ${title}`} onClick={props.onAdd}>
                  <Plus size={12} />
                </button>
              )
            ) : null}
            {props.openHref ? (
              preview ? (
                <span title="Open" aria-hidden="true">
                  <ArrowUpRight size={12} />
                </span>
              ) : (
                <Link href={props.openHref} title="Open" aria-label={`Open ${title}`}>
                  <ArrowUpRight size={12} />
                </Link>
              )
            ) : null}
            {props.onHide && !preview ? (
              <button type="button" title="Hide tile" aria-label={`Hide ${title}`} onClick={props.onHide}>
                <EyeOff size={12} />
              </button>
            ) : null}
          </span>
        ) : null}
      </header>
      <div className="tb">{children}</div>
      {preview ? null : props.corner}
    </section>
  );
}

/* ── Numerals ─────────────────────────────────────────────────────────── */
export function Num({ v, size = 44, unit, color, style }: { v: ReactNode; size?: number; unit?: ReactNode; color?: string; style?: CSSProperties }) {
  return (
    <span className="row" style={{ alignItems: "baseline", gap: 4, ...style }}>
      <span className="num" style={{ fontSize: size, color: color ?? "var(--ink)" }}>{v}</span>
      {unit && <span style={{ fontSize: Math.max(11, size * 0.26), color: "var(--faint)", fontWeight: 500 }}>{unit}</span>}
    </span>
  );
}

/* ── Ring ─────────────────────────────────────────────────────────────── */
export function Ring({ p, size = 56, stroke = 5, color = "var(--accent)", track = "rgba(243,238,230,0.08)", children, glow }: {
  p: number; size?: number; stroke?: number; color?: string; track?: string; children?: ReactNode; glow?: boolean;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)", overflow: "visible" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${c * Math.max(0.001, Math.min(1, p))} ${c}`}
          style={glow ? { filter: `drop-shadow(0 0 6px ${color})` } : undefined} />
      </svg>
      {children && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>{children}</div>}
    </div>
  );
}

/* ── Sparkline ────────────────────────────────────────────────────────── */
export function Spark({ data, w = 160, h = 40, color = "var(--accent)", fill = true, dot = true, target, min, max, strokeW = 1.6, dash }: {
  data: number[]; w?: number; h?: number; color?: string; fill?: boolean; dot?: boolean; target?: number; min?: number; max?: number; strokeW?: number; dash?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const lo = min ?? Math.min(...data, target ?? Infinity);
  const hi = max ?? Math.max(...data, target ?? -Infinity);
  const pad = 3;
  const x = (i: number) => pad + (i * (w - pad * 2)) / (data.length - 1);
  const y = (v: number) => pad + (h - pad * 2) * (1 - (v - lo) / (hi - lo || 1));
  const pts = data.map((v, i) => [x(i), y(v)] as const);
  // smooth path
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i]; const mx = (x0 + x1) / 2;
    d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
  }
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {target != null && (
        <line x1={0} x2={w} y1={y(target)} y2={y(target)} stroke="rgba(243,238,230,0.35)" strokeDasharray="3 4" strokeWidth={1} />
      )}
      {fill && <path d={`${d} L${last[0]},${h} L${pts[0][0]},${h} Z`} fill={`url(#${id})`} />}
      <path d={d} fill="none" stroke={color} strokeWidth={strokeW} strokeLinecap="round" strokeDasharray={dash ? "3 3" : undefined} />
      {dot && (
        <>
          <circle cx={last[0]} cy={last[1]} r={5} fill={color} opacity={0.18} />
          <circle cx={last[0]} cy={last[1]} r={2.6} fill={color} />
        </>
      )}
    </svg>
  );
}

/* ── Bars ─────────────────────────────────────────────────────────────── */
export function Bars({ data, w = 160, h = 40, color = "var(--accent)", gap = 3, hi, labels, target }: {
  data: number[]; w?: number; h?: number; color?: string; gap?: number; hi?: number; labels?: string[]; target?: number;
}) {
  const max = Math.max(...data, target ?? 0);
  const bw = (w - gap * (data.length - 1)) / data.length;
  const lh = labels ? 14 : 0;
  return (
    <svg width={w} height={h + lh} style={{ display: "block", overflow: "visible" }}>
      {target != null && <line x1={0} x2={w} y1={h - (target / max) * h} y2={h - (target / max) * h} stroke="rgba(243,238,230,0.3)" strokeDasharray="3 4" />}
      {data.map((v, i) => {
        const bh = Math.max(2, (v / max) * h);
        return (
          <g key={i}>
            <rect x={i * (bw + gap)} y={h - bh} width={bw} height={bh} rx={Math.min(3, bw / 2)} fill={color} opacity={hi === undefined ? 0.85 : i === hi ? 1 : 0.32} />
            {labels && <text x={i * (bw + gap) + bw / 2} y={h + 11} textAnchor="middle" fontSize="9.5" fill={i === hi ? "var(--ink-2)" : "var(--faint)"} fontFamily="Figtree">{labels[i]}</text>}
          </g>
        );
      })}
    </svg>
  );
}

/* ── Heat grid ────────────────────────────────────────────────────────── */
export function Heat({ weeks, cell = 11, gap = 3, color = "var(--accent-rgb)", today }: { weeks: number[][]; cell?: number; gap?: number; color?: string; today?: [number, number] }) {
  const op = [0, 0.22, 0.42, 0.66, 0.95];
  return (
    <svg width={weeks.length * (cell + gap) - gap} height={7 * (cell + gap) - gap} style={{ display: "block" }}>
      {weeks.map((wk, x) =>
        wk.map((v, y) => (
          <rect key={`${x}-${y}`} x={x * (cell + gap)} y={y * (cell + gap)} width={cell} height={cell} rx={2.5}
            fill={v < 0 ? "transparent" : v === 0 ? "rgba(243,238,230,0.055)" : `rgb(${color} / ${op[v]})`}
            stroke={today && today[0] === x && today[1] === y ? "var(--ink)" : "none"} strokeWidth={1.2} />
        )),
      )}
    </svg>
  );
}
export function makeHeat(weeks: number, seed: number, bias = 0.5, lastDay = 6): number[][] {
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      if (w === weeks - 1 && d > lastDay) return -1;
      const r = rnd() + (w / weeks) * bias * 0.6 - (d >= 5 ? 0.18 : 0);
      return r < 0.25 ? 0 : r < 0.5 ? 1 : r < 0.72 ? 2 : r < 0.9 ? 3 : 4;
    }),
  );
}

/* ── Avatars ──────────────────────────────────────────────────────────── */
const AV = ["#e7a08a", "#7eb8c9", "#8fbf9f", "#e0b15a", "#c9a4e0", "#d4c07a", "#f0a0b8", "#9fb4e8", "#b8c98f"];
export function initials(n: string) {
  const p = n.replace(/^(Dr\.|Ms\.|Mr\.|Prof\.|Adv\.)\s*/, "").split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase();
}
export function Av({ n, s = 26, ring }: { n: string; s?: number; ring?: string }) {
  let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return (
    <span className="av" style={{ width: s, height: s, fontSize: s * 0.4, background: AV[h % AV.length], boxShadow: ring ? `0 0 0 2px var(--tile), 0 0 0 3.5px ${ring}` : undefined }}>
      {initials(n)}
    </span>
  );
}
export function AvStack({ names, s = 24, max = 4 }: { names: string[]; s?: number; max?: number }) {
  return (
    <span className="avs">
      {names.slice(0, max).map((n) => <Av key={n} n={n} s={s} />)}
      {names.length > max && <span className="av" style={{ width: s, height: s, fontSize: s * 0.38, background: "var(--raised)", color: "var(--muted)" }}>+{names.length - max}</span>}
    </span>
  );
}

/* ── Stacked horizontal bar ───────────────────────────────────────────── */
export function Stacked({ parts, h = 10, gap = 2 }: { parts: { v: number; c: string; o?: number }[]; h?: number; gap?: number }) {
  const t = parts.reduce((a, b) => a + b.v, 0);
  return (
    <div style={{ display: "flex", gap, height: h }}>
      {parts.map((p, i) => (
        <div key={i} style={{ flex: p.v / t, background: p.c, opacity: p.o ?? 1, borderRadius: 3 }} />
      ))}
    </div>
  );
}

export function Seg({ n, done, color = "var(--accent)", h = 6, gap = 2, partial }: { n: number; done: number; color?: string; h?: number; gap?: number; partial?: number }) {
  return (
    <div style={{ display: "flex", gap, height: h }}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} style={{ flex: 1, borderRadius: 2, background: i < done ? color : i === done && partial ? `linear-gradient(90deg, ${color} ${partial * 100}%, rgba(243,238,230,0.08) ${partial * 100}%)` : "rgba(243,238,230,0.08)" }} />
      ))}
    </div>
  );
}

export function Pct({ v }: { v: number }) {
  return <span>{Math.round(v * 100)}<span style={{ fontSize: "0.7em", opacity: 0.7 }}>%</span></span>;
}

/* skeleton block */
export function Sk({ w = "100%", h = 10, r = 5, style }: { w?: number | string; h?: number; r?: number; style?: CSSProperties }) {
  return <div className="sk" style={{ width: w, height: h, borderRadius: r, flexShrink: 0, ...style }} />;
}

/* Empty ghost: the populated preview, dimmed, with one action */
/** An empty tile. Without an action (someone else's space), it only says what would be here. */
export function Ghost({ children, label, sub, action, kind, onAction }: { children: ReactNode; label: string; sub?: string; action?: string; kind?: string; onAction?: () => void }) {
  const preview = useContext(DeskPreviewContext);
  return (
    <div className="ghost">
      <div className="gx">{children}</div>
      <div className="gcta">
        <div className="gl">{label}</div>
        {sub && <div className="gs">{sub}</div>}
        {!action ? null : preview ? (
          <span className="gbtn" aria-hidden="true">
            <Plus size={12} strokeWidth={2.4} />
            {action}
          </span>
        ) : (
          <button type="button" className="gbtn" data-desk-add={kind ?? action} onClick={onAction}>
            <Plus size={12} strokeWidth={2.4} />
            {action}
          </button>
        )}
      </div>
    </div>
  );
}

export function Note({ children, style }: { children: ReactNode; style: CSSProperties }) {
  return <span className="note" style={style}>{children}</span>;
}

/* One spec the later Plots product can drive. Existing charts go through Chart. */
export type ChartKind = "bar" | "line" | "spark" | "ring" | "heat" | "stacked";
export type ChartSpec = {
  type: ChartKind;
  series: Array<{ name?: string; data: number[]; color?: string }>;
  x?: string[];
  y?: string;
  target?: number;
  band?: [number, number];
};

export function Chart({ spec, w = 160, h = 40 }: { spec: ChartSpec; w?: number; h?: number }) {
  const series = spec.series[0];
  const data = series?.data ?? [];
  const color = series?.color ?? "var(--accent)";
  if (spec.type === "bar") return <Bars data={data} w={w} h={h} color={color} labels={spec.x} target={spec.target} hi={data.length - 1} />;
  if (spec.type === "ring") {
    const value = data[0] ?? 0;
    const max = spec.target || 1;
    return <Ring p={Math.max(0, Math.min(1, value / max))} color={color} />;
  }
  if (spec.type === "stacked") {
    return <Stacked parts={spec.series.map((row) => ({ v: row.data[0] ?? 0, c: row.color ?? color }))} />;
  }
  return <Spark data={data} w={w} h={h} color={color} target={spec.target} min={spec.band?.[0]} max={spec.band?.[1]} strokeW={spec.type === "line" ? 2 : 1.6} />;
}
