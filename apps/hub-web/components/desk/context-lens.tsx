"use client";

import { Fragment, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api, type DeskLive } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import { resolveExtras } from "@/lib/desk-extras";
import { lensSections } from "./live-board";
import {
  Briefcase,
  Database,
  FileCode2,
  FileText,
  GitFork,
  Landmark,
  Library,
  Mail,
  MessageCircle,
  Mic,
  NotebookText,
  Presentation,
  Receipt,
  ScanLine,
  Users,
} from "lucide-react";
import type { DeskId } from "./desks";
import { DESKS } from "./desks";
import { accentVars, Av, Tile, type State } from "./ui";
import { Drafts } from "./widgets/legal";
import { CiteGraph } from "./widgets/research";
import "./desk.css";
import { contextTabs, tabKey } from "./context-tabs";
import { useLayoutPreference, useTileControls, type Arrangeable, type TileControls } from "./arrange";
import { arrange, hiddenTilesFor, isDefaultLayout, showTile } from "./layout";

const GraphTab = dynamic(() => import("@/components/context/graph").then((mod) => mod.GraphTab), {
  ssr: false,
  loading: () => <div className="skeleton h-[480px] w-full rounded-xl" />,
});
const PeopleTab = dynamic(() => import("@/components/context/people").then((mod) => mod.PeopleTab), {
  loading: () => <div className="skeleton h-[320px] w-full rounded-xl" />,
});
const ProjectsTab = dynamic(() => import("@/components/context/projects").then((mod) => mod.ProjectsTab), {
  loading: () => <div className="skeleton h-[320px] w-full rounded-xl" />,
});
const ArtifactsTab = dynamic(() => import("@/components/context/artifacts").then((mod) => mod.ArtifactsTab), {
  loading: () => <div className="skeleton h-[320px] w-full rounded-xl" />,
});

const MATTERS = [
  { n: "Rao v. Sunrise Hospital", f: "NCDRC", st: "Pleadings", next: "Limitation 5 Oct", c: "Sunita Rao", docs: 14, hot: "r" },
  { n: "Mehta Textiles v. Union of India", f: "Supreme Court", st: "Pleadings", next: "SLP by 6 Oct", c: "Vikram Mehta", docs: 31, hot: "r" },
  { n: "Arora v. DLF Homes", f: "State Commission", st: "Pleadings", next: "Written version 14 Oct", c: "Ritu Arora", docs: 22, hot: "y" },
  { n: "Nair Estates v. Kochhar", f: "Commercial Court, Saket", st: "Evidence", next: "Mediation Sat", c: "Harish Nair", docs: 48, hot: "y" },
  { n: "State v. R. Khanna", f: "Delhi HC · Ct 32", st: "Arguments", next: "Bail today, item 14", c: "Rohit Khanna", docs: 19, hot: "" },
  { n: "Joshi v. Joshi", f: "Tis Hazari", st: "Reserved", next: "Order reserved 11 Sept", c: "Anjali Joshi", docs: 37, hot: "" },
];

const PEOPLE_L = [
  { g: "Clients", p: [{ n: "Sunita Rao", r: "Rao v. Sunrise" }, { n: "Vikram Mehta", r: "MD, Mehta Textiles" }, { n: "Harish Nair", r: "Director, Nair Estates" }] },
  { g: "Counsel", p: [{ n: "Adv. Kavita Sen", r: "Senior counsel · SLP" }, { n: "Adv. Manish Gupta", r: "Opposite, DLF Homes" }] },
  { g: "Chamber", p: [{ n: "Suresh Yadav", r: "Clerk · filings" }] },
];

const ART_L = [
  { i: FileText, t: "HC order dt. 8 Jul 2026 · certified copy.pdf", m: "Mehta Textiles", w: "Tue" },
  { i: Mail, t: "Re: vakalatnama signature, Sunita Rao", m: "Rao v. Sunrise", w: "Mon" },
  { i: MessageCircle, t: "Payment receipts 2019 (7 photos)", m: "Arora v. DLF", w: "Sun" },
  { i: Receipt, t: "e-Filing acknowledgement · Diary 41822/2026", m: "Mehta Textiles", w: "25 Sept" },
  { i: ScanLine, t: "Exhibit P-7 · site inspection report", m: "Nair Estates", w: "22 Sept" },
];

