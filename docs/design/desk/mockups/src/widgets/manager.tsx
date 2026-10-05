import { Fragment } from "react";
import { Gauge, OctagonAlert, Repeat2, Goal, ScrollText, Plane } from "lucide-react";
import { Tile, Num, Av, Sk, type WP } from "../kit/ui";

const PROJ = { Checkout: "var(--a)", Onboarding: "#7eb8c9", Platform: "#c9a4e0", Support: "rgba(243,238,230,0.35)" } as const;
type PK = keyof typeof PROJ;
const TEAM: { n: string; role: string; parts: [PK, number][]; note?: string }[] = [
  { n: "Ananya Iyer", role: "Staff engineer", parts: [["Checkout", 70], ["Platform", 48]] },
  { n: "Arjun Singh", role: "SRE", parts: [["Platform", 64], ["Support", 40]], note: "on call" },
  { n: "Rahul Verma", role: "Backend", parts: [["Checkout", 80], ["Support", 16]] },
  { n: "Farhan Qureshi", role: "Data", parts: [["Onboarding", 58], ["Checkout", 30]] },
  { n: "Meera Pillai", role: "Frontend", parts: [["Onboarding", 52], ["Checkout", 20]] },
  { n: "Divya Menon", role: "Design", parts: [["Onboarding", 45], ["Checkout", 20]] },
  { n: "Neha Joshi", role: "QA", parts: [["Checkout", 35], ["Support", 20]], note: "leave Thu–Fri" },
];
export function TeamLoad(p: WP) {
  const c = p.c ?? 8, r = p.r ?? 4;
  if (p.state === "skeleton") return <Tile title="Team load" icon={Gauge} c={c} r={r} hero skel>{TEAM.map((t) => <div key={t.n} className="row gap10" style={{ padding: "6px 0" }}><Sk w={26} h={26} r={99} /><Sk w={110} h={10} /><Sk h={10} style={{ flex: 1 }} /></div>)}</Tile>;
  const ghost = p.state === "empty" && { label: "Who is carrying the week", sub: "", action: "Add your team" };
  const max = 130;
  return (
    <Tile title="Team load" icon={Gauge} c={c} r={r} hero meta="7 people · this sprint" right={<span className="row gap10">{(Object.keys(PROJ) as PK[]).map((k) => <span key={k} className="row gap4"><span className="sq" style={{ background: PROJ[k] }} />{k}</span>)}</span>} hover={p.hover} ghost={ghost}>
      <div className="row" style={{ gap: 22, flex: 1, minHeight: 0 }}>
        <div className="col" style={{ width: 150, gap: 6, justifyContent: "center" }}>
          <Num v="2" size={84} color="var(--danger)" />
          <span style={{ fontSize: 14, fontWeight: 600 }}>over capacity</span>
          <span style={{ fontSize: 12, color: "var(--faint)", lineHeight: 1.45 }}>Ananya and Arjun are above 100%. Meera and Divya have room for Checkout.</span>
        </div>
        <div className="col grow" style={{ justifyContent: "space-between", position: "relative" }}>
          <div style={{ position: "absolute", left: `calc(170px + (100% - 220px) * ${100 / max})`, top: -4, bottom: 0, borderLeft: "1px dashed rgba(243,238,230,0.3)" }}>
            <span style={{ position: "absolute", top: -12, left: -14, fontSize: 10, color: "var(--faint)" }}>100%</span>
          </div>
          {TEAM.map((t) => {
            const tot = t.parts.reduce((a, b) => a + b[1], 0);
            const over = tot > 100;
            return (
              <div key={t.n} className="row gap10" style={{ height: 30 }}>
                <Av n={t.n} s={26} ring={over ? "var(--danger)" : undefined} />
                <div className="col" style={{ width: 134, minWidth: 0 }}>
                  <span className="trunc" style={{ fontSize: 12.5, fontWeight: 600 }}>{t.n}</span>
                  <span className="trunc" style={{ fontSize: 11, color: t.note ? "var(--warn)" : "var(--faint)" }}>{t.role}{t.note ? ` · ${t.note}` : ""}</span>
                </div>
                <div className="grow" style={{ height: 12, display: "flex", gap: 2, position: "relative" }}>
                  {t.parts.map(([k, v], i) => <div key={i} style={{ width: `${(v / max) * 100}%`, background: PROJ[k], borderRadius: 3, opacity: 0.9 }} />)}
                  {over && <div style={{ position: "absolute", left: `${(100 / max) * 100}%`, width: `${((tot - 100) / max) * 100}%`, top: -2, bottom: -2, borderRadius: 3, backgroundImage: "repeating-linear-gradient(135deg, rgb(227 107 100 / 0.9) 0 2px, transparent 2px 5px)", border: "1px solid var(--danger)" }} />}
                </div>
                <span className="num" style={{ width: 44, textAlign: "right", fontSize: 17, color: over ? "var(--danger)" : tot < 70 ? "var(--ok)" : "var(--ink-2)" }}>{tot}<span style={{ fontSize: 10, fontFamily: "Figtree", letterSpacing: 0 }}>%</span></span>
              </div>
            );
          })}
        </div>
      </div>
    </Tile>
  );
}

