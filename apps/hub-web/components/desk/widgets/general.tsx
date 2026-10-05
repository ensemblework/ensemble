"use client";
import { Sun, CircleCheck, Sunrise, Crosshair, Sparkles, Package, Users, AlarmClock, Video, Coffee, Pin } from "lucide-react";
import { Tile, Num, Ring, Av, AvStack, Sk, type WP } from "../ui";

const T0 = 9, T1 = 19;
const BLOCKS = [
  { s: 9.5, e: 9.75, t: "Standup", k: "meet", w: "Teams" },
  { s: 10, e: 11.5, t: "Focus · ranker ADR", k: "focus" },
  { s: 12, e: 12.5, t: "1:1 · Priya Nandakumar", k: "meet", w: "1:1" },
  { s: 13, e: 14, t: "Lunch", k: "break" },
  { s: 14.5, e: 16, t: "Focus · retry helper PR", k: "focus" },
  { s: 16.5, e: 17, t: "Empty-state copy · Shachee", k: "meet", w: "Meet" },
  { s: 17.5, e: 18, t: "Weekly recap", k: "agent" },
];
const DUES = [{ x: 9.2, t: "Reply to Priya · overdue", r: true }, { x: 17.9, t: "Retry helper PR due" }];

export function YourDay(p: WP) {
  const c = p.c ?? 8, r = p.r ?? 4;
  if (p.state === "skeleton") return <Tile title="Your day" icon={Sun} c={c} r={r} hero skel><div className="row gap16"><Sk w={90} h={60} r={10} /><Sk w={90} h={60} r={10} /><Sk w={90} h={60} r={10} /></div><Sk h={60} r={10} style={{ marginTop: "auto" }} /></Tile>;
  const pct = (h: number) => `${((h - T0) / (T1 - T0)) * 100}%`;
  return (
    <Tile title="Your day" icon={Sun} c={c} r={r} hero meta="3 meetings · 3 h focus" right="Wed, 30 Sept" hover={p.hover}>
      <div className="row" style={{ gap: 28, alignItems: "flex-end" }}>
        {[{ n: "3", l: "in focus", c: "var(--ink)" }, { n: "2", l: "need you", c: "var(--accent)" }, { n: "1", l: "overdue", c: "var(--danger)" }, { n: "4", l: "proposals", c: "var(--ink-2)" }].map((x) => (
          <div key={x.l} className="col" style={{ gap: 2 }}><span className="num" style={{ fontSize: 56, color: x.c }}>{x.n}</span><span style={{ fontSize: 12.5, color: "var(--faint)" }}>{x.l}</span></div>
        ))}
        <div className="col" style={{ marginLeft: "auto", maxWidth: 270, gap: 4, paddingBottom: 3 }}>
          <span className="cap" style={{ color: "var(--accent)" }}>Next up · 12:00 pm</span>
          <span style={{ fontSize: 14, fontWeight: 600 }}>1:1 with Priya Nandakumar</span>
          <span className="faint" style={{ fontSize: 12 }}>She asked for the p95 numbers. Draft reply is ready.</span>
        </div>
      </div>
      <div style={{ marginTop: "auto", position: "relative", height: 128 }}>
        {DUES.map((d) => (
          <div key={d.t} style={{ position: "absolute", left: pct(d.x), top: 0, bottom: 22 }}>
            <div className="row gap4" style={{ fontSize: 11, whiteSpace: "nowrap", color: d.r ? "#ffb9b3" : "var(--muted)", transform: d.x > 17 ? "translateX(-100%)" : undefined }}><Pin size={10} />{d.t}</div>
            <div style={{ position: "absolute", top: 16, bottom: 0, borderLeft: `1px dashed ${d.r ? "var(--danger)" : "rgba(243,238,230,0.3)"}` }} />
          </div>
        ))}
        <div style={{ position: "absolute", left: 0, right: 0, top: 22, height: 84, borderRadius: 10, background: "rgba(243,238,230,0.025)", boxShadow: "inset 0 0 0 1px rgba(243,238,230,0.05)", backgroundImage: `repeating-linear-gradient(90deg, rgba(243,238,230,0.045) 0 1px, transparent 1px 10%)` }}>
          <span className="cap" style={{ position: "absolute", right: 8, top: 4, fontSize: 9 }}>Calendar</span>
          <span className="cap" style={{ position: "absolute", right: 8, bottom: 4, fontSize: 9 }}>Focus</span>
          {BLOCKS.map((b) => (
            <div key={b.t} className="row gap4" style={{ position: "absolute", left: pct(b.s), width: `calc(${pct(b.e + T0 - b.s)} - 3px)`, top: b.k === "meet" ? 7 : 45, height: 32, overflow: b.k === "meet" ? "visible" : "hidden", borderRadius: 7, padding: "0 7px", fontSize: 11, fontWeight: 600,
              background: b.k === "focus" ? "linear-gradient(135deg, rgb(var(--accent-rgb) / 0.35), rgb(var(--accent-rgb) / 0.18))" : b.k === "meet" ? "rgba(126,184,201,0.2)" : b.k === "agent" ? "rgba(201,164,224,0.16)" : "transparent",
              border: b.k === "break" ? "1px dashed rgba(243,238,230,0.12)" : "none", color: b.k === "break" ? "var(--faint)" : "var(--ink)",
              opacity: b.e < 11.33 ? 0.5 : 1 }}>
              {b.k === "meet" ? <Video size={10} style={{ flexShrink: 0 }} /> : b.k === "break" ? <Coffee size={10} style={{ flexShrink: 0 }} /> : b.k === "agent" ? <Sparkles size={10} style={{ flexShrink: 0 }} /> : null}
              {b.k === "meet" ? <span style={{ position: "absolute", left: "calc(100% + 6px)", whiteSpace: "nowrap", color: b.e < 11.33 ? "var(--faint)" : "var(--ink-2)", fontWeight: 500 }}>{b.t}</span> : <span className="trunc">{b.t}</span>}
            </div>
          ))}
          <div style={{ position: "absolute", left: pct(11.33), top: -4, bottom: -4, borderLeft: "1.5px solid var(--danger)" }}><span style={{ position: "absolute", top: -3, left: -3.5, width: 6, height: 6, borderRadius: 99, background: "var(--danger)" }} /></div>
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 12 }}>
          {[9, 11, 13, 15, 17, 19].map((h) => <span key={h} style={{ position: "absolute", left: pct(h), fontSize: 10.5, color: "var(--faint)", transform: h === 19 ? "translateX(-100%)" : undefined }}>{h > 12 ? `${h - 12} pm` : `${h} am`}</span>)}
        </div>
      </div>
    </Tile>
  );
}

