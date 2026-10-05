/* Plots placeholders on the customization surfaces (design only; SPEC §8).
   X-plots-widget-gallery-1440: the add-a-tile gallery with a "Plots" category, cards marked coming soon.
   X-plots-tile-settings-1440: tile settings with a greyed "Chart type" row reserved for Plots. */
import { Search, X, Plus, Lock, ChevronDown, TrendingUp, CalendarClock, ListChecks, ChartColumn, IndianRupee, Users, Sparkles, ChartNoAxesCombined, ChartSpline, ChartPie, Flag, Info } from "lucide-react";
import { Shell } from "../kit/shell";
import { accentVars } from "../kit/ui";
import { deskById } from "../desks/registry";
import { shellOpts, TodayHead } from "../desks/today";
import { SoonChip, PlotCardArt, PLOT_LINE, RingPlotToggle } from "../kit/plots";
import * as E from "../widgets/exam";

const CATS = [
  { l: "Suggested", n: 6, i: Sparkles }, { l: "Dates & deadlines", n: 5, i: CalendarClock }, { l: "Lists", n: 8, i: ListChecks },
  { l: "Charts", n: 6, i: ChartColumn }, { l: "Money", n: 3, i: IndianRupee }, { l: "People", n: 4, i: Users },
];
const CARDS = [
  { k: "any" as const, i: ChartNoAxesCombined, t: "Plot", s: "Any column against any column: bar, line, pie and more.", sz: ["S", "M", "L"] },
  { k: "trend" as const, i: ChartSpline, t: "Trend over time", s: "A dated column on x, one or more series on y.", sz: ["M", "L"] },
  { k: "breakdown" as const, i: ChartPie, t: "Breakdown", s: "Share by category, as a pie or a ranked bar.", sz: ["S", "M"] },
];

