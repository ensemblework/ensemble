"use client";
import { CalendarRange, CircleDashed, Flag, Flame, Clock, Users, BookOpen, ListChecks } from "lucide-react";
import { Tile, Num, Ring, Heat, makeHeat, Av, Sk, Stacked, type WP } from "../ui";

export const COURSES = {
  OS: { c: "#cf9cf2", n: "Operating Systems", code: "CS301" },
  DB: { c: "#7eb8c9", n: "Database Systems", code: "CS303" },
  CN: { c: "#e7a08a", n: "Computer Networks", code: "CS305" },
  MA: { c: "#d4c07a", n: "Probability & Stats", code: "MA301" },
  HS: { c: "#8fbf9f", n: "Professional Ethics", code: "HS301" },
} as const;
type K = keyof typeof COURSES;
type Cls = { k: K; s: number; e: number; room: string; lab?: boolean; label?: string };
const WEEK: { d: string; n: number; today?: boolean; past?: boolean; holiday?: string; cls: Cls[]; due?: { t: string; k: K; time: string }[] }[] = [
  { d: "Mon", n: 28, past: true, cls: [{ k: "OS", s: 9, e: 10, room: "LT-204" }, { k: "DB", s: 10, e: 11, room: "LT-204" }, { k: "MA", s: 11.25, e: 12.25, room: "LT-105" }, { k: "CN", s: 14, e: 16, room: "Lab 2", lab: true }] },
  { d: "Tue", n: 29, past: true, cls: [{ k: "CN", s: 9, e: 10, room: "LT-204" }, { k: "OS", s: 10, e: 11, room: "LT-204" }, { k: "DB", s: 11.25, e: 13.25, room: "Lab 4", lab: true }, { k: "HS", s: 15, e: 16, room: "Seminar hall" }] },
  { d: "Wed", n: 30, today: true, cls: [{ k: "MA", s: 9, e: 10, room: "LT-105" }, { k: "DB", s: 10, e: 11, room: "LT-204" }, { k: "OS", s: 11.25, e: 12.25, room: "LT-204" }, { k: "OS", s: 14, e: 16, room: "Lab 3", lab: true }], due: [{ t: "CN assignment 2", k: "CN", time: "11:59 pm" }] },
  { d: "Thu", n: 1, cls: [{ k: "CN", s: 9, e: 10, room: "LT-204" }, { k: "MA", s: 10, e: 11, room: "LT-105" }, { k: "DB", s: 11.25, e: 12.25, room: "LT-204" }, { k: "HS", s: 15, e: 16, room: "Seminar hall" }], due: [{ t: "DBMS lab record", k: "DB", time: "5 pm" }] },
  { d: "Fri", n: 2, holiday: "Gandhi Jayanti", cls: [] },
  { d: "Sat", n: 3, cls: [{ k: "OS", s: 10, e: 13, room: "Coding club", label: "Hackathon prep" }] },
  { d: "Sun", n: 4, cls: [{ k: "DB", s: 16, e: 18, room: "Library", label: "Group study" }], due: [{ t: "OS quiz 3 · Moodle", k: "OS", time: "9 pm" }] },
];
const T0 = 8.75, T1 = 18.1;

