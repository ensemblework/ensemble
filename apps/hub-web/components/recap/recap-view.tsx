"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  Award,
  Bot,
  CalendarClock,
  CalendarRange,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock3,
  Copy,
  Download,
  FileText,
  Flag,
  FolderKanban,
  ListChecks,
  ListPlus,
  PieChart,
  Scale,
  Sprout,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { InfoTip, MenuItem, Popover, QueryError, Skeleton } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api, type RecapStats, type WeeklyRecap } from "@/lib/api";
import { AgentBars, Ahead, Highlights, Projects, RecapTile, Record } from "./tiles";
import { DailyChart, HeatScale, HeatStrip, SuccessRing, SurfaceDonut } from "./charts";
import { addDays, dayMonth, duration, hourLabel, peakWindow, plural, shortDuration, weekdayLong } from "./format";
import "./recap.css";

const ACTIVE_NOTE = "Screen time while Ensemble is open and in use: your own activity, across your spaces. It is not hours worked, and nothing outside Ensemble is counted.";

export function RecapView({ date }: { date: string | null }) {
  const recap = useQuery({
    queryKey: date ? ["weekly-recap", date] : ["weekly-recap"],
    queryFn: () => api.weeklyRecap(date ?? undefined),
    placeholderData: keepPreviousData,
  });
  const data = recap.data;
  return (
    <div className="recap page-read mx-auto max-w-[1200px] px-4 pb-24 pt-8 sm:px-8" aria-busy={recap.isFetching && recap.isPlaceholderData ? true : undefined}>
      {data ? <Header data={data} /> : <HeaderSkeleton />}
      {recap.isError && !data ? (
        <QueryError error={recap.error as Error} retry={() => void recap.refetch()} />
      ) : !data ? (
        <BodySkeleton />
      ) : (
        <div className="recap-body">
          <Body data={data} />
        </div>
      )}
    </div>
  );
}

function Header({ data }: { data: WeeklyRecap }) {
  const previous = addDays(data.start, -7);
  const next = addDays(data.start, 7);
  const canGoNext = next <= data.today;
  const lastDay = addDays(data.end, -1);
  const which = data.current ? "This week" : data.end <= data.today && data.today < addDays(data.end, 7) ? "Last week" : null;
  return (
    <header className="recap-head">
      <div className="min-w-0">
        <div className="recap-kicker"><i aria-hidden />{which ? `Weekly recap · ${which}` : "Weekly recap"}</div>
        <h1 className="display recap-title"><small>Week of</small>{data.label}</h1>
      </div>
      <div className="recap-actions">
        <nav className="recap-nav" aria-label="Weeks">
          <Link href={`/recap?date=${previous}`} aria-label={`Previous week, from ${dayMonth(previous)}`} title="Previous week">
            <ChevronLeft size={15} aria-hidden />
          </Link>
          {data.current ? (
            <span aria-current="page" className="recap-nav-now px-2 text-[12.5px]">This week</span>
          ) : (
            <Link href="/recap" className="recap-nav-now">This week</Link>
          )}
          {canGoNext ? (
            <Link href={`/recap?date=${next}`} aria-label={`Next week, from ${dayMonth(next)}`} title="Next week">
              <ChevronRight size={15} aria-hidden />
            </Link>
          ) : (
            <span aria-disabled="true" aria-label="Next week has not started" title="Next week has not started">
              <ChevronRight size={15} aria-hidden />
            </span>
          )}
        </nav>
        <ExportMenu data={data} />
      </div>
      {isQuiet(data) ? null : (
        <p className="recap-narrative">
          {data.narrative.split(/(\d+)/).map((part, index) => (index % 2 ? <strong key={index}>{part}</strong> : part))}
        </p>
      )}
      <p className="recap-note">
        {weekdayLong(data.start)} {dayMonth(data.start)} to {weekdayLong(lastDay)} {dayMonth(lastDay)}, {data.timeZone.replace(/_/g, " ")} time.{" "}
        {data.compare === "to_date" ? "Changes compare with this time last week." : "Changes compare with the week before."}
      </p>
    </header>
  );
}