const BLOCK = [
  { t: "Razorpay webhook retries rate-limited", who: "Rahul Verma", age: 6, sev: "r" },
  { t: "Prod DB migration window needs sign-off", who: "Arjun Singh", age: 1, sev: "r" },
  { t: "Onboarding copy stuck in legal review", who: "Divya Menon", age: 3, sev: "y" },
  { t: "Load-test env still on old instance type", who: "Ananya Iyer", age: 2, sev: "y" },
];
export function Blockers(p: WP) {
  const ghost = p.state === "empty" && { label: "Nothing is blocked", sub: "", action: "Flag a blocker" };
  return (
    <Tile title="Blockers" icon={OctagonAlert} c={p.c ?? 4} r={p.r ?? 4} meta="4 open · oldest 6d" hover={p.hover} ghost={ghost} add>
      <div className="col" style={{ gap: 8 }}>
        {BLOCK.map((b) => (
          <div key={b.t} style={{ borderRadius: 10, padding: "8px 10px", background: "rgba(243,238,230,0.03)", border: "1px solid rgba(243,238,230,0.06)", boxShadow: `inset 2px 0 0 ${b.sev === "r" ? "var(--danger)" : "var(--warn)"}` }}>
            <div style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.3 }}>{b.t}</div>
            <div className="row gap6" style={{ marginTop: 5 }}><Av n={b.who} s={18} /><span className="faint" style={{ fontSize: 11.5 }}>{b.who.split(" ")[0]}</span><span className={`pill ${b.sev}`} style={{ marginLeft: "auto" }}>{b.age}d</span></div>
          </div>
        ))}
      </div>
    </Tile>
  );
}

