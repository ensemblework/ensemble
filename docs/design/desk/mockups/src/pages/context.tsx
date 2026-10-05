import { Fragment } from "react";
import { Briefcase, Users, FileText, Mail, MessageCircle, Receipt, ScanLine, Landmark, Library, Database, FileCode2, NotebookText, GitFork, Presentation, Pencil, Search, Mic } from "lucide-react";
import { Shell } from "../kit/shell";
import { shellOpts } from "../desks/today";
import type { DeskDef } from "../desks/registry";
import { Tile, Av, Num } from "../kit/ui";
import * as L from "../widgets/legal";
import * as R from "../widgets/research";

function Head({ desk, tabs }: { desk: DeskDef; tabs: string[] }) {
  return (
    <>
      <div className="phead" style={{ marginBottom: 14 }}>
        <div>
          <div className="kick"><span className="deskchip"><i />{desk.name} lens</span></div>
          <h1 className="display">Context</h1>
          <div className="sub">{desk.id === "chambers" ? "Everyone and everything behind your 13 matters, grouped by matter." : "The people, papers and data behind Chapter 2, grouped by project."}</div>
        </div>
        <div className="row gap8"><span className="btn"><Search size={13} />Find</span><span className="btn"><Pencil size={13} />Edit layout</span></div>
      </div>
      <div className="row" style={{ gap: 2, padding: 3, borderRadius: 10, border: "1px solid var(--line)", background: "rgba(243,238,230,0.02)", alignSelf: "flex-start", width: "fit-content", marginBottom: 16 }}>
        {tabs.map((t, i) => <span key={t} style={{ padding: "4px 11px", borderRadius: 7, fontSize: 12.5, color: i === 0 ? "var(--ink)" : "var(--muted)", background: i === 0 ? "var(--raised)" : "transparent", boxShadow: i === 0 ? "inset 0 1px 0 rgba(255,255,255,0.05)" : "none" }}>{t}</span>)}
      </div>
    </>
  );
}

