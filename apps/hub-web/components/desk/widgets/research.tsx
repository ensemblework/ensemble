"use client";
import { Library, PenLine, Share2, Flame, HelpCircle, CalendarClock, Send, ChevronRight, FileText } from "lucide-react";
import { Tile, Num, Spark, Bars, Av, Sk, Seg, type WP } from "../ui";

type Paper = { t: string; a: string; y: number; v: string; vk: "conf" | "journal" | "arxiv"; x?: string };
const LANES: { l: string; n: number; papers: Paper[] }[] = [
  { l: "To read", n: 9, papers: [
    { t: "Lahaja: A robust multi-accent benchmark for Hindi ASR", a: "Javed et al.", y: 2024, v: "Interspeech", vk: "conf", x: "added by Dr. Iyer" },
    { t: "Scaling speech technology to 1,000+ languages", a: "Pratap et al.", y: 2024, v: "JMLR", vk: "journal", x: "48 pp" },
    { t: "Svarah: English ASR on Indian accents", a: "Javed et al.", y: 2023, v: "Interspeech", vk: "conf" },
  ] },
  { l: "Reading", n: 3, papers: [
    { t: "Robust speech recognition via large-scale weak supervision", a: "Radford et al.", y: 2023, v: "ICML", vk: "conf", x: "p. 11 of 28" },
    { t: "Vistaar: Diverse benchmarks for Indian-language ASR", a: "Bhogale et al.", y: 2023, v: "Interspeech", vk: "conf", x: "p. 3 of 5" },
  ] },
  { l: "Notes", n: 4, papers: [
    { t: "Towards building ASR systems for the next billion users", a: "Javed et al.", y: 2022, v: "AAAI", vk: "conf", x: "14 notes" },
    { t: "XLS-R: Self-supervised cross-lingual speech representation", a: "Babu et al.", y: 2022, v: "Interspeech", vk: "conf", x: "9 notes" },
    { t: "IndicSUPERB: A speech processing universal benchmark", a: "Javed et al.", y: 2023, v: "AAAI", vk: "conf", x: "6 notes" },
  ] },
  { l: "Cited", n: 23, papers: [
    { t: "wav2vec 2.0: Self-supervised learning of speech representations", a: "Baevski et al.", y: 2020, v: "NeurIPS", vk: "conf", x: "Ch 2 §2.1, §2.3" },
    { t: "Conformer: Convolution-augmented transformer for ASR", a: "Gulati et al.", y: 2020, v: "Interspeech", vk: "conf", x: "Ch 2 §2.2" },
    { t: "HuBERT: Self-supervised speech representation learning", a: "Hsu et al.", y: 2021, v: "IEEE TASLP", vk: "journal", x: "Ch 2 §2.1" },
  ] },
];
const VK = { conf: "var(--accent)", journal: "#c9a4e0", arxiv: "#e0b15a" };

