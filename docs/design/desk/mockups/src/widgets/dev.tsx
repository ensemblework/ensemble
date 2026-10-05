import { GitPullRequest, GitBranch, ShieldCheck, Rocket, CircleDot, Layers3, Ban, CheckCheck, MessageSquare } from "lucide-react";
import { Tile, Num, Ring, Bars, Spark, Av, Sk, Seg, type WP } from "../kit/ui";

type PR = { repo: string; n: number; t: string; who: string; ci: ("p" | "f" | "r" | "s")[]; st: "req" | "chg" | "ok" | "re"; add: number; del: number; age: string; com: number };
const PRS: PR[] = [
  { repo: "hub-web", n: 482, t: "feat(today): bento grid with fixed tile heights", who: "Shachee Rane", ci: ["p", "p", "p", "r", "p"], st: "req", add: 612, del: 188, age: "2h", com: 3 },
  { repo: "hub-api", n: 479, t: "fix(layout): reject a second XL placement on write", who: "Priya Nandakumar", ci: ["p", "p", "f", "p", "p"], st: "req", add: 46, del: 12, age: "5h", com: 1 },
  { repo: "hub-web", n: 476, t: "perf: code-split persona widgets per desk", who: "Prajwal Bhagwat", ci: ["p", "p", "p", "p", "p"], st: "chg", add: 238, del: 301, age: "1d", com: 7 },
  { repo: "shared-types", n: 118, t: "chore: add measure + unit to task for desk widgets", who: "Karthik Subramanian", ci: ["p", "p", "p", "p", "s"], st: "ok", add: 64, del: 9, age: "1d", com: 2 },
  { repo: "context-bridge", n: 57, t: "feat: GitHub review threads as artifacts", who: "Ishaan Kapoor", ci: ["p", "p", "p", "p", "p"], st: "re", add: 402, del: 37, age: "3d", com: 11 },
];
const STL = { req: ["Review requested", "a"], chg: ["Changes requested · you", "r"], ok: ["Approved · merge ready", "g"], re: ["Re-review", "y"] } as const;
const CIC = { p: "var(--ok)", f: "var(--danger)", r: "var(--warn)", s: "rgba(243,238,230,0.25)" };

function Diff({ add, del }: { add: number; del: number }) {
  return <span className="mono" style={{ fontSize: 10.5, width: 74, textAlign: "right" }}><span style={{ color: "var(--ok)" }}>+{add}</span> <span style={{ color: "var(--danger)" }}>−{del}</span></span>;
}

export function PrQueue(p: WP) {
  const c = p.c ?? 8, r = p.r ?? 4;
  if (p.state === "skeleton") return <Tile title="Pull requests needing you" icon={GitPullRequest} c={c} r={r} hero skel>{[0, 1, 2, 3, 4].map((i) => <div key={i} className="row gap10" style={{ padding: "9px 0" }}><Sk w={26} h={26} r={99} /><div className="col gap6 grow"><Sk w="60%" h={10} /><Sk w="30%" h={8} /></div><Sk w={50} h={8} /><Sk w={110} h={18} r={99} /></div>)}</Tile>;
  const ghost = p.state === "empty" && { label: "Reviews waiting on you, with CI at a glance", sub: "Connect GitHub, or try the desk with sample pull requests.", action: "Connect GitHub" };
  const rows = p.mobile && (p.c ?? 8) <= 4 && p.state ? PRS.slice(0, 4) : PRS;
  return (
    <Tile title="Pull requests needing you" icon={GitPullRequest} c={c} r={r} hero meta={p.mobile ? "3 on you" : "5 open · 3 on you"} right={p.mobile ? undefined : "ensemble / 4 repos"} hover={p.hover} ghost={ghost} add>
      {p.mobile && !p.state && (
        <div className="row gap10" style={{ alignItems: "flex-end", marginBottom: 4 }}>
          <Num v="3" size={40} /><span className="faint" style={{ fontSize: 12, paddingBottom: 4 }}>waiting on you · oldest 3 days</span>
        </div>
      )}
      {!p.mobile && (
        <div className="row gap16" style={{ alignItems: "flex-end", marginBottom: 8 }}>
          <Num v="3" size={52} />
          <div className="col" style={{ paddingBottom: 5 }}><span style={{ fontSize: 13.5, fontWeight: 600 }}>waiting on your review</span><span className="faint" style={{ fontSize: 12 }}>oldest 3 days · #57 context-bridge</span></div>
          <div className="row gap16" style={{ marginLeft: "auto", paddingBottom: 6, fontSize: 11.5, color: "var(--faint)" }}>
            <span className="row gap4"><span className="dot" />passing</span><span className="row gap4"><span className="dot" style={{ background: "var(--warn)" }} />running</span><span className="row gap4"><span className="dot" style={{ background: "var(--danger)" }} />failed</span>
          </div>
        </div>
      )}
      <div className="col">
        {rows.map((x) => (
          <div key={x.n} className="li" style={{ padding: p.mobile ? "7px 0" : "6px 0" }}>
            <Av n={x.who} s={24} />
            <div className="col grow" style={{ minWidth: 0 }}>
              <span className="t" style={{ fontSize: 13 }}>{x.t}</span>
              <span className="m"><span className="mono" style={{ fontSize: 10.5 }}>{x.repo}#{x.n}</span> · {x.who.split(" ")[0]} · {x.age}</span>
            </div>
            {!p.mobile && <span className="row gap4 m"><MessageSquare size={11} />{x.com}</span>}
            {!p.mobile && <Diff add={x.add} del={x.del} />}
            <span className="row" style={{ gap: 3 }}>{x.ci.map((c, i) => <span key={i} style={{ width: 7, height: 7, borderRadius: 99, background: CIC[c], boxShadow: c === "r" ? "0 0 6px var(--warn)" : "none" }} />)}</span>
            {!p.mobile ? <span className={`pill ${STL[x.st][1]}`} style={{ width: 150, justifyContent: "center" }}>{STL[x.st][0]}</span> : <span className={`pill ${STL[x.st][1]}`}>{x.st === "chg" ? "Changes" : x.st === "ok" ? "Ready" : x.st === "re" ? "Re-review" : "Review"}</span>}
          </div>
        ))}
      </div>
    </Tile>
  );
}

