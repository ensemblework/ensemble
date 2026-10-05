import type { CSSProperties, ReactNode } from "react";
import { Search, Sparkles, Check, Minus, Plus, ArrowRight, Undo2, ChevronRight, Eye, RefreshCcw, Tag, Columns3, SlidersHorizontal, Star, CalendarRange, Hourglass, Library, Gavel, Clock, Gauge, GitPullRequest, GanttChart, Sun } from "lucide-react";
import { Shell, MobileShell } from "../kit/shell";
import { accentVars, ACCENTS, type State } from "../kit/ui";
import { DESKS, TEMPLATES, deskById, type DeskDef } from "../desks/registry";
import { shellOpts, TodayHead } from "../desks/today";

const HERO: Record<string, { l: string; i: typeof Sun; n: number }> = {
  default: { l: "Your day", i: Sun, n: 8 },
  semester: { l: "Week strip", i: CalendarRange, n: 8 },
  exam: { l: "Countdown", i: Hourglass, n: 8 },
  literature: { l: "Reading pipeline", i: Library, n: 7 },
  chambers: { l: "Limitation band", i: Gavel, n: 10 },
  classes: { l: "Live timetable", i: Clock, n: 8 },
  staff: { l: "Team load", i: Gauge, n: 6 },
  branch: { l: "PRs needing you", i: GitPullRequest, n: 8 },
  bench: { l: "Build timeline", i: GanttChart, n: 8 },
};

export function Mini({ desk, width, height, head = true, state, style }: { desk: DeskDef; width: number; height: number; head?: boolean; state?: State; style?: CSSProperties }) {
  const scale = width / 1224;
  return (
    <div style={{ width, height, overflow: "hidden", position: "relative", borderRadius: 10, background: "radial-gradient(80% 60% at 0% 0%, rgb(var(--a-rgb) / 0.14), transparent 60%), var(--bg)", boxShadow: "inset 0 0 0 1px rgba(243,238,230,0.06)", ...accentVars(desk.accent), ...style }}>
      <div style={{ width: 1224, padding: "26px 22px", transform: `scale(${scale})`, transformOrigin: "0 0", pointerEvents: "none" }}>
        {head && (
          <div style={{ marginBottom: 18 }}>
            <div className="row gap8" style={{ fontSize: 12.5, color: "var(--muted)" }}>Wed, 30 Sept<span className="deskchip"><i />{desk.name}</span></div>
            <div className="display" style={{ fontSize: 34, marginTop: 4 }}>Today</div>
          </div>
        )}
        <div className="bento">{desk.tiles(state)}</div>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 48, background: "linear-gradient(180deg, transparent, rgba(20,18,16,0.95))" }} />
    </div>
  );
}

function Chips({ wrap }: { wrap?: boolean }) {
  const P = [["All", 8], ["Student", 1], ["Aspirant", 1], ["Researcher", 1], ["Legal", 1], ["Teacher", 1], ["Manager", 1], ["Developer", 1], ["Maker", 1]] as const;
  return (
    <div className="row" style={{ gap: 6, flexWrap: wrap ? "wrap" : "nowrap", overflow: "hidden" }}>
      {P.map(([l, n], i) => (
        <span key={l} className="row gap6" style={{ height: 30, padding: "0 12px", borderRadius: 99, fontSize: 12.5, whiteSpace: "nowrap", background: i === 0 ? "var(--ink)" : "rgba(243,238,230,0.04)", color: i === 0 ? "#14120f" : "var(--ink-2)", border: i === 0 ? "none" : "1px solid var(--line)", fontWeight: i === 0 ? 600 : 500 }}>{l}<span style={{ opacity: 0.55, fontSize: 11.5 }}>{n}</span></span>
      ))}
    </div>
  );
}

