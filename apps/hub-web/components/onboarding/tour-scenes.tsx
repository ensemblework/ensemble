"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { AgentIcon as Orbit } from "@/components/agent-icon";
import { Bell, CalendarDays, Check, CheckCheck, ChevronDown, CircleCheck, Code2, Columns3, FileText, FolderOpen, GitBranch, MessageSquare, Pencil, MousePointer2, Plus, Search, Settings, ShieldCheck, Sparkles, Users } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { PreviewTiles, specPool } from "@/components/desk/live-board";
import { tileFitsRole, tileDescription } from "@/components/desk/tile-catalog";
import { BrandLogo } from "@/components/connectors/brand-logo";
import { BrandMorph } from "@/components/motion/brand-morph";
import { personInitials } from "@/lib/initials";
import { sampleLive } from "./sample";
import { demoBeat } from "./tour-playback";
import { tourProfile, type TourStep } from "./tour-plan";

type Profile = ReturnType<typeof tourProfile>;
type Live = ReturnType<typeof sampleLive>;
const NAV = [
  ["today", "Today", CalendarDays], ["board", "Board", Columns3], ["context", "Context", Users],
  ["files", "Files", FolderOpen], ["meetings", "Meeting notes", MessageSquare], ["code", "Code", Code2], ["approvals", "Needs me", CircleCheck],
] as const;

export function previewSize(width: number, height: number) {
  const compact = width < 600 || width / height < 1.6;
  const canvasWidth = compact ? 480 : 1040;
  const canvasHeight = 500;
  return { compact, width: canvasWidth, height: canvasHeight, scale: Math.max(0, Math.min(width / canvasWidth, height / canvasHeight)) };
}