export function PlotsGallery() {
  const d = deskById("chambers");
  return (
    <Shell o={shellOpts(d)}>
      <div className="page">
        <TodayHead desk={d} />
        <div className="bento">{d.tiles()}</div>
      </div>
      <div style={{ position: "fixed", inset: 0, background: "rgba(12,10,8,0.64)", backdropFilter: "blur(2px)", zIndex: 40 }} />
      <div style={{ position: "fixed", left: "calc(50% + 104px)", top: 92, transform: "translateX(-50%)", width: 1000, zIndex: 41, ...accentVars(d.accent) }}>
        <div className="modal">
          <div className="row gap12" style={{ padding: "16px 20px", borderBottom: "1px solid var(--line)" }}>
            <div className="col" style={{ gap: 2 }}>
              <span className="display" style={{ fontSize: 22 }}>Add a tile</span>
              <span className="faint" style={{ fontSize: 12.5 }}>to Chambers · Today · it lands in the first free slot</span>
            </div>
            <div className="row gap8" style={{ marginLeft: "auto", width: 300, height: 32, padding: "0 10px", borderRadius: 9, border: "1px solid var(--line-strong)", background: "rgba(243,238,230,0.03)", color: "var(--faint)", fontSize: 12.5 }}><Search size={13} />Search tiles<span className="kbd" style={{ marginLeft: "auto" }}>/</span></div>
            <span className="icon-btn"><X size={15} /></span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "208px minmax(0,1fr)", minHeight: 540 }}>
            <div className="col" style={{ padding: "14px 10px", gap: 2, borderRight: "1px solid var(--line)" }}>
              <span className="cap" style={{ padding: "4px 10px 8px" }}>Categories</span>
              {CATS.map((c) => (
                <div key={c.l} className="nav" style={{ fontSize: 13 }}><c.i size={15} strokeWidth={1.8} />{c.l}<span className="faint" style={{ marginLeft: "auto", fontSize: 11.5 }}>{c.n}</span></div>
              ))}
              <div style={{ height: 1, background: "var(--line)", margin: "8px 8px" }} />
              <div className="nav" data-on style={{ fontSize: 13 }}><ChartNoAxesCombined size={15} strokeWidth={1.8} />Plots<span className="soon" style={{ marginLeft: "auto", height: 17, fontSize: 9.5, padding: "0 6px" }}>soon</span></div>
              <div className="faint" style={{ fontSize: 11, lineHeight: 1.45, padding: "10px 10px 0", marginTop: "auto" }}>Plots is on the way. Its tiles are listed so you know where they'll go; they can't be added yet.</div>
            </div>
            <div className="col" style={{ padding: "18px 22px 20px", gap: 14 }}>
              <div className="row gap10">
                <span className="display" style={{ fontSize: 20 }}>Plots</span>
                <SoonChip />
                <span className="faint" style={{ fontSize: 12, marginLeft: "auto" }}>3 reserved tiles</span>
              </div>
              <div style={{ fontSize: 13, color: "var(--muted)", marginTop: -6, maxWidth: 620, lineHeight: 1.5 }}>{PLOT_LINE}. Bar, line, pie and more, 2D only, with row caps and type checks on the way in.</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                {CARDS.map((c) => (
                  <div key={c.t} className="tile pslot" style={{ padding: 10, gap: 0 }}>
                    <div style={{ position: "relative", height: 150, borderRadius: 10, overflow: "hidden", background: "rgba(0,0,0,0.12)" }}>
                      <div className="pframe" />
                      <PlotCardArt kind={c.k} />
                      <span className="soon" style={{ position: "absolute", left: 10, top: 10 }}><i />Coming soon</span>
                    </div>
                    <div className="col" style={{ padding: "12px 6px 4px", gap: 5, position: "relative", zIndex: 1 }}>
                      <div className="row gap8"><span className="ti" style={{ width: 20, height: 20, borderRadius: 6, display: "grid", placeItems: "center", color: "var(--a)", background: "rgb(var(--a-rgb) / 0.12)" }}><c.i size={12} strokeWidth={2.2} /></span><span style={{ fontSize: 14, fontWeight: 600 }}>{c.t}</span></div>
                      <span className="faint" style={{ fontSize: 12, lineHeight: 1.45, minHeight: 35 }}>{c.s}</span>
                      <div className="row gap6" style={{ marginTop: 6 }}>
                        {["S", "M", "L"].map((z) => <span key={z} className="mono" style={{ width: 22, height: 20, borderRadius: 5, display: "grid", placeItems: "center", fontSize: 10, border: "1px solid var(--line)", color: c.sz.includes(z) ? "var(--muted)" : "var(--ghost)", opacity: c.sz.includes(z) ? 1 : 0.5 }}>{z}</span>)}
                        <span className="gbtn off" aria-disabled="true" style={{ marginLeft: "auto", padding: "3px 10px", fontSize: 11.5 }}><Plus size={11} strokeWidth={2.4} />Add</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="row gap12" style={{ padding: "12px 14px", borderRadius: 12, border: "1px solid var(--line)", background: "rgba(243,238,230,0.02)" }}>
                <Info size={15} color="var(--a)" style={{ flexShrink: 0 }} />
                <div className="col" style={{ gap: 2, flex: 1 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>Already plot-ready on this desk</span>
                  <span className="faint" style={{ fontSize: 12 }}>Billable keeps its ring today. When Plots arrives, the same tile can switch to a plot of your hours without moving.</span>
                </div>
                <RingPlotToggle />
              </div>
              <div className="row sb" style={{ marginTop: "auto", paddingTop: 12, borderTop: "1px solid var(--line)" }}>
                <span className="mono faint" style={{ fontSize: 10.5 }}>Plots category shows only while the plots flag is on · cards are display-only</span>
                <span className="btn">Done</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}

export function PlotsTileSettings() {
  const d = deskById("exam");
  // Mock scores sits at cols 7–12, rows 5–7 of the Exam season bento (1180 px wide: col 87.33 px, gap 12 px).
  const colW = (1180 - 11 * 12) / 12;
  const tileX = 6 * (colW + 12), tileY = 4 * (72 + 12);
  return (
    <Shell o={shellOpts(d)}>
      <div className="page">
        <TodayHead desk={d} />
        <div style={{ position: "relative" }}>
          <div className="bento">
            <E.Countdown />
            <E.DailyTarget />
            <E.Affairs />
            <E.Syllabus />
            <E.MockTrend />
            <E.RevisionQueue />
            <E.HoursHeat />
            <E.PyqAccuracy />
          </div>
          <div style={{ position: "absolute", inset: 0, background: "rgba(12,10,8,0.5)", zIndex: 3, pointerEvents: "none", clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 ${tileY - 4}px, ${tileX - 4}px ${tileY - 4}px, ${tileX - 4}px ${tileY + 244}px, ${tileX + 588}px ${tileY + 244}px, ${tileX + 588}px ${tileY - 4}px, 0 ${tileY - 4}px)` }} />
          <div style={{ position: "absolute", left: tileX - 3, top: tileY - 3, width: 590, height: 246, borderRadius: 16, boxShadow: "0 0 0 1.5px rgb(var(--a-rgb) / 0.6), 0 0 40px -6px rgb(var(--a-rgb) / 0.35)", zIndex: 4, pointerEvents: "none" }} />
          <div className="modal" style={{ position: "absolute", left: tileX - 372, top: tileY - 176, width: 356, zIndex: 6, padding: 0 }}>
            <div className="row gap8" style={{ padding: "14px 16px 12px", borderBottom: "1px solid var(--line)" }}>
              <span className="ti" style={{ width: 22, height: 22, borderRadius: 6, display: "grid", placeItems: "center", color: "var(--a)", background: "rgb(var(--a-rgb) / 0.12)" }}><TrendingUp size={12} strokeWidth={2.2} /></span>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Tile settings</span>
              <span className="faint" style={{ fontSize: 12 }}>Mock scores</span>
              <span className="icon-btn" style={{ marginLeft: "auto", width: 24, height: 24 }}><X size={14} /></span>
            </div>
            <div className="col" style={{ padding: "6px 16px 14px" }}>
              <SetRow l="Title"><span className="field">Mock scores</span></SetRow>
              <SetRow l="Size">
                <span className="segtog">{["S", "M", "L"].map((z) => z === "M" ? <b key={z}>M</b> : <span key={z} className="off" style={{ color: "var(--muted)" }}>{z}</span>)}</span>
              </SetRow>
              <SetRow l="Series"><span className="field">GS I · out of 200<ChevronDown size={12} style={{ marginLeft: "auto" }} /></span></SetRow>
              <SetRow l="Target line"><span className="field" style={{ width: 80 }}>110</span></SetRow>
              <SetRow l="Cut-off band"><span className="switch on"><i /></span></SetRow>
              <div className="setrow off" aria-disabled="true">
                <div className="row sb">
                  <span className="row gap6 sl"><Lock size={11} />Chart type</span>
                  <span className="field dis">Line<ChevronDown size={12} style={{ marginLeft: "auto" }} /></span>
                </div>
                <div className="row gap8" style={{ marginTop: 8 }}>
                  <SoonChip />
                  <span style={{ fontSize: 11.5, color: "var(--faint)", lineHeight: 1.4 }}>Reserved for Plots: bar, line, area, pie and more, 2D only.</span>
                </div>
              </div>
            </div>
            <div className="row sb" style={{ padding: "12px 16px", borderTop: "1px solid var(--line)" }}>
              <span className="btn-g" style={{ color: "var(--danger)", paddingLeft: 0 }}>Remove tile</span>
              <span className="btn-p">Done</span>
            </div>
          </div>
          <span className="note" style={{ left: tileX - 372, top: tileY + 292, zIndex: 7 }}>Chart type · greyed, aria-disabled · reserved for Plots</span>
          <span className="note" style={{ left: tileX - 372, top: tileY + 322, zIndex: 7 }}>row hidden while the plots flag is off</span>
          <span className="note" style={{ left: tileX + 300, top: tileY - 30, zIndex: 7 }}>plot type chip · marked soon</span>
        </div>
      </div>
    </Shell>
  );
}

function SetRow({ l, children }: { l: string; children: React.ReactNode }) {
  return <div className="setrow"><div className="row sb"><span className="sl">{l}</span>{children}</div></div>;
}
export { Flag };