export function NeedsMe(p: WP) {
  return (
    <Tile title="Needs me" icon={CircleCheck} c={p.c ?? 4} r={p.r ?? 2} meta="2 open" hover={p.hover}>
      <div className="row gap12" style={{ alignItems: "center" }}>
        <Num v="2" size={44} color="var(--accent)" />
        <div className="col" style={{ minWidth: 0, gap: 3, fontSize: 12.5 }}>
          <span className="trunc">Approve: send Priya the dashboard link</span>
          <span className="trunc">Question: which Ruff rules to enable?</span>
        </div>
      </div>
      <div className="row gap6" style={{ marginTop: "auto" }}><span className="btn-p" style={{ padding: "3px 10px", fontSize: 11.5 }}>Review both</span><span className="faint" style={{ fontSize: 11.5 }}>asked 40 min ago</span></div>
    </Tile>
  );
}
export function Brief(p: WP) {
  return (
    <Tile title="Morning brief" icon={Sunrise} c={p.c ?? 4} r={p.r ?? 2} meta="written 7:02 am" hover={p.hover}>
      <p className="display" style={{ margin: 0, fontSize: 15.5, lineHeight: 1.45, color: "var(--ink-2)", fontWeight: 400 }}>Priya is waiting on the latency numbers. The ranker ADR is the one deep-work block today; everything else can slide to Thursday.</p>
    </Tile>
  );
}