/** Fit the entire fictional app, including its chrome, like a contained video. */
export function FitPreview({ children }: { children: React.ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => previewSize(1040, 500));
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const measure = () => { if (node.clientWidth && node.clientHeight) setSize(previewSize(node.clientWidth, node.clientHeight)); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div ref={viewport} className="film-viewport"><div className="film-canvas" data-compact={size.compact || undefined} style={{ width: size.width, height: size.height, transform: `translate(-50%, -50%) scale(${size.scale})` }}>{children}</div></div>;
}

export function DemoApp({ step, chapters, children }: { step: TourStep; chapters: TourStep[]; children: React.ReactNode }) {
  const active = step.id === "pages" ? "pages" : step.id === "arrange" || step.id === "welcome" || step.id === "finish" || step.id === "assistant" ? "today" : step.id;
  return <div className="film-app" aria-hidden="true" inert>
    <aside className="film-sidebar"><div className="film-brand"><BrandMorph size={19} />Ensemble</div><div className="film-space"><span>F</span>Fieldnote<ChevronDown size={10} /></div><div className="film-jump"><Search size={11} />Jump to…<small>⌘ K</small></div>
      <div className="film-nav">{NAV.filter(([id]) => id !== "code" || chapters.some((chapter) => chapter.id === "code")).map(([id, label, Icon]) => <span key={id} data-active={active === id || undefined}><Icon size={13} />{label}</span>)}</div><span className="film-page-nav" data-active={active === "pages" || undefined}><FileText size={13} />Pages<Plus size={10} /></span><span className="film-settings" data-active={active === "connections" || undefined}><Settings size={13} />Settings</span></aside>
    <div className="film-app-area"><div className="film-topbar"><span>{step.id === "connections" ? "Settings" : step.id === "pages" ? "Pages" : NAV.find(([id]) => id === active)?.[1] ?? "Today"}</span><span className="film-search"><Search size={11} />Search and jump…</span><Bell size={12} /><span className="film-avatar">MC</span></div><div className="film-content">{children}</div></div>
  </div>;
}

function Heading({ title, line, action, target }: { title: string; line: string; action?: string; target?: string }) {
  return <div className="film-page-heading"><div><h3>{title}</h3><p>{line}</p></div>{action && <span className="film-button" data-film-target={target}><Plus size={10} />{action}</span>}</div>;
}

const TodayScene = memo(function TodayScene({ profile }: { profile: Profile }) {
  const live = useMemo(() => sampleLive(profile.role), [profile.role]);
  const card = profile.template;
  const tiles = (card?.tiles ?? [["progress", 4, 3], ["focus", 8, 3], ["plan", 6, 3]]).slice(0, 3).map(([key], i) => [key, i === 0 ? 6 : 3, 6] as const);
  return <><Heading title="Today" line={card?.name ?? "A little direction for your day"} action="Add a tile" /><div className="desk film-desk" data-desk={card?.desk ?? "branch"}><div className="bento"><PreviewTiles deskId={card?.desk ?? "branch"} tiles={tiles} live={live} /></div></div><div className="film-day-tail"><span><CircleCheck size={12} />A clear next step</span><span>Your work, in one view</span></div></>;
});

function AddTileScene({ profile, ms }: { profile: Profile; ms: number }) {
  const live = useMemo(() => sampleLive(profile.role), [profile.role]);
  const existing = new Set(profile.template?.tiles.map(([key]) => key));
  const choices = [...specPool().values()].filter((tile) => !existing.has(tile.key) && tileFitsRole(tile.key, profile.role === "general" ? "engineer" : profile.role));
  const picked = choices.find((tile) => tile.key === "due-week") ?? choices.find((tile) => tile.key === "workload") ?? choices.find((tile) => tile.key === "progress") ?? choices[0]!;
  const opening = demoBeat(ms, 650, 950);
  const added = demoBeat(ms, 3250, 3550);
  return <><Heading title="Today" line="A desk you can make your own" action="Add a tile" target="add-tile" /><div className="film-gallery film-panel" style={{ opacity: opening }}>
    <header><strong>Make room for your best work</strong><span>Your tile library</span></header>
    <div className="film-gallery-body"><aside><span className="film-gallery-search"><Search size={12} />Find a tile…</span>{[picked, ...choices.filter((tile) => tile.key !== picked.key).slice(0, 2)].map((tile, i) => <div key={tile.key} data-film-target={i === 0 ? "pick-tile" : undefined} data-selected={i === 0 || undefined}><tile.icon size={15} /><span><strong>{tile.title}</strong><small>{i === 0 && added ? "On your Today" : "Available to add"}</small></span></div>)}</aside>
    <section><strong>{picked.title}</strong><p>{tileDescription(picked)}</p><div className="desk film-gallery-preview" data-desk={profile.template?.desk ?? "branch"}><div className="bento"><PreviewTiles deskId={profile.template?.desk ?? "branch"} tiles={[[picked.key, 12, 4]]} live={live} /></div></div><footer><small>Preview with sample data</small><span className="film-button" data-film-target="place-tile" data-primary>{added ? <Check size={11} /> : <Plus size={11} />}{added ? "On Today" : "Add to Today"}</span></footer></section></div>
    <div className="film-gallery-notice" style={{ opacity: added }}><Check size={12} />{picked.title} added to Today</div>
  </div></>;
}

function BoardScene({ live, ms }: { live: Live; ms: number }) {
  const tasks = live.tasks.filter((task) => task.taskType === "task").slice(0, 5);
  const moving = demoBeat(ms, 1350, 1950);
  return <><Heading title="Task board" line="Proposed through done. Drag a card to move it." action="New task" /><div className="film-board-filter"><Search size={11} />Search tasks or #label…<span>All owners</span><span>By priority</span></div><div className="film-board">
    {["To do", "In progress", "Done"].map((label, column) => <div className="film-lane" key={label}><header>{label}<small>{column === 0 ? ms >= 1950 ? 2 : 3 : column === 1 && ms >= 1950 ? 2 : 1}</small><Plus size={11} /></header>{tasks.slice(column === 0 ? 1 : column + 2, column === 0 ? 3 : column + 3).map((task, i) => <div className="film-task" key={task.id} style={column === 0 && i === 0 ? { marginTop: `${102 * (1 - moving)}px` } : undefined}><strong>{task.title}</strong><div><span className="film-tag">{i ? "Medium" : "High"}</span><span className="film-avatar">{column === 0 ? "MC" : "DP"}</span></div></div>)}</div>)}
    <div className="film-task film-moving-task" style={{ left: `calc(${moving * 33.8}% + 9px)`, top: `${50 + moving * 80}px`, transform: `rotate(${-moving * (1 - moving) * 12}deg)` }}><strong>{tasks[0]?.title ?? "Choose a useful next step"}</strong><div><span className="film-tag">High</span><span className="film-avatar">MC</span></div></div>
  </div><div className="film-scene-note" style={{ opacity: demoBeat(ms, 2300, 2700) }}><Check size={12} />A clear owner. A visible next step.</div></>;
}

function PageScene({ profile, ms }: { profile: Profile; ms: number }) {
  const { story } = profile;
  const tomorrow = useMemo(() => { const date = new Date(); date.setDate(date.getDate() + 1); return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date); }, []);
  const person = demoBeat(ms, 1200, 1500);
  const project = demoBeat(ms, 1950, 2250);
  const date = demoBeat(ms, 2650, 2950);
  const onBoard = ms >= 4050;
  const due = ms >= 5300;
  return <div className="film-document">
    <div className="film-document-tools"><span><FileText size={11} />{onBoard ? "Task page" : "Pages"}</span><span><Check size={10} />{ms < 3100 ? "Saving…" : "Saved"}</span><span className="film-button">Share</span></div>
    <h3>{story.page}</h3>
    {onBoard && <div className="film-task-properties"><span>To do</span><span>Owner <b>Me</b></span><span className="film-due" data-film-target="due">Due <b>{due ? "Tomorrow" : "Set date"}</b></span></div>}
    <div className="film-editor-toolbar"><b>B</b><i>I</i><span>≡</span><span>☑</span><span>Link</span></div>
    <div className="film-document-body"><h4>Our next step</h4><p><span className="film-mention" data-kind="people" data-film-target="person-mention" style={{ opacity: person }}>@{story.person}</span> asked me to {story.work} for <span className="film-mention" data-kind="project" data-film-target="project-mention" style={{ opacity: project }}>@{story.project}</span> by <span className="film-mention" data-kind="date" data-film-target="date-mention" style={{ opacity: date }}>@{tomorrow}</span>.</p><p className="film-document-note">Keep the review notes and decisions here, alongside the work.</p></div>
    {ms >= 650 && ms < 1200 && <div className="film-mention-menu"><small>PEOPLE</small><span data-film-target="person-choice"><Users size={13} />{story.person}</span><small>Person</small></div>}
    {!onBoard && <span className="film-button film-add-board" data-film-target="add-board" data-primary>Add to board</span>}
    {onBoard && ms >= 4850 && !due && <div className="film-date-menu"><CalendarDays size={14} /><span>Today</span><strong data-film-target="tomorrow">Tomorrow</strong><span>Next week</span></div>}
    <div className="film-document-saved" style={{ opacity: demoBeat(ms, 5600, 5900) }}><CircleCheck size={12} />On the board · due Tomorrow</div>
  </div>;
}

