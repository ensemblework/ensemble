import { Shell } from "../kit/shell";
import { accentVars, type AccentId } from "../kit/ui";
import * as L from "../widgets/legal";
import * as E from "../widgets/exam";
import * as D from "../widgets/dev";
import { PlotSlot } from "../kit/plots";
import { Fragment, type ReactNode } from "react";

const ROWS: { name: string; persona: string; accent: AccentId; size: string; note?: string; render: (s: "skeleton" | "empty" | "populated") => ReactNode }[] = [
  { name: "Filings due", persona: "Chambers", accent: "brass", size: "L · 4 rows", render: (s) => <L.Filings state={s} c={4} r={4} /> },
  { name: "Mock scores", persona: "Exam season", accent: "rose", size: "M · 3 rows", render: (s) => <E.MockTrend state={s} c={4} r={3} /> },
  { name: "Pull requests needing you", persona: "Branch desk", accent: "indigo", size: "L · 4 rows (compact)", render: (s) => <D.PrQueue state={s} c={4} r={4} mobile /> },
  { name: "Billable", persona: "Chambers", accent: "brass", size: "M · 3 rows", render: (s) => <L.Billable state={s} c={4} r={3} /> },
  {
    name: "Plot slot · reserved", persona: "Staff week", accent: "ember", size: "M · 3 rows · static tile",
    note: "The placeholder is what ships (behind the plots flag). The third tile is illustrative: the same footprint once Plots exists.",
    render: (s) => s === "populated" ? <PlotSlot preview title="Load trend" c={4} r={3} /> : <PlotSlot state={s === "skeleton" ? "skeleton" : undefined} title="Load trend" meta="plot slot · 8 weeks" c={4} r={3} />,
  },
];

export function StatesSheet() {
  return (
    <div style={{ minHeight: "100vh", background: "radial-gradient(900px 400px at 0% 0%, rgba(124,106,247,0.08), transparent 60%), var(--bg)" }}>
      <div className="sheet">
        <div className="cap" style={{ marginBottom: 8 }}>Ensemble · Desk design · Sheet A2</div>
        <h1 className="display">Three states, one shape</h1>
        <p className="lede">A tile keeps its footprint from the first paint to the last row. The skeleton is the final layout in outline; empty is the real widget, dimmed, with exactly one action; populated is the finished tile. Nothing jumps, nothing collapses.</p>
        <div style={{ display: "grid", gridTemplateColumns: "180px repeat(3, 1fr)", gap: 16, marginTop: 30, alignItems: "end" }}>
          <span />
          {[["Skeleton", "Final shape in outline. Shimmer 1.4 s, off under reduced motion."], ["Empty · ghost", "The populated tile at 22% with one clear action."], ["Populated", "Real data, signature visual first."]].map(([h, s]) => (
            <div key={h}><div className="display" style={{ fontSize: 20 }}>{h}</div><div className="faint" style={{ fontSize: 12, marginTop: 2 }}>{s}</div></div>
          ))}
        </div>
        {ROWS.map((row) => (
          <div key={row.name} style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 16, marginTop: 18, ...accentVars(row.accent) }}>
            <div className="col" style={{ paddingTop: 14, gap: 4 }}>
              <span className="deskchip" style={{ alignSelf: "flex-start" }}><i />{row.persona}</span>
              <span style={{ fontSize: 15, fontWeight: 600, marginTop: 6 }}>{row.name}</span>
              <span className="faint" style={{ fontSize: 12 }}>{row.size}</span>
              {row.note && <span className="faint" style={{ fontSize: 11.5, lineHeight: 1.45, marginTop: 6 }}>{row.note}</span>}
            </div>
            <div className="bento">{row.render("skeleton")}{row.render("empty")}{row.render("populated")}</div>
          </div>
        ))}
        <Motion />
      </div>
    </div>
  );
}

