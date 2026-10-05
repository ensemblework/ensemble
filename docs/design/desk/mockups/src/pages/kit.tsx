import { ArrowUpRight, Plus, Gavel } from "lucide-react";
import { accentVars, ACCENTS } from "../kit/ui";
import { DESKS } from "../desks/registry";
import * as L from "../widgets/legal";
import * as E from "../widgets/exam";
import { PlotSlot, SoonChip } from "../kit/plots";

const LISTS: Record<string, string[]> = {
  default: ["Your day · XL", "Needs me · S-wide", "Morning brief · S-wide", "Focus · M", "Proposals · M", "Deliverables · M", "People · M", "Reminders · M", "Focus time · Plot slot M"],
  semester: ["Week strip · XL hero", "Deadline rail · L", "Course rings · M-wide", "Study streak · S-wide", "In class now · S", "Study plan · M", "Group project · M", "Reading · M", "Study hours · Plot slot M"],
  exam: ["Countdown · XL hero", "Today's target · S-wide", "Current affairs · S-wide", "Syllabus map · M", "Mock trend · M · plot-ready", "Revision due · M", "Daily hours heat · M", "PYQ accuracy · M"],
  literature: ["Reading pipeline · XL hero", "Draft words · M", "Citation graph · M", "Reading streak · M", "Reading trend · Plot slot M", "Open questions · M", "Supervision · M", "Venue countdown · M"],
  chambers: ["Limitation band · XL hero", "Hearings strip · M", "Billable ring · M · Ring/Plot", "Matters by stage · M", "Filings due · L", "Draft pair · L", "Cause list live · S", "Unbilled · S", "Focus · M", "Client follow-ups · M"],
  classes: ["Timetable · XL hero", "Marking queue · M", "Syllabus by class · M", "Student follow-ups · M", "Attendance · S", "PTM slots · S", "Duty · S", "Paper to set · S", "Marks by class · Plot slot L"],
  staff: ["Team load · XL hero", "Blockers · L", "1:1 cadence · M", "Objectives · M", "Load trend · Plot slot M", "Decision log · M", "Who's out · M"],
  branch: ["PRs needing you · XL hero", "Branch activity · S-wide", "CI health · S-wide", "Deploys · M", "Assigned issues · M", "WIP · S", "Blocked · S", "Done this week · S", "Commit trend · Plot slot S"],
  bench: ["Build Gantt · XL hero", "Parts / BOM · L", "Test grid · L", "Build log · L", "Spend · S", "Lead time · S", "Pump current · S", "Current draw · Plot slot L", "Next milestone · S"],
};

