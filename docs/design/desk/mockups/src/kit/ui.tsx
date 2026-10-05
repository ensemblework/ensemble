import type { CSSProperties, ReactNode } from "react";
import { ArrowUpRight, Plus, type LucideIcon } from "lucide-react";

export type State = "populated" | "skeleton" | "empty";
export type WP = { c?: number; r?: number; state?: State; mobile?: boolean; hover?: boolean; style?: CSSProperties };

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
  ({ "--a": ACCENTS[id].hex, "--a-rgb": ACCENTS[id].rgb } as CSSProperties);

export function Tile(props: {
  title: string; icon: LucideIcon; meta?: ReactNode; right?: ReactNode; c?: number; r?: number;
  hero?: boolean; hover?: boolean; add?: boolean; children: ReactNode; style?: CSSProperties; className?: string; pad?: string; skel?: boolean;
  ghost?: { label: string; sub?: string; action: string } | false;
}) {
  const { title, icon: Icon, c = 4, r = 3, hero, hover, add, style, className, pad, skel, ghost } = props;
  const meta = ghost ? undefined : props.meta;
  const right = ghost ? undefined : props.right;
  const children = ghost ? <Ghost {...ghost}>{props.children}</Ghost> : props.children;
  return (
    <section
      className={`tile${hero ? " hero" : ""}${hover ? " hover" : ""}${skel ? " skel" : ""}${className ? " " + className : ""}`}
      style={{ gridColumn: `span ${c}`, gridRow: `span ${r}`, ...(pad ? { padding: pad } : {}), ...style }}
    >
      <header className="th">
        <span className="ti"><Icon size={12} strokeWidth={2.2} /></span>
        <span className="tt">{title}</span>
        {meta != null && <span className="tm">{meta}</span>}
        {right != null && <span className="tright">{right}</span>}
        <span className="tacts">
          {add && <span title="Add"><Plus size={12} /></span>}
          <span title="Open"><ArrowUpRight size={12} /></span>
        </span>
      </header>
      <div className="tb">{children}</div>
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
export function Ring({ p, size = 56, stroke = 5, color = "var(--a)", track = "rgba(243,238,230,0.08)", children, glow }: {
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
let sid = 0;
export function Spark({ data, w = 160, h = 40, color = "var(--a)", fill = true, dot = true, target, min, max, strokeW = 1.6, dash }: {
  data: number[]; w?: number; h?: number; color?: string; fill?: boolean; dot?: boolean; target?: number; min?: number; max?: number; strokeW?: number; dash?: boolean;
}) {
  const id = `sg${sid++}`;
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
export function Bars({ data, w = 160, h = 40, color = "var(--a)", gap = 3, hi, labels, target }: {
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
export function Heat({ weeks, cell = 11, gap = 3, color = "var(--a-rgb)", today }: { weeks: number[][]; cell?: number; gap?: number; color?: string; today?: [number, number] }) {
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

export function Seg({ n, done, color = "var(--a)", h = 6, gap = 2, partial }: { n: number; done: number; color?: string; h?: number; gap?: number; partial?: number }) {
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
export function Ghost({ children, label, sub, action }: { children: ReactNode; label: string; sub?: string; action: string }) {
  return (
    <div className="ghost">
      <div className="gx">{children}</div>
      <div className="gcta">
        <div className="gl">{label}</div>
        {sub && <div className="gs">{sub}</div>}
        <span className="gbtn"><Plus size={12} strokeWidth={2.4} />{action}</span>
      </div>
    </div>
  );
}

export function Note({ children, style }: { children: ReactNode; style: CSSProperties }) {
  return <span className="note" style={style}>{children}</span>;
}