function Card({ desk, w, mh = 176, hover, current }: { desk: DeskDef; w: number; mh?: number; hover?: boolean; current?: boolean }) {
  const H = HERO[desk.id];
  return (
    <div className={`tile${hover ? " hover" : ""}`} style={{ ...accentVars(desk.accent), padding: 8, gap: 0, borderColor: hover ? "rgb(var(--a-rgb) / 0.45)" : undefined, boxShadow: hover ? "0 0 0 1px rgb(var(--a-rgb) / 0.25), 0 24px 50px -24px rgb(var(--a-rgb) / 0.35), inset 0 1px 0 rgba(255,255,255,0.06)" : undefined }}>
      <Mini desk={desk} width={w - 16} height={mh} />
      <div style={{ padding: "12px 8px 6px", position: "relative", zIndex: 1 }}>
        <div className="row gap8">
          <span style={{ width: 8, height: 8, borderRadius: 99, background: "var(--a)", boxShadow: "0 0 0 3px rgb(var(--a-rgb) / 0.2)" }} />
          <span className="display" style={{ fontSize: 18 }}>{desk.name}</span>
          <span className="faint" style={{ fontSize: 11.5, marginLeft: "auto" }}>{desk.persona}</span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 5, lineHeight: 1.45, minHeight: 36 }}>{desk.blurb}</div>
        <div className="row gap6" style={{ marginTop: 10 }}>
          <span className="pill a"><H.i size={11} />{H.l}</span>
          <span className="pill">{H.n} widgets</span>
          {desk.id === "exam" && <span className="pill y">90-day season</span>}
          {current && <span className="pill g"><Check size={11} />Current</span>}
          {hover && <span className="row gap4" style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, color: "var(--a)" }}>Preview<ArrowRight size={12} /></span>}
        </div>
      </div>
    </div>
  );
}

export function Gallery() {
  const feat = deskById("chambers");
  return (
    <Shell o={{ accent: "indigo", active: "Templates", dev: true, deskName: "Your desk", crumb: "Templates" }}>
      <div className="page">
        <div className="phead">
          <div>
            <div className="kick">Templates</div>
            <h1 className="display">A desk for the work you do</h1>
            <div className="sub">Eight desks, each built around the one thing its person watches. Your tasks, people and notes stay; only tiles, labels and modules change.</div>
          </div>
          <span className="btn"><SlidersHorizontal size={13} />Build your own</span>
        </div>
        <div className="row gap12" style={{ marginBottom: 18 }}>
          <div className="row gap8" style={{ width: 300, height: 34, padding: "0 12px", borderRadius: 10, border: "1px solid var(--line-strong)", background: "rgba(243,238,230,0.03)", color: "var(--faint)", fontSize: 13, flexShrink: 0 }}><Search size={14} />Search desks, widgets, roles<span className="kbd" style={{ marginLeft: "auto" }}>/</span></div>
          <Chips />
        </div>
        {/* featured row */}
        <div style={{ display: "grid", gridTemplateColumns: "1.62fr 1fr", gap: 12, marginBottom: 26 }}>
          <div className="tile hero" style={{ ...accentVars(feat.accent), padding: 10, flexDirection: "row", gap: 0 }}>
            <Mini desk={feat} width={470} height={318} />
            <div className="col" style={{ padding: "14px 18px", gap: 8, flex: 1, position: "relative", zIndex: 1 }}>
              <span className="row gap6 cap" style={{ color: "var(--a)" }}><Star size={11} fill="currentColor" />Featured</span>
              <span className="display" style={{ fontSize: 32 }}>Chambers</span>
              <span style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 }}>A 60-day limitation band that never scrolls away, the week's hearings, and billable time against a target. Built with advocates in Delhi and Pune.</span>
              <div className="col" style={{ gap: 6, marginTop: 6, fontSize: 12.5 }}>
                {["Counts periods under the Limitation Act, holidays included", "Matters, Filings and Hearings replace Projects and Tasks", "Code, Runs and Metrics fold away. Nothing is deleted"].map((x) => <span key={x} className="row gap8"><Check size={13} color="var(--a)" />{x}</span>)}
              </div>
              <div className="row gap8" style={{ marginTop: "auto" }}><span className="btn-p" style={{ padding: "7px 14px", fontSize: 13 }}>Preview Chambers<ArrowRight size={13} /></span><span className="faint" style={{ fontSize: 12, whiteSpace: "nowrap" }}>10 widgets · Brass</span></div>
            </div>
          </div>
          <div className="col" style={{ gap: 12 }}>
            {[deskById("exam"), deskById("branch")].map((d, i) => (
              <div key={d.id} className="tile" style={{ ...accentVars(d.accent), padding: 8, flexDirection: "row", gap: 12, flex: 1 }}>
                <Mini desk={d} width={200} height={146} head={false} />
                <div className="col" style={{ gap: 5, position: "relative", zIndex: 1, paddingTop: 6, flex: 1, minWidth: 0 }}>
                  <span className="cap" style={{ color: "var(--a)" }}>{i === 0 ? "In season · Prelims 2027" : "For builders"}</span>
                  <span className="display" style={{ fontSize: 20 }}>{d.name}</span>
                  <span style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.45 }}>{d.blurb}</span>
                  <span className="row gap4" style={{ marginTop: "auto", fontSize: 12, fontWeight: 600, color: "var(--a)" }}>Preview<ArrowRight size={12} /></span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="row sb" style={{ marginBottom: 12 }}><span className="display" style={{ fontSize: 20 }}>All desks</span><span className="faint" style={{ fontSize: 12.5 }}>Sorted by fit for your work · Developer first</span></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {TEMPLATES.map((d, i) => <Card key={d.id} desk={d} w={286} hover={i === 4} />)}
        </div>
      </div>
    </Shell>
  );
}

