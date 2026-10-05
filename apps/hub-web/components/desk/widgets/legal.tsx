"use client";
import { CalendarClock, Gavel, Hourglass, Layers, FileSignature, FilePen, PhoneCall, Target, Scale, IndianRupee, ListTodo, Mail, MessageCircle, Phone } from "lucide-react";
import { Tile, Num, Ring, Bars, Av, Sk, Ghost, Spark, type WP } from "../ui";
import { RingPlotToggle } from "../plots";

/* 60-day horizon from Wed 30 Sept 2026 */
const H = 60;
type Pin = { d: number; label: string; what: string; court: string; date: string; note?: string };
export const PINS: Pin[] = [
  { d: 5, label: "Rao v. Sunrise Hospital", what: "First appeal · NCDRC", court: "NCDRC", date: "Mon, 5 Oct", note: "Falls on 2 Oct (Gandhi Jayanti). s.4 moves it to 5 Oct." },
  { d: 6, label: "Mehta Textiles v. UoI", what: "SLP (C) · 90 days", court: "Supreme Court", date: "Tue, 6 Oct" },
  { d: 14, label: "Arora v. DLF Homes", what: "Written version · 30+15", court: "State Commission", date: "Wed, 14 Oct" },
  { d: 19, label: "Nair Estates v. Kochhar", what: "Written statement · 120-day bar", court: "Commercial Court, Saket", date: "Mon, 19 Oct" },
  { d: 27, label: "Joshi v. Joshi", what: "First appeal · s.96 CPC", court: "Delhi HC", date: "Tue, 27 Oct" },
  { d: 41, label: "Bharat Infra v. NHAI", what: "s.34 petition · 3 months", court: "Delhi HC", date: "Tue, 10 Nov" },
  { d: 56, label: "Kapoor v. State", what: "Criminal revision", court: "Sessions, Tis Hazari", date: "Wed, 25 Nov" },
];
const zone = (d: number) => (d <= 7 ? "r" : d <= 21 ? "y" : "g");
const zc = { r: "var(--danger)", y: "var(--warn)", g: "rgba(243,238,230,0.55)" } as const;
const WEEKS = [{ d: 5, l: "5 Oct" }, { d: 12, l: "12 Oct" }, { d: 19, l: "19 Oct" }, { d: 26, l: "26 Oct" }, { d: 33, l: "2 Nov" }, { d: 40, l: "9 Nov" }, { d: 47, l: "16 Nov" }, { d: 54, l: "23 Nov" }];