const ONES = [
  { n: "Ananya Iyer", dots: [1, 1, 1, 0, 1, 1, 1, 1], last: "3d ago", ok: true },
  { n: "Rahul Verma", dots: [1, 0, 1, 1, 0, 1, 0, 0], last: "16d ago", ok: false },
  { n: "Meera Pillai", dots: [1, 1, 0, 1, 1, 0, 1, 1], last: "6d ago", ok: true },
  { n: "Arjun Singh", dots: [0, 1, 1, 0, 1, 1, 0, 1], last: "8d ago", ok: true },
  { n: "Divya Menon", dots: [1, 1, 1, 1, 0, 0, 0, 0], last: "29d ago", ok: false },
];
export function OneOnOnes(p: WP) {
  const ghost = p.state === "empty" && { label: "Cadence per person", sub: "", action: "Add a 1:1 note" };
  return (
    <Tile title="1:1 cadence" icon={Repeat2} c={p.c ?? 6} r={p.r ?? 3} meta="weekly · last 8 weeks" right={<span className="row gap4"><span className="sq" style={{ background: "var(--danger)", borderRadius: 99 }} />2 overdue</span>} hover={p.hover} ghost={ghost}>
      <div className="col">
        {ONES.map((o) => (
          <div key={o.n} className="li">
            <Av n={o.n} s={24} />
            <span className="t" style={{ flex: "0 0 120px" }}>{o.n}</span>
            <div className="row grow" style={{ gap: 6, justifyContent: "flex-end" }}>
              {o.dots.map((d, i) => <span key={i} style={{ width: 9, height: 9, borderRadius: 99, background: d ? (i === 7 ? "var(--a)" : "rgb(var(--a-rgb) / 0.55)") : "transparent", border: d ? "none" : "1.5px solid rgba(243,238,230,0.15)" }} />)}
            </div>
            <span className="m" style={{ width: 62, textAlign: "right", color: o.ok ? undefined : "var(--danger)" }}>{o.last}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}

const OKR = [
  { t: "Checkout p95 under 300 ms", now: "340 ms", p: 0.62, conf: "y" },
  { t: "Activation from 34% to 42%", now: "38.5%", p: 0.56, conf: "g" },
  { t: "Zero Sev-1 incidents in Q4", now: "0 so far", p: 1, conf: "g" },
  { t: "Hire 2 backend engineers", now: "1 offer out", p: 0.35, conf: "r" },
];
export function Objectives(p: WP) {
  const ghost = p.state === "empty" && { label: "Objectives you actually track", sub: "", action: "Add an objective" };
  return (
    <Tile title="Q4 objectives" icon={Goal} c={p.c ?? 6} r={p.r ?? 3} meta="week 1 of 13" hover={p.hover} ghost={ghost}>
      <div className="col" style={{ gap: 11 }}>
        {OKR.map((o) => (
          <div key={o.t} className="col" style={{ gap: 5 }}>
            <div className="row gap8" style={{ fontSize: 12.5 }}>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: o.conf === "g" ? "var(--ok)" : o.conf === "y" ? "var(--warn)" : "var(--danger)" }} />
              <span className="grow trunc">{o.t}</span><span className="faint" style={{ fontSize: 11.5 }}>{o.now}</span>
            </div>
            <div className="bar" style={{ height: 5 }}><i style={{ width: `${o.p * 100}%` }} /><span style={{ position: "absolute", left: "8%", top: -2, bottom: -2, borderLeft: "1.5px solid var(--ink-2)", opacity: 0.5 }} /></div>
          </div>
        ))}
      </div>
    </Tile>
  );
}

const DEC = [
  { d: "29 Sept", t: "Freeze Checkout v2 scope; tax-invoice PDF moves to Nov", who: "You", re: "revisit 20 Oct" },
  { d: "25 Sept", t: "Adopt Razorpay Magic Checkout for UPI intent on web", who: "Ananya Iyer" },
  { d: "22 Sept", t: "On-call rotation goes to 2 people per week", who: "Arjun Singh" },
  { d: "18 Sept", t: "Drop the Android tablet layout from Q4", who: "Divya Menon", re: "revisit Jan" },
  { d: "15 Sept", t: "Hire for backend first; hold the second design role", who: "You" },
];
export function DecisionLog(p: WP) {
  const ghost = p.state === "empty" && { label: "What you already decided", sub: "", action: "Log a decision" };
  return (
    <Tile title="Decision log" icon={ScrollText} c={p.c ?? 7} r={p.r ?? 3} meta="12 this quarter" hover={p.hover} ghost={ghost} add>
      <div className="col" style={{ position: "relative", paddingLeft: 16 }}>
        <div style={{ position: "absolute", left: 3, top: 6, bottom: 6, width: 1, background: "var(--line-strong)" }} />
        {DEC.map((d, i) => (
          <div key={d.t} className="row gap10" style={{ padding: "5px 0", position: "relative" }}>
            <span style={{ position: "absolute", left: -16, top: 11, width: 7, height: 7, borderRadius: 99, background: i === 0 ? "var(--a)" : "var(--raised)", border: "1.5px solid " + (i === 0 ? "var(--a)" : "var(--faint)") }} />
            <span className="m" style={{ width: 52, fontSize: 11.5, color: "var(--faint)" }}>{d.d}</span>
            <span className="trunc grow" style={{ fontSize: 12.5 }}>{d.t}</span>
            {d.re && <span className="pill">{d.re}</span>}
            <Av n={d.who === "You" ? "Prajwal Bhagwat" : d.who} s={20} />
          </div>
        ))}
      </div>
    </Tile>
  );
}

const OUT = [
  { n: "Neha Joshi", days: [3, 4], kind: "Leave" },
  { n: "Farhan Qureshi", days: [7, 8, 9], kind: "Leave" },
  { n: "Arjun Singh", days: [0, 1, 2, 3], kind: "On call" },
  { n: "Divya Menon", days: [6], kind: "Offsite" },
  { n: "Rahul Verma", days: [8, 9], kind: "Leave" },
];
export function WhosOut(p: WP) {
  const D = ["M", "T", "W", "T", "F", "M", "T", "W", "T", "F"];
  const N = [28, 29, 30, 1, 2, 5, 6, 7, 8, 9];
  return (
    <Tile title="Who's out" icon={Plane} c={p.c ?? 5} r={p.r ?? 3} meta="next 2 weeks" hover={p.hover}>
      <div style={{ display: "grid", gridTemplateColumns: "96px repeat(10, 1fr)", gap: 3, alignItems: "center" }}>
        <span />
        {D.map((d, i) => <span key={i} style={{ fontSize: 10, textAlign: "center", color: i === 2 ? "var(--a)" : "var(--faint)", fontWeight: i === 2 ? 700 : 500 }}>{d}<br /><span style={{ fontSize: 10.5 }}>{N[i]}</span></span>)}
        {OUT.map((o) => (
          <Fragment key={o.n}>
            <span className="row gap6" style={{ fontSize: 12 }}><Av n={o.n} s={18} /><span className="trunc">{o.n.split(" ")[0]}</span></span>
            {D.map((_, i) => (
              <span key={o.n + i} style={{ height: 20, borderRadius: 4, background: i === 4 ? "transparent" : o.days.includes(i) ? (o.kind === "On call" ? "rgb(var(--a-rgb) / 0.3)" : "rgb(var(--a-rgb) / 0.75)") : "rgba(243,238,230,0.04)", backgroundImage: i === 4 ? "repeating-linear-gradient(135deg, rgba(243,238,230,0.1) 0 1.5px, transparent 1.5px 5px)" : undefined }} />
            ))}
          </Fragment>
        ))}
      </div>
      <div className="row gap12 faint" style={{ fontSize: 11, marginTop: "auto" }}><span className="row gap4"><span className="sq" style={{ background: "rgb(var(--a-rgb) / 0.75)" }} />Leave</span><span className="row gap4"><span className="sq" style={{ background: "rgb(var(--a-rgb) / 0.3)" }} />On call</span><span>Fri 2 Oct · holiday</span></div>
    </Tile>
  );
}