export function GalleryMobile() {
  const feat = deskById("chambers");
  return (
    <MobileShell o={{ accent: "indigo" }}>
      <div className="kick" style={{ fontSize: 12, color: "var(--muted)" }}>Templates</div>
      <h1 className="display" style={{ fontSize: 28, margin: "4px 0 6px" }}>A desk for the work you do</h1>
      <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 14 }}>Your tasks stay. Tiles, labels and modules change.</div>
      <div className="row gap8" style={{ height: 40, padding: "0 12px", borderRadius: 12, border: "1px solid var(--line-strong)", background: "rgba(243,238,230,0.03)", color: "var(--faint)", fontSize: 13.5, marginBottom: 12 }}><Search size={15} />Search desks and widgets</div>
      <div style={{ marginRight: -14, marginBottom: 16 }}><Chips /></div>
      <div className="tile hero" style={{ ...accentVars(feat.accent), padding: 8, marginBottom: 12 }}>
        <Mini desk={feat} width={346} height={190} />
        <div className="col" style={{ padding: "12px 6px 4px", gap: 6, position: "relative", zIndex: 1 }}>
          <span className="row gap6 cap" style={{ color: "var(--a)" }}><Star size={11} fill="currentColor" />Featured</span>
          <span className="display" style={{ fontSize: 24 }}>Chambers</span>
          <span style={{ fontSize: 13, color: "var(--muted)" }}>{feat.blurb}</span>
          <span className="btn-p" style={{ alignSelf: "flex-start", marginTop: 6, padding: "8px 14px", fontSize: 13 }}>Preview<ArrowRight size={13} /></span>
        </div>
      </div>
      <div className="col" style={{ gap: 12 }}>
        {TEMPLATES.filter((d) => d.id !== "chambers").map((d) => <Card key={d.id} desk={d} w={362} mh={170} />)}
      </div>
    </MobileShell>
  );
}

