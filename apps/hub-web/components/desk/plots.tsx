"use client";
/* Plots placeholders (design only). Plots is not built: these tiles reserve
   labelled slots where a Plots widget will slot in later. Static SVG + CSS,
   no chart library. See SPEC.md §8 "Plots slots (reserved)". */
import type { CSSProperties, ReactNode } from "react";
import { ChartNoAxesCombined, ChartSpline, ChevronDown, Plus, type LucideIcon } from "lucide-react";
import { Tile, Sk, type WP } from "./ui";

export type PlotSize = "S" | "M" | "L";
export const plotSize = (r: number): PlotSize => (r <= 2 ? "S" : r === 3 ? "M" : "L");
export const PLOT_LINE = "Drop a CSV, Excel or TXT file and plot anything against anything";

/* The small "Plots · coming soon" chip */
export function SoonChip({ label = "Plots · coming soon", style }: { label?: string; style?: CSSProperties }) {
  return <span className="soon" style={style}><i />{label}</span>;
}

/* Dimmed ghost chart: faint gridlines, bars, a line over them, and a pie. */
export function PlotGhostArt({ size }: { size: PlotSize }) {
  const bars = [34, 52, 44, 66, 58, 74, 62, 82, 70, 88];
  const n = bars.length;
  const bw = 200 / n;
  const line = [30, 40, 36, 52, 48, 60, 57, 68, 64, 76].map((v, i) => [i * bw + bw / 2, 100 - v] as const);
  let d = `M${line[0][0]},${line[0][1]}`;
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1]; const [x1, y1] = line[i]; const mx = (x0 + x1) / 2;
    d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
  }
  const pie = size === "S" ? 46 : size === "M" ? 70 : 92;
  const wedge = (a0: number, a1: number, r = 20) => {
    const p = (a: number) => [20 + r * Math.sin(a * 2 * Math.PI), 20 - r * Math.cos(a * 2 * Math.PI)];
    const [x0, y0] = p(a0); const [x1, y1] = p(a1);
    return `M20,20 L${x0},${y0} A${r},${r} 0 ${a1 - a0 > 0.5 ? 1 : 0} 1 ${x1},${y1} Z`;
  };
  return (
    <div className="pgart" data-size={size}>
      <div className="col" style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <div className="row" style={{ flex: 1, minHeight: 0, gap: 6, alignItems: "stretch" }}>
          {size === "L" && (
            <div className="col sb" style={{ padding: "2px 0" }}>{[0, 1, 2, 3].map((i) => <span key={i} className="pgtick" style={{ width: 14 }} />)}</div>
          )}
          <svg viewBox="0 0 200 100" preserveAspectRatio="none" style={{ flex: 1, minWidth: 0, height: "100%", display: "block", overflow: "visible" }}>
            {[25, 50, 75].map((y) => <line key={y} x1={0} x2={200} y1={y} y2={y} stroke="rgba(243,238,230,0.5)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" strokeWidth={1} />)}
            <line x1={0} x2={200} y1={100} y2={100} stroke="rgba(243,238,230,0.7)" vectorEffect="non-scaling-stroke" strokeWidth={1} />
            {bars.map((v, i) => <rect key={i} x={i * bw + bw * 0.2} y={100 - v} width={bw * 0.6} height={v} rx={1.5} fill="var(--accent)" opacity={0.55} />)}
            <path d={`${d} L${line[n - 1][0]},100 L${line[0][0]},100 Z`} fill="var(--accent)" opacity={0.12} />
            <path d={d} fill="none" stroke="var(--ink)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
          </svg>
        </div>
        {size !== "S" && (
          <div className="row sb" style={{ paddingLeft: size === "L" ? 20 : 0 }}>{Array.from({ length: size === "L" ? 6 : 4 }, (_, i) => <span key={i} className="pgtick" />)}</div>
        )}
      </div>
      <div className="col" style={{ alignItems: "center", justifyContent: "center", gap: 8, flexShrink: 0 }}>
        <svg width={pie} height={pie} viewBox="0 0 40 40" style={{ display: "block" }}>
          <path d={wedge(0, 0.46)} fill="var(--accent)" opacity={0.85} />
          <path d={wedge(0.46, 0.74)} fill="var(--accent)" opacity={0.5} />
          <path d={wedge(0.74, 1)} fill="rgba(243,238,230,0.6)" />
          <circle cx={20} cy={20} r={20} fill="none" stroke="var(--tile)" strokeWidth={0.8} />
        </svg>
        {size === "L" && (
          <div className="col" style={{ gap: 5 }}>{[0.85, 0.5, 0.3].map((o, i) => <span key={i} className="row gap4"><span className="sq" style={{ background: "var(--accent)", opacity: o }} /><span className="pgtick" style={{ width: 34 }} /></span>)}</div>
        )}
      </div>
    </div>
  );
}

