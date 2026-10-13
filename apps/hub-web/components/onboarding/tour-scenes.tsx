"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Bell, CalendarDays, Check, CheckCheck, ChevronDown, CircleCheck, Code2, Columns3, FileText, FolderOpen, GitBranch, GripVertical, MessageSquare, MousePointer2, Plus, Search, Settings, ShieldCheck, Sparkles, Users } from "lucide-react";
import { memo, useMemo, type CSSProperties } from "react";
import { PreviewTiles, specPool } from "@/components/desk/live-board";
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

export function DemoApp({ step, chapters, children }: { step: TourStep; chapters: TourStep[]; children: React.ReactNode }) {
  const active = step.id === "arrange" || step.id === "welcome" || step.id === "finish" || step.id === "assistant" ? "today" : step.id;
  return <div className="film-app" aria-hidden="true" inert>
    <aside className="film-sidebar"><div className="film-brand"><BrandMorph size={19} />Ensemble</div><div className="film-space"><span>F</span>Fieldnote<ChevronDown size={10} /></div><div className="film-jump"><Search size={11} />Jump to…<small>⌘ K</small></div>
      <div className="film-nav">{NAV.filter(([id]) => id !== "code" || chapters.some((chapter) => chapter.id === "code")).map(([id, label, Icon]) => <span key={id} data-active={active === id || undefined}><Icon size={13} />{label}</span>)}</div><span className="film-settings" data-active={active === "connections" || undefined}><Settings size={13} />Settings</span></aside>
    <div className="film-app-area"><div className="film-topbar"><span>{step.id === "connections" ? "Settings" : NAV.find(([id]) => id === active)?.[1] ?? "Today"}</span><span className="film-search"><Search size={11} />Ask Ensemble · search your work</span><Bell size={12} /><span className="film-avatar">MC</span></div><div className="film-content">{children}</div></div>
  </div>;
}

function Heading({ title, line, action }: { title: string; line: string; action?: string }) {
  return <div className="film-page-heading"><div><h3>{title}</h3><p>{line}</p></div>{action && <span className="film-button"><Plus size={10} />{action}</span>}</div>;
}

const TodayScene = memo(function TodayScene({ profile }: { profile: Profile }) {
  const live = useMemo(() => sampleLive(profile.role), [profile.role]);
  const card = profile.template;
  const tiles = (card?.tiles ?? [["progress", 4, 3], ["focus", 8, 3], ["plan", 6, 3]]).slice(0, 3).map(([key], i) => [key, i === 0 ? 6 : 3, 6] as const);
  return <><Heading title="Today" line={card?.name ?? "A little direction for your day"} action="Add a tile" /><div className="desk film-desk" data-desk={card?.desk ?? "branch"}><div className="bento"><PreviewTiles deskId={card?.desk ?? "branch"} tiles={tiles} live={live} /></div></div><div className="film-day-tail"><span><CircleCheck size={12} />A clear next step</span><span>Your work, in one view</span></div></>;
});

function ArrangeScene({ profile, ms }: { profile: Profile; ms: number }) {
  const titles = profile.template?.tiles.slice(0, 3).map(([key]) => specPool().get(key)?.title ?? "Your work") ?? ["Focus", "Task progress", "Week ahead"];
  const amount = demoBeat(ms, 2600, 7000);
  return <><Heading title="Today" line="A desk you can make your own" action="Add a tile" /><div className="film-arrange-grid">
    {titles.map((title, index) => <div className="film-panel film-arrange-tile" key={title} style={{ left: `${index === 0 ? 0 : index === 1 ? 55 - amount * 17 : 80}%`, width: `${index === 0 ? 52 - amount * 17 : index === 1 ? 22 + amount * 17 : 20}%` }}><div className="film-panel-head"><GripVertical size={12} /><strong>{title}</strong><Plus size={10} /></div>{index === 1 ? <div className="film-ring"><span>6<small>done this week</small></span></div> : <div className="film-tile-list">{["One clear priority", "A little room to think", "The next useful step"].map((row, i) => <div key={row}><span className="film-check" />{row}<small>{i + 1}</small></div>)}</div>}<i className="film-resize-corner" /></div>)}
  </div><div className="film-scene-note" style={{ opacity: demoBeat(ms, 7600, 9000) }}><Check size={12} />Your arrangement is saved</div></>;
}