export function WeekStrip(p: WP) {
  const c = p.c ?? 12, r = p.r ?? 4;
  const ghost = p.state === "empty" && { label: "Your week, one glance", sub: "Import the timetable PDF or add classes; deadlines pin themselves to the day.", action: "Add your timetable" };
  if (p.state === "skeleton")
    return <Tile title="This week" icon={CalendarRange} c={c} r={r} hero skel><div className="row gap8" style={{ flex: 1 }}>{Array.from({ length: 7 }, (_, i) => <div key={i} className="col gap6" style={{ flex: 1 }}><Sk w={40} h={10} /><Sk h={40} r={8} /><Sk h={60} r={8} /></div>)}</div></Tile>;
  return (
    <Tile title="This week" icon={CalendarRange} c={c} r={r} hero meta="15 classes · 3 due" right="Week 9 of 16 · Odd semester" hover={p.hover} ghost={ghost} add>
      <div style={{ display: "grid", gridTemplateColumns: "34px repeat(7, minmax(0,1fr))", gridTemplateRows: "auto auto minmax(0,1fr)", gap: "0 6px", flex: 1, minHeight: 0 }}>
        <div />
        {WEEK.map((d) => (
          <div key={d.n} className="row sb" style={{ padding: "0 6px 5px", borderBottom: "1px solid var(--line)" }}>
            <span className="cap" style={{ color: d.today ? "var(--accent)" : undefined }}>{d.d}</span>
            <span className="num" style={{ fontSize: 22, color: d.today ? "var(--ink)" : d.past ? "var(--faint)" : "var(--ink-2)" }}>{d.n}</span>
          </div>
        ))}
        {/* due lane */}
        <div className="cap" style={{ fontSize: 9.5, paddingTop: 7 }}>Due</div>
        {WEEK.map((d) => (
          <div key={d.n} style={{ height: 32, padding: "5px 0 5px" }}>
            {d.due?.map((x) => (
              <div key={x.t} className="row gap6" style={{ height: 22, padding: "0 7px", borderRadius: 6, background: d.today ? "rgb(227 107 100 / 0.16)" : "rgba(243,238,230,0.05)", border: `1px solid ${d.today ? "rgb(227 107 100 / 0.35)" : "rgba(243,238,230,0.08)"}`, fontSize: 11 }}>
                <Flag size={10} color={d.today ? "var(--danger)" : COURSES[x.k].c} />
                <span className="trunc" style={{ fontWeight: 600 }}>{x.t}</span>
              </div>
            ))}
          </div>
        ))}
        {/* time grid */}
        <div style={{ position: "relative" }}>
          {[9, 11, 13, 15, 17].map((h) => (
            <span key={h} style={{ position: "absolute", top: `${((h - T0) / (T1 - T0)) * 100}%`, fontSize: 10, color: "var(--faint)", transform: "translateY(-50%)" }}>{h > 12 ? `${h - 12} pm` : h === 12 ? "12 pm" : `${h} am`}</span>
          ))}
        </div>
        {WEEK.map((d) => (
          <div key={d.n} style={{ position: "relative", borderRadius: 8, background: d.today ? "rgb(var(--accent-rgb) / 0.06)" : "transparent", backgroundImage: d.holiday ? "repeating-linear-gradient(135deg, rgba(243,238,230,0.045) 0 2px, transparent 2px 8px)" : `repeating-linear-gradient(180deg, transparent 0 calc(${100 / 4.75}% - 1px), rgba(243,238,230,0.04) calc(${100 / 4.75}% - 1px) ${100 / 4.75}%)` }}>
            {d.holiday && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center", fontSize: 11, color: "var(--faint)" }}>No classes<br />{d.holiday}</div>}
            {d.cls.map((k, i) => {
              const co = COURSES[k.k];
              const now = d.today && k.s === 11.25;
              return (
                <div key={i} style={{ position: "absolute", left: 0, right: 0, top: `${((k.s - T0) / (T1 - T0)) * 100}%`, height: `calc(${((k.e - k.s) / (T1 - T0)) * 100}% - 3px)`, borderRadius: 5, padding: "2px 6px", overflow: "hidden", background: `color-mix(in srgb, ${co.c} ${d.past ? 9 : now ? 30 : 16}%, transparent)`, borderLeft: `2px solid ${co.c}`, opacity: d.past ? 0.55 : 1, boxShadow: now ? `0 0 0 1px ${co.c}, 0 6px 18px -6px ${co.c}` : "none", backgroundImage: k.lab ? `repeating-linear-gradient(135deg, color-mix(in srgb, ${co.c} 10%, transparent) 0 3px, transparent 3px 7px)` : undefined }}>
                  <div style={{ fontSize: 10.5, lineHeight: "14px", color: "var(--ink)" }} className="trunc"><b style={{ fontWeight: 700 }}>{k.label ?? `${co.code}${k.lab ? " Lab" : ""}`}</b>{k.e - k.s < 2 && <span style={{ color: "var(--muted)" }}> · {k.room}</span>}</div>
                  {k.e - k.s >= 2 && <div style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.2 }} className="trunc">{k.room}</div>}
                </div>
              );
            })}
            {d.today && (
              <div style={{ position: "absolute", left: -4, right: -2, top: `${((11.33 - T0) / (T1 - T0)) * 100}%`, height: 0, borderTop: "1.5px solid var(--danger)", zIndex: 2 }}>
                <span style={{ position: "absolute", left: -2, top: -4, width: 7, height: 7, borderRadius: 99, background: "var(--danger)" }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </Tile>
  );
}

const RINGS: { k: K; p: number; att: number; next: string }[] = [
  { k: "OS", p: 0.62, att: 0.81, next: "Unit 3 · Deadlocks" },
  { k: "DB", p: 0.55, att: 0.88, next: "Unit 3 · Normal forms" },
  { k: "CN", p: 0.48, att: 0.72, next: "Unit 2 · Data link" },
  { k: "MA", p: 0.7, att: 0.9, next: "Unit 4 · Regression" },
  { k: "HS", p: 0.8, att: 0.76, next: "Case study 5" },
];
export function CourseRings(p: WP) {
  const ghost = p.state === "empty" && { label: "Progress per course", sub: "", action: "Add your courses" };
  if (p.state === "skeleton")
    return <Tile title="Courses" icon={CircleDashed} c={p.c ?? 8} r={p.r ?? 2} skel><div className="row" style={{ justifyContent: "space-around" }}>{RINGS.map((r) => <div key={r.k} className="row gap10"><Sk w={52} h={52} r={99} /><div className="col gap6"><Sk w={50} h={10} /><Sk w={70} h={8} /></div></div>)}</div></Tile>;
  return (
    <Tile title="Courses" icon={CircleDashed} c={p.c ?? 8} r={p.r ?? 2} meta="syllabus covered · attendance" right={<span className="row gap4"><span className="sq" style={{ background: "var(--danger)" }} />below 75%</span>} hover={p.hover} ghost={ghost}>
      <div className="row" style={{ justifyContent: "space-between", flex: 1, alignItems: "center", gap: 8 }}>
        {RINGS.map((r) => {
          const co = COURSES[r.k];
          const low = r.att < 0.75, warn = r.att < 0.78 && !low;
          return (
            <div key={r.k} className="row gap10" style={{ minWidth: 0 }}>
              <Ring p={r.p} size={54} stroke={5} color={co.c}><span style={{ fontSize: 12.5, fontWeight: 700 }}>{Math.round(r.p * 100)}</span></Ring>
              <div className="col" style={{ minWidth: 0, gap: 2 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }} className="trunc">{co.code}</span>
                <span style={{ fontSize: 11, color: "var(--faint)" }} className="trunc">{r.next}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: low ? "var(--danger)" : warn ? "var(--warn)" : "var(--muted)" }}>Att {Math.round(r.att * 100)}%</span>
              </div>
            </div>
          );
        })}
      </div>
    </Tile>
  );
}

const RAIL = [
  { t: "CN assignment 2", s: "Sliding-window protocols · Moodle", d: 0, when: "Today, 11:59 pm", k: "CN" as K },
  { t: "DBMS lab record", s: "Experiments 1–6, signed", d: 1, when: "Thu, 5 pm", k: "DB" as K },
  { t: "OS quiz 3", s: "Scheduling · 20 min online", d: 4, when: "Sun, 9 pm", k: "OS" as K },
  { t: "MA301 tutorial sheet 4", s: "Bayes, 12 problems", d: 6, when: "Tue, 6 Oct", k: "MA" as K },
  { t: "Mini-project review 1", s: "ER diagram + schema", d: 12, when: "Mon, 12 Oct", k: "DB" as K },
  { t: "Mid-semester exams", s: "Timetable out on Moodle", d: 19, when: "From 19 Oct", k: "HS" as K },
];
export function DeadlineRail(p: WP) {
  const ghost = p.state === "empty" && { label: "Deadlines line up here", sub: "Forward the Moodle email or add one yourself.", action: "Add an assignment" };
  return (
    <Tile title="Deadlines" icon={Flag} c={p.c ?? 4} r={p.r ?? 4} meta="6 in 19 days" hover={p.hover} ghost={ghost} add>
      <div className="col" style={{ position: "relative", paddingLeft: 18 }}>
        <div style={{ position: "absolute", left: 4, top: 8, bottom: 8, width: 1.5, background: "linear-gradient(180deg, var(--danger), var(--warn) 30%, rgba(243,238,230,0.12) 60%)" }} />
        {RAIL.map((x) => {
          const col = x.d === 0 ? "var(--danger)" : x.d <= 4 ? "var(--warn)" : "rgba(243,238,230,0.35)";
          return (
            <div key={x.t} className="row gap10" style={{ padding: "5.5px 0", position: "relative" }}>
              <span style={{ position: "absolute", left: -18, top: 12, width: 9, height: 9, borderRadius: 99, background: "var(--tile)", border: `2px solid ${col}` }} />
              <div className="col grow" style={{ minWidth: 0 }}>
                <span className="trunc" style={{ fontSize: 13, fontWeight: 500 }}>{x.t}</span>
                <span className="trunc" style={{ fontSize: 11.5, color: "var(--faint)" }}><span style={{ color: COURSES[x.k].c }}>●</span> {x.when} · {x.s}</span>
              </div>
              <span className="num" style={{ fontSize: 22, color: x.d === 0 ? "var(--danger)" : x.d <= 4 ? "var(--warn)" : "var(--ink-2)" }}>{x.d === 0 ? "0" : x.d}<span style={{ fontSize: 10, fontFamily: "Figtree", color: "var(--faint)", letterSpacing: 0 }}>d</span></span>
            </div>
          );
        })}
      </div>
    </Tile>
  );
}

export function Streak(p: WP) {
  const ghost = p.state === "empty" && { label: "Every study session lights a square", sub: "", action: "Log today's study" };
  return (
    <Tile title="Study streak" icon={Flame} c={p.c ?? 5} r={p.r ?? 2} meta="20 weeks" hover={p.hover} ghost={ghost}>
      <div className="row gap16" style={{ alignItems: "center", flex: 1 }}>
        <div className="col" style={{ gap: 2 }}>
          <Num v="12" size={44} unit="days" />
          <span style={{ fontSize: 11.5, color: "var(--faint)" }}>best 21 · 3.4 h/day</span>
        </div>
        <div style={{ marginLeft: "auto" }}><Heat weeks={makeHeat(20, 7, 0.8, 2)} cell={10} gap={3} today={[19, 2]} /></div>
      </div>
    </Tile>
  );
}

export function NowNext(p: WP) {
  const ghost = p.state === "empty" && { label: "Now and next", sub: "", action: "Add your timetable" };
  return (
    <Tile title="In class now" icon={Clock} c={p.c ?? 3} r={p.r ?? 2} hover={p.hover} ghost={ghost}>
      <div className="row gap12" style={{ alignItems: "center" }}>
        <Ring p={5 / 60} size={48} stroke={4} color={COURSES.OS.c}><span style={{ fontSize: 11, fontWeight: 700 }}>OS</span></Ring>
        <div className="col"><Num v="55" size={32} unit="min left" /></div>
      </div>
      <div style={{ marginTop: "auto", fontSize: 11.5, color: "var(--faint)" }}>LT-204 · Prof. Kulkarni<br /><span className="ink2">Next · OS Lab, 2:00 pm, Lab 3</span></div>
    </Tile>
  );
}

const GROUP = [
  { n: "Aditi Rao", done: 5, all: 6, w: "ER diagram" },
  { n: "Karan Mehta", done: 3, all: 6, w: "Schema + seed data" },
  { n: "Prajwal Bhagwat", done: 4, all: 5, w: "Menu module UI" },
  { n: "Sneha Patil", done: 1, all: 5, w: "Report outline" },
];
export function GroupProject(p: WP) {
  const ghost = p.state === "empty" && { label: "Who is carrying the group project", sub: "", action: "Add your group" };
  return (
    <Tile title={(p.c ?? 4) < 4 ? "Mini-project" : "Mini-project · Mess manager"} icon={Users} c={p.c ?? 4} r={p.r ?? 3} meta="Review 1 in 12d" hover={p.hover} ghost={ghost}>
      <div className="col">
        {GROUP.map((g) => (
          <div key={g.n} className="li">
            <Av n={g.n} s={24} />
            <div className="col grow" style={{ minWidth: 0, gap: 4 }}>
              <div className="row sb"><span className="trunc" style={{ fontSize: 12.5 }}>{g.n.split(" ")[0]}{g.n.startsWith("Prajwal") ? " (you)" : ""}</span><span className="m">{g.done}/{g.all}</span></div>
              <div className="bar" style={{ height: 4 }}><i style={{ width: `${(g.done / g.all) * 100}%`, background: g.done / g.all < 0.3 ? "var(--warn)" : "var(--accent)" }} /></div>
            </div>
          </div>
        ))}
      </div>
    </Tile>
  );
}

const READ = [
  { t: "Galvin · Ch 7 Deadlocks", k: "OS" as K, a: 18, b: 42 },
  { t: "Korth · Ch 8 Normalisation", k: "DB" as K, a: 30, b: 36 },
  { t: "Forouzan · Ch 11 Data link control", k: "CN" as K, a: 4, b: 38 },
  { t: "Lecture 14 slides · Bayes", k: "MA" as K, a: 22, b: 22 },
];
export function Reading(p: WP) {
  const ghost = p.state === "empty" && { label: "Chapters with a page count", sub: "", action: "Add a chapter" };
  return (
    <Tile title="Reading" icon={BookOpen} c={p.c ?? 4} r={p.r ?? 3} meta="4 open · 84 pages left" hover={p.hover} ghost={ghost} add>
      <div className="col">
        {READ.map((x) => (
          <div key={x.t} className="li" style={{ flexDirection: "column", alignItems: "stretch", gap: 5 }}>
            <div className="row sb"><span className="trunc" style={{ fontSize: 12.5 }}>{x.t}</span><span className="m">{x.a === x.b ? "done" : `p. ${x.a}/${x.b}`}</span></div>
            <div className="bar" style={{ height: 4 }}><i style={{ width: `${(x.a / x.b) * 100}%`, background: COURSES[x.k].c, opacity: x.a === x.b ? 0.45 : 1 }} /></div>
          </div>
        ))}
      </div>
    </Tile>
  );
}

const PLAN = [
  { t: "Finish CN assignment 2 · Q4–Q6", k: "CN" as K, m: 90, done: false },
  { t: "Write up DBMS experiments 5 and 6", k: "DB" as K, m: 60, done: false },
  { t: "Revise scheduling for OS quiz", k: "OS" as K, m: 45, done: false },
  { t: "MA301 · 4 problems from sheet 4", k: "MA" as K, m: 30, done: true },
];
export function StudyPlan(p: WP) {
  const ghost = p.state === "empty" && { label: "A plan for today", sub: "", action: "Plan today" };
  return (
    <Tile title="Study plan" icon={ListChecks} c={p.c ?? 4} r={p.r ?? 3} meta="3 h 45 m today" hover={p.hover} ghost={ghost} add>
      <Stacked parts={PLAN.map((x) => ({ v: x.m, c: COURSES[x.k].c, o: x.done ? 0.35 : 0.9 }))} h={6} />
      <div className="col" style={{ marginTop: 8 }}>
        {PLAN.map((x) => (
          <div key={x.t} className="li">
            <span style={{ width: 14, height: 14, borderRadius: 4, border: `1.5px solid ${COURSES[x.k].c}`, background: x.done ? COURSES[x.k].c : "transparent", flexShrink: 0 }} />
            <span className="t" style={{ textDecoration: x.done ? "line-through" : "none", color: x.done ? "var(--faint)" : undefined }}>{x.t}</span>
            <span className="m">{x.m} m</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}