function Band({ compact, ghost }: { compact?: boolean; ghost?: boolean }) {
  const pct = (d: number) => `${(d / H) * 100}%`;
  const pins = ghost ? PINS.slice(1, 5) : PINS;
  return (
    <div style={{ position: "relative", height: compact ? 64 : 104, marginTop: compact ? 4 : 0 }}>
      {/* pins labels */}
      {!compact && pins.map((p, i) => {
        const z = zone(p.d);
        const up = i % 2 === 0;
        const right = p.d > 48;
        return (
          <div key={p.label} style={{ position: "absolute", left: pct(p.d), top: up ? 0 : 22, bottom: 36, width: 0 }}>
            <div style={{ position: "absolute", left: 0, top: 14, bottom: 0, borderLeft: `1px solid ${z === "g" ? "rgba(243,238,230,0.22)" : zc[z]}`, opacity: 0.75 }} />
            <div style={{ position: "absolute", top: 0, [right ? "right" : "left"]: -3, whiteSpace: "nowrap", fontSize: 11.5, display: "flex", gap: 6, alignItems: "center", color: z === "g" ? "var(--muted)" : "var(--ink)" } as React.CSSProperties}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: zc[z], transform: "rotate(45deg)", flexShrink: 0, order: right ? 2 : 0 }} />
              <span style={{ fontWeight: 600 }}>{p.label.split(" v. ")[0]}</span>
              <span style={{ color: "var(--faint)" }}>{p.date.replace(/^\w+, /, "")}</span>
            </div>
          </div>
        );
      })}
      {/* band */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 16, height: compact ? 30 : 22, borderRadius: 7, overflow: "hidden", background: "rgba(243,238,230,0.03)", boxShadow: "inset 0 0 0 1px rgba(243,238,230,0.06)" }}>
        <div style={{ position: "absolute", left: 0, width: pct(7.5), top: 0, bottom: 0, background: "linear-gradient(90deg, rgb(227 107 100 / 0.42), rgb(227 107 100 / 0.2))" }} />
        <div style={{ position: "absolute", left: pct(7.5), width: pct(14), top: 0, bottom: 0, background: "linear-gradient(90deg, rgb(224 160 74 / 0.28), rgb(224 160 74 / 0.1))" }} />
        <div style={{ position: "absolute", left: pct(21.5), right: 0, top: 0, bottom: 0, background: "linear-gradient(90deg, rgb(var(--accent-rgb) / 0.08), rgb(var(--accent-rgb) / 0.02))" }} />
        {/* day ticks */}
        <div style={{ position: "absolute", inset: 0, backgroundImage: `repeating-linear-gradient(90deg, rgba(243,238,230,0.08) 0 1px, transparent 1px ${100 / H}%)` }} />
        {/* weekend hatch for holiday 2 Oct */}
        <div style={{ position: "absolute", left: pct(2), width: pct(1), top: 0, bottom: 0, backgroundImage: "repeating-linear-gradient(135deg, rgba(243,238,230,0.25) 0 1.5px, transparent 1.5px 4px)" }} />
        {pins.map((p) => (
          <div key={p.label} style={{ position: "absolute", left: pct(p.d), top: "50%", width: 9, height: 9, marginLeft: -4.5, marginTop: -4.5, borderRadius: 99, background: zc[zone(p.d)], boxShadow: `0 0 0 3px var(--tile), 0 0 12px ${zc[zone(p.d)]}` }} />
        ))}
      </div>
      {/* today marker */}
      <div style={{ position: "absolute", left: 0, bottom: 10, height: compact ? 42 : 34, borderLeft: "2px solid var(--accent)" }} />
      {/* axis */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 12, fontSize: 10.5, color: "var(--faint)" }}>
        <span style={{ position: "absolute", left: 0, color: "var(--accent)", fontWeight: 600 }}>Today</span>
        {WEEKS.filter((w, i) => !compact || i === 1 || i === 3 || i === 5).map((w) => (
          <span key={w.d} style={{ position: "absolute", left: pct(w.d), transform: "translateX(-50%)" }}>{w.l}</span>
        ))}
      </div>
    </div>
  );
}