function ExportMenu({ data }: { data: WeeklyRecap }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.markdown);
      toast("Copied the week as Markdown.");
    } catch {
      toast("Could not copy. Download the Markdown instead.", { tone: "error" });
    }
  };
  const download = () => {
    const blob = new Blob([data.markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ensemble-week-${data.start}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Popover
      align="right"
      width={220}
      trigger={(open, toggle) => (
        <button type="button" className="btn" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          Export
          <ChevronDown size={14} aria-hidden />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label="Export the week">
          <MenuItem onClick={() => { close(); void copy(); }}>
            <Copy size={14} aria-hidden />
            Copy as Markdown
          </MenuItem>
          <MenuItem onClick={() => { close(); download(); }}>
            <Download size={14} aria-hidden />
            Download Markdown
          </MenuItem>
        </div>
      )}
    </Popover>
  );
}

function isQuiet(data: WeeklyRecap) {
  const s = data.stats;
  return !s.completed && !s.created && !s.agentRuns && !s.activeMinutes && !s.meetings && !s.decisions && !s.pagesEdited && !data.done.length;
}

function Body({ data }: { data: WeeklyRecap }) {
  const quiet = isQuiet(data);
  const showAhead = data.current || data.ahead.overdueTotal > 0;
  return (
    <div className="mt-6 space-y-3">
      {quiet ? <Quiet data={data} /> : <Kpis data={data} />}
      <div className="recap-grid">
        {quiet ? null : (
          <>
            <RecapTile title="Daily rhythm" icon={CalendarRange} lg={8} right={<DailyLegend />}>
              <DailyChart days={data.days} today={data.today} />
              <Flow data={data} />
            </RecapTile>
            <RecapTile title="Highlights" icon={Award} lg={4}>
              <Highlights rows={data.highlights} />
            </RecapTile>
            {data.stats.activeMinutes ? (
              <>
                <WhenYouWorked data={data} />
                <RecapTile title="Where time went" icon={PieChart} md={6} lg={5} right={<InfoTip label="About active time" text={ACTIVE_NOTE} />}>
                  <SurfaceDonut surfaces={data.surfaces} />
                </RecapTile>
              </>
            ) : (
              <section className="recap-tile recap-quiet-time" aria-labelledby="recap-no-time">
                <header className="recap-tile-head">
                  <Clock3 size={14} strokeWidth={2.1} aria-hidden />
                  <h2 id="recap-no-time">When you worked</h2>
                </header>
                <p>
                  {data.current
                    ? "Fills in as you use Ensemble: when you were active, and where the time went."
                    : "No active time was recorded in Ensemble that week."}
                </p>
                <InfoTip label="About active time" text={ACTIVE_NOTE} />
              </section>
            )}
            <RecapTile title="Projects moved" icon={FolderKanban} md={6} lg={6} meta={data.projects.length ? plural(data.projects.length, "project") : undefined}>
              <Projects rows={data.projects} />
            </RecapTile>
            <RecapTile title="Agent work" icon={Bot} md={6} lg={6} right={<Link href="/runs" className="recap-link">Runs</Link>}>
              <AgentWork data={data} />
            </RecapTile>
          </>
        )}
        {showAhead ? (
          <RecapTile title={data.current ? "Looking ahead" : "What this week left open"} icon={data.current ? CalendarClock : Flag}>
            <Ahead data={data} />
          </RecapTile>
        ) : null}
        {data.done.length || data.decided.length || data.meetings.length ? (
          <RecapTile title="The week, item by item" icon={ListChecks}>
            <Record data={data} />
          </RecapTile>
        ) : null}
      </div>
    </div>
  );
}

function Quiet({ data }: { data: WeeklyRecap }) {
  return (
    <section className="recap-tile recap-quiet" aria-labelledby="recap-quiet-title">
      <span className="recap-quiet-mark" aria-hidden><Sprout size={20} /></span>
      <div className="min-w-0">
        <h2 id="recap-quiet-title">A quiet week</h2>
        <p>
          {data.current
            ? "Nothing has been finished or recorded yet. Pick one task to move forward today, and this page fills in as you go."
            : "Nothing was finished or recorded that week."}
        </p>
      </div>
      {data.current ? (
        <Link href="/board" className="btn">Open the board</Link>
      ) : (
        <Link href="/recap" className="btn">Go to this week</Link>
      )}
    </section>
  );
}

/* ── KPI row ─────────────────────────────────────────────────────────── */

/** A change against last week. `neutral`: more is not better or worse (tasks added, screen time). */
function Delta({ now, before, against, format = (value: number) => String(value), less = "fewer", neutral = false }: { now: number; before: number; against: string; format?: (value: number) => string; less?: string; neutral?: boolean }) {
  if (now === before) {
    return now ? <><span className="recap-delta" data-tone="flat" aria-hidden>=</span><span>same as {against}</span></> : <span>none either week</span>;
  }
  const up = now > before;
  const diff = format(Math.abs(now - before));
  return (
    <>
      <span className="recap-delta" data-tone={neutral ? "flat" : up ? "up" : "down"}>
        <span aria-hidden>{up ? "▲" : "▼"}</span>
        {diff}
      </span>
      <span><span className="sr-only">{up ? "more" : less} than</span><span aria-hidden>vs</span> {against}</span>
    </>
  );
}

function Kpi({ icon: Icon, label, value, delta, sub, zero }: { icon: LucideIcon; label: string; value: ReactNode; delta: ReactNode; sub: ReactNode; zero: boolean }) {
  return (
    <section className="recap-tile recap-kpi" aria-label={label} data-zero={zero ? "" : undefined}>
      <div className="recap-kpi-label">
        <Icon size={13} aria-hidden />
        <span>{label}</span>
      </div>
      <span className="recap-num">{value}</span>
      <div className="recap-kpi-delta">{delta}</div>
      <div className="recap-kpi-sub">{sub}</div>
    </section>
  );
}

function ActiveValue({ minutes }: { minutes: number }) {
  if (minutes < 60) return <>{minutes}<small>m</small></>;
  return <>{Math.floor(minutes / 60)}<small>h</small>{minutes % 60 ? <>{minutes % 60}<small>m</small></> : null}</>;
}

function Kpis({ data }: { data: WeeklyRecap }) {
  const s = data.stats;
  const p = data.previous;
  const against = data.compare === "to_date" ? "last week" : "the week before";
  const delta = (key: keyof RecapStats, format?: (value: number) => string) => (
    <Delta now={s[key]} before={p[key]} against={against} format={format} less={format ? "less" : "fewer"} neutral={key === "created" || key === "activeMinutes"} />
  );
  const net = s.completed - s.created;
  const activeDays = data.days.filter((day) => day.activeMinutes > 0).length;
  return (
    <div className="recap-kpis">
      <Kpi icon={CircleCheck} label="Tasks done" zero={!s.completed} value={s.completed} delta={delta("completed")}
        sub={s.completed ? `${s.completed - s.completedByAgents} by you · ${s.completedByAgents} by agents` : "None finished yet"} />
      <Kpi icon={ListPlus} label="Tasks added" zero={!s.created} value={s.created} delta={delta("created")}
        sub={net > 0 ? `Open work down by ${net}` : net < 0 ? `Open work up by ${-net}` : s.created ? "As many done as added" : "Nothing new"} />
      <Kpi icon={Bot} label="Agent runs" zero={!s.agentRuns} value={s.agentRuns} delta={delta("agentRuns")}
        sub={s.agentRuns ? `${s.agentSucceeded} succeeded${data.agents.failed ? ` · ${data.agents.failed} failed` : ""}` : "No runs"} />
      <Kpi icon={Clock3} label="Active in Ensemble" zero={!s.activeMinutes} value={<ActiveValue minutes={s.activeMinutes} />} delta={delta("activeMinutes", shortDuration)}
        sub={<>{activeDays ? `${plural(activeDays, "day")}, ~${shortDuration(s.activeMinutes / activeDays)} each` : "No screen time yet"}<InfoTip label="About active time" text={ACTIVE_NOTE} /></>} />
      <Kpi icon={Scale} label="Decisions" zero={!s.decisions} value={s.decisions} delta={delta("decisions")}
        sub={s.meetings ? `${plural(s.meetings, "meeting")} with notes` : "Meetings and Needs me"} />
      <Kpi icon={FileText} label="Pages edited" zero={!s.pagesEdited} value={s.pagesEdited} delta={delta("pagesEdited")} sub="Pages and task notes" />
    </div>
  );
}

/* ── Tiles that need the whole recap ─────────────────────────────────── */

function DailyLegend() {
  return (
    <span className="recap-legend" aria-hidden>
      <span><i style={{ ["--swatch" as string]: "var(--recap-you)" }} />You</span>
      <span><i style={{ ["--swatch" as string]: "var(--recap-agents)" }} />Agents</span>
      <span><i data-ghost="" />Added</span>
    </span>
  );
}

function Flow({ data }: { data: WeeklyRecap }) {
  const best = [...data.days].sort((a, b) => b.completedByYou + b.completedByAgents - (a.completedByYou + a.completedByAgents))[0];
  const bestDone = best ? best.completedByYou + best.completedByAgents : 0;
  return (
    <div className="recap-tile-foot recap-flow">
      <span><b>{data.stats.completed}</b> finished</span>
      <span><b>{data.stats.created}</b> added</span>
      {bestDone > 0 && best ? <span>Busiest: <b>{weekdayLong(best.date)}</b>, {plural(bestDone, "task")}</span> : null}
    </div>
  );
}

function WhenYouWorked({ data }: { data: WeeklyRecap }) {
  const total = data.stats.activeMinutes;
  const peak = peakWindow(data.rhythm);
  const topDay = [...data.days].sort((a, b) => b.activeMinutes - a.activeMinutes)[0];
  const summary = total
    ? `${duration(total)} active in Ensemble.${peak ? ` Most active ${hourLabel(peak.from)} to ${hourLabel(peak.to)}.` : ""}${topDay?.activeMinutes ? ` Longest day: ${weekdayLong(topDay.date)}, ${duration(topDay.activeMinutes)}.` : ""}`
    : "No active time recorded this week.";
  return (
    <RecapTile title="When you worked" icon={Clock3} md={6} lg={7} meta={total ? duration(total) : undefined} right={<InfoTip label="About active time" text={ACTIVE_NOTE} />}>
      <HeatStrip rhythm={data.rhythm} days={data.days} summary={summary} />
      <div className="recap-tile-foot recap-heat-foot">
        {total ? (
          <div className="recap-chips">
            {peak ? <span className="recap-chip">Peak hours <b>{hourLabel(peak.from)}–{hourLabel(peak.to)}</b></span> : null}
            {topDay?.activeMinutes ? <span className="recap-chip">Longest day <b>{weekdayLong(topDay.date)}</b></span> : null}
            <span className="recap-chip">Active days <b>{data.days.filter((day) => day.activeMinutes > 0).length}</b></span>
          </div>
        ) : (
          <span>Active time fills in as you use Ensemble. It counts screen time, not hours worked.</span>
        )}
        <HeatScale />
      </div>
    </RecapTile>
  );
}

function AgentWork({ data }: { data: WeeklyRecap }) {
  const { agents, stats } = data;
  if (!agents.runs) {
    return (
      <p className="recap-empty-line">
        No agent runs this week. Assign a task to an agent from its page and its runs show up here. <Link href="/board">Open the board</Link>
      </p>
    );
  }
  return (
    <div className="recap-agents">
      <SuccessRing succeeded={agents.succeeded} runs={agents.runs} />
      <div className="recap-agent-facts">
        <div className="recap-agent-counts">
          <span><b>{agents.runs}</b>{agents.runs === 1 ? "run" : "runs"}</span>
          <span><b>{agents.succeeded}</b>succeeded</span>
          {agents.failed ? <span><b>{agents.failed}</b>failed</span> : null}
          <span><b>{stats.completedByAgents}</b>{stats.completedByAgents === 1 ? "task finished" : "tasks finished"}</span>
        </div>
        <AgentBars rows={agents.byAgent} />
      </div>
    </div>
  );
}

/* ── Loading ─────────────────────────────────────────────────────────── */

function HeaderSkeleton() {
  return (
    <div className="recap-head" aria-hidden>
      <div className="min-w-0 space-y-3">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-9 w-80 max-w-full" />
      </div>
      <Skeleton className="h-8 w-56" />
      <div className="col-span-full space-y-2">
        <Skeleton className="h-5 w-[min(48rem,100%)]" />
        <Skeleton className="h-5 w-[min(30rem,80%)]" index={1} />
      </div>
    </div>
  );
}

function BodySkeleton() {
  return (
    <div className="mt-6 space-y-3" role="status" aria-label="Loading the week">
      <div className="recap-kpis">
        {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} index={index} className="h-[118px] rounded-tile" />)}
      </div>
      <div className="recap-grid">
        <div data-lg="8"><Skeleton className="h-[290px] w-full rounded-tile" /></div>
        <div data-lg="4"><Skeleton className="h-[290px] w-full rounded-tile" index={1} /></div>
        <div data-md="6" data-lg="7"><Skeleton className="h-[230px] w-full rounded-tile" index={2} /></div>
        <div data-md="6" data-lg="5"><Skeleton className="h-[230px] w-full rounded-tile" index={3} /></div>
      </div>
    </div>
  );
}