const TRACKS = [
  { l: "Tiles rise in", d: "opacity 0→1, translateY 6→0 · 240 ms · 20 ms stagger per tile", s: 0, e: 240, stag: true },
  { l: "Rings draw", d: "stroke-dashoffset 100%→value · 700 ms · ease-out", s: 80, e: 780 },
  { l: "Numerals count up", d: "0→value in 12 steps · 600 ms · tabular figures, no reflow", s: 80, e: 680 },
  { l: "List rows stagger", d: "opacity + 4 px · 20 ms apart · max 8 rows animate", s: 120, e: 300, stag: true },
  { l: "Sparklines", d: "path length reveal · 500 ms, end dot pops last", s: 160, e: 660 },
  { l: "Hover lift", d: "translateY −1.5 px, border to 14% · 120 ms", s: 0, e: 120, hover: true },
];
function Motion() {
  const W = 900, T = 900;
  return (
    <div style={{ marginTop: 48 }}>
      <h2 className="display" style={{ fontSize: 26, margin: "0 0 4px" }}>Motion, all cheap CSS</h2>
      <div className="faint" style={{ fontSize: 13, marginBottom: 18 }}>Transform and opacity only. No layout animation, no JS timers beyond one IntersectionObserver per desk. Under <span className="mono">prefers-reduced-motion</span> or the in-app setting, every track below is skipped and the final frame paints at once.</div>
      <div className="tile" style={{ padding: 22, ...accentVars("brass") }}>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr 360px", gap: 16, alignItems: "center" }}>
          <span className="cap">Track</span>
          <div style={{ position: "relative", height: 14 }}>{[0, 200, 400, 600, 800].map((t) => <span key={t} className="mono faint" style={{ position: "absolute", left: `${(t / T) * 100}%`, fontSize: 10 }}>{t} ms</span>)}</div>
          <span className="cap">Spec</span>
          {TRACKS.map((t) => (
            <Fragment key={t.l}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t.l}</span>
              <div key={t.l + "b"} style={{ position: "relative", height: 22, backgroundImage: `repeating-linear-gradient(90deg, rgba(243,238,230,0.05) 0 1px, transparent 1px ${(100 / T) * 100}%)` }}>
                {t.stag ? [0, 1, 2, 3, 4, 5].map((i) => <span key={i} style={{ position: "absolute", left: `${((t.s + i * 20) / T) * 100}%`, width: `${((t.e - t.s) / T) * 100}%`, top: 3 + i * 2.6, height: 3, borderRadius: 2, background: `rgb(var(--a-rgb) / ${0.9 - i * 0.12})` }} />) : <span style={{ position: "absolute", left: `${(t.s / T) * 100}%`, width: `${((t.e - t.s) / T) * 100}%`, top: 6, height: 10, borderRadius: 5, background: t.hover ? "rgba(243,238,230,0.35)" : "linear-gradient(90deg, rgb(var(--a-rgb) / 0.9), rgb(var(--a-rgb) / 0.25))" }} />}
              </div>
              <span key={t.l + "d"} className="mono faint" style={{ fontSize: 11 }}>{t.d}</span>
            </Fragment>
          ))}
        </div>
        <div className="row" style={{ gap: 24, marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--line)" }}>
          {[["Budget", "≤ 16 ms per frame on a 4× throttled CPU; nothing animates after 900 ms"], ["Trigger", "on first mount of the desk only; revisits within a session paint final state"], ["Reduced motion", "data-reduce-motion or the OS flag: rings and numerals render at value, no stagger"], ["Skeleton", "shimmer is a background-position loop on one gradient; stops once data lands"]].map(([h, s]) => (
            <div key={h} className="col" style={{ flex: 1, gap: 4 }}><span style={{ fontSize: 13, fontWeight: 600 }}>{h}</span><span className="faint" style={{ fontSize: 12, lineHeight: 1.45 }}>{s}</span></div>
          ))}
        </div>
      </div>
      <span style={{ display: "none" }}>{W}</span>
    </div>
  );
}
export { Shell };