export function LimitationHero(p: WP) {
  const c = p.c ?? 12, r = p.r ?? 4;
  if (p.state === "skeleton")
    return (
      <Tile title="Limitation · next 60 days" icon={Hourglass} c={c} r={r} hero skel>
        <div className="row gap16" style={{ alignItems: "flex-end", marginBottom: 18 }}><Sk w={70} h={62} r={10} /><div className="col gap8"><Sk w={260} h={12} /><Sk w={180} h={10} /></div></div>
        <Sk h={22} r={7} style={{ marginTop: 28 }} />
        <div className="row gap10" style={{ marginTop: 22 }}>{[0, 1, 2, 3].map((i) => <Sk key={i} h={62} r={10} style={{ flex: 1 }} />)}</div>
      </Tile>
    );
  if (p.state === "empty")
    return (
      <Tile title="Limitation · next 60 days" icon={Hourglass} c={c} r={r} hero meta="Nothing tracked yet">
        <Ghost label="The band keeps every limitation date in sight" sub="Add a matter with its order date. Ensemble counts the period under the Limitation Act and pins it here." action="Add your first limitation date">
          <HeroBody />
        </Ghost>
      </Tile>
    );
  return (
    <Tile title="Limitation · next 60 days" icon={Hourglass} c={c} r={r} hero meta="7 matters · Limitation Act, 1963" right="Counted from order dates" hover={p.hover} add>
      <HeroBody />
    </Tile>
  );
}
function Legend() {
  const items = [
    { n: 2, l: "inside 7 days", c: "var(--danger)" },
    { n: 2, l: "inside 21 days", c: "var(--warn)" },
    { n: 3, l: "calm", c: "rgba(243,238,230,0.5)" },
  ];
  return (
    <div className="row" style={{ marginLeft: "auto", gap: 22, paddingBottom: 8 }}>
      {items.map((i) => (
        <div key={i.l} className="col gap4" style={{ alignItems: "flex-start" }}>
          <span className="num" style={{ fontSize: 30, color: i.c }}>{i.n}</span>
          <span className="row gap4" style={{ fontSize: 11.5, color: "var(--faint)" }}><span className="sq" style={{ background: i.c, width: 6, height: 6 }} />{i.l}</span>
        </div>
      ))}
    </div>
  );
}
function HeroBody() {
  return (
    <>
      <div className="row gap16" style={{ alignItems: "flex-end", marginBottom: 6 }}>
        <Num v="5" size={76} unit="days" color="var(--ink)" />
        <div className="col gap4" style={{ paddingBottom: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Rao v. Sunrise Hospital <span className="faint" style={{ fontWeight: 400 }}>· First appeal before NCDRC</span></div>
          <div className="row gap6" style={{ fontSize: 12.5, color: "var(--muted)" }}>
            <span className="pill r">Mon, 5 Oct</span>30 days from the order of 2 Sept. Day 30 is Gandhi Jayanti, so s.4 carries it to Monday.
          </div>
        </div>
        <Legend />
      </div>
      <Band />
      <div className="row gap10" style={{ marginTop: 12 }}>
        {PINS.slice(1, 5).map((p) => {
          const z = zone(p.d);
          return (
            <div key={p.label} style={{ flex: 1, minWidth: 0, borderRadius: 10, padding: "8px 10px", background: "rgba(243,238,230,0.025)", border: "1px solid rgba(243,238,230,0.06)", boxShadow: `inset 2px 0 0 ${zc[z]}` }}>
              <div className="row sb"><span className="trunc" style={{ fontSize: 12.5, fontWeight: 600 }}>{p.label}</span><span className="num" style={{ fontSize: 20, color: z === "g" ? "var(--ink-2)" : zc[z] }}>{p.d}<span style={{ fontSize: 11, fontFamily: "Figtree", color: "var(--faint)", letterSpacing: 0 }}>d</span></span></div>
              <div className="trunc" style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 1 }}>{p.what} · {p.court}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function LimitationMobile() {
  return (
    <Tile title="Limitation · 60 days" icon={Hourglass} c={4} r={4} hero meta="7 matters" pad="16px 16px">
      <div className="row gap12" style={{ alignItems: "flex-end" }}>
        <Num v="5" size={64} unit="days" />
        <div className="col" style={{ paddingBottom: 6, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>Rao v. Sunrise Hospital</div>
          <div className="faint" style={{ fontSize: 12 }}>NCDRC appeal · moved to Mon, 5 Oct</div>
        </div>
      </div>
      <Band compact />
      <div className="col" style={{ marginTop: 6 }}>
        {PINS.slice(1, 4).map((p) => (
          <div key={p.label} className="li"><span className="sq" style={{ background: zc[zone(p.d)], transform: "rotate(45deg)", width: 7, height: 7 }} /><span className="t">{p.label}</span><span className="m">{p.date}</span></div>
        ))}
      </div>
    </Tile>
  );
}

/* Hearings this week — calendar strip */
type Hear = { t: string; c: string; w: string; past?: boolean };
const DAYS: { d: string; n: number; today?: boolean; holiday?: string; items: Hear[] }[] = [
  { d: "Mon", n: 28, items: [{ t: "10:30", c: "Saket", w: "Nair · framing of issues", past: true }] },
  { d: "Tue", n: 29, items: [{ t: "2:00", c: "Delhi HC", w: "Bharat Infra · s.9 interim", past: true }] },
  { d: "Wed", n: 30, today: true, items: [{ t: "10:30 am", c: "Delhi HC · Ct 32", w: "State v. Khanna · bail" }, { t: "2:15 pm", c: "NCDRC", w: "Rao · admission" }] },
  { d: "Thu", n: 1, items: [{ t: "11:00", c: "Tis Hazari", w: "Joshi · evidence" }, { t: "3:30", c: "Chamber", w: "Arora · client meet" }] },
  { d: "Fri", n: 2, holiday: "Gandhi Jayanti", items: [] },
  { d: "Sat", n: 3, items: [{ t: "11:00", c: "Mediation", w: "Nair v. Kochhar" }] },
];
export function Hearings(p: WP) {
  const c = p.c ?? 6, r = p.r ?? 3;
  if (p.state === "skeleton")
    return (
      <Tile title="Hearings this week" icon={Gavel} c={c} r={r} skel>
        <div className="row gap8" style={{ flex: 1 }}>{DAYS.map((d) => <div key={d.n} className="col gap6" style={{ flex: 1 }}><Sk w={26} h={9} /><Sk w={20} h={18} /><Sk h={40} r={8} style={{ marginTop: 6 }} /></div>)}</div>
      </Tile>
    );
  if (p.state === "empty")
    return (
      <Tile title="Hearings this week" icon={Gavel} c={c} r={r}>
        <Ghost label="No hearings listed this week" action="Add your first hearing"><HearBody /></Ghost>
      </Tile>
    );
  if (p.mobile)
    return (
      <Tile title="Hearings" icon={Gavel} c={c} r={r} meta="4 still to come">
        <div className="col">
          {DAYS.filter((d) => !d.items.every((i) => i.past) || d.holiday).slice(0, 4).map((d) => (
            <div key={d.n} className="row gap10" style={{ padding: "6px 0", borderTop: d.today ? 0 : "1px solid rgba(243,238,230,0.055)", alignItems: "flex-start" }}>
              <div className="col" style={{ width: 34, alignItems: "center" }}><span className="cap" style={{ color: d.today ? "var(--accent)" : undefined }}>{d.d}</span><span className="num" style={{ fontSize: 20 }}>{d.n}</span></div>
              <div className="col gap4 grow" style={{ minWidth: 0 }}>
                {d.holiday ? <span className="faint" style={{ fontSize: 12, paddingTop: 8 }}>Court holiday · {d.holiday}</span> : d.items.map((it) => (
                  <div key={it.w} className="row gap8" style={{ fontSize: 12.5 }}><span style={{ width: 3, alignSelf: "stretch", borderRadius: 2, background: "var(--accent)" }} /><span className="grow trunc">{it.w}</span><span className="faint" style={{ fontSize: 11.5 }}>{it.t}</span></div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Tile>
    );
  return (
    <Tile title="Hearings this week" icon={Gavel} c={c} r={r} meta="6 listed" right="28 Sept – 3 Oct" hover={p.hover} add>
      <HearBody />
    </Tile>
  );
}
function HearBody() {
  return (
    <div className="row" style={{ flex: 1, gap: 6, alignItems: "stretch" }}>
      {DAYS.map((d) => (
        <div key={d.n} className="col" style={{ flex: d.today ? 1.35 : 1, minWidth: 0, gap: 5, borderRadius: 10, padding: "6px 6px 8px", background: d.today ? "rgb(var(--accent-rgb) / 0.09)" : "transparent", boxShadow: d.today ? "inset 0 0 0 1px rgb(var(--accent-rgb) / 0.28)" : "none" }}>
          <div className="row sb" style={{ padding: "0 2px" }}>
            <span className="cap" style={{ color: d.today ? "var(--accent)" : undefined }}>{d.d}</span>
            <span className="num" style={{ fontSize: 20, color: d.today ? "var(--ink)" : "var(--muted)" }}>{d.n}</span>
          </div>
          {d.holiday && (
            <div style={{ flex: 1, borderRadius: 7, display: "grid", placeItems: "center", textAlign: "center", fontSize: 11, color: "var(--faint)", backgroundImage: "repeating-linear-gradient(135deg, rgba(243,238,230,0.05) 0 2px, transparent 2px 7px)", padding: 4 }}>Court holiday<br />{d.holiday}</div>
          )}
          {d.items.map((it) => (
            <div key={it.w} style={{ borderRadius: 7, padding: "5px 6px", background: it.past ? "rgba(243,238,230,0.03)" : "rgba(243,238,230,0.055)", borderLeft: `2px solid ${it.past ? "rgba(243,238,230,0.15)" : "var(--accent)"}`, opacity: it.past ? 0.55 : 1 }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: it.past ? "var(--muted)" : "var(--ink)" }}>{it.t}</div>
              <div style={{ fontSize: 11.5, lineHeight: 1.25, marginTop: 1, color: "var(--ink-2)" }}>{it.w}</div>
              <div style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 2 }} className="trunc">{it.c}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function Billable(p: WP) {
  const c = p.c ?? 3, r = p.r ?? 3;
  if (p.state === "skeleton")
    return (
      <Tile title="Billable" icon={Target} c={c} r={r} skel>
        <div className="row gap12"><Sk w={74} h={74} r={99} /><div className="col gap8"><Sk w={60} h={26} /><Sk w={80} h={9} /></div></div>
        <Sk h={40} style={{ marginTop: "auto" }} />
      </Tile>
    );
  if (p.state === "empty")
    return (
      <Tile title="Billable" icon={Target} c={c} r={r}>
        <Ghost label="Set a weekly target" action="Log your first hour"><BillBody /></Ghost>
      </Tile>
    );
  // Plots flag on: Ring · Plot toggle. Off: "this week" returns to the meta slot.
  if (p.plots) return <Tile title="Billable" icon={Target} c={c} r={r} right={<RingPlotToggle />} hover={p.hover}><BillBody week /></Tile>;
  return <Tile title="Billable" icon={Target} c={c} r={r} meta="this week" hover={p.hover}><BillBody /></Tile>;
}
function BillBody({ week }: { week?: boolean }) {
  return (
    <>
      <div className="row gap12">
        <Ring p={31.5 / 40} size={74} stroke={6}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>79%</span>
        </Ring>
        <div className="col gap4">
          <Num v="31.5" size={34} unit="h" />
          <span style={{ fontSize: 12, color: "var(--faint)" }}>of 40 h{week ? " · this week" : " target"}</span>
        </div>
      </div>
      <div style={{ marginTop: "auto" }}>
        <Bars data={[6.5, 7, 8.5, 5.5, 4, 0]} w={200} h={34} hi={2} labels={["M", "T", "W", "T", "F", "S"]} target={6.7} />
      </div>
    </>
  );
}

const STAGES = [
  { l: "Pleadings", n: 5, o: 1 }, { l: "Evidence", n: 3, o: 0.72 }, { l: "Arguments", n: 2, o: 0.5 }, { l: "Reserved", n: 1, o: 0.34 }, { l: "Execution", n: 2, o: 0.2 },
];
export function Stages(p: WP) {
  const c = p.c ?? 3, r = p.r ?? 3;
  return (
    <Tile title="Matters by stage" icon={Layers} c={c} r={r} meta="13 active" hover={p.hover} ghost={p.state === "empty" && { label: "Every matter, by stage", action: "Add a matter" }}>
      <div style={{ display: "flex", gap: 3, height: 64, alignItems: "flex-end" }}>
        {STAGES.map((s) => (
          <div key={s.l} style={{ flex: s.n, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 5 }}>
            <span className="num" style={{ fontSize: 22, color: "var(--ink)", paddingLeft: 2 }}>{s.n}</span>
            <div style={{ height: 10, borderRadius: 3, background: `rgb(var(--accent-rgb) / ${s.o})` }} />
          </div>
        ))}
      </div>
      <div className="col" style={{ marginTop: 12, gap: 5 }}>
        {STAGES.map((s) => (
          <div key={s.l} className="row gap8" style={{ fontSize: 12 }}>
            <span className="sq" style={{ background: `rgb(var(--accent-rgb) / ${s.o})` }} />
            <span className="grow ink2">{s.l}</span>
            <span className="faint">{s.l === "Reserved" ? "Joshi · since 11 Sept" : s.l === "Arguments" ? "next 7 Oct" : s.n}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}

export function CauseList(p: WP) {
  if (p.mobile)
    return (
      <Tile title="Cause list" icon={Scale} c={2} r={2} pad="14px 14px">
        <Num v="14" size={40} />
        <span className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>Ct 32 · board at 9</span>
        <div style={{ marginTop: "auto", display: "flex", gap: 2 }}>{Array.from({ length: 14 }, (_, i) => <div key={i} style={{ flex: 1, height: 5, borderRadius: 2, background: i < 9 ? "rgba(243,238,230,0.35)" : i === 13 ? "var(--accent)" : "rgba(243,238,230,0.08)" }} />)}</div>
      </Tile>
    );
  return (
    <Tile ghost={p.state === "empty" && { label: "Your item on the board", action: "Link a cause list" }} title="Cause list · live" icon={Scale} c={p.c ?? 3} r={p.r ?? 2} right={<span className="row gap4"><span className="dot" style={{ background: "var(--ok)", boxShadow: "0 0 0 3px rgb(var(--ok-rgb)/0.2)" }} />Ct 32</span>}>
      <div className="row gap10" style={{ alignItems: "flex-end" }}>
        <Num v="14" size={44} />
        <div className="col" style={{ paddingBottom: 4 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>State v. Khanna</span>
          <span className="faint" style={{ fontSize: 11.5 }}>Board at item 9 · ~11:40 am</span>
        </div>
      </div>
      <div style={{ marginTop: "auto", display: "flex", gap: 2 }}>
        {Array.from({ length: 20 }, (_, i) => (
          <div key={i} style={{ flex: 1, height: 6, borderRadius: 2, background: i < 9 ? "rgba(243,238,230,0.35)" : i === 13 ? "var(--accent)" : "rgba(243,238,230,0.08)", boxShadow: i === 13 ? "0 0 8px var(--accent)" : "none" }} />
        ))}
      </div>
    </Tile>
  );
}

export function Unbilled(p: WP) {
  if (p.mobile)
    return (
      <Tile title="Unbilled" icon={IndianRupee} c={2} r={2} pad="14px 14px">
        <Num v="₹3.84" size={32} unit="L" />
        <span className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>6 matters · oldest 41d</span>
        <div style={{ marginTop: "auto" }}><Spark data={[1.2, 1.6, 1.9, 2.1, 2.6, 2.9, 3.4, 3.84]} w={130} h={20} /></div>
      </Tile>
    );
  return (
    <Tile title="Unbilled" icon={IndianRupee} c={p.c ?? 3} r={p.r ?? 2} meta="6 matters" ghost={p.state === "empty" && { label: "Time not yet invoiced", action: "Set your hourly rate" }}>
      <div className="row sb" style={{ alignItems: "flex-end" }}>
        <Num v="₹3.84" size={36} unit="lakh" />
        <Spark data={[1.2, 1.6, 1.9, 2.1, 2.6, 2.9, 3.4, 3.84]} w={80} h={30} />
      </div>
      <div className="row gap6" style={{ marginTop: "auto", fontSize: 11.5, color: "var(--faint)" }}>
        <span className="pill y">Bharat Infra ₹1,62,000</span><span>oldest 41 days</span>
      </div>
    </Tile>
  );
}

const FILINGS = [
  { d: "2", m: "Oct", t: "Vakalatnama + memo of appeal", mt: "Rao v. Sunrise", s: "Ready to file", k: "g" },
  { d: "5", m: "Oct", t: "SLP paper book, 4 sets", mt: "Mehta Textiles", s: "Vetting · Adv. Sen", k: "y" },
  { d: "9", m: "Oct", t: "Court fee · ₹12,500 e-stamp", mt: "Arora v. DLF", s: "Pay by 8 Oct", k: "y" },
  { d: "14", m: "Oct", t: "Written version, 38 pp", mt: "Arora v. DLF", s: "Draft 2 of 3", k: "" },
  { d: "16", m: "Oct", t: "Affidavit of admission/denial", mt: "Nair Estates", s: "Not started", k: "r" },
];
export function Filings(p: WP) {
  const c = p.c ?? 5, r = p.r ?? 4;
  if (p.state === "skeleton")
    return (
      <Tile title="Filings due" icon={FileSignature} c={c} r={r} skel>
        {[0, 1, 2, 3].map((i) => <div key={i} className="row gap10" style={{ padding: "8px 0" }}><Sk w={36} h={36} r={9} /><div className="col gap6 grow"><Sk w="70%" h={10} /><Sk w="40%" h={8} /></div><Sk w={70} h={16} r={99} /></div>)}
      </Tile>
    );
  if (p.state === "empty")
    return (
      <Tile title="Filings due" icon={FileSignature} c={c} r={r}>
        <Ghost label="Nothing due to file" sub="Filings you add appear here with their date, matter and stage." action="Add a filing"><FilBody /></Ghost>
      </Tile>
    );
  return <Tile title="Filings due" icon={FileSignature} c={c} r={r} meta="5 in 16 days" hover={p.hover} add><FilBody /></Tile>;
}
function FilBody() {
  return (
    <div className="col">
      {FILINGS.map((f) => (
        <div key={f.t} className="li" style={{ padding: "7px 0" }}>
          <div className="col" style={{ width: 38, height: 38, borderRadius: 9, alignItems: "center", justifyContent: "center", background: "rgba(243,238,230,0.04)", border: "1px solid rgba(243,238,230,0.07)", flexShrink: 0 }}>
            <span className="num" style={{ fontSize: 17 }}>{f.d}</span>
            <span style={{ fontSize: 9, color: "var(--faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 1 }}>{f.m}</span>
          </div>
          <div className="col grow" style={{ minWidth: 0 }}>
            <span className="t">{f.t}</span>
            <span className="m">{f.mt}</span>
          </div>
          <span className={`pill ${f.k}`}>{f.s}</span>
        </div>
      ))}
    </div>
  );
}

function Doc({ marks, label, sub }: { marks: number[]; label: string; sub: string }) {
  return (
    <div className="col gap6" style={{ flex: 1, minWidth: 0 }}>
      <div style={{ borderRadius: 8, background: "linear-gradient(180deg, #37312a, #2d2822)", border: "1px solid rgba(243,238,230,0.1)", padding: "12px 12px", height: 196, display: "flex", flexDirection: "column", gap: 5, boxShadow: "0 10px 24px -12px rgba(0,0,0,0.8)", position: "relative", overflow: "hidden" }}>
        <div style={{ height: 5, width: "46%", background: "rgba(243,238,230,0.5)", borderRadius: 2, marginBottom: 5 }} />
        {Array.from({ length: 17 }, (_, i) => (
          <div key={i} style={{ height: 3, width: `${[92, 86, 95, 70, 90, 88, 60, 94, 80, 91, 76, 89, 55, 93, 84, 90, 48][i]}%`, borderRadius: 2, background: marks.includes(i) ? (i % 2 ? "rgb(227 107 100 / 0.85)" : "rgb(60 186 134 / 0.85)") : "rgba(243,238,230,0.16)" }} />
        ))}
      </div>
      <div className="row sb" style={{ fontSize: 12 }}><span style={{ fontWeight: 600 }}>{label}</span><span className="faint">{sub}</span></div>
    </div>
  );
}
export function Drafts(p: WP) {
  return (
    <Tile title="Draft pair" icon={FilePen} c={p.c ?? 4} r={p.r ?? 4} meta="Arora v. DLF" hover={p.hover} ghost={p.state === "empty" && { label: "Two drafts, side by side", sub: "Drop two versions of a pleading; changes are marked line by line.", action: "Add the two drafts" }}>
      <div className="row gap10"><Doc marks={[]} label="Draft 1" sub="Adv. Sen · 22 Sept" /><Doc marks={[2, 3, 6, 9, 11, 14, 15]} label="Draft 2" sub="You · today" /></div>
      <div className="row gap8" style={{ marginTop: "auto", fontSize: 12 }}>
        <span className="pill g">+14 lines</span><span className="pill r">−9 lines</span><span className="faint">Paras 7, 12, 18 reworded</span>
      </div>
    </Tile>
  );
}

const FOLLOW = [
  { n: "Sunita Rao", m: "Rao v. Sunrise", w: "Needs signed vakalatnama", last: "Called 2d ago", ch: Phone, hot: true },
  { n: "Vikram Mehta", m: "Mehta Textiles", w: "Certified copy of HC order", last: "Email 5d ago", ch: Mail, hot: true },
  { n: "Ritu Arora", m: "Arora v. DLF", w: "Payment receipts for 2019", last: "WhatsApp 9d", ch: MessageCircle },
  { n: "Harish Nair", m: "Nair Estates", w: "Board resolution for suit", last: "Meeting Sat", ch: CalendarClock },
];
export function FollowUps(p: WP) {
  return (
    <Tile title="Client follow-ups" icon={PhoneCall} c={p.c ?? 6} r={p.r ?? 3} meta="4 waiting on clients" hover={p.hover} add ghost={p.state === "empty" && { label: "What each client still owes you", action: "Add a client" }}>
      <div className="col">
        {FOLLOW.map((f) => (
          <div key={f.n} className="li">
            <Av n={f.n} s={26} ring={f.hot ? "var(--warn)" : undefined} />
            <div className="col grow" style={{ minWidth: 0 }}><span className="t">{f.w}</span><span className="m">{f.n} · {f.m}</span></div>
            <span className="row gap4 m"><f.ch size={12} />{f.last}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}

const WORK = [
  { t: "Final read of Rao appeal memo", mt: "Rao v. Sunrise", due: "today", p: "r", mins: 45 },
  { t: "Index and paginate SLP paper book", mt: "Mehta Textiles", due: "tomorrow", p: "r", mins: 90 },
  { t: "Mark objections in Kochhar plaint", mt: "Nair Estates", due: "Fri", p: "y", mins: 60 },
  { t: "Research: s.12A pre-institution mediation", mt: "Nair Estates", due: "next wk", p: "", mins: 30 },
];
export function LegalFocus(p: WP) {
  return (
    <Tile title="Focus" icon={ListTodo} c={p.c ?? 6} r={p.r ?? 3} meta="4 today · 3 h 45 m" hover={p.hover} add ghost={p.state === "empty" && { label: "The day's work, by matter", action: "Add a task" }}>
      <div className="col">
        {WORK.map((w) => (
          <div key={w.t} className="li">
            <span style={{ width: 15, height: 15, borderRadius: 99, border: `1.5px solid ${w.p === "r" ? "var(--danger)" : w.p === "y" ? "var(--warn)" : "rgba(243,238,230,0.3)"}`, flexShrink: 0 }} />
            <div className="col grow" style={{ minWidth: 0 }}><span className="t">{w.t}</span><span className="m">{w.mt}</span></div>
            <span className="m">{w.mins} min</span>
            <span className={`pill ${w.due === "today" ? "r" : ""}`} style={{ minWidth: 62, justifyContent: "center" }}>{w.due}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}