export function Pipeline(p: WP) {
  const c = p.c ?? 12, r = p.r ?? 4;
  if (p.state === "skeleton") return <Tile title="Reading pipeline" icon={Library} c={c} r={r} hero skel><div className="row gap12" style={{ flex: 1 }}>{LANES.map((l) => <div key={l.l} className="col gap8" style={{ flex: 1 }}><Sk w={80} h={10} /><Sk h={62} r={10} /><Sk h={62} r={10} /></div>)}</div></Tile>;
  const ghost = p.state === "empty" && { label: "Papers move left to right as you read", sub: "Drop a DOI, an arXiv link or a PDF. Venue and year fill in on their own.", action: "Add your first paper" };
  return (
    <Tile title="Reading pipeline" icon={Library} c={c} r={r} hero meta="39 papers · Ch 2, Related work" right="3 moved this week" hover={p.hover} ghost={ghost} add>
      <div className="row" style={{ flex: 1, gap: 10, alignItems: "stretch", minHeight: 0 }}>
        {LANES.map((l, li) => (
          <div key={l.l} className="row" style={{ flex: 1, minWidth: 0, gap: 10 }}>
            <div className="col" style={{ flex: 1, minWidth: 0, gap: 7 }}>
              <div className="row gap8" style={{ padding: "0 2px" }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: li === 1 ? "var(--accent)" : "var(--ink-2)" }}>{l.l}</span>
                <span className="num" style={{ fontSize: 18, color: "var(--muted)" }}>{l.n}</span>
                <div className="grow" style={{ height: 2, borderRadius: 2, background: `rgb(var(--accent-rgb) / ${0.12 + li * 0.18})` }} />
              </div>
              {li === 1 && null}
              {l.papers.map((pp) => (
                <div key={pp.t} style={{ borderRadius: 10, padding: "8px 10px", background: li === 1 ? "rgb(var(--accent-rgb) / 0.07)" : "rgba(243,238,230,0.03)", border: `1px solid ${li === 1 ? "rgb(var(--accent-rgb) / 0.25)" : "rgba(243,238,230,0.065)"}`, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)" }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", fontFamily: "var(--font-display)", letterSpacing: "-0.005em" }}>{pp.t}</div>
                  <div className="row gap6" style={{ marginTop: 5, fontSize: 11 }}>
                    <span style={{ padding: "0 5px", borderRadius: 4, border: `1px solid color-mix(in srgb, ${VK[pp.vk]} 40%, transparent)`, color: VK[pp.vk], fontWeight: 600, fontSize: 10.5, lineHeight: "15px" }}>{pp.v} {String(pp.y).slice(2)}</span>
                    <span className="faint trunc grow">{pp.a}</span>
                    {pp.x && <span className="faint" style={{ whiteSpace: "nowrap" }}>{pp.x}</span>}
                  </div>
                  {li === 1 && pp.x?.startsWith("p.") && <div className="bar" style={{ height: 3, marginTop: 6 }}><i style={{ width: pp.x.includes("11") ? "39%" : "60%" }} /></div>}
                </div>
              ))}
              {li === 1 && <div className="row gap6" style={{ justifyContent: "center", borderRadius: 10, padding: "9px 10px", border: "1px dashed rgb(var(--accent-rgb) / 0.3)", fontSize: 11.5, color: "var(--faint)" }}>Drop a PDF, DOI or arXiv link</div>}
            </div>
            {li < 3 && <ChevronRight size={14} color="var(--ghost)" style={{ alignSelf: "center", flexShrink: 0 }} />}
          </div>
        ))}
      </div>
    </Tile>
  );
}

export function WordCount(p: WP) {
  const ghost = p.state === "empty" && { label: "Words toward a goal", sub: "", action: "Link your draft" };
  return (
    <Tile title="Chapter 2 draft" icon={PenLine} c={p.c ?? 4} r={p.r ?? 3} meta="Related work" hover={p.hover} ghost={ghost}>
      <div className="row sb" style={{ alignItems: "flex-end" }}>
        <Num v="7,840" size={40} unit="words" />
        <span style={{ fontSize: 12, color: "var(--faint)", paddingBottom: 5 }}>goal 12,000</span>
      </div>
      <div style={{ marginTop: 10 }}>
        <div className="bar" style={{ height: 8 }}><i style={{ width: "65%", background: "linear-gradient(90deg, rgb(var(--accent-rgb)/0.5), var(--accent))" }} /></div>
        <div className="row sb" style={{ fontSize: 11, color: "var(--faint)", marginTop: 5 }}><span>65%</span><span>~9 days at 460/day · 9 Oct</span></div>
      </div>
      <div style={{ marginTop: "auto" }}><Bars data={[320, 610, 0, 480, 720, 150, 0, 540, 390, 860, 410, 0, 530, 466]} w={(p.c ?? 4) < 4 ? 250 : 320} h={36} hi={13} /></div>
    </Tile>
  );
}