function BoardScene({ live, ms }: { live: Live; ms: number }) {
  const tasks = live.tasks.filter((task) => task.taskType === "task").slice(0, 5);
  const moving = demoBeat(ms, 2600, 5800);
  return <><Heading title="Task board" line="Proposed through done. Drag a card to move it." action="New task" /><div className="film-board-filter"><Search size={11} />Search tasks or #label…<span>All owners</span><span>By priority</span></div><div className="film-board">
    {["To do", "In progress", "Done"].map((label, column) => <div className="film-lane" key={label}><header>{label}<small>{column === 0 ? ms >= 5800 ? 2 : 3 : column === 1 && ms >= 5800 ? 2 : 1}</small><Plus size={11} /></header>{tasks.slice(column === 0 ? 1 : column + 2, column === 0 ? 3 : column + 3).map((task, i) => <div className="film-task" key={task.id} style={column === 0 && i === 0 ? { marginTop: `${102 * (1 - moving)}px` } : undefined}><strong>{task.title}</strong><div><span className="film-tag">{i ? "Medium" : "High"}</span><span className="film-avatar">{column === 0 ? "MC" : "DP"}</span></div></div>)}</div>)}
    <div className="film-task film-moving-task" style={{ left: `calc(${moving * 33.8}% + 9px)`, top: `${50 + moving * 80}px`, transform: `rotate(${-moving * (1 - moving) * 12}deg)` }}><strong>{tasks[0]?.title ?? "Choose a useful next step"}</strong><div><span className="film-tag">High</span><span className="film-avatar">MC</span></div></div>
  </div><div className="film-scene-note" style={{ opacity: demoBeat(ms, 7400, 9000) }}><Check size={12} />A clear owner. A visible next step.</div></>;
}

function ContextScene({ live, ms }: { live: Live; ms: number }) {
  const linked = demoBeat(ms, 2500, 6500);
  const people = live.people.slice(0, 3);
  return <><Heading title="Context" line="The people, projects, and sources around your work" /><div className="film-context"><div className="film-panel film-people"><div className="film-panel-head"><Users size={12} /><strong>People</strong></div>{people.map((person) => <div className="film-person" key={person.id}><span className="film-avatar">{personInitials(person.name)}</span><div><strong>{person.name}</strong><small>{person.role}</small></div></div>)}</div><div className="film-panel film-graph"><svg viewBox="0 0 460 250">
    {[[94, 65], [365, 65], [94, 196], [365, 196]].map(([x, y], i) => <line key={i} x1="230" y1="128" x2={x} y2={y} stroke={i < 2 ? "var(--accent)" : "var(--line-strong)"} strokeWidth="1.5" strokeDasharray="220" strokeDashoffset={220 * (1 - linked)} />)}
    <circle cx="230" cy="128" r="29" fill="var(--accent-soft)" stroke="var(--accent)" /><text x="230" y="132" textAnchor="middle" fill="var(--ink)" fontSize="11" fontWeight="600">Project</text>
    {[[94, 65], [365, 65], [94, 196], [365, 196]].map(([x, y], i) => <g key={i} opacity={.55 + linked * .45}><rect x={x! - 60} y={y! - 20} width="120" height="40" rx="10" fill="var(--panel)" stroke="var(--line-strong)" /><text x={x} y={y! + 4} textAnchor="middle" fill="var(--ink)" fontSize="11">{i < 2 ? people[i]?.name ?? "Collaborator" : i === 2 ? "Source material" : "Related work"}</text></g>)}
  </svg><span className="film-graph-label">{live.projects[0]?.name ?? "Your project"}</span></div></div></>;
}

