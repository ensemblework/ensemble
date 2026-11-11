"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { AgentIcon as Orbit } from "@/components/agent-icon";
import { Bell, CalendarCheck, CalendarDays, Check, CheckCheck, ChevronsUpDown, CircleCheck, Code2, Columns3, FileText, FolderOpen, GitBranch, Menu, MessageSquare, Paperclip, Pencil, Plus, Redo2, Search, Settings, ShieldCheck, Sparkles, Undo2, Users } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PreviewTiles, specPool } from "@/components/desk/live-board";
import { tileFitsRole, tileDescription } from "@/components/desk/tile-catalog";
import { greeting, longDate } from "@/components/desk/glance";
import { BrandLogo } from "@/components/connectors/brand-logo";
import { BrandMorph } from "@/components/motion/brand-morph";
import { personInitials } from "@/lib/initials";
import { sampleLive } from "./sample";
import { demoBeat } from "./tour-playback";
import { tourProfile, type TourStep } from "./tour-plan";

type Profile = ReturnType<typeof tourProfile>;
type Live = ReturnType<typeof sampleLive>;
/** The live sidebar's groups, order and icons (`components/shell/sidebar.tsx`). */
const NAV = [
  [["today", "Today", CalendarDays]],
  [["pages", "Pages", FileText]],
  [["files", "Files", FolderOpen]],
  [["board", "Board", Columns3], ["approvals", "Needs me", CircleCheck]],
  [["context", "Context", Users], ["meetings", "Meeting notes", CalendarCheck]],
  [["code", "Code", Code2]],
] as const;
const TITLES: Record<string, string> = { today: "Today", pages: "Pages", files: "Files", board: "Board", approvals: "Needs me", context: "Context", meetings: "Meeting notes", code: "Code", connections: "Settings" };

/** The app is laid out at a fixed size and scaled; its proportions follow the frame so it fills it like a video. */
export function previewSize(width: number, height: number) {
  const compact = width < 600 || width / height < 1.6;
  const aspect = width > 0 && height > 0 ? width / height : 2.08;
  const canvasWidth = compact ? 480 : Math.round(Math.min(1240, Math.max(1040, 500 * aspect)));
  const canvasHeight = Math.round(Math.min(compact ? 720 : 600, Math.max(500, canvasWidth / aspect)));
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
  const active = step.id === "arrange" || step.id === "welcome" || step.id === "finish" || step.id === "assistant" ? "today" : step.id;
  const shown = (id: string) => (id !== "code" || chapters.some((chapter) => chapter.id === "code")) && (id !== "meetings" || chapters.some((chapter) => chapter.id === "meetings"));
  return <div className="film-app" aria-hidden="true" inert>
    <aside className="film-sidebar"><div className="film-brand"><BrandMorph size={19} />Ensemble</div><div className="film-space"><span>F</span>Fieldnote<ChevronsUpDown size={10} /></div>
      <div className="film-nav">{NAV.map((group, i) => { const items = group.filter(([id]) => shown(id)); return items.length ? <div key={i} className="film-nav-group">{items.map(([id, label, Icon]) => <span key={id} data-active={active === id || undefined}><Icon size={13} strokeWidth={1.8} />{label}{id === "pages" && <Plus size={10} className="film-nav-add" />}</span>)}</div> : null; })}</div>
      <div className="film-settings" data-active={active === "connections" || undefined}><span><Settings size={13} strokeWidth={1.8} />Settings</span></div></aside>
    <div className="film-app-area"><div className="film-topbar"><span className="film-topbar-title"><Menu size={12} />{TITLES[active] ?? "Today"}</span><span className="film-search"><Search size={11} />Search and jump…<kbd>⌘K</kbd></span><span className="film-topbar-actions"><Bell size={12} /><Undo2 size={12} /><Redo2 size={12} /><span className="film-avatar">MC</span></span></div><div className="film-content">{children}</div>
      <span className="film-launcher" data-film-target="launcher"><BrandMorph size={18} /></span></div>
  </div>;
}

function Heading({ title, line, action, target, kicker }: { title: string; line: string; action?: string; target?: string; kicker?: string }) {
  return <div className="film-page-heading"><div>{kicker && <small className="film-kicker">{kicker}</small>}<h3>{title}</h3><p>{line}</p></div>{action && <span className="film-button" data-film-target={target}><Plus size={10} />{action}</span>}</div>;
}