function ContextScene({ profile, ms }: { profile: Profile; ms: number }) {
  const { story } = profile;
  const selected = demoBeat(ms, 1700, 2050);
  return <><Heading title="Context" line="Saved relationships and page mentions" /><div className="film-context-tabs"><span>People</span><span>Projects</span><span data-active>Graph</span><small>3 nodes · 2 links</small></div>
    <div className="film-context-record film-panel"><div className="film-graph-filters"><span>People</span><span>Projects</span><span>Tasks</span><small>Fit</small></div><svg viewBox="0 0 760 210" className="film-real-graph">
      <line x1="178" y1="65" x2="380" y2="126" stroke="var(--line-strong)" strokeDasharray="5 4" /><line x1="582" y1="65" x2="380" y2="126" stroke="var(--line-strong)" strokeDasharray="5 4" />
      <circle cx="178" cy="65" r="11" fill="var(--kind-people)" /><text x="178" y="96" textAnchor="middle">{story.person}</text>
      <rect x="571" y="54" width="22" height="22" rx="5" fill="var(--kind-project)" /><text x="582" y="96" textAnchor="middle">{story.project}</text>
      <path d="M380 111 L395 126 L380 141 L365 126 Z" fill="var(--kind-task)" stroke="var(--ink)" strokeWidth={selected} /><text x="380" y="165" textAnchor="middle">{story.page}</text>
    </svg><div className="film-graph-detail" style={{ opacity: selected }}><FileText size={13} /><strong>{story.page}</strong><span>Task · To do</span><small>Mentions {story.person} · {story.project}</small></div></div>
  </>;
}

function FilesScene({ live, ms }: { live: Live; ms: number }) {
  return <><Heading title="Files" line="Keep a useful source close to your work" action="Upload" /><div className="film-files"><div className="film-file-list">{live.artifacts.slice(0, 4).map((file, i) => <div key={file.id} data-selected={i === 0 || undefined}><FileText size={17} /><span><strong>{file.title}</strong><small>{i === 0 ? "Opened in preview" : "Source material"}</small></span></div>)}</div><div className="film-paper"><span className="film-paper-kicker">REFERENCE NOTES</span><h4>{live.artifacts[0]?.title ?? "Project notes.pdf"}</h4><p>Keep the original source alongside the work it supports.</p><div className="film-paper-highlight" style={{ background: ms >= 1900 ? "var(--accent-soft)" : "transparent" }}>The next step has a source you can return to.</div>{[90, 100, 87, 95, 74].map((width, i) => <i key={i} style={{ width: `${width}%` }} />)}<span className="film-file-attached" style={{ opacity: demoBeat(ms, 3500, 3900) }}><Check size={12} />Attach to a page</span></div></div></>;
}