/* ── Detail ───────────────────────────────────────────────────────────── */
const GETS = [
  ["Limitation band", "XL"], ["Hearings this week", "M"], ["Billable", "M"], ["Matters by stage", "M"], ["Filings due", "L"],
  ["Draft pair", "L"], ["Cause list · live", "S"], ["Unbilled", "S"], ["Focus", "M"], ["Client follow-ups", "M"],
];
function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ paddingTop: 16, marginTop: 16, borderTop: "1px solid var(--line)" }}>
      <div className="row sb" style={{ marginBottom: 10 }}><span style={{ fontSize: 13, fontWeight: 700 }}>{title}</span>{right}</div>
      {children}
    </div>
  );
}
export function Detail() {
  const d = deskById("chambers");
  const current = DESKS[0];
  return (
    <Shell o={{ accent: "indigo", active: "Templates", dev: true, deskName: "Your desk", crumb: "Templates / Chambers" }}>
      <div className="page" style={{ ...accentVars(d.accent) }}>
        <div className="row gap6" style={{ fontSize: 12.5, color: "var(--faint)", marginBottom: 14 }}>Templates<ChevronRight size={12} /><span className="ink2">Chambers</span></div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 372px", gap: 18, alignItems: "start" }}>
          <div className="col" style={{ gap: 12 }}>
            <div className="tile hero" style={{ padding: 10 }}>
              <div className="row sb" style={{ padding: "2px 6px 10px", position: "relative", zIndex: 1 }}>
                <div className="row" style={{ gap: 2, padding: 3, borderRadius: 9, border: "1px solid var(--line)" }}>
                  {["Today", "Context", "Board"].map((t, i) => <span key={t} style={{ padding: "3px 10px", borderRadius: 6, fontSize: 12, background: i === 0 ? "var(--raised)" : "transparent", color: i === 0 ? "var(--ink)" : "var(--muted)" }}>{t}</span>)}
                </div>
                <span className="row gap6 faint" style={{ fontSize: 12 }}><Eye size={13} />Sample docket · 7 matters</span>
              </div>
              <Mini desk={d} width={790} height={590} />
            </div>
            <div className="row gap12">
              {[["Limitation band", "60 days, red inside 7, amber inside 21; holidays extend the last day under s.4."], ["Hearings strip", "The week with court and item number; court holidays hatched."], ["Billable ring", "Hours against a weekly target, with the day-by-day bars beneath."]].map(([h, s]) => (
                <div key={h} className="tile" style={{ flex: 1, padding: "12px 14px" }}><span style={{ fontSize: 13, fontWeight: 600, position: "relative", zIndex: 1 }}>{h}</span><span className="faint" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.45, position: "relative", zIndex: 1 }}>{s}</span></div>
              ))}
            </div>
          </div>
          <div className="tile" style={{ padding: "20px 20px 18px", position: "sticky", top: 70 }}>
            <div style={{ position: "relative", zIndex: 1 }}>
              <div className="row gap8"><span className="deskchip"><i />Legal</span><span className="faint" style={{ fontSize: 12 }}>v1 · Brass accent</span></div>
              <div className="display" style={{ fontSize: 34, marginTop: 10 }}>Chambers</div>
              <div style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5, marginTop: 6 }}>Limitation dates stay on screen, even when the docket is empty. For advocates who live by the cause list.</div>
              <div className="row gap8" style={{ marginTop: 16 }}>
                <span className="btn-p" style={{ padding: "9px 16px", fontSize: 13.5, flex: 1, justifyContent: "center" }}>Apply Chambers</span>
                <span className="btn" style={{ padding: "8px 12px", fontSize: 13 }}><Eye size={14} />Try on my data</span>
              </div>
              <div className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>Undo for 30 days from Settings · Templates.</div>

              <Section title="What you get" right={<span className="faint" style={{ fontSize: 11.5 }}>10 widgets</span>}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 12px" }}>
                  {GETS.map(([w, s]) => <span key={w} className="row gap6" style={{ fontSize: 12.5 }}><span className="mono" style={{ width: 20, fontSize: 10, color: "var(--a)" }}>{s}</span><span className="trunc">{w}</span></span>)}
                </div>
                <div className="row gap6" style={{ marginTop: 12, flexWrap: "wrap" }}>
                  <Columns3 size={13} color="var(--faint)" />
                  {["Intake", "Drafting", "Filed", "Listed", "Reserved", "Disposed"].map((l) => <span key={l} className="pill">{l}</span>)}
                </div>
                <div className="row gap6" style={{ marginTop: 8, flexWrap: "wrap" }}>
                  <Tag size={13} color="var(--faint)" />
                  {[["limitation", "r"], ["hearing", "a"], ["filing", "y"], ["time", ""]].map(([l, k]) => <span key={l} className={`pill ${k}`}>{l}</span>)}
                </div>
              </Section>

              <Section title={`What changes from ${current.name}`} right={<span className="faint" style={{ fontSize: 11.5 }}>diff</span>}>
                <div className="col" style={{ gap: 5, fontSize: 12.5 }}>
                  {[["+", "Limitation band, Hearings, Billable, Filings, +4 more"], ["−", "Your day, Proposals, Morning brief, People"], ["~", "Focus keeps its tasks; re-grouped by matter"], ["~", "Board → Matters · Project → Matter · Deliverable → Filing"], ["−", "Code, Runs, Skills, Workspace, Metrics hidden"]].map(([k, t], i) => (
                    <div key={i} className="row gap8" style={{ alignItems: "flex-start" }}>
                      <span style={{ width: 18, height: 18, borderRadius: 5, display: "grid", placeItems: "center", flexShrink: 0, background: k === "+" ? "rgb(60 186 134 / 0.15)" : k === "−" ? "rgb(227 107 100 / 0.15)" : "rgba(243,238,230,0.06)", color: k === "+" ? "var(--ok)" : k === "−" ? "var(--danger)" : "var(--muted)" }}>{k === "+" ? <Plus size={11} /> : k === "−" ? <Minus size={11} /> : <RefreshCcw size={10} />}</span>
                      <span style={{ lineHeight: 1.4 }}>{t}</span>
                    </div>
                  ))}
                </div>
              </Section>
              <Section title="What stays">
                <div className="row gap8" style={{ fontSize: 12.5, color: "var(--muted)" }}><Check size={14} color="var(--ok)" />142 tasks, 38 people, 6 projects, reminders and notes</div>
              </Section>
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}