/** The live Today header: the date, a greeting, and the summary chips. */
function TodayHeading({ line, target }: { line?: string; target?: string }) {
  const [date, hello] = useMemo(() => { const now = new Date(); return [longDate(now), greeting(now)]; }, []);
  return <><Heading kicker={date} title={hello} line={line ?? ""} action="Add a tile" target={target} />{!line && <div className="film-chips"><span><CircleCheck size={10} /><b>3</b> open</span><span><CalendarDays size={10} /><b>1</b> due today</span><span><Users size={10} /><b>0</b> need you</span></div>}</>;
}

const TodayScene = memo(function TodayScene({ profile }: { profile: Profile }) {
  const live = useMemo(() => sampleLive(profile.role), [profile.role]);
  const card = profile.template;
  const tiles = (card?.tiles ?? [["progress", 4, 3], ["focus", 8, 3], ["plan", 6, 3]]).slice(0, 3).map(([key], i) => [key, i === 0 ? 6 : 3, 6] as const);
  return <><TodayHeading /><div className="desk film-desk" data-desk={card?.desk ?? "branch"} data-film-target="desk"><div className="bento"><PreviewTiles deskId={card?.desk ?? "branch"} tiles={tiles} live={live} /></div></div></>;
});

function AddTileScene({ profile, ms }: { profile: Profile; ms: number }) {
  const live = useMemo(() => sampleLive(profile.role), [profile.role]);
  const existing = new Set(profile.template?.tiles.map(([key]) => key));
  const choices = [...specPool().values()].filter((tile) => !existing.has(tile.key) && tileFitsRole(tile.key, profile.role === "general" ? "engineer" : profile.role));
  const picked = choices.find((tile) => tile.key === "due-week") ?? choices.find((tile) => tile.key === "workload") ?? choices.find((tile) => tile.key === "progress") ?? choices[0]!;
  const opening = demoBeat(ms, 650, 950);
  const added = demoBeat(ms, 3250, 3550);
  return <><TodayHeading line="A desk you can make your own" target="add-tile" /><div className="film-gallery film-panel" style={{ opacity: opening, transform: `translateY(${((1 - opening) * 6).toFixed(2)}px) scale(${(.985 + opening * .015).toFixed(4)})` }}>
    <header><strong>Make room for your best work</strong><span>Your tile library</span></header>
    <div className="film-gallery-body"><aside><span className="film-gallery-search"><Search size={12} />Find a tile…</span>{[picked, ...choices.filter((tile) => tile.key !== picked.key).slice(0, 2)].map((tile, i) => <div key={tile.key} data-film-target={i === 0 ? "pick-tile" : undefined} data-hover={i === 0 && ms >= 1850 || undefined} data-selected={i === 0 && ms >= 2050 || undefined}><tile.icon size={15} /><span><strong>{tile.title}</strong><small>{i === 0 && added ? "On your Today" : "Available to add"}</small></span></div>)}</aside>
    <section><strong>{picked.title}</strong><p>{tileDescription(picked)}</p><div className="desk film-gallery-preview" data-desk={profile.template?.desk ?? "branch"}><div className="bento"><PreviewTiles deskId={profile.template?.desk ?? "branch"} tiles={[[picked.key, 12, 4]]} live={live} /></div></div><footer><small>Preview with sample data</small><span className="film-button" data-film-target="place-tile" data-primary>{added ? <Check size={11} /> : <Plus size={11} />}{added ? "On Today" : "Add to Today"}</span></footer></section></div>
    <div className="film-gallery-notice" style={{ opacity: added }} data-film-target="added-notice"><Check size={12} />{picked.title} added to Today</div>
  </div></>;
}

/** The live priority tag: a dot and a label in the priority's own colours. */
function Priority({ level }: { level: "high" | "medium" }) {
  return <span className="film-prio" style={{ background: `var(--prio-${level}-bg)`, color: `var(--prio-${level}-fg)` }}><i style={{ background: `var(--prio-${level})` }} />{level === "high" ? "High" : "Medium"}</span>;
}

