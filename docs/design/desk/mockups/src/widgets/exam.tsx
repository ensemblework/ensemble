import { Hourglass, Target, Newspaper, Grid2x2, TrendingUp, Repeat, CalendarDays, Crosshair } from "lucide-react";
import { Tile, Num, Ring, Heat, makeHeat, Spark, Sk, Seg, type WP } from "../kit/ui";
import { PlotTypeChip } from "../kit/plots";

const PHASES = [
  { l: "Foundation", s: "Jun – Sept", w: 4, done: true },
  { l: "Revision 1", s: "Oct – Dec", w: 3, now: true },
  { l: "Test series", s: "Jan – Mar", w: 3 },
  { l: "Final revision", s: "Apr – May", w: 2 },
];

export function Countdown(p: WP) {
  const c = p.c ?? 8, r = p.r ?? 4;
  if (p.state === "skeleton")
    return <Tile title="UPSC CSE Prelims 2027" icon={Hourglass} c={c} r={r} hero skel><div className="row gap16"><Sk w={260} h={120} r={14} /><Sk w={150} h={150} r={99} style={{ marginLeft: "auto" }} /></div><Sk h={34} r={8} style={{ marginTop: "auto" }} /></Tile>;
  const ghost = p.state === "empty" && { label: "One date, large enough to see from across the room", sub: "Pick your exam; the season, phases and mocks arrange around it.", action: "Set your exam date" };
  if (p.mobile)
    return (
      <Tile title="Prelims 2027" icon={Hourglass} c={4} r={4} hero meta="Sun, 23 May" pad="16px">
        <div className="row" style={{ alignItems: "center" }}>
          <div className="col"><Num v="235" size={92} /><span style={{ fontSize: 13, color: "var(--muted)", marginTop: 6 }}>days to go · Revision 1</span></div>
          <div style={{ marginLeft: "auto" }}><Ring p={0.58} size={96} stroke={7} glow><div className="col" style={{ alignItems: "center" }}><span style={{ fontSize: 18, fontWeight: 700 }}>58%</span><span style={{ fontSize: 10, color: "var(--faint)" }}>syllabus</span></div></Ring></div>
        </div>
        <Phases compact />
      </Tile>
    );
  return (
    <Tile title="UPSC CSE Prelims 2027" icon={Hourglass} c={c} r={r} hero meta="Sun, 23 May 2027 · tentative" right="Season day 122 of 357" hover={p.hover} ghost={ghost}>
      <div className="row" style={{ alignItems: "center", flex: 1, gap: 24 }}>
        <div className="col">
          <div className="row" style={{ alignItems: "flex-end", gap: 12 }}>
            <span className="num" style={{ fontSize: 148, lineHeight: 0.78, background: "linear-gradient(180deg, var(--ink) 30%, rgb(var(--a-rgb) / 0.85))", WebkitBackgroundClip: "text", color: "transparent" }}>235</span>
            <div className="col" style={{ paddingBottom: 6, gap: 3 }}>
              <span style={{ fontSize: 16, fontWeight: 600 }}>days</span>
              <span style={{ fontSize: 12.5, color: "var(--faint)" }}>33 weeks · 7 full mocks planned</span>
            </div>
          </div>
          <div className="row gap8" style={{ marginTop: 16, fontSize: 12.5, color: "var(--muted)" }}>
            <span className="pill a">Next: Test series opens Sun, 4 Oct</span><span>GS mock 11 · 2 hours · 100 questions</span>
          </div>
        </div>
        <div style={{ marginLeft: "auto", position: "relative" }}>
          <Ring p={0.58} size={168} stroke={9} glow>
            <div style={{ position: "absolute" }}><Ring p={0.34} size={130} stroke={4} color="rgba(243,238,230,0.5)" track="rgba(243,238,230,0.05)" /></div>
            <div className="col" style={{ alignItems: "center" }}><span className="num" style={{ fontSize: 36 }}>58<span style={{ fontSize: 16 }}>%</span></span><span style={{ fontSize: 11, color: "var(--faint)" }}>syllabus covered</span></div>
          </Ring>
          <div className="row gap10" style={{ justifyContent: "center", marginTop: 8, fontSize: 11, color: "var(--faint)" }}>
            <span className="row gap4"><span className="sq" style={{ background: "var(--a)" }} />covered</span>
            <span className="row gap4"><span className="sq" style={{ background: "rgba(243,238,230,0.5)" }} />season 34%</span>
          </div>
        </div>
      </div>
      <Phases />
    </Tile>
  );
}
function Phases({ compact }: { compact?: boolean }) {
  return (
    <div style={{ marginTop: compact ? "auto" : 10 }}>
      <div className="row" style={{ gap: 4 }}>
        {PHASES.map((ph) => (
          <div key={ph.l} className="col" style={{ flex: ph.w, gap: 5 }}>
            <div style={{ height: 6, borderRadius: 3, background: ph.done ? "rgb(var(--a-rgb) / 0.55)" : ph.now ? "linear-gradient(90deg, var(--a) 12%, rgb(var(--a-rgb) / 0.16) 12%)" : "rgba(243,238,230,0.08)", boxShadow: ph.now ? "0 0 10px rgb(var(--a-rgb) / 0.4)" : "none" }} />
            <div className="row gap6" style={{ fontSize: compact ? 10.5 : 11.5 }}>
              <span style={{ fontWeight: 600, whiteSpace: "nowrap", color: ph.now ? "var(--ink)" : ph.done ? "var(--muted)" : "var(--faint)" }}>{compact && ph.l === "Final revision" ? "Final" : ph.l}</span>
              {!compact && ph.w >= 3 && <span className="faint">{ph.s}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DailyTarget(p: WP) {
  const ghost = p.state === "empty" && { label: "Hours against the number you set", sub: "", action: "Set a daily target" };
  if (p.mobile)
    return (
      <Tile title="Today" icon={Target} c={2} r={2} pad="14px">
        <Num v="5.5" size={34} unit="/ 8 h" />
        <div style={{ marginTop: "auto" }}><Seg n={8} done={5} partial={0.5} h={7} /></div>
      </Tile>
    );
  return (
    <Tile title="Today's target" icon={Target} c={p.c ?? 4} r={p.r ?? 2} meta="8 h" hover={p.hover} ghost={ghost}>
      <div className="row sb" style={{ alignItems: "flex-end" }}>
        <Num v="5.5" size={40} unit="h done" />
        <span style={{ fontSize: 12, color: "var(--faint)", paddingBottom: 4 }}>2.5 h left · till 10 pm</span>
      </div>
      <div style={{ marginTop: "auto" }}>
        <Seg n={8} done={5} partial={0.5} h={8} gap={3} />
        <div className="row sb" style={{ fontSize: 11, color: "var(--faint)", marginTop: 5 }}><span>Polity 2 h · Economy 2 h · CA 1.5 h</span><span>Geography next</span></div>
      </div>
    </Tile>
  );
}

const SRC = [{ l: "The Hindu", n: 6, o: 1 }, { l: "PIB", n: 4, o: 0.7 }, { l: "Indian Express", n: 3, o: 0.5 }, { l: "Yojana", n: 1, o: 0.3 }];
export function Affairs(p: WP) {
  const ghost = p.state === "empty" && { label: "Clip articles as you read", sub: "", action: "Save your first article" };
  if (p.mobile)
    return (
      <Tile title="Saved" icon={Newspaper} c={2} r={2} pad="14px">
        <Num v="14" size={34} unit="in 2 days" />
        <div style={{ marginTop: "auto", display: "flex", gap: 2, height: 7 }}>{SRC.map((s) => <div key={s.l} style={{ flex: s.n, background: `rgb(var(--a-rgb) / ${s.o})`, borderRadius: 2 }} />)}</div>
      </Tile>
    );
  return (
    <Tile title="Current affairs saved" icon={Newspaper} c={p.c ?? 4} r={p.r ?? 2} meta="last 2 days" hover={p.hover} ghost={ghost} add>
      <div className="row gap12" style={{ alignItems: "flex-end" }}>
        <Num v="14" size={40} unit="clips" />
        <span className="trunc" style={{ fontSize: 12, color: "var(--muted)", paddingBottom: 5 }}>Latest · RBI repo rate held at 5.5%</span>
      </div>
      <div style={{ marginTop: "auto" }}>
        <div style={{ display: "flex", gap: 2, height: 8 }}>{SRC.map((s) => <div key={s.l} style={{ flex: s.n, background: `rgb(var(--a-rgb) / ${s.o})`, borderRadius: 2 }} />)}</div>
        <div className="row gap10" style={{ fontSize: 11, color: "var(--faint)", marginTop: 5 }}>{SRC.map((s) => <span key={s.l}>{s.l} {s.n}</span>)}</div>
      </div>
    </Tile>
  );
}

const SUBJ = [
  { l: "Polity", v: 0.82, c: "1 / 1 / 3 / 3" }, { l: "Modern History", v: 0.74, c: "1 / 3 / 3 / 5" }, { l: "Geography", v: 0.61, c: "1 / 5 / 3 / 7" },
  { l: "Current affairs", v: 0.6, c: "1 / 7 / 3 / 9" }, { l: "Economy", v: 0.55, c: "3 / 1 / 5 / 3" }, { l: "Environment", v: 0.48, c: "3 / 3 / 5 / 5" },
  { l: "Sci & Tech", v: 0.35, c: "3 / 5 / 4 / 7", sm: true }, { l: "Art & Culture", v: 0.22, c: "4 / 5 / 5 / 7", sm: true },
  { l: "Ancient & Med.", v: 0.4, c: "3 / 7 / 4 / 9", sm: true }, { l: "CSAT", v: 0.7, c: "4 / 7 / 5 / 9", sm: true },
];
export function Syllabus(p: WP) {
  const ghost = p.state === "empty" && { label: "Coverage by subject", sub: "", action: "Load the GS syllabus" };
  return (
    <Tile title="Syllabus coverage" icon={Grid2x2} c={p.c ?? 6} r={p.r ?? 3} meta={(p.c ?? 6) < 6 ? "58% overall" : "GS Paper I + CSAT"} right={(p.c ?? 6) < 6 ? undefined : "58% overall"} hover={p.hover} ghost={ghost}>
      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "repeat(8, minmax(0,1fr))", gridTemplateRows: "repeat(4, minmax(0,1fr))", gap: 3 }}>
        {SUBJ.map((s) => (
          <div key={s.l} style={{ gridArea: s.c, position: "relative", borderRadius: 7, overflow: "hidden", background: "rgba(243,238,230,0.04)", border: "1px solid rgba(243,238,230,0.05)", padding: "5px 7px", display: "flex", flexDirection: s.sm ? "row" : "column", alignItems: s.sm ? "center" : undefined, justifyContent: "space-between", gap: 4 }}>
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: `${s.v * 100}%`, background: `linear-gradient(180deg, rgb(var(--a-rgb) / ${0.2 + s.v * 0.3}), rgb(var(--a-rgb) / ${0.08 + s.v * 0.2}))`, borderTop: "1px solid rgb(var(--a-rgb) / 0.6)" }} />
            <span className="trunc" style={{ position: "relative", fontSize: 11, fontWeight: 600, color: "var(--ink)" }}>{s.l}</span>
            <span className="num" style={{ position: "relative", fontSize: s.sm ? 15 : 19, alignSelf: s.sm ? "center" : "flex-end", color: s.v < 0.4 ? "var(--warn)" : "var(--ink)" }}>{Math.round(s.v * 100)}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}

const MOCKS = [78, 84, 81, 92, 88, 97, 94, 101, 99, 106];
export function MockTrend(p: WP) {
  const c = p.c ?? 6, r = p.r ?? 3;
  if (p.state === "skeleton")
    return <Tile title="Mock scores" icon={TrendingUp} c={c} r={r} skel><div className="row gap12"><Sk w={90} h={40} r={8} /><Sk w={60} h={12} /></div><Sk h={90} r={8} style={{ marginTop: "auto" }} /></Tile>;
  const ghost = p.state === "empty" && { label: "Your trend against the target line", sub: "Add a score after each mock. Two points make a line.", action: "Add your first mock score" };
  const w = p.mobile ? 330 : c >= 6 ? 520 : c >= 4 ? 350 : 260;
  return (
    <Tile title="Mock scores" icon={TrendingUp} c={c} r={r} meta={c >= 6 && !p.mobile ? "GS I · out of 200 · 10 mocks" : "GS I · /200"} right={<PlotTypeChip compact={c < 6 || p.mobile} />} hover={p.hover} ghost={ghost} add>
      <div className="row gap12" style={{ alignItems: "flex-end" }}>
        <Num v="106" size={40} unit="/ 200" />
        <span className="pill g" style={{ marginBottom: 6 }}>+7 on mock 9</span>
        <span style={{ fontSize: 12, color: "var(--faint)", marginLeft: "auto", marginBottom: 6 }}>Target <b className="ink2">110</b> · 4 to go</span>
      </div>
      <div style={{ marginTop: "auto", position: "relative" }}>
        <Spark data={MOCKS} w={w} h={p.mobile ? 80 : 96} target={110} min={70} max={116} strokeW={2} />
        <span style={{ position: "absolute", right: 0, top: -3, fontSize: 10, color: "var(--muted)", background: "var(--tile)", padding: "0 4px", borderRadius: 4 }}>target 110</span>
        <div className="row sb" style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 4 }}><span>22 Jun</span><span>Mock 5 · 3 Aug</span><span>27 Sept</span></div>
      </div>
    </Tile>
  );
}

const REV = [
  { t: "Fundamental Rights · Art 12–35", s: "Polity", pass: 3, iv: "7d", ret: 0.9 },
  { t: "Indian monsoon mechanism", s: "Geography", pass: 2, iv: "3d", ret: 0.62 },
  { t: "Union Budget 2026–27 highlights", s: "Economy", pass: 1, iv: "1d", ret: 0.4 },
  { t: "Buddhist councils and patrons", s: "Ancient", pass: 2, iv: "3d", ret: 0.55 },
  { t: "Ramsar sites added in 2025", s: "Environment", pass: 1, iv: "1d", ret: 0.35 },
];
export function RevisionQueue(p: WP) {
  const ghost = p.state === "empty" && { label: "Spaced revision, due today", sub: "", action: "Add a topic to revise" };
  return (
    <Tile title="Revision due today" icon={Repeat} c={p.c ?? 5} r={p.r ?? 3} meta="5 topics · ~1 h 40 m" hover={p.hover} ghost={ghost} add>
      <div className="col">
        {REV.map((x) => (
          <div key={x.t} className="li">
            <div className="row" style={{ gap: 2 }}>{[1, 2, 3, 4].map((i) => <span key={i} style={{ width: 4, height: 12, borderRadius: 2, background: i <= x.pass ? "var(--a)" : "rgba(243,238,230,0.1)" }} />)}</div>
            <div className="col grow" style={{ minWidth: 0 }}><span className="t">{x.t}</span></div>
            <span className="m">{x.s}</span>
            <span className={`pill ${x.ret < 0.45 ? "r" : x.ret < 0.65 ? "y" : "g"}`} style={{ minWidth: 38, justifyContent: "center" }}>{x.iv}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}

export function HoursHeat(p: WP) {
  const ghost = p.state === "empty" && { label: "Daily hours, as a grid", sub: "", action: "Log today's hours" };
  return (
    <Tile title="Daily hours" icon={CalendarDays} c={p.c ?? 4} r={p.r ?? 3} meta="14 weeks" hover={p.hover} ghost={ghost}>
      <div className="row gap16" style={{ alignItems: "flex-end" }}>
        <Num v="6.8" size={36} unit="h avg" />
        <span style={{ fontSize: 12, color: "var(--faint)", paddingBottom: 4 }}>↑ 0.9 h vs August</span>
      </div>
      <div style={{ marginTop: "auto" }}><Heat weeks={makeHeat(14, 11, 1, 2)} cell={14} gap={3.5} today={[13, 2]} /></div>
      <div className="row sb" style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 5 }}><span>Jul</span><span>Aug</span><span>Sept</span></div>
    </Tile>
  );
}

const ACC = [{ l: "Polity", v: 0.78 }, { l: "Economy", v: 0.64 }, { l: "History", v: 0.61 }, { l: "Environment", v: 0.52 }, { l: "Sci & Tech", v: 0.41 }, { l: "Art & Culture", v: 0.33 }];
export function PyqAccuracy(p: WP) {
  const ghost = p.state === "empty" && { label: "Accuracy on past papers", sub: "", action: "Attempt a PYQ set" };
  return (
    <Tile title="PYQ accuracy" icon={Crosshair} c={p.c ?? 3} r={p.r ?? 3} meta="2013–2025" hover={p.hover} ghost={ghost}>
      <div className="col" style={{ gap: 7 }}>
        {ACC.map((a) => (
          <div key={a.l} className="col" style={{ gap: 3 }}>
            <div className="row sb" style={{ fontSize: 11.5 }}><span className="ink2">{a.l}</span><span style={{ color: a.v < 0.45 ? "var(--warn)" : "var(--faint)" }}>{Math.round(a.v * 100)}%</span></div>
            <div className="bar" style={{ height: 4 }}><i style={{ width: `${a.v * 100}%`, opacity: 0.4 + a.v * 0.6 }} /></div>
          </div>
        ))}
      </div>
    </Tile>
  );
}