/* ── Apply moment ─────────────────────────────────────────────────────── */
export function Apply({ phase }: { phase: 1 | 2 }) {
  const d = deskById("chambers");
  const old = [
    { l: "Your day", c: 8, r: 4 }, { l: "Needs me", c: 4, r: 2 }, { l: "Morning brief", c: 4, r: 2 },
    { l: "Focus", c: 6, r: 3 }, { l: "Proposals", c: 6, r: 3 },
  ];
  return (
    <Shell o={{ ...shellOpts(d), accent: "brass" }}>
      <div className="page" style={{ position: "relative" }}>
        <TodayHead desk={d} />
        <div style={{ position: "relative" }}>
          <div className={`bento ${phase === 1 ? "applying" : ""}`}>{d.tiles()}</div>
          {phase === 1 && (
            <div className="bento" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              {old.map((o, i) => (
                <div key={o.l} style={{ gridColumn: `span ${o.c}`, gridRow: `span ${o.r}`, borderRadius: 14, border: "1.5px dashed rgba(124,106,247,0.55)", background: "rgba(124,106,247,0.04)", opacity: [0.55, 0.4, 0.3, 0.22, 0.16][i], display: "flex", alignItems: "flex-start", padding: 12, fontSize: 12, color: "#b9aefb", transform: `translateY(${-4 - i}px) scale(${1 - i * 0.004})` }}>
                  <span className="row gap6"><Minus size={11} />{o.l}</span>
                </div>
              ))}
            </div>
          )}
          {phase === 1 && (
            <>
              <span className="note" style={{ left: 610, top: -30 }}>1 · old tiles fade 120 ms · dashed = where they were</span>
              <span className="note" style={{ right: 12, top: 36 }}>2 · accent crossfades indigo → brass, 240 ms</span>
              <span className="note" style={{ left: 380, top: 350 }}>3 · new tiles FLIP into slots · 320 ms · 20 ms stagger</span>
              <span className="note" style={{ right: 12, top: 610 }}>4 · numerals count up, rings draw, after tiles land</span>
            </>
          )}
        </div>
        {phase === 1 && <span className="note" style={{ position: "fixed", left: 118, top: 160 }}>Board → Matters · Code, Runs, Skills fold away</span>}
      </div>
      {phase === 2 && (
        <div style={{ position: "fixed", left: "calc(50% + 104px)", bottom: 28, transform: "translateX(-50%)", zIndex: 30, ...accentVars("brass") }}>
          <div className="toast">
            <span style={{ width: 24, height: 24, borderRadius: 99, display: "grid", placeItems: "center", background: "rgb(var(--a-rgb) / 0.18)", color: "var(--a)" }}><Check size={14} strokeWidth={2.6} /></span>
            <span style={{ fontWeight: 600 }}>You're on Chambers</span>
            <span className="faint">·</span>
            <span className="row gap6" style={{ fontWeight: 600, color: "var(--a)" }}><Undo2 size={14} />Undo</span>
            <span className="kbd">Ctrl Z</span>
            <svg width="18" height="18" style={{ transform: "rotate(-90deg)" }}><circle cx="9" cy="9" r="7" fill="none" stroke="rgba(243,238,230,0.12)" strokeWidth="2" /><circle cx="9" cy="9" r="7" fill="none" stroke="var(--a)" strokeWidth="2" strokeDasharray={`${44 * 0.7} 44`} strokeLinecap="round" /></svg>
          </div>
        </div>
      )}
    </Shell>
  );
}
export { Sparkles, ACCENTS };