/* The disabled "Add data" action */
export function AddDataOff({ small }: { small?: boolean }) {
  return <span className="gbtn off" aria-disabled="true" title="Plots is not available yet" style={small ? { padding: "3px 9px", fontSize: 11.5 } : undefined}><Plus size={small ? 11 : 12} strokeWidth={2.4} />Add data</span>;
}

/* The reserved Plot slot tile, sizes S (2 rows), M (3 rows), L (4 rows).
   `preview` = illustrative only: what the slot turns into once Plots ships. */
export function PlotSlot(p: WP & { title?: string; meta?: string; icon?: LucideIcon; preview?: boolean; note?: ReactNode }) {
  const c = p.c ?? 4, r = p.r ?? 3;
  const size = plotSize(r);
  const title = p.title ?? "Plot slot";
  const icon = p.icon ?? ChartNoAxesCombined;
  const meta = c >= 4 && !p.mobile ? p.meta ?? "reserved for Plots" : undefined;
  if (p.state === "skeleton")
    return (
      <Tile title={title} icon={icon} c={c} r={r} skel className="pslot">
        <div className="row gap12" style={{ flex: 1, alignItems: "stretch" }}>
          <div className="sk" style={{ flex: 1, borderRadius: 8 }} />
          <Sk w={size === "S" ? 46 : size === "M" ? 70 : 92} h={size === "S" ? 46 : size === "M" ? 70 : 92} r={99} style={{ alignSelf: "center" }} />
        </div>
      </Tile>
    );
  if (p.preview)
    return (
      <Tile title={title} icon={icon} c={c} r={r} meta={c >= 4 ? "bar + line" : undefined} right={<span className="pill" style={{ borderStyle: "dashed" }}>Later · illustrative</span>} hover={p.hover}>
        <PlotPreview c={c} />
      </Tile>
    );
  return (
    <Tile title={title} icon={icon} c={c} r={r} meta={meta} right={<SoonChip label={size === "S" && c <= 3 ? "Plots · soon" : undefined} />} hover={p.hover} className={`pslot${size === "S" ? " s" : ""}`}>
      <div className="pwrap">
        <div className="pframe" />
        <div className="pgx"><PlotGhostArt size={size} /></div>
        <div className="pcta">
          <div className={size === "S" ? "gs" : "gl"}>{PLOT_LINE}</div>
          <AddDataOff small={size === "S"} />
          {size === "L" && <div className="gs" style={{ marginTop: 2 }}>Bar, line, pie and more · 2D only</div>}
        </div>
      </div>
    </Tile>
  );
}

/* Chambers · Billable: "Ring · Plot" toggle, Plot side marked coming soon */
export function RingPlotToggle() {
  return (
    <span className="segtog" title="Plot view arrives with Plots">
      <b>Ring</b>
      <span className="off">Plot<em>soon</em></span>
    </span>
  );
}

/* Exam season · Mock scores: plot-ready "Plot type" affordance, coming soon */
export function PlotTypeChip({ type = "Line", compact }: { type?: string; compact?: boolean }) {
  return (
    <span className="ptype" title="Any chart type from Plots · coming soon">
      <ChartSpline size={11} strokeWidth={2.2} />
      {!compact && <span className="k">Plot-ready</span>}
      <span className="v">{type}<ChevronDown size={10} strokeWidth={2.4} /></span>
      <em>soon</em>
    </span>
  );
}