function BoardScene({ live, ms }: { live: Live; ms: number }) {
  const tasks = live.tasks.filter((task) => task.taskType === "task").slice(0, 5);
  const dropped = ms >= 1950;
  const card = (task: Live["tasks"][number] | undefined, level: "high" | "medium", owner: string) => <><strong>{task?.title ?? "Choose a useful next step"}</strong><div><Priority level={level} /><span className="film-avatar">{owner}</span></div></>;
  // The pointer carries the card (`data-film-drag`) to the empty slot, which then shows it in place.
  return <><Heading title="Task board" line="Proposed through done. Drag a card to move it." action="New task" /><div className="film-board-filter"><Search size={11} />Search tasks or #label…<span>All owners</span><span>By priority</span></div><div className="film-board">
    <div className="film-lane"><header>To do<small>{dropped ? 2 : 3}</small><Plus size={11} /></header>
      <div className="film-task">{card(tasks[1], "high", "MC")}</div><div className="film-task">{card(tasks[2], "medium", "MC")}</div>
      {!dropped && <div className="film-task" data-film-drag data-film-target="drag-card">{card(tasks[0], "high", "MC")}</div>}</div>
    <div className="film-lane"><header>In progress<small>{dropped ? 2 : 1}</small><Plus size={11} /></header>
      <div className="film-task">{card(tasks[3], "high", "DP")}</div><div className="film-task" data-film-target="drop-slot" style={dropped ? undefined : { visibility: "hidden" }}>{card(tasks[0], "high", "MC")}</div></div>
    <div className="film-lane"><header>Done<small>1</small><Plus size={11} /></header><div className="film-task">{card(tasks[4], "medium", "DP")}</div></div>
  </div><div className="film-scene-note" style={{ opacity: demoBeat(ms, 2300, 2700) }}><Check size={12} />A clear owner. A visible next step.</div></>;
}

function PageScene({ profile, ms }: { profile: Profile; ms: number }) {
  const { story } = profile;
  const tomorrow = useMemo(() => { const date = new Date(); date.setDate(date.getDate() + 1); return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date); }, []);
  const person = demoBeat(ms, 1200, 1500);
  const project = demoBeat(ms, 1950, 2250);
  const date = demoBeat(ms, 2650, 2950);
  const onBoard = ms >= 4050;
  const due = ms >= 5600;
  // Menus stay mounted while closed so the pointer can aim at them before they open.
  const mentions = demoBeat(ms, 650, 760) * (1 - demoBeat(ms, 1200, 1320));
  const dates = demoBeat(ms, 4850, 4960) * (1 - demoBeat(ms, 5600, 5720));
  return <div className="film-document">
    <div className="film-document-tools"><span><FileText size={11} />{onBoard ? "Task page" : "Pages"}</span><span><Check size={10} />{ms < 3100 ? "Saving…" : "Saved"}</span><span className="film-button">Share</span></div>
    <h3>{story.page}</h3>
    {onBoard && <div className="film-task-properties"><span>To do</span><span>Owner <b>Me</b></span><span className="film-due" data-film-target="due" data-open={(ms >= 4850 && !due) || undefined}>Due <b>{due ? "Tomorrow" : "Set date"}</b></span></div>}
    <div className="film-editor-toolbar"><b>B</b><i>I</i><span>≡</span><span>☑</span><span>Link</span></div>
    <div className="film-document-body"><h4>Our next step</h4><p><span className="film-mention" data-kind="people" style={{ opacity: person }}>@{story.person}</span> asked me to {story.work} for <span className="film-mention" data-kind="project" style={{ opacity: project }}>@{story.project}</span> by <span className="film-mention" data-kind="date" style={{ opacity: date }}>@{tomorrow}</span>.</p><p className="film-document-note" data-film-target="doc-note">Keep the review notes and decisions here, alongside the work.</p></div>
    <div className="film-mention-menu" style={{ opacity: mentions, visibility: mentions ? undefined : "hidden" }}><small>People</small><span data-film-target="person-choice" data-hover={(ms >= 1000 && ms < 1200) || undefined}><span className="film-avatar">{personInitials(story.person)}</span>{story.person}</span>{(() => { const other = ["Lena Ortiz", "Daniel Park"].find((name) => name !== story.person)!; return <span><span className="film-avatar">{personInitials(other)}</span>{other}</span>; })()}</div>
    {!onBoard && <span className="film-button film-add-board" data-film-target="add-board" data-primary>Add to board</span>}
    {onBoard && <div className="film-date-menu" style={{ opacity: dates, visibility: dates ? undefined : "hidden" }}><span>Today</span><strong data-film-target="tomorrow" data-hover={(ms >= 5400 && ms < 5600) || undefined}>Tomorrow</strong><span>Next week</span><small><CalendarDays size={11} />Pick a date</small></div>}
    <div className="film-document-saved" style={{ opacity: demoBeat(ms, 5900, 6200) }}><CircleCheck size={12} />On the board · due Tomorrow</div>
  </div>;
}