function CodeScene({ ms }: { ms: number }) {
  const changed = demoBeat(ms, 1300, 1900);
  return <><Heading title="Code" line="Review a change before it becomes part of your work" /><div className="film-code"><div className="film-code-toolbar"><GitBranch size={12} />ensemble/welcome<span>Changes ready for review</span></div><div className="film-code-file"><FileText size={12} />src/welcome.tsx <small>+2 −1</small></div><div className="film-diff"><div><em>1</em>export function Welcome() {'{'}</div><div><em>2</em>  return (</div><div className="film-diff-old"><em>−</em>    &lt;h1&gt;Hello&lt;/h1&gt;</div><div className="film-diff-new" style={{ opacity: changed }}><em>+</em>    &lt;h1&gt;Welcome to your space&lt;/h1&gt;</div><div className="film-diff-new" style={{ opacity: changed }}><em>+</em>    &lt;p&gt;A clear next step.&lt;/p&gt;</div><div><em>5</em>  );</div><div><em>6</em>{'}'}</div></div><div className="film-review-bar"><ShieldCheck size={13} />You review what changes<span className="film-button">Review changes</span></div></div></>;
}

function MeetingScene({ live, ms }: { live: Live; ms: number }) {
  return <><Heading title="Meeting notes" line="Keep the decision and the follow-up together" action="New notes" /><div className="film-meeting"><div className="film-panel film-meeting-list">{live.meetings.slice(0, 3).map((meeting, i) => <div key={meeting.id} data-selected={i === 0 || undefined}><MessageSquare size={13} /><strong>{meeting.title}</strong></div>)}</div><div className="film-panel film-notes"><span className="film-paper-kicker">MEETING NOTES</span><h4>{live.meetings[0]?.title ?? "Team check-in"}</h4><p>What we decided</p><div className="film-note-line">Focus on the most useful next step this week.</div><p className="film-note-subheading">Follow-ups</p><div className="film-followup" style={{ opacity: .45 + demoBeat(ms, 1600, 2200) * .55 }}><span className="film-check" /><strong>Send the revised plan by Friday</strong><span className="film-avatar">MC</span></div><span className="film-notes-saved" style={{ opacity: demoBeat(ms, 3300, 3700) }}><Check size={12} />Decision and next step, together</span></div></div></>;
}

function ApprovalScene({ profile }: { profile: Profile }) {
  const code = profile.codeEnabled && (profile.role === "engineer" || profile.role === "vibe");
  const { story } = profile;
  return <><Heading title="Needs me" line="Decisions to make, questions to answer, and work ready for a next step." />
    <div className="film-review-overview">{[[Orbit, "Questions from Ensemble runs", code ? "1" : "0"], [ShieldCheck, "Outgoing approvals", code ? "0" : "1"], [CalendarDays, "Waiting tasks", "0"]].map(([Icon, label, count]) => { const Mark = Icon as typeof Orbit; return <div key={String(label)}><Mark size={17} /><span><strong>{String(count)}</strong><small>{String(label)}</small></span></div>; })}</div>
    <div className="film-context-tabs"><span>Everything</span><span data-active={code || undefined}>Requests</span><span data-active={!code || undefined}>Approvals</span><span>Waiting tasks</span></div>
    <div className="film-real-request film-panel" data-request-kind={code ? "permission" : "outgoing"}>
      {code ? <><div className="film-request-meta"><span className="film-tag">Ensemble agent</span><span>wants to git push · just now</span><small>{story.page}</small></div><h4>Push the reviewed changes?</h4><pre>git push origin feature/welcome</pre><p className="film-request-path">fieldnote/app</p><div className="film-real-actions"><span className="film-button" data-primary><Check size={11} />Allow once</span><span className="film-reason">Reason if you deny (sent to the agent)</span><span>Deny</span></div></>
      : <><div className="film-request-meta"><span>SEND EMAIL</span><small>Open task ↗</small></div><h4>{story.subject}</h4><p className="film-request-path">Just now · To {story.person}</p><pre>{story.message}</pre><span className="film-reason">Why? (optional, helps the skill learn)</span><div className="film-real-actions"><span className="film-button" data-primary><Check size={11} />Approve</span><span className="film-button"><Pencil size={11} />Edit</span><span>Reject</span></div></>}
    </div>
  </>;
}