/* Illustrative only (A2 "populated" column): what a slot looks like once Plots ships. */
export function PlotPreview({ c = 4 }: { c?: number }) {
  const bars = [62, 71, 68, 84, 92, 88, 79, 96];
  const peak = [78, 90, 84, 104, 118, 110, 96, 118];
  const W = c >= 4 ? 330 : 240, H = 118, max = 125;
  const bw = W / bars.length;
  const y = (v: number) => H - (v / max) * H;
  const pts = peak.map((v, i) => [i * bw + bw / 2, y(v)] as const);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) { const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i]; const mx = (x0 + x1) / 2; d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`; }
  return (
    <div className="col" style={{ flex: 1, gap: 6 }}>
      <div className="row gap10" style={{ fontSize: 11, color: "var(--faint)" }}>
        <span className="row gap4"><span className="sq" style={{ background: "var(--accent)" }} />team avg %</span>
        <span className="row gap4"><span style={{ width: 10, height: 2, borderRadius: 2, background: "var(--ink-2)" }} />peak %</span>
        <span style={{ marginLeft: "auto" }} className="mono">team-load.csv</span>
      </div>
      <svg width={W} height={H + 14} style={{ display: "block", overflow: "visible", marginTop: "auto" }}>
        <line x1={0} x2={W} y1={y(100)} y2={y(100)} stroke="rgba(243,238,230,0.3)" strokeDasharray="3 4" />
        <text x={0} y={y(100) - 4} textAnchor="start" fontSize="9.5" fill="var(--muted)" fontFamily="Figtree">100%</text>
        {bars.map((v, i) => <rect key={i} x={i * bw + bw * 0.22} y={y(v)} width={bw * 0.56} height={H - y(v)} rx={3} fill="var(--accent)" opacity={i === bars.length - 1 ? 1 : 0.55} />)}
        <path d={d} fill="none" stroke="var(--ink-2)" strokeWidth={1.8} strokeLinecap="round" />
        {pts.map(([x, yy], i) => <circle key={i} cx={x} cy={yy} r={2.2} fill="var(--tile)" stroke="var(--ink-2)" strokeWidth={1.4} />)}
        {bars.map((_, i) => <text key={i} x={i * bw + bw / 2} y={H + 12} textAnchor="middle" fontSize="9.5" fill="var(--faint)" fontFamily="Figtree">{`W${33 + i}`}</text>)}
      </svg>
    </div>
  );
}

/* Card art for the widget gallery "Plots" category */
export function PlotCardArt({ kind }: { kind: "any" | "trend" | "breakdown" }) {
  if (kind === "any") return <div className="pgx" style={{ inset: 14 }}><PlotGhostArt size="M" /></div>;
  if (kind === "trend") {
    const a = [30, 38, 34, 48, 44, 58, 52, 66, 61, 74], b = [22, 26, 30, 28, 36, 34, 42, 40, 47, 50];
    const path = (v: number[]) => { const p = v.map((n, i) => [i * 22.2, 100 - n] as const); let d = `M${p[0][0]},${p[0][1]}`; for (let i = 1; i < p.length; i++) { const mx = (p[i - 1][0] + p[i][0]) / 2; d += ` C${mx},${p[i - 1][1]} ${mx},${p[i][1]} ${p[i][0]},${p[i][1]}`; } return d; };
    return (
      <div className="pgx" style={{ inset: 14 }}>
        <svg viewBox="0 0 200 100" preserveAspectRatio="none" style={{ width: "100%", height: "100%", display: "block" }}>
          {[25, 50, 75].map((y) => <line key={y} x1={0} x2={200} y1={y} y2={y} stroke="rgba(243,238,230,0.5)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />)}
          <path d={`${path(a)} L200,100 L0,100 Z`} fill="var(--accent)" opacity={0.18} />
          <path d={path(a)} fill="none" stroke="var(--accent)" strokeWidth={2.2} vectorEffect="non-scaling-stroke" />
          <path d={path(b)} fill="none" stroke="var(--ink)" strokeWidth={1.6} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
    );
  }
  return (
    <div className="pgx" style={{ inset: 14, alignItems: "center", gap: 18 }}>
      <svg width={84} height={84} viewBox="0 0 40 40">
        <circle cx={20} cy={20} r={15} fill="none" stroke="var(--accent)" strokeWidth={8} strokeDasharray={`${0.5 * 94.2} 94.2`} transform="rotate(-90 20 20)" />
        <circle cx={20} cy={20} r={15} fill="none" stroke="var(--accent)" strokeOpacity={0.5} strokeWidth={8} strokeDasharray={`0 ${0.5 * 94.2} ${0.3 * 94.2} 94.2`} transform="rotate(-90 20 20)" />
        <circle cx={20} cy={20} r={15} fill="none" stroke="rgba(243,238,230,0.6)" strokeWidth={8} strokeDasharray={`0 ${0.8 * 94.2} ${0.2 * 94.2} 94.2`} transform="rotate(-90 20 20)" />
      </svg>
      <div className="col" style={{ flex: 1, gap: 8 }}>
        {[0.9, 0.62, 0.4, 0.25].map((o, i) => <div key={i} style={{ height: 9, borderRadius: 4, width: `${100 - i * 18}%`, background: "var(--accent)", opacity: o }} />)}
      </div>
    </div>
  );
}