const NODES = [
  { x: 150, y: 88, r: 15, l: "Ch 2", me: true },
  { x: 62, y: 42, r: 10, l: "wav2vec 2.0" }, { x: 44, y: 110, r: 8, l: "HuBERT" }, { x: 95, y: 150, r: 7, l: "XLS-R" },
  { x: 250, y: 40, r: 9, l: "IndicWav2Vec" }, { x: 268, y: 118, r: 7, l: "Vistaar" }, { x: 214, y: 158, r: 6, l: "IndicSUPERB" },
  { x: 150, y: 20, r: 6, l: "Whisper" }, { x: 320, y: 78, r: 5, l: "Lahaja" },
];
const EDGES = [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [1, 2], [1, 3], [4, 5], [4, 6], [5, 8], [3, 4], [7, 5]];
export function CiteGraph(p: WP) {
  const ghost = p.state === "empty" && { label: "Who cites whom", sub: "", action: "Import a .bib file" };
  return (
    <Tile title="Citation graph" icon={Share2} c={p.c ?? 4} r={p.r ?? 3} meta="23 cited · 2 clusters" hover={p.hover} ghost={ghost}>
      <svg viewBox="0 0 340 180" style={{ width: "100%", flex: 1, minHeight: 0 }}>
        <ellipse cx={80} cy={100} rx={80} ry={70} fill="rgb(var(--accent-rgb) / 0.04)" />
        <ellipse cx={260} cy={100} rx={80} ry={75} fill="rgba(201,164,224,0.05)" />
        <text x={14} y={176} fontSize="9.5" fill="var(--faint)" fontFamily="Figtree">Self-supervised</text>
        <text x={270} y={176} fontSize="9.5" fill="var(--faint)" fontFamily="Figtree">Indic benchmarks</text>
        {EDGES.map(([a, b], i) => <line key={i} x1={NODES[a].x} y1={NODES[a].y} x2={NODES[b].x} y2={NODES[b].y} stroke={a === 0 ? "rgb(var(--accent-rgb) / 0.35)" : "rgba(243,238,230,0.12)"} strokeWidth={a === 0 ? 1.2 : 1} />)}
        {NODES.map((n) => (
          <g key={n.l}>
            <circle cx={n.x} cy={n.y} r={n.r + 4} fill={n.me ? "rgb(var(--accent-rgb) / 0.18)" : "transparent"} />
            <circle cx={n.x} cy={n.y} r={n.r} fill={n.me ? "var(--accent)" : n.x > 200 ? "#c9a4e0" : "rgb(var(--accent-rgb) / 0.75)"} stroke="var(--tile)" strokeWidth={2} />
            <text x={n.x} y={n.y + n.r + 11} textAnchor="middle" fontSize="9.5" fill={n.me ? "var(--ink)" : "var(--muted)"} fontFamily="Figtree" fontWeight={n.me ? 700 : 500}>{n.l}</text>
          </g>
        ))}
      </svg>
    </Tile>
  );
}

export function ReadStreak(p: WP) {
  const ghost = p.state === "empty" && { label: "Papers read per week", sub: "", action: "Mark a paper read" };
  return (
    <Tile title="Reading streak" icon={Flame} c={p.c ?? 4} r={p.r ?? 3} meta="papers / week" hover={p.hover} ghost={ghost}>
      <div className="row gap12" style={{ alignItems: "flex-end" }}>
        <Num v="7" size={44} unit="weeks running" />
      </div>
      <div style={{ fontSize: 12, color: "var(--faint)", marginTop: 4 }}>3.1 papers a week since mid-August</div>
      <div style={{ marginTop: "auto" }}><Bars data={[1, 0, 2, 1, 0, 3, 2, 4, 3, 3, 5, 3]} w={(p.c ?? 4) < 4 ? 250 : 320} h={52} hi={11} labels={["J", "", "", "", "A", "", "", "", "S", "", "", "Now"]} /></div>
    </Tile>
  );
}