export function BranchActivity(p: WP) {
  const ghost = p.state === "empty" && { label: "Commits on your branch", sub: "", action: "Link a repo" };
  return (
    <Tile title="Branch activity" icon={GitBranch} c={p.c ?? 4} r={p.r ?? 2} meta="14 days" hover={p.hover} ghost={ghost}>
      <div className="row sb" style={{ alignItems: "flex-end" }}>
        <div className="col"><Num v="38" size={34} unit="commits" /><span className="mono faint" style={{ marginTop: 4 }}>feature-2 · 12 ahead of main</span></div>
        <Bars data={[2, 4, 1, 0, 0, 5, 3, 6, 2, 1, 0, 4, 7, 3]} w={p.mobile ? 120 : 150} h={40} hi={13} gap={2.5} />
      </div>
    </Tile>
  );
}

export function CiHealth(p: WP) {
  if (p.mobile)
    return (
      <Tile title="CI" icon={ShieldCheck} c={2} r={2} pad="14px" meta="7 days">
        <div className="row gap10" style={{ alignItems: "center", flex: 1 }}>
          <Ring p={0.94} size={50} stroke={5} color="var(--ok)"><span style={{ fontSize: 11.5, fontWeight: 700 }}>94%</span></Ring>
          <div className="col"><span className="num" style={{ fontSize: 24 }}>2</span><span className="faint" style={{ fontSize: 11 }}>flaky tests</span></div>
        </div>
      </Tile>
    );
  return (
    <Tile title="CI health" icon={ShieldCheck} c={p.c ?? 4} r={p.r ?? 2} meta="main · 7 days" hover={p.hover}>
      <div className="row gap12" style={{ alignItems: "center", flex: 1 }}>
        <Ring p={0.94} size={56} stroke={5} color="var(--ok)"><span style={{ fontSize: 12, fontWeight: 700 }}>94%</span></Ring>
        <div className="col" style={{ minWidth: 0, gap: 2 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>2 flaky tests</span>
          <span className="mono faint trunc">e2e/today.spec.ts · 3/20</span>
          <span className="mono faint trunc">api/layout.test.ts · 1/20</span>
        </div>
      </div>
    </Tile>
  );
}

const DEP: { env: string; pts: { x: number; ok: boolean; v?: string }[] }[] = [
  { env: "production", pts: [{ x: 0.08, ok: true, v: "v0.41.0" }, { x: 0.46, ok: true, v: "v0.41.2" }, { x: 0.9, ok: true, v: "v0.42.1" }] },
  { env: "staging", pts: [{ x: 0.05, ok: true }, { x: 0.2, ok: true }, { x: 0.33, ok: false }, { x: 0.36, ok: true }, { x: 0.58, ok: true }, { x: 0.72, ok: true }, { x: 0.86, ok: true }] },
  { env: "preview", pts: Array.from({ length: 14 }, (_, i) => ({ x: 0.04 + i * 0.068, ok: i !== 9 })) },
];
export function Deploys(p: WP) {
  const ghost = p.state === "empty" && { label: "Every deploy on one line", sub: "", action: "Connect deploys" };
  return (
    <Tile title="Deploys" icon={Rocket} c={p.c ?? 6} r={p.r ?? 3} meta="last 7 days" right="v0.42.1 on prod · 2 h ago" hover={p.hover} ghost={ghost}>
      <div className="col" style={{ gap: 12, flex: 1, justifyContent: "center" }}>
        {DEP.map((d) => (
          <div key={d.env} className="row gap10">
            <span className="mono" style={{ width: 74, color: d.env === "production" ? "var(--ink)" : "var(--faint)" }}>{d.env}</span>
            <div className="grow" style={{ position: "relative", height: 22 }}>
              <div style={{ position: "absolute", left: 0, right: 0, top: 10.5, height: 1, background: "var(--line-strong)" }} />
              {d.pts.map((pt, i) => (
                <span key={i} style={{ position: "absolute", left: `${pt.x * 100}%`, top: d.env === "production" ? 4 : 7, width: d.env === "production" ? 14 : 8, height: d.env === "production" ? 14 : 8, marginLeft: -4, borderRadius: d.env === "production" ? 4 : 99, background: pt.ok ? (d.env === "production" ? "var(--a)" : "rgb(var(--a-rgb) / 0.55)") : "var(--danger)", boxShadow: "0 0 0 3px var(--tile)" }} />
              ))}
              {d.env === "production" && d.pts.map((pt) => <span key={pt.v} className="mono" style={{ position: "absolute", left: `${pt.x * 100}%`, top: -12, fontSize: 9.5, color: "var(--muted)", transform: "translateX(-30%)" }}>{pt.v ?? ""}</span>)}
            </div>
          </div>
        ))}
      </div>
      <div className="row sb faint" style={{ fontSize: 10.5, paddingLeft: 84 }}><span>Thu 24</span><span>Sat 26</span><span>Mon 28</span><span>Today</span></div>
    </Tile>
  );
}

const ISS = [
  { id: "ENS-512", t: "Context overview renders an empty card with 0 people", p: 3, l: ["bug", "context"], e: "S" },
  { id: "ENS-507", t: "Undo toast hides behind the Ask dock on 390", p: 2, l: ["bug", "mobile"], e: "XS" },
  { id: "ENS-498", t: "Template apply: animate tiles to new slots", p: 2, l: ["desk"], e: "M" },
  { id: "ENS-490", t: "Widget skeletons should match final tile shape", p: 1, l: ["desk", "perf"], e: "S" },
  { id: "ENS-486", t: "Count-up numerals ignore reduced motion in Safari", p: 1, l: ["a11y"], e: "XS" },
];
export function Issues(p: WP) {
  const ghost = p.state === "empty" && { label: "Issues assigned to you", sub: "", action: "Connect Linear or GitHub" };
  return (
    <Tile title="Assigned to you" icon={CircleDot} c={p.c ?? 6} r={p.r ?? 3} meta="4 issues · cycle 14" hover={p.hover} ghost={ghost}>
      <div className="col">
        {ISS.map((x) => (
          <div key={x.id} className="li">
            <span className="row" style={{ gap: 1.5, alignItems: "flex-end", height: 12 }}>{[1, 2, 3].map((i) => <span key={i} style={{ width: 3, height: 4 + i * 2.5, borderRadius: 1, background: i <= x.p ? (x.p === 3 ? "var(--danger)" : "var(--ink-2)") : "rgba(243,238,230,0.15)" }} />)}</span>
            <span className="mono faint" style={{ width: 58 }}>{x.id}</span>
            <span className="t">{x.t}</span>
            {!p.mobile && x.l.map((l) => <span key={l} className="pill">{l}</span>)}
            <span className="m" style={{ width: 20, textAlign: "right" }}>{x.e}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}

export function Wip(p: WP) {
  return (
    <Tile title="In progress" icon={Layers3} c={p.c ?? 4} r={p.r ?? 2} meta="WIP cap 5" hover={p.hover}>
      <div className="row sb" style={{ alignItems: "flex-end" }}><Num v="4" size={36} unit="of 5" /><span className="faint" style={{ fontSize: 11.5, paddingBottom: 4 }}>1 slot free</span></div>
      <div style={{ marginTop: "auto" }}><Seg n={5} done={4} h={8} gap={4} /></div>
    </Tile>
  );
}
export function Blocked(p: WP) {
  return (
    <Tile title="Blocked" icon={Ban} c={p.c ?? 4} r={p.r ?? 2} meta="1 task" hover={p.hover}>
      <div className="row gap10" style={{ alignItems: "center" }}><Num v="1" size={36} color="var(--warn)" /><div className="col" style={{ minWidth: 0 }}><span className="trunc" style={{ fontSize: 12.5, fontWeight: 500 }}>Bump the retry helper</span><span className="faint" style={{ fontSize: 11.5 }}>waiting on Priya · 3d</span></div></div>
      <div className="row gap6" style={{ marginTop: "auto" }}><Av n="Priya Nandakumar" s={20} /><span className="faint" style={{ fontSize: 11.5 }}>Asked in #infra, Mon 4:12 pm</span></div>
    </Tile>
  );
}
export function WeekDone(p: WP) {
  return (
    <Tile title="Done this week" icon={CheckCheck} c={p.c ?? 4} r={p.r ?? 2} meta="vs 8 last week" hover={p.hover}>
      <div className="row sb" style={{ alignItems: "flex-start" }}>
        <Num v="11" size={36} unit="tasks" />
        <Bars data={[4, 3, 4, 0, 0]} w={110} h={40} hi={2} labels={["M", "T", "W", "T", "F"]} />
      </div>
      <div className="faint" style={{ fontSize: 11.5, marginTop: "auto" }}><span className="ok">↑ 3</span> on last week · 2 by the agent</div>
    </Tile>
  );
}
export { Spark };
