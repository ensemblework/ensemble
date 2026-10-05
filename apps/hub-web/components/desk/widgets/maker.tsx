"use client";
import { Fragment } from "react";
import { GanttChart, PackageCheck, FlaskConical, NotebookPen, Wallet, Truck, Zap, Milestone, Thermometer, ShoppingCart, Wrench, Camera } from "lucide-react";
import { Tile, Num, Ring, Spark, Sk, type WP } from "../ui";

/* weeks: 7 Sept .. 29 Nov (12 weeks); today = 30 Sept = week 3 + 2/7 */
const WK = ["7 Sep", "14", "21", "28", "5 Oct", "12", "19", "26", "2 Nov", "9", "16", "23"];
const TODAY = 3 + 2 / 7;
const ROWS = [
  { l: "Schematic · rev C", s: 0, e: 1.6, p: 1 },
  { l: "PCB layout + DRC", s: 1.3, e: 2.9, p: 1 },
  { l: "Fab + assembly · JLCPCB", s: 2.9, e: 4.4, p: 0.35, note: "shipped · DHL" },
  { l: "Enclosure · print + fit", s: 3.6, e: 5.2, p: 0.1 },
  { l: "Bench bring-up", s: 4.4, e: 6.2, p: 0 },
  { l: "Thermal + load tests", s: 6, e: 8.2, p: 0 },
  { l: "Field trial · Nashik farm", s: 9.3, e: 11.6, p: 0 },
];
const MS = [{ x: 4.3, l: "Boards arrive 8 Oct" }, { x: 9.3, l: "Trial 16 Nov" }];

