import { Clock, ClipboardCheck, BookMarked, UserRoundSearch, UserCheck, Users, ShieldCheck, FileQuestion, MapPin, ArrowRight } from "lucide-react";
import { Tile, Num, Ring, Av, Sk, Seg, type WP } from "../kit/ui";

const PERIODS = [
  { p: "1", t: "8:00", cl: "9-B", s: "Science", past: true },
  { p: "2", t: "8:40", free: true, past: true },
  { p: "3", t: "9:20", cl: "11-C", s: "Physics", past: true },
  { p: "", t: "10:00", brk: "Break", past: true },
  { p: "4", t: "10:20", cl: "12-A", s: "Physics", past: true },
  { p: "5", t: "11:00", cl: "10-B", s: "Physics lab", now: true },
  { p: "6", t: "11:40", cl: "9-B", s: "Science", next: true },
  { p: "", t: "12:20", brk: "Lunch" },
  { p: "7", t: "1:00", free: true },
  { p: "8", t: "1:40", cl: "11-C", s: "Physics" },
];

export function Timetable(p: WP) {
  const c = p.c ?? 12, r = p.r ?? 4;
  if (p.state === "skeleton") return <Tile title="Today's timetable" icon={Clock} c={c} r={r} hero skel><div className="row gap12"><Sk h={120} r={12} style={{ flex: 1.4 }} /><Sk h={120} r={12} style={{ flex: 1 }} /></div><div className="row gap6" style={{ marginTop: "auto" }}>{PERIODS.map((_, i) => <Sk key={i} h={54} r={8} style={{ flex: 1 }} />)}</div></Tile>;
  const ghost = p.state === "empty" && { label: "The period you're in, and the next one", sub: "", action: "Add your timetable" };
  return (
    <Tile title="Today's timetable" icon={Clock} c={c} r={r} hero meta="6 periods · 2 free" right="Wed · Day 3 of the cycle" hover={p.hover} ghost={ghost}>
      <div className="row" style={{ gap: 12, flex: 1, marginBottom: 12, alignItems: "stretch" }}>
        <div className="row" style={{ flex: 1.5, gap: 18, padding: "14px 16px", borderRadius: 12, background: "linear-gradient(135deg, rgb(var(--a-rgb) / 0.16), rgb(var(--a-rgb) / 0.04))", border: "1px solid rgb(var(--a-rgb) / 0.3)", alignItems: "center" }}>
          <Ring p={20 / 40} size={92} stroke={7} glow><div className="col" style={{ alignItems: "center" }}><span className="num" style={{ fontSize: 30 }}>20</span><span style={{ fontSize: 10.5, color: "var(--faint)" }}>min left</span></div></Ring>
          <div className="col" style={{ gap: 4, minWidth: 0 }}>
            <span className="cap" style={{ color: "var(--a)" }}>Now · Period 5 · 11:00 – 11:40</span>
            <span className="display" style={{ fontSize: 26 }}>10-B · Physics lab</span>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>Refraction through a glass slab · 36 students · Lab 2</span>
            <div className="row gap6" style={{ marginTop: 4 }}><span className="pill a">Lab manual p. 42</span><span className="pill">3 groups without a slab</span></div>
          </div>
        </div>
        <div className="col" style={{ flex: 1, gap: 4, padding: "14px 16px", borderRadius: 12, background: "rgba(243,238,230,0.03)", border: "1px solid rgba(243,238,230,0.07)" }}>
          <span className="cap">Next · Period 6 · 11:40</span>
          <span className="display" style={{ fontSize: 22 }}>9-B · Science</span>
          <span style={{ fontSize: 12.5, color: "var(--muted)" }}>Sound: echo and SONAR · Room 14</span>
          <div className="row gap6" style={{ marginTop: "auto", fontSize: 12, color: "var(--faint)" }}><MapPin size={12} />2 floors up · 4 min walk<ArrowRight size={12} style={{ marginLeft: "auto" }} /></div>
        </div>
      </div>
      <div className="row" style={{ gap: 5 }}>
        {PERIODS.map((x, i) => (
          <div key={i} className="col" style={{ flex: x.brk ? 0.6 : 1, minWidth: 0, height: 60, borderRadius: 9, padding: "6px 8px", gap: 1,
            background: x.now ? "var(--a)" : x.next ? "rgb(var(--a-rgb) / 0.12)" : x.free ? "transparent" : "rgba(243,238,230,0.04)",
            border: x.free ? "1px dashed rgba(243,238,230,0.14)" : x.next ? "1px solid rgb(var(--a-rgb) / 0.35)" : "1px solid rgba(243,238,230,0.05)",
            backgroundImage: x.brk ? "repeating-linear-gradient(135deg, rgba(243,238,230,0.04) 0 2px, transparent 2px 7px)" : undefined,
            opacity: x.past ? 0.5 : 1, color: x.now ? "#14120f" : undefined }}>
            <div className="row sb" style={{ fontSize: 10.5, fontWeight: 600, color: x.now ? "rgba(20,18,15,0.7)" : "var(--faint)" }}><span>{x.p ? `P${x.p}` : ""}</span><span>{x.t}</span></div>
            <span style={{ fontSize: 13, fontWeight: 700 }} className="trunc">{x.brk ?? (x.free ? "Free" : x.cl)}</span>
            <span style={{ fontSize: 11, color: x.now ? "rgba(20,18,15,0.75)" : "var(--faint)" }} className="trunc">{x.free ? (i === 8 ? "Mark 9-B tests" : "Planning") : x.s ?? ""}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}

const GRADE = [
  { cl: "12-A", w: "Pre-board practice paper", done: 9, all: 41, due: "Fri" },
  { cl: "9-B", w: "Unit test 2 · Motion", done: 21, all: 38, due: "Mon" },
  { cl: "10-B", w: "Lab records · Exp 4–6", done: 7, all: 36, due: "Tue" },
  { cl: "11-C", w: "Assignment 3 · Vectors", done: 18, all: 24, due: "Thu" },
];
export function Grading(p: WP) {
  const ghost = p.state === "empty" && { label: "Copies waiting, by class", sub: "", action: "Add a set to mark" };
  return (
    <Tile title="Marking queue" icon={ClipboardCheck} c={p.c ?? 4} r={p.r ?? 3} meta="85 copies left" hover={p.hover} ghost={ghost} add>
      <div className="col" style={{ gap: 9, flex: 1, justifyContent: "space-around" }}>
        {GRADE.map((g) => (
          <div key={g.cl} className="col" style={{ gap: 4 }}>
            <div className="row gap8" style={{ fontSize: 12.5 }}>
              <span style={{ fontWeight: 700, width: 34 }}>{g.cl}</span>
              <span className="trunc grow ink2">{g.w}</span>
              <span className="num" style={{ fontSize: 16 }}>{g.all - g.done}</span>
              <span className="faint" style={{ fontSize: 11, width: 28, textAlign: "right" }}>{g.due}</span>
            </div>
            <div className="bar" style={{ height: 5, marginLeft: 42 }}><i style={{ width: `${(g.done / g.all) * 100}%` }} /></div>
          </div>
        ))}
      </div>
    </Tile>
  );
}

const SYL = [
  { cl: "12-A", ch: 14, done: 9, part: 0.4, s: "Wave optics", st: "on track" },
  { cl: "11-C", ch: 15, done: 5, part: 0.7, s: "Laws of motion", st: "1 chapter behind" },
  { cl: "10-B", ch: 13, done: 7, part: 0.2, s: "Light: refraction", st: "on track" },
  { cl: "9-B", ch: 12, done: 6, part: 0.5, s: "Sound", st: "ahead" },
];
export function SyllabusClass(p: WP) {
  const ghost = p.state === "empty" && { label: "Chapters covered per class", sub: "", action: "Add a syllabus" };
  return (
    <Tile title="Syllabus by class" icon={BookMarked} c={p.c ?? 4} r={p.r ?? 3} meta="CBSE 2026–27" hover={p.hover} ghost={ghost}>
      <div className="col" style={{ gap: 10, flex: 1, justifyContent: "space-around" }}>
        {SYL.map((s) => (
          <div key={s.cl} className="col" style={{ gap: 5 }}>
            <div className="row gap8" style={{ fontSize: 12 }}>
              <span style={{ fontWeight: 700, width: 34 }}>{s.cl}</span><span className="grow trunc ink2">{s.s}</span>
              <span style={{ fontSize: 11, color: s.st.includes("behind") ? "var(--warn)" : "var(--faint)" }}>{s.st}</span>
            </div>
            <Seg n={s.ch} done={s.done} partial={s.part} h={6} gap={2} />
          </div>
        ))}
      </div>
    </Tile>
  );
}

const FU = [
  { n: "Aarav Sharma", cl: "10-B", w: "3 lab records missing · call parent", tag: "r" },
  { n: "Ishita Nair", cl: "12-A", w: "38% in unit test · remedial on Sat", tag: "y" },
  { n: "Rohan Das", cl: "9-B", w: "Absent 4 days · check with class teacher", tag: "y" },
  { n: "Meher Kaur", cl: "11-C", w: "Asked for olympiad practice sets", tag: "g" },
];
export function FollowUpsT(p: WP) {
  const ghost = p.state === "empty" && { label: "Students to follow up", sub: "", action: "Add a follow-up" };
  return (
    <Tile title="Student follow-ups" icon={UserRoundSearch} c={p.c ?? 4} r={p.r ?? 3} meta="4 open" hover={p.hover} ghost={ghost} add>
      <div className="col">
        {FU.map((f) => (
          <div key={f.n} className="li">
            <Av n={f.n} s={26} ring={f.tag === "r" ? "var(--danger)" : f.tag === "y" ? "var(--warn)" : undefined} />
            <div className="col grow" style={{ minWidth: 0 }}><span className="t">{f.n} <span className="faint" style={{ fontSize: 11.5 }}>{f.cl}</span></span><span className="m trunc">{f.w}</span></div>
          </div>
        ))}
      </div>
    </Tile>
  );
}

export function Attendance(p: WP) {
  return (
    <Tile title="Attendance today" icon={UserCheck} c={p.c ?? 3} r={p.r ?? 2} meta="4 classes" hover={p.hover}>
      <div className="row gap12" style={{ alignItems: "center", flex: 1 }}>
        <Ring p={0.93} size={58} stroke={5}><span style={{ fontSize: 12.5, fontWeight: 700 }}>93%</span></Ring>
        <div className="col"><Num v="139" size={28} unit="/ 149" /><span className="faint" style={{ fontSize: 11.5, marginTop: 3 }}>10 absent · 3 late</span></div>
      </div>
    </Tile>
  );
}
export function Ptm(p: WP) {
  return (
    <Tile title="Parent–teacher meet" icon={Users} c={p.c ?? 3} r={p.r ?? 2} meta="Sat, 10 Oct" hover={p.hover}>
      <div className="row sb" style={{ alignItems: "flex-end" }}><Num v="14" size={36} unit="booked" /><span className="faint" style={{ fontSize: 11.5, paddingBottom: 4 }}>of 36 · 10-B</span></div>
      <div style={{ marginTop: "auto", display: "flex", gap: 2 }}>{Array.from({ length: 18 }, (_, i) => <div key={i} style={{ flex: 1, height: 14, borderRadius: 3, background: [0, 1, 2, 4, 5, 7, 8, 9, 11, 12, 14, 15, 16, 17].includes(i) ? "rgb(var(--a-rgb) / 0.7)" : "rgba(243,238,230,0.07)" }} />)}</div>
      <div className="row sb faint" style={{ fontSize: 10.5, marginTop: 4 }}><span>9:00</span><span>10-minute slots</span><span>12:00</span></div>
    </Tile>
  );
}
export function Duty(p: WP) {
  return (
    <Tile title="Duty" icon={ShieldCheck} c={p.c ?? 3} r={p.r ?? 2} meta="this week" hover={p.hover}>
      <div className="col" style={{ gap: 6 }}>
        <div className="row gap8"><span className="pill a">Thu</span><span style={{ fontSize: 12.5 }}>Invigilation · P3–P4 · Hall B</span></div>
        <div className="row gap8"><span className="pill">Sat</span><span style={{ fontSize: 12.5 }}>Bus duty · Gate 2 · 1:30 pm</span></div>
        <div className="row gap8"><span className="pill y">Today</span><span style={{ fontSize: 12.5 }}>Substitution P7 · 8-A</span></div>
      </div>
    </Tile>
  );
}
export function NextTest(p: WP) {
  return (
    <Tile title="Paper to set" icon={FileQuestion} c={p.c ?? 3} r={p.r ?? 2} meta="12-A pre-board" hover={p.hover}>
      <div className="row sb" style={{ alignItems: "flex-end" }}><Num v="70" size={36} unit="% set" /><span className="faint" style={{ fontSize: 11.5, paddingBottom: 4 }}>due Thu, 15 Oct</span></div>
      <div style={{ marginTop: "auto" }}><Seg n={5} done={3} partial={0.5} h={7} /><div className="row sb faint" style={{ fontSize: 10.5, marginTop: 4 }}><span>A · MCQ</span><span>B</span><span>C</span><span>D · case</span><span>E</span></div></div>
    </Tile>
  );
}