function FilesScene({ live, ms }: { live: Live; ms: number }) {
  return <><Heading title="Files" line="Keep a useful source close to your work" action="Upload" /><div className="film-files"><div className="film-file-list">{live.artifacts.slice(0, 4).map((file, i) => <div key={file.id} data-selected={i === 0 || undefined}><FileText size={17} /><span><strong>{file.title}</strong><small>{i === 0 ? "Opened in preview" : "Source material"}</small></span></div>)}</div><div className="film-paper"><span className="film-paper-kicker">REFERENCE NOTES</span><h4>{live.artifacts[0]?.title ?? "Project notes.pdf"}</h4><p>Keep the original source alongside the work it supports.</p><div className="film-paper-highlight" style={{ background: ms >= 4000 ? "var(--accent-soft)" : "transparent" }}>The next step has a source you can return to.</div>{[90, 100, 87, 95, 74].map((width, i) => <i key={i} style={{ width: `${width}%` }} />)}<span className="film-file-attached" style={{ opacity: demoBeat(ms, 7600, 9200) }}><Check size={12} />Attach to a page</span></div></div></>;
}

function CodeScene({ ms }: { ms: number }) {
  const changed = demoBeat(ms, 2800, 6000);
  return <><Heading title="Code" line="Review a change before it becomes part of your work" /><div className="film-code"><div className="film-code-toolbar"><GitBranch size={12} />ensemble/welcome<span>Changes ready for review</span></div><div className="film-code-file"><FileText size={12} />src/welcome.tsx <small>+2 −1</small></div><div className="film-diff"><div><em>1</em>export function Welcome() {'{'}</div><div><em>2</em>  return (</div><div className="film-diff-old"><em>−</em>    &lt;h1&gt;Hello&lt;/h1&gt;</div><div className="film-diff-new" style={{ opacity: changed }}><em>+</em>    &lt;h1&gt;Welcome to your space&lt;/h1&gt;</div><div className="film-diff-new" style={{ opacity: changed }}><em>+</em>    &lt;p&gt;A clear next step.&lt;/p&gt;</div><div><em>5</em>  );</div><div><em>6</em>{'}'}</div></div><div className="film-review-bar"><ShieldCheck size={13} />You review what changes<span className="film-button">Review changes</span></div></div></>;
}

function MeetingScene({ live, ms }: { live: Live; ms: number }) {
  return <><Heading title="Meeting notes" line="Keep the decision and the follow-up together" action="New notes" /><div className="film-meeting"><div className="film-panel film-meeting-list">{live.meetings.slice(0, 3).map((meeting, i) => <div key={meeting.id} data-selected={i === 0 || undefined}><MessageSquare size={13} /><strong>{meeting.title}</strong></div>)}</div><div className="film-panel film-notes"><span className="film-paper-kicker">MEETING NOTES</span><h4>{live.meetings[0]?.title ?? "Team check-in"}</h4><p>What we decided</p><div className="film-note-line">Focus on the most useful next step this week.</div><p className="film-note-subheading">Follow-ups</p><div className="film-followup" style={{ opacity: .45 + demoBeat(ms, 3500, 6500) * .55 }}><span className="film-check" /><strong>Send the revised plan by Friday</strong><span className="film-avatar">MC</span></div><span className="film-notes-saved" style={{ opacity: demoBeat(ms, 8000, 10000) }}><Check size={12} />Decision and next step, together</span></div></div></>;
}

function ApprovalScene({ live, ms }: { live: Live; ms: number }) {
  const reviewed = demoBeat(ms, 3000, 6500);
  return <><Heading title="Needs me" line="Questions and approvals that need your decision" /><div className="film-approval film-panel"><div className="film-approval-title"><span className="film-assistant-icon"><Sparkles size={19} /></span><div><strong>Ensemble needs your review</strong><small>Proposed changes · waiting for you</small></div><span className="film-tag">Needs you</span></div><h4>Add a next step to your project?</h4><p>A proposed task based on your notes, ready for a closer look.</p><div className="film-request-detail" style={{ opacity: reviewed, transform: `translateY(${(1 - reviewed) * 10}px)` }}><span className="film-check" /><span>{live.tasks[0]?.title ?? "Prepare the next useful step"}</span><small>To do</small></div><div className="film-approval-actions"><span className="film-button" data-primary>Review request</span><span>Not now</span></div><div className="film-approval-foot"><ShieldCheck size={12} />The decision stays with you</div></div></>;
}