function ConnectionsScene({ profile, ms }: { profile: Profile; ms: number }) {
  const shown = demoBeat(ms, 2700, 3100);
  return <><Heading title="Connected apps" line="Bring relevant work from the tools you already use" /><div className="film-connections">{[["googleworkspace", "Google Workspace", "Drive, calendar, and more"], ["github", "GitHub", "Repositories and issues"], ["microsoft365", "Microsoft 365", "Files, mail, and calendar"]].map(([id, title, line], i) => <div className="film-panel" key={id} data-selected={i === (profile.role === "engineer" || profile.role === "vibe" ? 1 : profile.role === "manager" ? 2 : 0) && ms > 1500 || undefined}><BrandLogo id={id!} size={30} /><strong>{title}</strong><p>{line}</p><span className="film-button">Connect</span></div>)}</div><div className="film-source-details" style={{ opacity: shown, transform: `translateY(${(1 - shown) * 8}px)` }}><ShieldCheck size={18} /><div><strong>Review each connection's access</strong><p>Choose the source, follow its sign-in steps, then choose what to use in Ensemble.</p></div></div></>;
}

function AssistantScene({ profile, live, ms }: { profile: Profile; live: Live; ms: number }) {
  const opened = demoBeat(ms, 1300, 2400);
  const typed = Math.round(profile.prompt.length * demoBeat(ms, 2800, 5400));
  const answer = demoBeat(ms, 6400, 8800);
  return <><Heading title="Today" line="A useful next step, with a little help" /><div className="film-assistant-background">{live.tasks.slice(0, 4).map((task) => <div className="film-panel" key={task.id}><span className="film-check" /><strong>{task.title}</strong></div>)}</div><div className="film-chat film-panel" style={{ opacity: opened, transform: `translateY(${(1 - opened) * 16}px)` }}><header><Sparkles size={14} /><strong>Ensemble</strong><span>New conversation</span></header><div className="film-chat-content"><div className="film-chat-greeting">How can I help?</div><div className="film-chat-question">{profile.prompt.slice(0, typed)}<i className="film-type-caret" style={{ opacity: ms < 5600 ? 1 : 0 }} /></div><div className="film-chat-answer" style={{ opacity: answer }}><Sparkles size={12} /><div><p>Let's start with a few clear next steps.</p><div className="film-proposal">{live.tasks.filter((task) => task.taskType === "task").slice(0, 2).map((task) => <span key={task.id}><span className="film-check" />{task.title}</span>)}<small><ShieldCheck size={11} />Proposed · held for you to apply</small></div></div></div></div><div className="film-compose">Ask a question…<span>↑</span></div></div><span className="film-launcher"><BrandMorph size={18} /></span></>;
}