const QS = [
  { q: "Does Lahaja's accent split overlap with Vistaar's Hindi test set?", t: "Data", age: "2d", who: "Dr. Meera Iyer" },
  { q: "Report WER or CER for Tamil? Reviewers in ARR asked for both", t: "Method", age: "5d", who: "Karthik S." },
  { q: "Is Whisper large-v3 fine-tuned on any Indic read speech?", t: "Related work", age: "1w", who: "You" },
  { q: "Which baseline for code-switched Hinglish: MMS or IndicWav2Vec?", t: "Experiments", age: "1w", who: "Ananya R." },
  { q: "Can we release the Marathi farm-radio subset under CC BY-NC?", t: "Data", age: "2w", who: "Dr. Meera Iyer" },
];
export function OpenQs(p: WP) {
  const ghost = p.state === "empty" && { label: "Questions nobody has answered", sub: "", action: "Ask the first question" };
  return (
    <Tile title="Open questions" icon={HelpCircle} c={p.c ?? 6} r={p.r ?? 3} meta="4 open" hover={p.hover} ghost={ghost} add>
      <div className="col">
        {QS.map((x) => (
          <div key={x.q} className="li">
            <Av n={x.who === "You" ? "Prajwal Bhagwat" : x.who} s={22} />
            <span className="t">{x.q}</span>
            <span className="pill">{x.t}</span>
            <span className="m" style={{ width: 22, textAlign: "right" }}>{x.age}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}

export function Advisor(p: WP) {
  const ghost = p.state === "empty" && { label: "Your next supervision", sub: "", action: "Add a meeting" };
  return (
    <Tile title="Next supervision" icon={CalendarClock} c={p.c ?? 3} r={p.r ?? 3} hover={p.hover} ghost={ghost}>
      <div className="row gap10">
        <Av n="Meera Iyer" s={36} ring="var(--accent)" />
        <div className="col"><span style={{ fontSize: 13, fontWeight: 600 }}>Dr. Meera Iyer</span><span className="faint" style={{ fontSize: 11.5 }}>Mon, 5 Oct · 3:00 pm</span></div>
        <span className="num" style={{ marginLeft: "auto", fontSize: 28 }}>5<span style={{ fontSize: 11, fontFamily: "Figtree", color: "var(--faint)", letterSpacing: 0 }}>d</span></span>
      </div>
      <div className="col" style={{ marginTop: 10 }}>
        {["Ch 2 outline, §2.3 onwards", "Lahaja vs Vistaar overlap", "ARR submission plan"].map((a, i) => (
          <div key={a} className="li"><span style={{ width: 14, height: 14, borderRadius: 4, border: "1.5px solid rgba(243,238,230,0.3)", background: i === 0 ? "var(--accent)" : "transparent", flexShrink: 0 }} /><span className="t" style={{ fontSize: 12.5 }}>{a}</span></div>
        ))}
      </div>
      <div style={{ marginTop: "auto", fontSize: 11.5, color: "var(--faint)" }}>Last time, 21 Sept: “Cut §2.4, merge it into 2.2.”</div>
    </Tile>
  );
}

export function Venue(p: WP) {
  const ghost = p.state === "empty" && { label: "A venue deadline", sub: "", action: "Pick a venue" };
  return (
    <Tile title="ARR · October cycle" icon={Send} c={p.c ?? 3} r={p.r ?? 3} meta="15 Oct" hover={p.hover} ghost={ghost}>
      <div className="row gap10" style={{ alignItems: "flex-end" }}><Num v="15" size={48} unit="days" /></div>
      <div className="col" style={{ marginTop: "auto", gap: 6 }}>
        <Seg n={5} done={2} partial={0.5} h={6} />
        <div className="col" style={{ gap: 3, fontSize: 11.5 }}>
          {[["Abstract", "done"], ["Experiments", "done"], ["Results tables", "half"], ["Limitations", ""], ["Anonymise", ""]].map(([l, s]) => (
            <div key={l} className="row gap6"><FileText size={11} color={s === "done" ? "var(--accent)" : "var(--ghost)"} /><span style={{ color: s ? "var(--ink-2)" : "var(--faint)" }}>{l}</span>{s === "half" && <span className="faint" style={{ marginLeft: "auto" }}>3 of 6</span>}</div>
          ))}
        </div>
      </div>
    </Tile>
  );
}