function ConnectionsScene({ ms }: { ms: number }) {
  const shown = demoBeat(ms, 3500, 7500);
  return <><Heading title="Connected apps" line="Bring relevant work from the tools you already use" /><div className="film-connections">{[["googleworkspace", "Google Workspace", "Drive, calendar, and more"], ["github", "GitHub", "Repositories and issues"], ["microsoft365", "Microsoft 365", "Files, mail, and calendar"]].map(([id, title, line], i) => <div className="film-panel" key={id} data-selected={i === 0 && ms > 3000 || undefined}><BrandLogo id={id!} size={30} /><strong>{title}</strong><p>{line}</p><span className="film-button">Connect</span></div>)}</div><div className="film-source-details" style={{ opacity: shown, transform: `translateY(${(1 - shown) * 8}px)` }}><ShieldCheck size={18} /><div><strong>Review each connection's access</strong><p>Choose the source, follow its sign-in steps, then choose what to use in Ensemble.</p></div></div></>;
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
  const scene = step.id === "arrange" ? <ArrangeScene profile={profile} ms={ms} /> : step.id === "board" ? <BoardScene live={live} ms={ms} /> : step.id === "context" ? <ContextScene live={live} ms={ms} /> : step.id === "files" ? <FilesScene live={live} ms={ms} /> : step.id === "code" ? <CodeScene ms={ms} /> : step.id === "meetings" ? <MeetingScene live={live} ms={ms} /> : step.id === "approvals" ? <ApprovalScene live={live} ms={ms} /> : step.id === "connections" ? <ConnectionsScene ms={ms} /> : step.id === "assistant" ? <AssistantScene profile={profile} live={live} ms={ms} /> : <TodayScene profile={profile} />;
  const cursor = demoCursor(step.id, ms);
  return <div className="film-scene" data-scene={step.id}>{scene}{step.id === "welcome" || step.id === "finish" ? <div className="film-intro"><span className="film-intro-mark">{step.id === "finish" ? <CheckCheck size={27} /> : <BrandMorph size={34} />}</span><strong>{step.id === "finish" ? "A good place to begin." : "A space that works like you."}</strong><small>{profile.template?.name ?? "Your Ensemble"}</small></div> : null}{!reduced && step.id !== "welcome" && step.id !== "finish" && <span className="film-pointer" style={{ left: `${cursor.x}%`, top: `${cursor.y}%` } as CSSProperties}><MousePointer2 size={22} /><i style={{ opacity: cursor.press }} /></span>}</div>;
}

export function demoCursor(id: string, ms: number) {
  const paths: Record<string, Array<[number, number, number]>> = {
    today: [[0, 85, 12], [2400, 31, 41], [5600, 31, 41], [9000, 67, 43]],
    arrange: [[0, 70, 48], [2500, 52, 72], [6900, 35, 72], [9500, 35, 72]],
    board: [[0, 86, 12], [2500, 20, 43], [5800, 54, 64], [9500, 54, 64]],
    context: [[0, 20, 38], [2300, 69, 53], [5500, 84, 37], [9300, 84, 37]],
    code: [[0, 75, 22], [2400, 52, 55], [6500, 80, 88], [9500, 80, 88]],
    files: [[0, 19, 37], [3200, 64, 45], [7500, 78, 76], [9800, 78, 76]],
    meetings: [[0, 15, 35], [3200, 60, 65], [6500, 60, 65], [9500, 74, 83]],
    approvals: [[0, 73, 30], [2900, 19, 76], [6500, 49, 56], [9500, 49, 56]],
    connections: [[0, 82, 30], [3000, 18, 60], [7300, 43, 82], [10000, 43, 82]],
    assistant: [[0, 92, 88], [1600, 92, 88], [4500, 78, 67], [8500, 76, 70]],
  };
  const points = paths[id] ?? paths.today!;
  let a = points[0]!;
  let b = a;
  for (let i = 1; i < points.length; i++) { b = points[i]!; if (ms <= b[0]) break; a = b; }
  const t = a === b ? 1 : demoBeat(ms, a[0], b[0]);
  return { x: a[1] + (b[1] - a[1]) * t, y: a[2] + (b[2] - a[2]) * t, press: Math.max(0, 1 - Math.abs(ms - 3000) / 320) };
}