function ContextScene({ profile, ms }: { profile: Profile; ms: number }) {
  const { story } = profile;
  const selected = demoBeat(ms, 1700, 2050);
  return <><Heading title="Context" line="Saved relationships and page mentions" /><div className="film-context-tabs"><span>People</span><span>Projects</span><span data-active>Graph</span><small>3 nodes · 2 links</small></div>
    <div className="film-context-record film-panel"><div className="film-graph-filters"><span>People</span><span>Projects</span><span>Tasks</span><small>Fit</small></div><svg viewBox="0 0 760 210" className="film-real-graph">
      <line x1="178" y1="65" x2="380" y2="126" stroke="var(--line-strong)" strokeDasharray="5 4" /><line x1="582" y1="65" x2="380" y2="126" stroke="var(--line-strong)" strokeDasharray="5 4" />
      <circle cx="178" cy="65" r="11" fill="var(--kind-people)" data-film-target="person-node" /><text x="178" y="96" textAnchor="middle">{story.person}</text>
      <rect x="571" y="54" width="22" height="22" rx="5" fill="var(--kind-project)" /><text x="582" y="96" textAnchor="middle">{story.project}</text>
      <path d="M380 111 L395 126 L380 141 L365 126 Z" fill="var(--kind-task)" stroke="var(--ink)" strokeWidth={selected * 2} data-film-target="task-node" /><text x="380" y="165" textAnchor="middle">{story.page}</text>
    </svg><div className="film-graph-detail" style={{ opacity: selected }} data-film-target="graph-detail"><FileText size={13} /><strong>{story.page}</strong><span>Task · To do</span><small>Mentions {story.person} · {story.project}</small></div></div>
  </>;
}

function FilesScene({ live, ms }: { live: Live; ms: number }) {
  return <><Heading title="Files" line="Keep a useful source close to your work" action="Upload" /><div className="film-files"><div className="film-file-list">{live.artifacts.slice(0, 4).map((file, i) => <div key={file.id} data-selected={i === 0 && ms >= 650 || undefined} data-film-target={i === 0 ? "file-0" : undefined}><FileText size={17} /><span><strong>{file.title}</strong><small>{i === 0 ? "Opened in preview" : "Source material"}</small></span></div>)}</div><div className="film-paper"><span className="film-paper-kicker">REFERENCE NOTES</span><h4>{live.artifacts[0]?.title ?? "Project notes.pdf"}</h4><p>Keep the original source alongside the work it supports.</p><div className="film-paper-highlight" data-film-target="highlight" data-on={ms >= 1900 || undefined}>The next step has a source you can return to.</div>{[90, 100, 87, 95, 74].map((width, i) => <i key={i} style={{ width: `${width}%` }} />)}<span className="film-button film-file-attach" data-film-target="attach" data-primary={ms < 3500 || undefined}>{ms >= 3500 ? <Check size={11} /> : <Paperclip size={11} />}{ms >= 3500 ? "Attached to a page" : "Attach to a page"}</span></div></div></>;
}