/* ── Chambers ─────────────────────────────────────────────────────────── */
const MATTERS = [
  { n: "Rao v. Sunrise Hospital", f: "NCDRC", st: "Pleadings", next: "Limitation 5 Oct", c: "Sunita Rao", docs: 14, hot: "r" },
  { n: "Mehta Textiles v. Union of India", f: "Supreme Court", st: "Pleadings", next: "SLP by 6 Oct", c: "Vikram Mehta", docs: 31, hot: "r" },
  { n: "Arora v. DLF Homes", f: "State Commission", st: "Pleadings", next: "Written version 14 Oct", c: "Ritu Arora", docs: 22, hot: "y" },
  { n: "Nair Estates v. Kochhar", f: "Commercial Court, Saket", st: "Evidence", next: "Mediation Sat", c: "Harish Nair", docs: 48, hot: "y" },
  { n: "State v. R. Khanna", f: "Delhi HC · Ct 32", st: "Arguments", next: "Bail today, item 14", c: "Rohit Khanna", docs: 19, hot: "" },
  { n: "Joshi v. Joshi", f: "Tis Hazari", st: "Reserved", next: "Order reserved 11 Sept", c: "Anjali Joshi", docs: 37, hot: "" },
];
function MattersLens() {
  return (
    <Tile title="Matters" icon={Briefcase} c={8} r={4} hero meta="13 active · 6 shown" right="grouped by stage">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gridTemplateRows: "repeat(2, 1fr)", gap: 10, flex: 1 }}>
        {MATTERS.map((m) => (
          <div key={m.n} className="col" style={{ borderRadius: 11, padding: "10px 12px", background: "rgba(243,238,230,0.03)", border: "1px solid rgba(243,238,230,0.07)", boxShadow: m.hot ? `inset 0 2px 0 ${m.hot === "r" ? "var(--danger)" : "var(--warn)"}` : "inset 0 1px 0 rgba(255,255,255,0.03)", gap: 6 }}>
            <div className="row sb"><span className="pill">{m.st}</span><span className="faint" style={{ fontSize: 11 }}>{m.docs} docs</span></div>
            <span className="display" style={{ fontSize: 15.5, lineHeight: 1.2 }}>{m.n}</span>
            <span className="faint trunc" style={{ fontSize: 11.5 }}><Landmark size={11} style={{ verticalAlign: -1 }} /> {m.f}</span>
            <div className="row gap6" style={{ marginTop: "auto" }}><Av n={m.c} s={20} /><span className="trunc" style={{ fontSize: 11.5, color: m.hot === "r" ? "#ffb9b3" : "var(--ink-2)" }}>{m.next}</span></div>
          </div>
        ))}
      </div>
    </Tile>
  );
}
const PEOPLE_L = [
  { g: "Clients", p: [{ n: "Sunita Rao", r: "Rao v. Sunrise" }, { n: "Vikram Mehta", r: "MD, Mehta Textiles" }, { n: "Harish Nair", r: "Director, Nair Estates" }] },
  { g: "Counsel", p: [{ n: "Adv. Kavita Sen", r: "Senior counsel · SLP" }, { n: "Adv. Manish Gupta", r: "Opposite, DLF Homes" }] },
  { g: "Chamber", p: [{ n: "Suresh Yadav", r: "Clerk · filings" }] },
];
function PeopleLens({ groups, meta, more }: { groups: typeof PEOPLE_L; meta: string; more: string }) {
  return (
    <Tile title="People" icon={Users} c={4} r={4} meta={meta} add>
      <div className="col" style={{ gap: 8 }}>
        {groups.map((g) => (
          <div key={g.g}>
            <div className="cap" style={{ fontSize: 9.5, marginBottom: 3 }}>{g.g}</div>
            {g.p.map((x) => (
              <div key={x.n} className="row gap8" style={{ padding: "3px 0" }}><Av n={x.n} s={24} /><div className="col" style={{ minWidth: 0 }}><span className="trunc" style={{ fontSize: 12.5, fontWeight: 500 }}>{x.n}</span><span className="trunc faint" style={{ fontSize: 11 }}>{x.r}</span></div></div>
            ))}
          </div>
        ))}
      </div>
      <div className="row gap6" style={{ marginTop: "auto", fontSize: 12, color: "var(--a)", fontWeight: 600 }}>{more}</div>
    </Tile>
  );
}
const ART_L = [
  { i: FileText, t: "HC order dt. 8 Jul 2026 · certified copy.pdf", m: "Mehta Textiles", w: "Tue", k: "PDF" },
  { i: Mail, t: "Re: vakalatnama signature — Sunita Rao", m: "Rao v. Sunrise", w: "Mon", k: "Email" },
  { i: MessageCircle, t: "Payment receipts 2019 (7 photos)", m: "Arora v. DLF", w: "Sun", k: "WhatsApp" },
  { i: Receipt, t: "e-Filing acknowledgement · Diary 41822/2026", m: "Mehta Textiles", w: "25 Sept", k: "Receipt" },
  { i: ScanLine, t: "Exhibit P-7 · site inspection report", m: "Nair Estates", w: "22 Sept", k: "Scan" },
];
function ArtifactsLens({ rows, meta, src }: { rows: typeof ART_L; meta: string; src: string }) {
  return (
    <Tile title="Artifacts" icon={FileText} c={6} r={3} meta={meta} right={src}>
      <div className="col">
        {rows.map((a) => (
          <div key={a.t} className="li">
            <span style={{ width: 26, height: 26, borderRadius: 7, display: "grid", placeItems: "center", background: "rgba(243,238,230,0.05)", border: "1px solid rgba(243,238,230,0.07)", color: "var(--a)", flexShrink: 0 }}><a.i size={13} /></span>
            <span className="t">{a.t}</span>
            <span className="pill">{a.m}</span>
            <span className="m" style={{ width: 48, textAlign: "right" }}>{a.w}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}
function Forums() {
  const F = [{ l: "Delhi HC", n: 5 }, { l: "District courts", n: 3 }, { l: "Consumer fora", n: 3 }, { l: "Supreme Court", n: 1 }, { l: "Arbitration", n: 1 }];
  return (
    <Tile title="Forums" icon={Landmark} c={3} r={3} meta="13 matters">
      <div className="col" style={{ gap: 8, flex: 1, justifyContent: "space-around" }}>
        {F.map((f) => (
          <div key={f.l} className="row gap8"><span className="grow ink2" style={{ fontSize: 12 }}>{f.l}</span><div style={{ width: 70, height: 6, borderRadius: 3, background: "rgba(243,238,230,0.07)" }}><div style={{ width: `${(f.n / 5) * 100}%`, height: "100%", borderRadius: 3, background: "var(--a)" }} /></div><span className="num" style={{ fontSize: 16, width: 14, textAlign: "right" }}>{f.n}</span></div>
        ))}
      </div>
    </Tile>
  );
}

export function ContextChambers({ desk }: { desk: DeskDef }) {
  return (
    <Shell o={{ ...shellOpts(desk, "Context"), crumb: "Context" }}>
      <div className="page">
        <Head desk={desk} tabs={["Overview", "People", "Matters", "Artifacts & sync", "Graph"]} />
        <div className="bento">
          <MattersLens />
          <PeopleLens groups={PEOPLE_L} meta="18 · 7 roles" more="All 18 people →" />
          <ArtifactsLens rows={ART_L} meta="212 · synced 4 min ago" src="Gmail · Drive · WhatsApp export" />
          <L.Drafts c={3} r={3} />
          <Forums />
        </div>
      </div>
    </Shell>
  );
}

/* ── Literature ───────────────────────────────────────────────────────── */
const VENUES = ["Interspeech", "ICASSP", "AAAI", "ACL / EMNLP", "NeurIPS / ICML", "TASLP / JMLR"];
const YEARS = [2020, 2021, 2022, 2023, 2024, 2025];
const DOTS: [number, number, number][] = [
  [0, 0, 3], [0, 2, 3], [0, 3, 2], [0, 3, 1], [0, 3, 0], [0, 4, 0], [0, 4, 3], [0, 5, 0],
  [1, 1, 3], [1, 3, 2], [1, 4, 0], [1, 5, 0], [1, 5, 1],
  [2, 2, 2], [2, 3, 2], [2, 3, 3],
  [3, 2, 3], [3, 4, 0], [3, 4, 0], [3, 5, 0],
  [4, 0, 3], [4, 1, 3], [4, 3, 1], [4, 2, 3],
  [5, 1, 3], [5, 4, 0], [5, 4, 3],
];
const STC = ["rgba(243,238,230,0.35)", "var(--a)", "#c9a4e0", "#d9d1c4"];
function VenueMap() {
  return (
    <Tile title="Papers by venue and year" icon={Library} c={8} r={4} hero meta="39 papers" right={<span className="row gap10">{["To read", "Reading", "Notes", "Cited"].map((l, i) => <span key={l} className="row gap4"><span className="sq" style={{ background: i ? STC[i] : "transparent", border: i ? "none" : "1.5px dashed rgba(243,238,230,0.5)", borderRadius: 99 }} />{l}</span>)}</span>}>
      <div style={{ display: "grid", gridTemplateColumns: "120px repeat(6, 1fr)", gridTemplateRows: "repeat(6, 1fr) 18px", flex: 1, columnGap: 6 }}>
        {VENUES.map((v, vi) => (
          <Fragment key={v}>
            <span className="row" style={{ fontSize: 12, color: "var(--ink-2)", borderTop: vi ? "1px solid var(--line)" : 0 }}>{v}</span>
            {YEARS.map((y, yi) => {
              const here = DOTS.filter((d) => d[0] === vi && d[1] === yi);
              return (
                <div key={v + y} className="row" style={{ gap: 4, borderTop: vi ? "1px solid var(--line)" : 0, justifyContent: "center", background: yi === 3 && vi === 0 ? "rgb(var(--a-rgb) / 0.06)" : "transparent", borderRadius: 4 }}>
                  {here.map((d, i) => <span key={i} style={{ width: 12, height: 12, borderRadius: 99, background: STC[d[2]], boxShadow: d[2] === 1 ? "0 0 8px var(--a)" : "none", border: d[2] === 0 ? "1.5px dashed rgba(243,238,230,0.35)" : "none", backgroundClip: "padding-box", ...(d[2] === 0 ? { background: "transparent" } : {}) }} />)}
                </div>
              );
            })}
          </Fragment>
        ))}
        <span />
        {YEARS.map((y) => <span key={y} className="mono faint" style={{ textAlign: "center", fontSize: 10.5, paddingTop: 4 }}>{y}</span>)}
      </div>
      <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>Interspeech 2023 is the densest cell: 3 papers you still owe notes on.</div>
    </Tile>
  );
}
const PEOPLE_R = [
  { g: "Supervision", p: [{ n: "Dr. Meera Iyer", r: "Advisor · IIT Madras" }, { n: "Prof. Hema Murthy", r: "Committee" }] },
  { g: "Co-authors", p: [{ n: "Karthik Subramanian", r: "Tamil ASR · ARR paper" }, { n: "Ananya Ramesh", r: "Hinglish baselines" }] },
  { g: "Lab", p: [{ n: "Farhan Ali", r: "GPU queue · A100 × 4" }, { n: "Divya Krishnan", r: "Annotation lead" }] },
];
const ART_R = [
  { i: FileText, t: "Radford-2023-Whisper.pdf · 14 highlights", m: "Reading", w: "today", k: "PDF" },
  { i: NotebookText, t: "Notes — IndicWav2Vec pretraining recipe", m: "Notes", w: "Tue", k: "Note" },
  { i: FileCode2, t: "thesis.bib · 212 entries, 3 missing DOIs", m: "Ch 2", w: "Mon", k: "Bib" },
  { i: GitFork, t: "iitm-speech/indic-asr-bench · 4 open PRs", m: "Code", w: "Mon", k: "Repo" },
  { i: Presentation, t: "Lab talk — SSL for Indic ASR.pptx", m: "Talks", w: "18 Sept", k: "Slides" },
];
function Datasets() {
  const D = [{ l: "IndicVoices", h: 1639 }, { l: "Vistaar test", h: 842 }, { l: "Lahaja", h: 12.5 }, { l: "Svarah", h: 9.6 }];
  return (
    <Tile title="Datasets" icon={Database} c={3} r={3} meta="hours of speech">
      <div className="col" style={{ gap: 9, flex: 1, justifyContent: "space-around" }}>
        {D.map((d) => (
          <div key={d.l} className="col" style={{ gap: 4 }}>
            <div className="row sb" style={{ fontSize: 12 }}><span className="ink2"><Mic size={11} style={{ verticalAlign: -1 }} /> {d.l}</span><span className="num" style={{ fontSize: 15 }}>{d.h >= 100 ? d.h.toLocaleString("en-IN") : d.h}</span></div>
            <div className="bar" style={{ height: 4 }}><i style={{ width: `${Math.max(4, (Math.log10(d.h) / Math.log10(1700)) * 100)}%` }} /></div>
          </div>
        ))}
      </div>
    </Tile>
  );
}
export function ContextLiterature({ desk }: { desk: DeskDef }) {
  return (
    <Shell o={{ ...shellOpts(desk, "Context"), crumb: "Context" }}>
      <div className="page">
        <Head desk={desk} tabs={["Overview", "People", "Papers", "Artifacts & sync", "Graph"]} />
        <div className="bento">
          <VenueMap />
          <PeopleLens groups={PEOPLE_R} meta="14 · 3 groups" more="All 14 people →" />
          <ArtifactsLens rows={ART_R} meta="318 · synced 12 min ago" src="Zotero · Drive · GitHub" />
          <R.CiteGraph c={3} r={3} />
          <Datasets />
        </div>
      </div>
    </Shell>
  );
}
export { Num };