export function KitSheet() {
  return (
    <div style={{ minHeight: "100vh", background: "radial-gradient(900px 400px at 0% 0%, rgba(228,197,110,0.07), transparent 60%), var(--bg)" }}>
      <div className="sheet" style={{ maxWidth: 1300 }}>
        <div className="cap" style={{ marginBottom: 8 }}>Ensemble · Desk design · Sheet A1</div>
        <h1 className="display">Widget kit</h1>
        <p className="lede">Every widget for the eight persona desks and the default desk, populated with real-shaped data. Each one leads with a signature visual (a serif numeral, a ring, a band, a grid) and keeps rows secondary. Tiles sit on a 12-column bento with four fixed heights.</p>
        <Foundations />
        <PlotKit />
        {DESKS.map((d) => (
          <div key={d.id} className="persona" style={accentVars(d.accent)}>
            <div className="row gap12" style={{ marginBottom: 12 }}>
              <span style={{ width: 12, height: 12, borderRadius: 99, background: "var(--a)", boxShadow: "0 0 0 4px rgb(var(--a-rgb) / 0.2)" }} />
              <span className="display" style={{ fontSize: 24 }}>{d.name}</span>
              <span className="faint" style={{ fontSize: 13 }}>{d.persona} · {ACCENTS[d.accent].label} accent</span>
              <span className="faint" style={{ fontSize: 12.5, marginLeft: "auto", maxWidth: 480, textAlign: "right" }}>{d.blurb}</span>
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
              {LISTS[d.id].map((w) => <span key={w} className="pill a" style={{ fontSize: 11 }}>{w}</span>)}
            </div>
            <div style={{ width: 1180, maxWidth: "100%" }} className="bento">{d.tiles()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* Plots placeholders (reserved, design only; SPEC §8) */
function PlotKit() {
  const sizes = [
    { k: "S", c: 3, r: 2, w: 286, h: 156, t: "Commit trend", use: "2 rows · 3–4 cols · Branch desk" },
    { k: "M", c: 4, r: 3, w: 385, h: 240, t: "Load trend", meta: "plot slot · 8 weeks", use: "3 rows · 3–4 cols · Default, Semester, Literature, Staff week" },
    { k: "L", c: 5, r: 4, w: 484, h: 324, t: "Current draw · series", meta: "plot slot · e.g. amps vs time", use: "4 rows · 5–6 cols · Classes, Bench" },
  ];
  return (
    <div className="persona" style={accentVars("indigo")}>
      <div className="row gap12" style={{ marginBottom: 12 }}>
        <span style={{ width: 12, height: 12, borderRadius: 99, background: "var(--a)", boxShadow: "0 0 0 4px rgb(var(--a-rgb) / 0.2)" }} />
        <span className="display" style={{ fontSize: 24 }}>Plot slot</span>
        <SoonChip />
        <span className="faint" style={{ fontSize: 12.5, marginLeft: "auto", maxWidth: 560, textAlign: "right" }}>Reserved space for Plots, not Plots itself. A static tile: dimmed ghost chart, one line of promise, a disabled action. It takes the accent of the desk it sits on.</span>
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        {["Plot slot · S", "Plot slot · M", "Plot slot · L", "No chart library · ≤ 1 kB", "Hidden behind the plots flag", "Billable · Ring · Plot toggle", "Mock scores · plot type chip"].map((w) => <span key={w} className="pill a" style={{ fontSize: 11 }}>{w}</span>)}
      </div>
      <div className="row" style={{ gap: 12, alignItems: "flex-end", width: 1180, maxWidth: "100%" }}>
        {sizes.map((s) => (
          <div key={s.k} className="col" style={{ gap: 8, width: s.w, flexShrink: 0 }}>
            <div className="bento" style={{ gridTemplateColumns: `repeat(${s.c}, minmax(0, 1fr))` }}><PlotSlot title={s.t} meta={s.meta} c={s.c} r={s.r} /></div>
            <div className="row gap8"><span className="num" style={{ fontSize: 22, color: "var(--a)" }}>{s.k}</span><span style={{ fontSize: 12.5, fontWeight: 600 }}>{s.h}px</span><span className="faint" style={{ fontSize: 11.5 }}>{s.use}</span></div>
          </div>
        ))}
      </div>
      <div className="bento" style={{ width: 1180, maxWidth: "100%", marginTop: 18 }}>
        <div style={{ display: "contents", ...accentVars("brass") }}><L.Billable c={3} r={3} /></div>
        <div style={{ display: "contents", ...accentVars("rose") }}><E.MockTrend c={5} r={3} /></div>
        <div className="tile" style={{ gridColumn: "span 4", gridRow: "span 3", padding: "16px 18px" }}>
          <div className="col" style={{ gap: 7, position: "relative", zIndex: 1, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.45 }}>
            <span className="display" style={{ fontSize: 18, color: "var(--ink)", marginBottom: 2 }}>Rules</span>
            <span>· Empty-ghost language: a dimmed, desaturated preview, one line, one action (here disabled).</span>
            <span>· A dashed inner frame says "reserved", not "broken".</span>
            <span>· Existing charts get an affordance, not a tile: <b className="ink2">Ring · Plot</b> and the <b className="ink2">plot type</b> chip, both marked soon.</span>
            <span>· Flag off: no slot, neighbours keep their approved spans.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Foundations() {
  const sizes = [
    { k: "S", h: 156, rows: 2, span: "3 cols", use: "one stat + one visual" },
    { k: "M", h: 240, rows: 3, span: "3–6 cols", use: "chart or 4–5 rows" },
    { k: "L", h: 324, rows: 4, span: "4–6 cols", use: "rich list, grid, pair" },
    { k: "XL", h: 324, rows: 4, span: "8–12 cols", use: "the hero, once per desk" },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.25fr 1fr", gap: 18, marginTop: 28, marginBottom: 12 }}>
      <div className="tile" style={{ padding: 22, ...accentVars("brass") }}>
        <div className="display" style={{ fontSize: 20, marginBottom: 4 }}>Grid and sizes</div>
        <div className="faint" style={{ fontSize: 12.5, marginBottom: 14 }}>12 columns · 72 px row track · 12 px gap · a tile never stretches to its neighbour. Height = rows × 72 + (rows − 1) × 12.</div>
        <div className="row" style={{ gap: 12, alignItems: "flex-end" }}>
          {sizes.map((s) => (
            <div key={s.k} className="col" style={{ gap: 8, flex: s.k === "XL" ? 2 : 1 }}>
              <div style={{ height: s.h * 0.55, borderRadius: 10, border: "1px solid rgb(var(--a-rgb) / 0.4)", background: "linear-gradient(180deg, rgb(var(--a-rgb) / 0.12), rgb(var(--a-rgb) / 0.03))", display: "grid", placeItems: "center", position: "relative" }}>
                <span className="num" style={{ fontSize: 34, color: "var(--a)" }}>{s.k}</span>
                <span className="mono" style={{ position: "absolute", right: 6, top: 5, fontSize: 10, color: "var(--muted)" }}>{s.h}px</span>
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{s.rows} rows · {s.span}</div>
              <div className="faint" style={{ fontSize: 11.5 }}>{s.use}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="tile" style={{ padding: 22, ...accentVars("brass") }}>
        <div className="display" style={{ fontSize: 20, marginBottom: 12 }}>Tile anatomy</div>
        <div style={{ position: "relative", display: "grid", gridTemplateColumns: "1fr", gridAutoRows: 72, gap: 12, marginTop: 30 }}>
          <L.CauseList c={1} r={2} hover />
          <span className="note" style={{ left: 10, top: -26 }}>icon · title · quiet meta</span>
          <span className="note" style={{ right: 4, top: -26 }}>hover: open ↗ · add +</span>
          <span className="note" style={{ left: 60, bottom: 34 }}>signature numeral · Fraunces opsz 144</span>
          <span className="note" style={{ right: 10, bottom: -14 }}>1 px top glow in template accent</span>
        </div>
        <div className="col" style={{ gap: 5, marginTop: 26, fontSize: 12, color: "var(--muted)" }}>
          <span>· Surface <span className="mono">#1e1a16</span> + 3% top gradient + accent radial at 5.5% + 5% grain</span>
          <span>· Border <span className="mono">rgba(243,238,230,.07)</span>, inner highlight <span className="mono">inset 0 1px 0 rgba(255,255,255,.045)</span></span>
          <span>· Hover lifts 1.5 px in 120 ms; actions fade in, the meta steps aside</span>
        </div>
      </div>
      <span style={{ display: "none" }}><ArrowUpRight /><Plus /><Gavel /></span>
    </div>
  );
}