const PEOPLE_R = [
  { g: "Supervision", p: [{ n: "Dr. Meera Iyer", r: "Advisor · IIT Madras" }, { n: "Prof. Hema Murthy", r: "Committee" }] },
  { g: "Co-authors", p: [{ n: "Karthik Subramanian", r: "Tamil ASR · ARR paper" }, { n: "Ananya Ramesh", r: "Hinglish baselines" }] },
  { g: "Lab", p: [{ n: "Farhan Ali", r: "GPU queue · A100 × 4" }, { n: "Divya Krishnan", r: "Annotation lead" }] },
];

const ART_R = [
  { i: FileText, t: "Radford-2023-Whisper.pdf · 14 highlights", m: "Reading", w: "today" },
  { i: NotebookText, t: "Notes, IndicWav2Vec pretraining recipe", m: "Notes", w: "Tue" },
  { i: FileCode2, t: "thesis.bib · 212 entries, 3 missing DOIs", m: "Ch 2", w: "Mon" },
  { i: GitFork, t: "iitm-speech/indic-asr-bench · 4 open PRs", m: "Code", w: "Mon" },
  { i: Presentation, t: "Lab talk, SSL for Indic ASR.pptx", m: "Talks", w: "18 Sept" },
];

function PeopleLens({ groups, meta, more, state }: { groups: typeof PEOPLE_L; meta: string; more: string; state: State }) {
  return (
    <Tile title="People" icon={Users} c={4} r={4} meta={state === "populated" ? meta : undefined} add ghost={state === "empty" ? { label: "People, grouped by role", sub: "Names you add land in the role they play.", action: "Add a person" } : false}>
      <div className="col" style={{ gap: 8 }}>
        {groups.map((group) => (
          <div key={group.g}>
            <div className="cap" style={{ fontSize: 9.5, marginBottom: 3 }}>{group.g}</div>
            {group.p.map((person) => (
              <div key={person.n} className="row gap8" style={{ padding: "3px 0" }}>
                <Av n={person.n} s={24} />
                <div className="col" style={{ minWidth: 0 }}>
                  <span className="trunc" style={{ fontSize: 12.5, fontWeight: 500 }}>{person.n}</span>
                  <span className="trunc faint" style={{ fontSize: 11 }}>{person.r}</span>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="row gap6" style={{ marginTop: "auto", fontSize: 12, color: "var(--accent)", fontWeight: 600 }}>{more}</div>
    </Tile>
  );
}

function ArtifactsLens({ rows, meta, src, state }: { rows: typeof ART_L; meta: string; src: string; state: State }) {
  return (
    <Tile title="Artifacts" icon={FileText} c={6} r={3} meta={state === "populated" ? meta : undefined} right={state === "populated" ? src : undefined} ghost={state === "empty" ? { label: "Files, mail and notes", sub: "Anything you attach shows its type.", action: "Add an artifact" } : false}>
      <div className="col">
        {rows.map((row) => (
          <div key={row.t} className="li">
            <span style={{ width: 26, height: 26, borderRadius: 7, display: "grid", placeItems: "center", background: "rgba(243,238,230,0.05)", color: "var(--accent)", flexShrink: 0 }}><row.i size={13} /></span>
            <span className="t">{row.t}</span>
            <span className="pill">{row.m}</span>
            <span className="m" style={{ width: 48, textAlign: "right" }}>{row.w}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}

function Chambers({ state }: { state: State }) {
  const forums = [{ l: "Delhi HC", n: 5 }, { l: "District courts", n: 3 }, { l: "Consumer fora", n: 3 }, { l: "Supreme Court", n: 1 }, { l: "Arbitration", n: 1 }];
  return (
    <>
      <Tile title="Matters" icon={Briefcase} c={8} r={4} hero meta={state === "populated" ? "13 active · 6 shown" : undefined} right={state === "populated" ? "grouped by stage" : undefined} ghost={state === "empty" ? { label: "Matters, with the next date", sub: "An empty docket still keeps the cards.", action: "Add a matter" } : false}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, flex: 1 }}>
          {MATTERS.map((matter) => (
            <div key={matter.n} className="col" style={{ borderRadius: 11, padding: "10px 12px", background: "rgba(243,238,230,0.03)", border: "1px solid rgba(243,238,230,0.07)", boxShadow: matter.hot ? `inset 0 2px 0 ${matter.hot === "r" ? "var(--danger)" : "var(--warn)"}` : undefined, gap: 6 }}>
              <div className="row sb"><span className="pill">{matter.st}</span><span className="faint" style={{ fontSize: 11 }}>{matter.docs} docs</span></div>
              <span className="display" style={{ fontSize: 15.5, lineHeight: 1.2 }}>{matter.n}</span>
              <span className="faint trunc" style={{ fontSize: 11.5 }}><Landmark size={11} /> {matter.f}</span>
              <div className="row gap6" style={{ marginTop: "auto" }}><Av n={matter.c} s={20} /><span className="trunc" style={{ fontSize: 11.5 }}>{matter.next}</span></div>
            </div>
          ))}
        </div>
      </Tile>
      <PeopleLens groups={PEOPLE_L} meta="18 · 7 roles" more="All 18 people" state={state} />
      <ArtifactsLens rows={ART_L} meta="212 · synced 4 min ago" src="Gmail · Drive · WhatsApp export" state={state} />
      <Drafts c={3} r={3} state={state} />
      <Tile title="Forums" icon={Landmark} c={3} r={3} meta={state === "populated" ? "13 matters" : undefined} ghost={state === "empty" ? { label: "Forums this docket sits in", action: "Add a forum" } : false}>
        <div className="col" style={{ gap: 8 }}>
          {forums.map((forum) => (
            <div key={forum.l} className="row gap8">
              <span className="grow" style={{ fontSize: 12 }}>{forum.l}</span>
              <span className="num" style={{ fontSize: 16 }}>{forum.n}</span>
            </div>
          ))}
        </div>
      </Tile>
    </>
  );
}

const VENUES = ["Interspeech", "ICASSP", "AAAI", "ACL / EMNLP", "NeurIPS / ICML", "TASLP / JMLR"];
const YEARS = [2020, 2021, 2022, 2023, 2024, 2025];
const DOTS: Array<[number, number, number]> = [
  [0, 0, 3], [0, 2, 3], [0, 3, 2], [0, 4, 0], [1, 1, 3], [1, 3, 2], [2, 2, 2], [3, 4, 0], [4, 0, 3], [5, 1, 3], [5, 4, 3],
];

function Literature({ state }: { state: State }) {
  const datasets = [{ l: "IndicVoices", h: "1,639" }, { l: "Vistaar test", h: "842" }, { l: "Lahaja", h: "12.5" }, { l: "Svarah", h: "9.6" }];
  return (
    <>
      <Tile title="Papers by venue and year" icon={Library} c={8} r={4} hero meta={state === "populated" ? "39 papers" : undefined} ghost={state === "empty" ? { label: "Papers, by venue and year", action: "Add a paper" } : false}>
        <div style={{ display: "grid", gridTemplateColumns: "120px repeat(6, 1fr)", gap: 6 }}>
          {VENUES.map((venue, vi) => (
            <Fragment key={venue}>
              <span style={{ fontSize: 12 }}>{venue}</span>
              {YEARS.map((year, yi) => (
                <div key={venue + year} className="row" style={{ justifyContent: "center", minHeight: 22 }}>
                  {DOTS.filter((dot) => dot[0] === vi && dot[1] === yi).map((dot, index) => (
                    <span key={index} style={{ width: 12, height: 12, borderRadius: 99, background: dot[2] ? "var(--accent)" : "transparent", border: dot[2] ? "none" : "1.5px dashed rgba(243,238,230,0.35)" }} />
                  ))}
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </Tile>
      <PeopleLens groups={PEOPLE_R} meta="14 · 3 groups" more="All 14 people" state={state} />
      <ArtifactsLens rows={ART_R} meta="318 · synced 12 min ago" src="Zotero · Drive · GitHub" state={state} />
      <CiteGraph c={3} r={3} state={state} />
      <Tile title="Datasets" icon={Database} c={3} r={3} meta="hours of speech" ghost={state === "empty" ? { label: "Hours of speech, by set", action: "Add a dataset" } : false}>
        <div className="col" style={{ gap: 9 }}>
          {datasets.map((row) => (
            <div key={row.l} className="row sb" style={{ fontSize: 12 }}>
              <span><Mic size={11} /> {row.l}</span>
              <span className="num" style={{ fontSize: 15 }}>{row.h}</span>
            </div>
          ))}
        </div>
      </Tile>
    </>
  );
}


export function ContextLens({ deskId, state, initialTab = null, search = "", who = "", ids = "" }: { deskId: DeskId; state: State; initialTab?: string | null; search?: string; who?: string; ids?: string }) {
  const desk = DESKS[deskId];
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences, staleTime: 30_000 });
  const extras = resolveExtras(deskId, prefs.data?.preferences.find((row) => row.key === "desk.extras")?.value);
  const router = useRouter();
  const tabs = contextTabs(deskId, extras.has("learning"));
  const [tab, setTab] = useState(() => tabs.find((label) => tabKey(label) === initialTab) ?? "Overview");
  // Links inside the lens (a graph node, a mention) change ?tab= without remounting it.
  const wanted = tabs.find((label) => tabKey(label) === (initialTab ?? "overview"));
  useEffect(() => {
    if (wanted) setTab(wanted);
  }, [wanted]);
  const active = tabs.includes(tab) ? tab : tabs[0]!;
  const choose = (label: string) => {
    setTab(label);
    const key = tabKey(label);
    router.replace(key === "overview" ? "/context" : `/context?tab=${key}`, { scroll: false });
  };
  const shared = ["people", "projects", "graph", "artifacts"].includes(tabKey(active));
  const rich = state === "populated" && (deskId === "chambers" || deskId === "literature") && active === "Overview";
  const live = useQuery({ queryKey: ["desk-live"], queryFn: api.deskLive, enabled: state !== "populated", staleTime: 15_000 });
  const sections = state === "populated" || shared ? [] : lensSections(deskId, tabKey(active), live.data ?? emptyLive(), extras);
  return (
    <div className="desk page" style={accentVars(desk.accent)} data-context-lens={deskId} data-sample={state === "populated" ? "1" : undefined}>
      <div className="phead" style={{ marginBottom: 14 }}>
        <div>
          {state === "populated" ? (
            <div className="kick">
              <span className="sample-mark">Sample</span>
            </div>
          ) : null}
          <h1 className="display">Context</h1>
          <div className="sub">
            {state === "populated" ? (
              deskId === "chambers" ? (
                "Everyone and everything behind your 13 matters, grouped by matter."
              ) : deskId === "literature" ? (
                "The people, papers and data behind Chapter 2, grouped by project."
              ) : (
                `A sample of ${desk.name}.`
              )
            ) : !live.isFetched ? (
              <span className="sub-skel sk" aria-hidden />
            ) : (
              "The people, projects, and files around your work."
            )}
          </div>
        </div>
      </div>
      <div className="context-tabs" role="tablist" aria-label="Context sections">
        {tabs.map((label) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={label === active}
            data-lens-tab={tabKey(label)}
            onClick={() => choose(label)}
            className="context-tab"
          >
            {label}
          </button>
        ))}
      </div>
      {tabKey(active) === "people" ? (
        <div data-lens-panel="people"><PeopleTab key={`${search}|${who}`} initialSearch={search} who={who} /></div>
      ) : tabKey(active) === "projects" ? (
        <div data-lens-panel="projects"><ProjectsTab ids={ids} /></div>
      ) : tabKey(active) === "graph" ? (
        <div data-lens-panel="graph" data-lens-graph style={{ height: "min(72vh, 720px)" }}><GraphTab /></div>
      ) : tabKey(active) === "artifacts" ? (
        <div data-lens-panel="artifacts"><ArtifactsTab /></div>
      ) : (
      <div className="bento" data-lens-panel={tabKey(active)}>
        {rich && deskId === "chambers" ? <Chambers state={state} /> : null}
        {rich && deskId === "literature" ? <Literature state={state} /> : null}
        {!rich && state === "populated" ? <SamplePanel deskId={deskId} tab={tabKey(active)} /> : null}
        {!rich && state !== "populated" ? (
          <ArrangedLens
            deskId={deskId}
            tab={tabKey(active)}
            sections={sections}
            live={live.data}
            ready={live.isFetched}
            onPeople={() => choose("People")}
            onSection={(kind) => router.push(`/today?form=${encodeURIComponent(kind)}`)}
          />
        ) : null}
      </div>
      )}
    </div>
  );
}

function SamplePanel({ deskId, tab }: { deskId: DeskId; tab: string }) {
  const lines = tab === "overview" ? ["Overview", "People", "Work"] : [tab];
  return (
    <>
      {lines.map((line) => (
        <Tile key={line} title={line} icon={Users} c={4} r={3} meta="Sample">
          <div className="col gap6">
            <span style={{ fontSize: 13, fontWeight: 600 }}>{DESKS[deskId].name}</span>
            <span className="faint" style={{ fontSize: 12 }}>Sample {line.toLowerCase()} for this desk.</span>
          </div>
        </Tile>
      ))}
    </>
  );
}

function personActivity(person: { openTasks?: number; recentTitle?: string | null }) {
  const open = person.openTasks ? `${person.openTasks} open` : "No open tasks";
  return person.recentTitle ? `${open} · ${person.recentTitle}` : open;
}

type Placed = { size: { c: number; r: number }; control: TileControls };

function LivePeople({ onOpen, size, control }: { onOpen: () => void } & Placed) {
  const people = useQuery({ queryKey: ["people"], queryFn: api.people, staleTime: 15_000 });
  const rows = people.data?.people ?? [];
  return (
    <Tile
      title="People"
      icon={Users}
      c={size.c}
      r={size.r}
      {...control}
      meta={people.isFetched ? String(rows.length) : undefined}
      onAdd={onOpen}
      ghost={people.isFetched && rows.length === 0 ? { label: "Add the people you work with", sub: "Teammates, clients, advisors, or classmates. They link to tasks, pages, and the graph.", action: "Add a person", kind: "person", onAction: onOpen } : false}
    >
      {rows.length ? <div className="col" data-lens-people style={{ gap: 2 }}>
        {rows.map((person) => (
          <div key={person.id} className="row gap8" style={{ padding: "6px 0", alignItems: "flex-start" }} data-person={person.id} data-person-name={person.name}>
            <Av n={person.name} s={28} />
            <div className="col" style={{ minWidth: 0, flex: 1, gap: 1 }}>
              <span className="trunc" style={{ fontSize: 13, fontWeight: 600 }}>{person.name}</span>
              {person.role ? <span className="trunc faint" style={{ fontSize: 11.5 }}>{person.role}{person.team ? ` · ${person.team}` : ""}</span> : null}
              <span className="trunc" style={{ fontSize: 11.5, color: "var(--muted)" }}>{personActivity(person)}</span>
            </div>
          </div>
        ))}
      </div> : null}
    </Tile>
  );
}

const KIND_LABEL: Record<string, string> = {
  email: "Email",
  chat_msg: "Chat",
  channel_msg: "Channel",
  event: "Event",
  transcript: "Transcript",
  transcript_segment: "Transcript",
  file: "File",
  pr: "Pull request",
  pr_comment: "Review",
  commit: "Commit",
  issue: "Issue",
  meeting_note: "Note",
};

function LiveArtifacts({ rows, ready, size, control }: { rows: DeskLive["artifacts"]; ready: boolean } & Placed) {
  const guest = useSpaceAccess().guest;
  return (
    <Tile
      title="Artifacts"
      icon={FileText}
      c={size.c}
      r={size.r}
      {...control}
      meta={ready ? String(rows.length) : undefined}
      ghost={ready && rows.length === 0 ? { label: "No files or links yet", sub: "Documents, mail, and pull requests from connected apps land here.", ...(guest ? {} : { action: "Connect an app", onAction: () => window.location.assign("/settings?tab=connections") }) } : false}
    >
      {rows.length ? <div className="col" data-lens-artifacts>
        {rows.filter((row) => row.kind in KIND_LABEL && row.title.trim()).map((row) => (
          <div key={row.id} className="li" data-artifact={row.id}>
            <span className="pill">{KIND_LABEL[row.kind] ?? row.kind}</span>
            <span className="t">{row.title}</span>
            <span className="m">{row.source}</span>
            <span className="m" style={{ width: 64, textAlign: "right" }}>{shortWhen(row.ts)}</span>
          </div>
        ))}
      </div> : null}
    </Tile>
  );
}

type Section = ReturnType<typeof lensSections>[number];

/**
 * The live tiles of one Context tab, arranged by the person: moved, resized, hidden.
 * Saved per desk and tab as `desk.context.<desk>.<tab>`.
 */
function ArrangedLens({ deskId, tab, sections, live, ready, onPeople, onSection }: { deskId: DeskId; tab: string; sections: Section[]; live: DeskLive | undefined; ready: boolean; onPeople: () => void; onSection: (kind: string) => void }) {
  // Today is the space owner's own: someone it is shared with is not sent there.
  const guest = useSpaceAccess().guest;
  const defaults: Arrangeable[] = [
    ...(tab === "overview" ? [{ key: "people", title: "People", c: 6, r: 3 }, { key: "artifacts", title: "Artifacts", c: 8, r: 4 }] : []),
    ...sections.map((section) => ({ key: `section:${section.title.toLowerCase()}`, title: section.title, c: section.rows.length > 3 ? 6 : 4, r: 3 })),
  ];
  const { layout, save } = useLayoutPreference(`desk.context.${deskId}.${tab}`);
  const pool = new Map(defaults.map((spec) => [spec.key, spec]));
  const shown = arrange(defaults, pool, layout);
  const hidden = hiddenTilesFor(defaults, shown);
  const customized = !isDefaultLayout(layout, shown, defaults);
  const tiles = useTileControls({ shown, hidden: hidden.map((spec) => spec.key), save, customized, restoreHint: "Bring it back below the tiles." });
  const byKey = new Map(sections.map((section) => [`section:${section.title.toLowerCase()}`, section]));
  return (
    <>
      {shown.map((spec) => {
        const size = tiles.sizeOf(spec);
        const control = tiles.controls(spec);
        if (spec.key === "people") return <LivePeople key={spec.key} onOpen={onPeople} size={size} control={control} />;
        if (spec.key === "artifacts") return <LiveArtifacts key={spec.key} rows={live?.artifacts ?? []} ready={ready} size={size} control={control} />;
        const section = byKey.get(spec.key);
        if (!section) return null;
        return (
          <Tile key={spec.key} title={section.title} icon={section.icon} c={size.c} r={size.r} {...control} meta={section.rows.length ? String(section.rows.length) : undefined} ghost={section.rows.length ? false : { label: `Nothing in ${section.title.toLowerCase()} yet`, ...(guest ? {} : { action: "Add it on Today", kind: section.kind, onAction: () => onSection(section.kind) }) }}>
            {section.rows.length ? (
              <div className="col gap6">
                {section.rows.map((row) => (
                  <div key={row.id} className="row sb">
                    <span className="trunc" style={{ fontSize: 13, fontWeight: 600 }}>{row.title}</span>
                    {row.meta ? <span className="faint" style={{ fontSize: 12 }}>{row.meta}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </Tile>
        );
      })}
      {hidden.length || customized ? (
        <div className="lens-hidden" style={{ gridColumn: "1 / -1" }} data-lens-hidden>
          {hidden.length ? <span>Hidden:</span> : null}
          {hidden.map((spec) => (
            <button key={spec.key} type="button" className="lens-chip" onClick={() => void save(showTile({ shown, hidden: hidden.map((item) => item.key) }, spec))}>
              + {spec.title}
            </button>
          ))}
          {customized ? (
            <button type="button" className="lens-reset" onClick={() => void save(null)}>
              Reset layout
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function shortWhen(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function emptyLive(): DeskLive {
  return {
    today: "",
    tasks: [],
    deliverables: [],
    people: [],
    meetings: [],
    artifacts: [] as DeskLive["artifacts"],
    reminders: [],
    slots: [],
    holidays: [],
    attendance: { present: 0, absent: 0 },
    objectives: [],
    deploys: [],
    parts: [],
    tests: [],
    citations: [],
    grading: [],
    repos: [],
    projects: [],
    limitation: [],
    countdowns: [],
  };
}