function CodeScene({ ms }: { ms: number }) {
  const changed = demoBeat(ms, 1300, 1900);
  return <><Heading title="Code" line="Review a change before it becomes part of your work" /><div className="film-code"><div className="film-code-toolbar"><GitBranch size={12} />ensemble/welcome<span>Changes ready for review</span></div><div className="film-code-file"><FileText size={12} />src/welcome.tsx <small>+2 −1</small></div><div className="film-diff"><div><em>1</em>export function Welcome() {'{'}</div><div><em>2</em>  return (</div><div className="film-diff-old"><em>−</em>    &lt;h1&gt;Hello&lt;/h1&gt;</div><div className="film-diff-new" style={{ opacity: changed }} data-film-target="diff-new"><em>+</em>    &lt;h1&gt;Welcome to your space&lt;/h1&gt;</div><div className="film-diff-new" style={{ opacity: changed }}><em>+</em>    &lt;p&gt;A clear next step.&lt;/p&gt;</div><div><em>5</em>  );</div><div><em>6</em>{'}'}</div></div><div className="film-review-bar"><ShieldCheck size={13} />You review what changes<span className="film-button" data-film-target="review">Review changes</span></div></div></>;
}

function MeetingScene({ live, ms }: { live: Live; ms: number }) {
  return <><Heading title="Meeting notes" line="Keep the decision and the follow-up together" action="New notes" /><div className="film-meeting"><div className="film-panel film-meeting-list">{live.meetings.slice(0, 3).map((meeting, i) => <div key={meeting.id} data-selected={i === 0 && ms >= 700 || undefined} data-film-target={i === 0 ? "meeting-0" : undefined}><MessageSquare size={13} /><strong>{meeting.title}</strong></div>)}</div><div className="film-panel film-notes"><span className="film-paper-kicker">MEETING NOTES</span><h4 data-film-target="notes-title">{live.meetings[0]?.title ?? "Team check-in"}</h4><p>What we decided</p><div className="film-note-line">Focus on the most useful next step this week.</div><p className="film-note-subheading">Follow-ups</p><div className="film-followup" style={{ opacity: .45 + demoBeat(ms, 1600, 2200) * .55 }} data-film-target="followup"><span className="film-check" /><strong>Send the revised plan by Friday</strong><span className="film-avatar">MC</span></div><span className="film-notes-saved" style={{ opacity: demoBeat(ms, 3300, 3700) }}><Check size={12} />Decision and next step, together</span></div></div></>;
}

function ApprovalScene({ profile }: { profile: Profile }) {
  const code = profile.codeEnabled && (profile.role === "engineer" || profile.role === "vibe");
  const { story } = profile;
  return <><Heading title="Needs me" line="Decisions to make, questions to answer, and work ready for a next step." />
    <div className="film-review-overview">{[[Orbit, "Questions from Ensemble runs", code ? "1" : "0"], [ShieldCheck, "Outgoing approvals", code ? "0" : "1"], [CalendarDays, "Waiting tasks", "0"]].map(([Icon, label, count]) => { const Mark = Icon as typeof Orbit; return <div key={String(label)}><Mark size={17} /><span><strong>{String(count)}</strong><small>{String(label)}</small></span></div>; })}</div>
    <div className="film-context-tabs"><span>Everything</span><span data-active={code || undefined}>Requests</span><span data-active={!code || undefined}>Approvals</span><span>Waiting tasks</span></div>
    <div className="film-real-request film-panel" data-request-kind={code ? "permission" : "outgoing"}>
      {code ? <><div className="film-request-meta"><span className="film-tag">Ensemble agent</span><span>wants to git push · just now</span><small>{story.page}</small></div><h4 data-film-target="request-title">Push the reviewed changes?</h4><pre data-film-target="request-body">git push origin feature/welcome</pre><p className="film-request-path">fieldnote/app</p><div className="film-real-actions"><span className="film-button" data-primary data-film-target="approve"><Check size={11} />Allow once</span><span className="film-reason">Reason if you deny (sent to the agent)</span><span>Deny</span></div></>
      : <><div className="film-request-meta"><span>SEND EMAIL</span><small>Open task ↗</small></div><h4 data-film-target="request-title">{story.subject}</h4><p className="film-request-path">Just now · To {story.person}</p><pre data-film-target="request-body">{story.message}</pre><span className="film-reason">Why? (optional, helps the skill learn)</span><div className="film-real-actions"><span className="film-button" data-primary data-film-target="approve"><Check size={11} />Approve</span><span className="film-button"><Pencil size={11} />Edit</span><span>Reject</span></div></>}
    </div>
  </>;
}