/** Fictional scenes have no controls or links and cannot navigate or write to the real app. */
export function TourScene({ step, profile, ms, reduced }: { step: TourStep; profile: Profile; ms: number; reduced: boolean }) {
  const live = useMemo(() => sampleLive(profile.role), [profile.role]);
  const scene = step.id === "arrange" ? <AddTileScene profile={profile} ms={ms} /> : step.id === "board" ? <BoardScene live={live} ms={ms} /> : step.id === "pages" ? <PageScene profile={profile} ms={ms} /> : step.id === "context" ? <ContextScene profile={profile} ms={ms} /> : step.id === "files" ? <FilesScene live={live} ms={ms} /> : step.id === "code" ? <CodeScene ms={ms} /> : step.id === "meetings" ? <MeetingScene live={live} ms={ms} /> : step.id === "approvals" ? <ApprovalScene profile={profile} /> : step.id === "connections" ? <ConnectionsScene profile={profile} ms={ms} /> : step.id === "assistant" ? <AssistantScene profile={profile} live={live} ms={ms} /> : <TodayScene profile={profile} />;
  const sceneRef = useRef<HTMLDivElement>(null);
  const [targets, setTargets] = useState<Record<string, { x: number; y: number }>>({});
  const phase = [650, 950, 1200, 1950, 2650, 3250, 4050, 4850, 5300].filter((time) => ms >= time).length;
  useLayoutEffect(() => {
    const node = sceneRef.current;
    if (!node) return;
    const measure = () => {
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const found: Record<string, { x: number; y: number }> = {};
      node.querySelectorAll<HTMLElement>("[data-film-target]").forEach((target) => {
        const rect = target.getBoundingClientRect();
        found[target.dataset.filmTarget!] = { x: (rect.left + rect.width / 2 - box.left) / box.width * 100, y: (rect.top + rect.height / 2 - box.top) / box.height * 100 };
      });
      setTargets((old) => ({ ...old, ...found }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [step.id, phase]);
  const cursor = demoCursor(step.id, ms, targets);
  return <div ref={sceneRef} className="film-scene" data-scene={step.id}>{scene}{step.id === "welcome" || step.id === "finish" ? <div className="film-intro"><span className="film-intro-mark">{step.id === "finish" ? <CheckCheck size={27} /> : <BrandMorph size={34} />}</span><strong>{step.id === "finish" ? "A good place to begin." : "A space that works like you."}</strong><small>{profile.template?.name ?? "Your Ensemble"}</small></div> : null}{!reduced && step.id !== "welcome" && step.id !== "finish" && <span className="film-pointer" style={{ left: `${cursor.x}%`, top: `${cursor.y}%` } as CSSProperties}><MousePointer2 size={22} /><i style={{ opacity: cursor.press }} /></span>}</div>;
}

/** Short movements separated by deliberate reading pauses; clicks match scene events. */
export function demoCursor(id: string, ms: number, targets: Record<string, { x: number; y: number }> = {}) {
  const paths: Record<string, { points: Array<[number, number, number, string?]>; clicks: number[] }> = {
    today: { points: [[0, 85, 12], [500, 85, 12], [900, 31, 41], [2800, 31, 41], [3200, 67, 43]], clicks: [] },
    arrange: { points: [[0, 60, 30], [250, 60, 30], [650, 94, 10, "add-tile"], [1700, 94, 10, "add-tile"], [2050, 18, 42, "pick-tile"], [2800, 18, 42, "pick-tile"], [3250, 89, 82, "place-tile"]], clicks: [650, 2050, 3250] },
    board: { points: [[0, 86, 12], [500, 86, 12], [850, 20, 43], [1350, 20, 43], [1950, 54, 64]], clicks: [1350, 1950] },
    pages: { points: [[0, 72, 25], [350, 72, 25], [650, 28, 43, "person-mention"], [1200, 28, 43, "person-choice"], [1650, 63, 44, "project-mention"], [2350, 63, 44, "project-mention"], [2650, 77, 44, "date-mention"], [3200, 77, 44, "date-mention"], [4050, 83, 78, "add-board"], [4500, 83, 78, "add-board"], [4850, 64, 26, "due"], [5300, 64, 26, "tomorrow"]], clicks: [1200, 1950, 2650, 4050, 5300] },
    context: { points: [[0, 78, 20], [650, 78, 20], [1050, 51, 54], [2050, 51, 54], [3400, 51, 54], [3750, 25, 38]], clicks: [1700] },
    code: { points: [[0, 75, 22], [600, 75, 22], [1000, 52, 55], [2900, 52, 55], [3350, 80, 88]], clicks: [] },
    files: { points: [[0, 19, 37], [650, 19, 37], [1050, 64, 45], [3050, 64, 45], [3500, 78, 76]], clicks: [650, 3500] },
    meetings: { points: [[0, 15, 35], [700, 15, 35], [1150, 60, 65], [2900, 60, 65], [3300, 74, 83]], clicks: [700] },
    approvals: { points: [[0, 81, 23], [850, 81, 23], [1250, 37, 51], [3700, 37, 51], [4200, 32, 77], [7000, 32, 77], [7400, 17, 77]], clicks: [] },
    connections: { points: [[0, 82, 30], [750, 82, 30], [1200, 48, 60], [2500, 48, 60], [2900, 43, 82]], clicks: [] },
    assistant: { points: [[0, 92, 88], [1300, 92, 88], [1750, 78, 67], [7800, 78, 67], [8250, 76, 70]], clicks: [1300] },
  };
  const { points, clicks } = paths[id] ?? paths.today!;
  let a = points[0]!;
  let b = a;
  for (let i = 1; i < points.length; i++) { b = points[i]!; if (ms <= b[0]) break; a = b; }
  const t = a === b ? 1 : demoBeat(ms, a[0], b[0]);
  const from = a[3] && targets[a[3]] || { x: a[1], y: a[2] };
  const to = b[3] && targets[b[3]] || { x: b[1], y: b[2] };
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, press: Math.max(0, ...clicks.map((time) => 1 - Math.abs(ms - time) / 160)) };
}