export function Gantt(p: WP) {
  const c = p.c ?? 12, r = p.r ?? 4;
  if (p.state === "skeleton") return <Tile title="Build · Solar pump controller rev C" icon={GanttChart} c={c} r={r} hero skel>{ROWS.map((x, i) => <div key={i} className="row gap12" style={{ padding: "5px 0" }}><Sk w={150} h={9} /><Sk w={`${(x.e - x.s) * 7}%`} h={12} style={{ marginLeft: `${x.s * 7}%` }} /></div>)}</Tile>;
  const ghost = p.state === "empty" && { label: "Milestones on a timeline", sub: "", action: "Add your first milestone" };
  const pct = (w: number) => `${(w / 12) * 100}%`;
  return (
    <Tile title="Build · Solar pump controller, rev C" icon={GanttChart} c={c} r={r} hero meta="7 stages · 12 weeks" right="On track · 1 stage at risk" hover={p.hover} ghost={ghost} add>
      <div style={{ display: "grid", gridTemplateColumns: "190px 1fr", flex: 1, minHeight: 0 }}>
        <div />
        <div style={{ position: "relative", height: 18, borderBottom: "1px solid var(--line)" }}>
          {WK.map((w, i) => <span key={i} style={{ position: "absolute", left: pct(i), fontSize: 10.5, color: "var(--faint)", paddingLeft: 4 }}>{w}</span>)}
        </div>
        <div className="col" style={{ justifyContent: "space-around", paddingTop: 6, paddingBottom: 20 }}>
          {ROWS.map((x) => <div key={x.l} className="row gap8" style={{ height: 24, fontSize: 12.5, color: x.p === 1 ? "var(--faint)" : "var(--ink-2)" }}><span className="sq" style={{ background: x.p === 1 ? "var(--ok)" : x.p > 0 ? "var(--accent)" : "rgba(243,238,230,0.2)", borderRadius: 99 }} /><span className="trunc">{x.l}</span></div>)}
        </div>
        <div style={{ position: "relative", paddingTop: 6, paddingBottom: 20, display: "flex", flexDirection: "column", justifyContent: "space-around", backgroundImage: `repeating-linear-gradient(90deg, rgba(243,238,230,0.04) 0 1px, transparent 1px ${100 / 12}%)` }}>
          {ROWS.map((x) => (
            <div key={x.l} style={{ position: "relative", height: 24 }}>
              <div style={{ position: "absolute", left: pct(x.s), width: pct(x.e - x.s), top: 5, height: 14, borderRadius: 5, background: x.p === 1 ? "rgb(60 186 134 / 0.25)" : "rgba(243,238,230,0.06)", border: `1px solid ${x.p === 1 ? "rgb(60 186 134 / 0.4)" : x.p > 0 ? "rgb(var(--accent-rgb) / 0.5)" : "rgba(243,238,230,0.1)"}`, overflow: "hidden" }}>
                {x.p > 0 && x.p < 1 && <div style={{ width: `${x.p * 100}%`, height: "100%", background: "linear-gradient(90deg, rgb(var(--accent-rgb) / 0.5), var(--accent))" }} />}
              </div>
              {x.note && <span style={{ position: "absolute", left: `calc(${pct(x.e)} + 8px)`, top: 5, fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}><Truck size={11} style={{ verticalAlign: -1 }} /> {x.note}</span>}
            </div>
          ))}
          {MS.map((m) => (
            <div key={m.l} style={{ position: "absolute", left: pct(m.x), top: 0, bottom: 0 }}>
              <div style={{ position: "absolute", top: 0, bottom: 0, borderLeft: "1px dashed rgb(var(--accent-rgb) / 0.4)" }} />
              <span style={{ position: "absolute", bottom: 1, left: -5, width: 10, height: 10, transform: "rotate(45deg)", background: "var(--accent)", borderRadius: 2 }} />
              <span style={{ position: "absolute", bottom: -2, left: 10, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap", color: "var(--ink-2)" }}>{m.l}</span>
            </div>
          ))}
          <div style={{ position: "absolute", left: pct(TODAY), top: -22, bottom: 0, borderLeft: "1.5px solid var(--danger)" }}>
            <span style={{ position: "absolute", top: -2, left: -18, fontSize: 10, fontWeight: 700, color: "#14120f", background: "var(--danger)", borderRadius: 4, padding: "0 4px" }}>Today</span>
          </div>
        </div>
      </div>
    </Tile>
  );
}

const BOM = [
  { l: "IRFB4110 MOSFET", q: 6, src: "Robu.in", s: "in" },
  { l: "STM32G431 MCU", q: 2, src: "Mouser India", s: "ship", n: "arrives 3 Oct" },
  { l: "ACS712 current sensor", q: 2, src: "Robu.in", s: "in" },
  { l: "IP65 enclosure 200×150", q: 1, src: "Amazon", s: "ship", n: "arrives 1 Oct" },
  { l: "Heatsink 100 mm, drilled", q: 2, src: "Lamington Rd", s: "buy" },
  { l: "MC4 connectors, pair", q: 4, src: "Robu.in", s: "in" },
];
export function Bom(p: WP) {
  const ghost = p.state === "empty" && { label: "Parts, sources and what is in hand", sub: "", action: "Paste a BOM" };
  return (
    <Tile title="Parts · BOM" icon={PackageCheck} c={p.c ?? 4} r={p.r ?? 4} meta="41 lines" hover={p.hover} ghost={ghost} add>
      <div className="row gap12" style={{ alignItems: "center", marginBottom: 8 }}>
        <Ring p={34 / 41} size={52} stroke={5}><span style={{ fontSize: 11.5, fontWeight: 700 }}>83%</span></Ring>
        <div className="col"><Num v="34" size={28} unit="of 41 in hand" /><span className="faint" style={{ fontSize: 11.5, marginTop: 3 }}>5 shipping · 2 to buy</span></div>
      </div>
      <div className="col">
        {BOM.map((b) => (
          <div key={b.l} className="li">
            <span style={{ width: 14, height: 14, borderRadius: 4, flexShrink: 0, display: "grid", placeItems: "center", background: b.s === "in" ? "var(--accent)" : "transparent", border: b.s === "in" ? "none" : `1.5px ${b.s === "ship" ? "dashed" : "solid"} ${b.s === "ship" ? "var(--accent)" : "var(--warn)"}` }}>{b.s === "in" && <span style={{ color: "#14120f", fontSize: 10, fontWeight: 900 }}>✓</span>}</span>
            <span className="t" style={{ fontSize: 12.5 }}>{b.l} <span className="faint">×{b.q}</span></span>
            <span className="m">{b.n ?? b.src}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}

const TESTS = ["Continuity", "Power-on · 24 V", "MPPT tracking", "Over-current trip", "Thermal · 45 °C", "Dry-run cut-off", "Reverse polarity"];
const BUILDS = ["A1", "A2", "B1", "B2", "C1"];
const RES = [
  "ppppn", "pppp-", "fpppn", "ffpp-", "nfff-", "nnpp-", "ppp--",
];
export function TestGrid(p: WP) {
  const ghost = p.state === "empty" && { label: "Pass / fail by build", sub: "", action: "Log a test run" };
  const col = (c: string) => (c === "p" ? "rgb(60 186 134 / 0.75)" : c === "f" ? "rgb(227 107 100 / 0.85)" : c === "n" ? "rgba(243,238,230,0.06)" : "transparent");
  return (
    <Tile title="Test results" icon={FlaskConical} c={p.c ?? 4} r={p.r ?? 4} meta="7 tests × 5 builds" hover={p.hover} ghost={ghost}>
      <div className="row gap12" style={{ alignItems: "flex-end", marginBottom: 10 }}>
        <Num v="4" size={28} unit="fails on B2" color="var(--danger)" />
        <span className="faint" style={{ fontSize: 11.5, marginLeft: "auto", paddingBottom: 3 }}>C1 boards not tested yet</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr repeat(5, 28px)", gap: 4, alignItems: "center" }}>
        <span />
        {BUILDS.map((b) => <span key={b} className="mono" style={{ textAlign: "center", color: b === "B2" ? "var(--ink)" : "var(--faint)" }}>{b}</span>)}
        {TESTS.map((t, i) => (
          <Fragment key={t}>
            <span className="trunc" style={{ fontSize: 12, color: "var(--ink-2)" }}>{t}</span>
            {RES[i].split("").map((c, j) => <span key={t + j} style={{ height: 20, borderRadius: 4, background: col(c), border: c === "-" ? "1px dashed rgba(243,238,230,0.14)" : "none" }} />)}
          </Fragment>
        ))}
      </div>
      <div className="row gap10 faint" style={{ fontSize: 11, marginTop: "auto" }}><span className="row gap4"><span className="sq" style={{ background: col("p") }} />pass</span><span className="row gap4"><span className="sq" style={{ background: col("f") }} />fail</span><span className="row gap4"><span className="sq" style={{ background: col("n") }} />skipped</span><span className="row gap4"><span className="sq" style={{ border: "1px dashed rgba(243,238,230,0.3)" }} />not run</span></div>
    </Tile>
  );
}

const LOG = [
  { t: "Today 10:40", i: Thermometer, x: "B2: Q3 hit 78 °C at 6 A continuous. Added 40 mm heatsink, down to 61 °C.", k: "warn" },
  { t: "Today 9:15", i: Camera, x: "Photos of B2 rework uploaded · 6 images", k: "" },
  { t: "Tue 6:30 pm", i: ShoppingCart, x: "Ordered rev C boards · 5 pcs · ₹6,840 incl. DHL", k: "" },
  { t: "Tue 2:10 pm", i: Wrench, x: "Swapped R14 to 4.7 k; dry-run cut-off now trips at 0.4 A", k: "ok" },
  { t: "Mon 5:45 pm", i: Zap, x: "MPPT tracks within 3% on the 330 W panel", k: "ok" },
];
export function BuildLog(p: WP) {
  const ghost = p.state === "empty" && { label: "A log of the build", sub: "", action: "Write the first entry" };
  return (
    <Tile title="Build log" icon={NotebookPen} c={p.c ?? 4} r={p.r ?? 4} meta="23 entries" hover={p.hover} ghost={ghost} add>
      <div className="col" style={{ position: "relative" }}>
        <div style={{ position: "absolute", left: 11, top: 10, bottom: 10, width: 1, background: "var(--line-strong)" }} />
        {LOG.map((l) => (
          <div key={l.x} className="row gap10" style={{ padding: "5px 0", alignItems: "flex-start", position: "relative" }}>
            <span style={{ width: 23, height: 23, borderRadius: 7, display: "grid", placeItems: "center", background: "var(--tile)", border: `1px solid ${l.k === "warn" ? "rgb(224 160 74 / 0.6)" : l.k === "ok" ? "rgb(60 186 134 / 0.5)" : "var(--line-strong)"}`, color: l.k === "warn" ? "var(--warn)" : l.k === "ok" ? "var(--ok)" : "var(--muted)", flexShrink: 0 }}><l.i size={12} /></span>
            <div className="col" style={{ minWidth: 0 }}><span style={{ fontSize: 12.5, lineHeight: 1.35 }}>{l.x}</span><span className="faint" style={{ fontSize: 11 }}>{l.t}</span></div>
          </div>
        ))}
      </div>
    </Tile>
  );
}

export function Budget(p: WP) {
  return (
    <Tile title="Spend" icon={Wallet} c={p.c ?? 3} r={p.r ?? 2} meta="budget ₹25,000" hover={p.hover}>
      <Num v="₹18,420" size={30} />
      <div style={{ marginTop: "auto" }}><div className="bar" style={{ height: 7 }}><i style={{ width: "74%" }} /></div><div className="row sb faint" style={{ fontSize: 11, marginTop: 4 }}><span>74%</span><span>₹6,580 left</span></div></div>
    </Tile>
  );
}
export function LeadTime(p: WP) {
  return (
    <Tile title="Longest lead time" icon={Truck} c={p.c ?? 3} r={p.r ?? 2} hover={p.hover}>
      <Num v="3" size={34} unit="days · STM32G431" />
      <div className="faint" style={{ fontSize: 11.5, marginTop: "auto" }}>Mouser India · in transit Mumbai hub</div>
    </Tile>
  );
}
export function CurrentDraw(p: WP) {
  return (
    <Tile title="Pump current · B2" icon={Zap} c={p.c ?? 3} r={p.r ?? 2} meta="last run" hover={p.hover}>
      <div className="row sb" style={{ alignItems: "flex-end" }}><Num v="5.8" size={30} unit="A peak" /><span className="pill g" style={{ marginBottom: 4 }}>under 6 A</span></div>
      <div style={{ marginTop: "auto" }}><Spark data={[0.2, 3.9, 5.8, 5.1, 5.3, 5.2, 5.4, 5.25, 5.3, 5.2, 5.35, 0.3]} w={230} h={30} /></div>
    </Tile>
  );
}
export function NextMilestone(p: WP) {
  return (
    <Tile title="Next milestone" icon={Milestone} c={p.c ?? 3} r={p.r ?? 2} hover={p.hover}>
      <div className="row gap10" style={{ alignItems: "flex-end" }}><Num v="8" size={38} unit="days" /></div>
      <div style={{ marginTop: "auto", fontSize: 12.5 }}>Rev C boards arrive<div className="faint" style={{ fontSize: 11.5 }}>Thu, 8 Oct · then bring-up</div></div>
    </Tile>
  );
}