function ConnectionsScene({ profile, ms }: { profile: Profile; ms: number }) {
  const shown = demoBeat(ms, 2700, 3100);
  return <><Heading title="Connected apps" line="Bring relevant work from the tools you already use" /><div className="film-connections">{[["googleworkspace", "Google Workspace", "Drive, calendar, and more"], ["github", "GitHub", "Repositories and issues"], ["microsoft365", "Microsoft 365", "Files, mail, and calendar"]].map(([id, title, line], i) => { const chosen = i === (profile.role === "engineer" || profile.role === "vibe" ? 1 : profile.role === "manager" ? 2 : 0); return <div className="film-panel" key={id} data-selected={chosen && ms >= 1500 || undefined} data-film-target={chosen ? "connector" : undefined}><BrandLogo id={id!} size={30} /><strong>{title}</strong><p>{line}</p><span className="film-button">Connect</span></div>; })}</div><div className="film-source-details" style={{ opacity: shown, transform: `translateY(${((1 - shown) * 8).toFixed(2)}px)` }} data-film-target="source-details"><ShieldCheck size={18} /><div><strong>Review each connection's access</strong><p>Choose the source, follow its sign-in steps, then choose what to use in Ensemble.</p></div></div></>;
}

function AssistantScene({ profile, live, ms }: { profile: Profile; live: Live; ms: number }) {
  const opened = demoBeat(ms, 1300, 2400);
  const typed = Math.round(profile.prompt.length * demoBeat(ms, 2800, 5400));
  const answer = demoBeat(ms, 6400, 8800);
  return <><TodayHeading line="A useful next step, with a little help" /><div className="film-assistant-background">{live.tasks.slice(0, 4).map((task) => <div className="film-panel" key={task.id}><span className="film-check" /><strong>{task.title}</strong></div>)}</div><div className="film-chat film-panel" style={{ opacity: opened, transform: `translateY(${((1 - opened) * 12).toFixed(2)}px) scale(${(.97 + opened * .03).toFixed(4)})` }}><header><Sparkles size={14} /><strong>Ensemble</strong><span>New conversation</span></header><div className="film-chat-content"><div className="film-chat-greeting">How can I help?</div><div className="film-chat-question">{profile.prompt.slice(0, typed)}<i className="film-type-caret" style={{ opacity: ms < 5600 ? 1 : 0 }} /></div><div className="film-chat-answer" style={{ opacity: answer }}><Sparkles size={12} /><div><p>Let's start with a few clear next steps.</p><div className="film-proposal" data-film-target="proposal">{live.tasks.filter((task) => task.taskType === "task").slice(0, 2).map((task) => <span key={task.id}><span className="film-check" />{task.title}</span>)}<small><ShieldCheck size={11} />Proposed · held for you to apply</small></div></div></div></div><div className="film-compose" data-film-target="compose">Ask a question…<span>↑</span></div></div></>;
}

/** Fictional scenes have no controls or links and cannot navigate or write to the real app. */
export function TourScene({ step, profile, ms }: { step: TourStep; profile: Profile; ms: number; reduced?: boolean }) {
  const live = useMemo(() => sampleLive(profile.role), [profile.role]);
  const scene = step.id === "arrange" ? <AddTileScene profile={profile} ms={ms} /> : step.id === "board" ? <BoardScene live={live} ms={ms} /> : step.id === "pages" ? <PageScene profile={profile} ms={ms} /> : step.id === "context" ? <ContextScene profile={profile} ms={ms} /> : step.id === "files" ? <FilesScene live={live} ms={ms} /> : step.id === "code" ? <CodeScene ms={ms} /> : step.id === "meetings" ? <MeetingScene live={live} ms={ms} /> : step.id === "approvals" ? <ApprovalScene profile={profile} /> : step.id === "connections" ? <ConnectionsScene profile={profile} ms={ms} /> : step.id === "assistant" ? <AssistantScene profile={profile} live={live} ms={ms} /> : <TodayScene profile={profile} />;
  return <div className="film-scene" data-scene={step.id}>{scene}{step.id === "welcome" || step.id === "finish" ? <div className="film-intro"><span className="film-intro-mark">{step.id === "finish" ? <CheckCheck size={27} /> : <BrandMorph size={34} />}</span><strong>{step.id === "finish" ? "A good place to begin." : "A space that works like you."}</strong><small>{profile.template?.name ?? "Your Ensemble"}</small></div> : null}</div>;
}