const FOCUS = [
  { t: "Reply to Priya with the latency numbers", pr: "High", due: "overdue 1 day", r: true, src: "Teams" },
  { t: "Bump the retry helper and open a PR", pr: "Normal", due: "today", src: "GitHub" },
  { t: "Write the ranker ADR", pr: "Normal", due: "tomorrow", src: "Meeting" },
  { t: "Check the Ruff preview changelog", pr: "Low", due: "Fri", src: "Email" },
  { t: "Share the dashboard link with Priya", pr: "Normal", due: "5:30 pm", src: "Reminder" },
];
export function Focus(p: WP) {
  return (
    <Tile title="Focus" icon={Crosshair} c={p.c ?? 6} r={p.r ?? 3} meta="4 · high, due and pinned" hover={p.hover} add>
      <div className="col">
        {FOCUS.map((f) => (
          <div key={f.t} className="li">
            <span style={{ width: 15, height: 15, borderRadius: 99, border: `1.5px solid ${f.r ? "var(--danger)" : "rgba(243,238,230,0.3)"}`, flexShrink: 0 }} />
            <span className={`pill ${f.pr === "High" ? "r" : f.pr === "Low" ? "" : "y"}`} style={{ width: 52, justifyContent: "center" }}>{f.pr}</span>
            <span className="t">{f.t}</span>
            <span className="m">{f.src}</span>
            <span className="m" style={{ color: f.r ? "var(--danger)" : undefined, width: 86, textAlign: "right" }}>{f.due}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}

const PROPS = [
  { t: "Follow up with Shachee on the empty-state copy", src: "teams", conf: 0.86 },
  { t: "Draft the Q4 latency summary for Priya", src: "meeting", conf: 0.78 },
  { t: "Look at the Ruff preview changelog", src: "email", conf: 0.64 },
];
export function Proposals(p: WP) {
  return (
    <Tile title="Proposals" icon={Sparkles} c={p.c ?? 6} r={p.r ?? 3} meta="4 waiting for a yes" hover={p.hover}>
      <div className="col" style={{ gap: 7 }}>
        {PROPS.map((x, i) => (
          <div key={x.t} className="row gap10" style={{ padding: "7px 10px", borderRadius: 10, background: i === 0 ? "rgb(var(--accent-rgb) / 0.08)" : "rgba(243,238,230,0.03)", border: `1px solid ${i === 0 ? "rgb(var(--accent-rgb) / 0.3)" : "rgba(243,238,230,0.06)"}` }}>
            <Ring p={x.conf} size={22} stroke={2.5}><span /></Ring>
            <div className="col grow" style={{ minWidth: 0 }}><span className="trunc" style={{ fontSize: 12.5, fontWeight: 500 }}>{x.t}</span><span className="faint" style={{ fontSize: 11 }}>from {x.src} · {Math.round(x.conf * 100)}% sure</span></div>
            <span className="btn-p" style={{ padding: "2px 9px", fontSize: 11.5 }}>I'll do it</span>
            <span className="btn" style={{ padding: "2px 9px", fontSize: 11.5 }}>Agent does it</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}

const DELIV = [
  { t: "Latency dashboard v2", pr: "Search quality", d: 3, p: 0.7 },
  { t: "Ranker ADR", pr: "Search quality", d: 6, p: 0.35 },
  { t: "Q4 planning doc", pr: "Team", d: 14, p: 0.15 },
];
export function Deliverables(p: WP) {
  return (
    <Tile title="Deliverables" icon={Package} c={p.c ?? 4} r={p.r ?? 3} meta="3 dated" hover={p.hover}>
      <div className="col" style={{ gap: 10 }}>
        {DELIV.map((d) => (
          <div key={d.t} className="row gap10">
            <span className="num" style={{ fontSize: 26, width: 30, color: d.d <= 3 ? "var(--warn)" : "var(--ink-2)" }}>{d.d}<span style={{ fontSize: 10, fontFamily: "Figtree", letterSpacing: 0, color: "var(--faint)" }}>d</span></span>
            <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
              <div className="row sb" style={{ fontSize: 12.5 }}><span className="trunc">{d.t}</span><span className="faint" style={{ fontSize: 11 }}>{Math.round(d.p * 100)}%</span></div>
              <div className="bar" style={{ height: 4 }}><i style={{ width: `${d.p * 100}%` }} /></div>
            </div>
          </div>
        ))}
      </div>
    </Tile>
  );
}
const PEOPLE = [
  { n: "Priya Nandakumar", r: "Infra lead", c: 4 }, { n: "Shachee Rane", r: "Design", c: 3 }, { n: "Karthik Subramanian", r: "Backend", c: 2 }, { n: "Ishaan Kapoor", r: "Platform", c: 1 },
];
export function People(p: WP) {
  return (
    <Tile title="People this week" icon={Users} c={p.c ?? 4} r={p.r ?? 3} meta="11 in touch" hover={p.hover}>
      <div className="col">
        {PEOPLE.map((x) => (
          <div key={x.n} className="li"><Av n={x.n} s={24} /><div className="col grow" style={{ minWidth: 0 }}><span className="t">{x.n}</span><span className="m">{x.r}</span></div><span className="row" style={{ gap: 2 }}>{Array.from({ length: 4 }, (_, i) => <span key={i} style={{ width: 5, height: 12, borderRadius: 2, background: i < x.c ? "var(--accent)" : "rgba(243,238,230,0.1)" }} />)}</span></div>
        ))}
      </div>
    </Tile>
  );
}
const REM = [
  { t: "Send Priya the dashboard link", w: "Today · 5:30 pm" },
  { t: "Review the ADR outline", w: "Tomorrow · 10:00 am" },
  { t: "Renew the staging TLS cert", w: "Mon, 5 Oct" },
];
export function Reminders(p: WP) {
  return (
    <Tile title="Reminders" icon={AlarmClock} c={p.c ?? 4} r={p.r ?? 3} meta="3 set · private" hover={p.hover} add>
      <div className="col">
        {REM.map((x, i) => (
          <div key={x.t} className="li"><span style={{ width: 28, height: 28, borderRadius: 8, display: "grid", placeItems: "center", background: i === 0 ? "rgb(var(--accent-rgb) / 0.16)" : "rgba(243,238,230,0.04)", color: i === 0 ? "var(--accent)" : "var(--faint)", flexShrink: 0 }}><AlarmClock size={13} /></span><div className="col grow" style={{ minWidth: 0 }}><span className="t">{x.t}</span><span className="m">{x.w}</span></div></div>
        ))}
      </div>
      <div className="row gap6" style={{ marginTop: "auto" }}><AvStack names={["Priya Nandakumar"]} s={18} /><span className="faint" style={{ fontSize: 11.5 }}>1 linked to a person</span></div>
    </Tile>
  );
}
