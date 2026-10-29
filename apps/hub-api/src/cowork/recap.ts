/** Weekly recap text. Meeting rows are rolled-up summaries, not the raw notes. */

export interface RecapLink {
  title: string;
  href: string;
  detail?: string;
}

export interface RecapMeeting {
  title: string;
  when: string;
  summary: string;
  href: string;
}

export interface WeeklyRecapInput {
  label: string;
  done: RecapLink[];
  decided: RecapLink[];
  slipped: RecapLink[];
  meetings: RecapMeeting[];
  /** Narrative, numbers, highlights and what is coming up. Omitted: only the lists. */
  summary?: RecapSummary;
}

const OPEN = new Set(["proposed", "todo", "in_progress", "waiting_approval", "blocked"]);

/** "30 Sept", or "30 Sept 2025" when the day is not in the year of `today`. */
function dueLabel(day: string, today: string): string {
  const label = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
  return day.slice(0, 4) === today.slice(0, 4) ? label : `${label} ${day.slice(0, 4)}`;
}

/**
 * Every open task that is past due as of `cutoff` (YYYY-MM-DD, exclusive), oldest first. For the
 * current week the cutoff is today; for a past week it is the end of that week. Earlier weeks'
 * misses still count: a task due last month and still open has slipped.
 */
export function slippedLinks(
  tasks: Array<{ id: string; title: string; status: string; due: Date | null }>,
  cutoff: string,
  today: string,
): RecapLink[] {
  return tasks
    .filter((task) => task.due && OPEN.has(task.status) && task.due.toISOString().slice(0, 10) < cutoff)
    .sort((a, b) => a.due!.getTime() - b.due!.getTime())
    .map((task) => ({ title: task.title, href: `/tasks/${task.id}`, detail: dueLabel(task.due!.toISOString().slice(0, 10), today) }));
}

function section(title: string, rows: string[], empty: string): string {
  if (!rows.length) return `## ${title}\n\n${empty}`;
  return `## ${title}\n\n${rows.map((row) => `- ${row}`).join("\n")}`;
}

export function renderWeeklyRecap(input: WeeklyRecapInput): string {
  const done = input.done.map((row) => (row.detail ? `${row.title} (${row.detail})` : row.title));
  const decided = input.decided.map((row) => row.title);
  const slipped = input.slipped.map((row) => (row.detail ? `${row.title} — due ${row.detail}` : row.title));
  const meetings = input.meetings.map((row) => {
    const summary = row.summary.replace(/\s+/g, " ").trim();
    return summary ? `${row.title} (${row.when}): ${summary}` : `${row.title} (${row.when})`;
  });
  return [
    `# Week of ${input.label}`,
    "",
    ...(input.summary ? [renderSummary(input.summary), ""] : []),
    section("Done", done, "Nothing was marked done."),
    "",
    section("Decided", decided, "No decisions were recorded."),
    "",
    section("Slipped", slipped, "Nothing past due is still open."),
    "",
    section("Meetings", meetings, "No meeting recaps this week."),
    "",
  ].join("\n");
}

export function clipSummary(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/* ── The week in numbers ─────────────────────────────────────────────────
 * Pure: the service passes rows it already scoped to one space (and, for screen
 * time, to the signed-in account). Days and hours are in the person's time zone.
 */

export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const HIGH_PRIORITY = new Set(["critical", "p0"]);
const ENGINES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", "cursor-agent": "Cursor", "copilot-cli": "GitHub Copilot" };

export interface RecapStats {
  completed: number;
  completedByAgents: number;
  created: number;
  agentRuns: number;
  agentSucceeded: number;
  /** Active screen time in Ensemble (interaction_events views), whole minutes. */
  activeMinutes: number;
  meetings: number;
  decisions: number;
  pagesEdited: number;
}

export interface RecapDay {
  date: string;
  completedByYou: number;
  completedByAgents: number;
  created: number;
  activeMinutes: number;
  /** After today: nothing can have happened yet. */
  future: boolean;
}

export interface RecapHighlight {
  kind: "deliverable" | "project_done" | "priority" | "best_day" | "project_push" | "streak" | "first_run" | "clear" | "agents" | "decisions";
  title: string;
  detail: string;
  href?: string;
}

export interface RecapProject {
  id: string;
  name: string;
  href: string;
  completed: number;
  created: number;
  open: number;
}

export interface RecapAgents {
  runs: number;
  succeeded: number;
  failed: number;
  byAgent: Array<{ name: string; runs: number; succeeded: number }>;
}

export interface CompletedFact {
  id: string;
  title: string;
  priority: string;
  projectId: string | null;
  at: Date;
  byAgent: boolean;
}

export interface ViewFact {
  at: Date;
  durationMs: number;
  surface: string;
}

export interface RunFact {
  at: Date;
  outcome: string | null;
  worker: string;
  provider: string | null;
}

/** Wall-clock date, hour and minute in `timeZone`, with one reusable formatter. */
export function zonedClock(timeZone: string): (at: Date) => { date: string; hour: number; minute: number; second: number } {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return (at) => {
    const parts = format.formatToParts(at);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
    return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24, minute: Number(get("minute")), second: Number(get("second")) };
  };
}

/** The seven calendar days of a Monday-start week. */
export function weekDates(start: string): string[] {
  const [year, month, day] = start.split("-").map(Number);
  return Array.from({ length: 7 }, (_, index) => new Date(Date.UTC(year!, month! - 1, day! + index)).toISOString().slice(0, 10));
}

export function agentName(provider: string | null | undefined, worker: string): string {
  if (provider && ENGINES[provider]) return ENGINES[provider]!;
  return worker === "workspace" || worker === "research" ? "Ensemble agent" : worker;
}

/** "45 min", "2 h", "6 h 20 min". */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const weekdayOf = (date: string) => WEEKDAY_NAMES[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7]!;

/**
 * Days, hour-by-weekday screen time and screen time per surface for one week. A view counts
 * from its start for its active duration, split at local hour boundaries.
 */
export function weekShape(input: {
  start: string;
  today: string;
  timeZone: string;
  completed: CompletedFact[];
  created: Date[];
  views: ViewFact[];
}): { days: RecapDay[]; rhythm: number[][]; surfaces: Array<{ surface: string; minutes: number }> } {
  const clock = zonedClock(input.timeZone);
  const dates = weekDates(input.start);
  const index = new Map(dates.map((date, i) => [date, i]));
  const days = dates.map((date) => ({ date, completedByYou: 0, completedByAgents: 0, created: 0, activeMs: 0, future: date > input.today }));
  const hours = dates.map(() => Array.from({ length: 24 }, () => 0));
  const surfaces = new Map<string, number>();
  for (const task of input.completed) {
    const day = days[index.get(clock(task.at).date) ?? -1];
    if (!day) continue;
    if (task.byAgent) day.completedByAgents += 1;
    else day.completedByYou += 1;
  }
  for (const at of input.created) {
    const day = days[index.get(clock(at).date) ?? -1];
    if (day) day.created += 1;
  }
  for (const view of input.views) {
    let cursor = view.at.getTime();
    let left = Math.max(0, view.durationMs);
    for (let guard = 0; left > 0 && guard < 48; guard++) {
      const local = clock(new Date(cursor));
      const toHour = (60 - local.minute) * 60_000 - local.second * 1000 - (cursor % 1000);
      const chunk = Math.min(left, Math.max(1000, toHour));
      const i = index.get(local.date);
      if (i !== undefined) {
        days[i]!.activeMs += chunk;
        hours[i]![local.hour]! += chunk;
        surfaces.set(view.surface, (surfaces.get(view.surface) ?? 0) + chunk);
      }
      cursor += chunk;
      left -= chunk;
    }
  }
  const ranked = [...surfaces.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 5).map(([surface, ms]) => ({ surface, minutes: Math.round(ms / 60_000) }));
  const other = Math.round(ranked.slice(5).reduce((sum, [, ms]) => sum + ms, 0) / 60_000);
  return {
    days: days.map(({ activeMs, ...day }) => ({ ...day, activeMinutes: Math.round(activeMs / 60_000) })),
    rhythm: hours.map((row) => row.map((ms) => Math.round(ms / 60_000))),
    surfaces: [...top.filter((row) => row.minutes > 0), ...(other > 0 ? [{ surface: "other", minutes: other }] : [])],
  };
}

export function agentSummary(runs: RunFact[]): RecapAgents {
  const byAgent = new Map<string, { runs: number; succeeded: number }>();
  for (const run of runs) {
    const name = agentName(run.provider, run.worker);
    const row = byAgent.get(name) ?? { runs: 0, succeeded: 0 };
    row.runs += 1;
    if (run.outcome === "success") row.succeeded += 1;
    byAgent.set(name, row);
  }
  return {
    runs: runs.length,
    succeeded: runs.filter((run) => run.outcome === "success").length,
    failed: runs.filter((run) => run.outcome === "failed").length,
    byAgent: [...byAgent.entries()].map(([name, row]) => ({ name, ...row })).sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name)).slice(0, 5),
  };
}

/** The day with the most tasks done; with none done, the most screen time. Earliest wins a tie. */
export function busiestDay(days: RecapDay[]): { date: string; completed: number; activeMinutes: number; by: "completed" | "active" } | null {
  let best: RecapDay | null = null;
  const done = (day: RecapDay) => day.completedByYou + day.completedByAgents;
  for (const day of days) if (done(day) > 0 && (!best || done(day) > done(best))) best = day;
  if (best) return { date: best.date, completed: done(best), activeMinutes: best.activeMinutes, by: "completed" };
  for (const day of days) if (day.activeMinutes > 0 && (!best || day.activeMinutes > best.activeMinutes)) best = day;
  return best ? { date: best.date, completed: 0, activeMinutes: best.activeMinutes, by: "active" } : null;
}

function comparison(now: number, before: number, against: string): string {
  if (now === before) return before ? `the same as ${against}` : "";
  if (!before) return `up from none ${against}`;
  return now > before ? `${now - before} more than ${against}` : `${before - now} fewer than ${against}`;
}

/** One or two plain sentences about the week. No model call. */
export function recapNarrative(input: { stats: RecapStats; previous: RecapStats; days: RecapDay[]; current: boolean }): string {
  const { stats, previous, current } = input;
  const against = current ? "this time last week" : "the week before";
  const quiet = !stats.completed && !stats.created && !stats.agentRuns && !stats.activeMinutes && !stats.meetings && !stats.decisions && !stats.pagesEdited;
  if (quiet) return current ? "A quiet week so far: nothing has been finished or recorded yet." : "A quiet week: nothing was finished or recorded.";
  const sentences: string[] = [];
  if (stats.completed) {
    const delta = comparison(stats.completed, previous.completed, against);
    const who = stats.completedByAgents ? "You and your agents" : "You";
    const agents = stats.completedByAgents ? `; agents handled ${stats.completedByAgents} of them` : "";
    sentences.push(`${current ? `${who} have finished` : `${who} finished`} ${plural(stats.completed, "task")}${delta ? `, ${delta}` : ""}${agents}.`);
  } else if (stats.created) {
    sentences.push(`No tasks ${current ? "finished yet" : "were finished"}, and ${plural(stats.created, "new task was", "new tasks were")} added.`);
  }
  if (stats.agentRuns && !stats.completedByAgents) {
    sentences.push(`Agents ran ${plural(stats.agentRuns, "time")} for you${stats.agentSucceeded ? `, ${stats.agentSucceeded} successfully` : ""}.`);
  }
  const best = busiestDay(input.days);
  if (best?.by === "completed" && stats.completed > 1) sentences.push(`${weekdayOf(best.date)} was your busiest day.`);
  else if (best?.by === "active" && best.activeMinutes >= 5) sentences.push(`You were most active on ${weekdayOf(best.date)}.`);
  if (!sentences.length && stats.activeMinutes) sentences.push(`You spent ${formatMinutes(stats.activeMinutes)} active in Ensemble.`);
  if (!sentences.length && stats.meetings) sentences.push(`${plural(stats.meetings, "meeting")} with notes.`);
  if (!sentences.length) sentences.push(`${plural(stats.decisions + stats.pagesEdited, "thing")} recorded this week.`);
  return sentences.join(" ");
}

/** Up to six small achievements, most notable first. Deterministic: same rows, same list. */
export function recapHighlights(input: {
  days: RecapDay[];
  stats: RecapStats;
  completed: CompletedFact[];
  deliverables: Array<{ title: string; href: string }>;
  projectsDone: Array<{ name: string; href: string }>;
  projects: RecapProject[];
  firstRun: boolean;
  current: boolean;
  waiting: number;
  decided: number;
}): RecapHighlight[] {
  const rows: RecapHighlight[] = [];
  for (const row of input.deliverables.slice(0, 2)) rows.push({ kind: "deliverable", title: `Delivered “${row.title}”`, detail: "Deliverable completed", href: row.href });
  for (const row of input.projectsDone.slice(0, 2)) rows.push({ kind: "project_done", title: `Completed ${row.name}`, detail: "Project marked complete", href: row.href });
  const urgent = input.completed.filter((task) => HIGH_PRIORITY.has(task.priority)).sort((a, b) => a.at.getTime() - b.at.getTime());
  if (urgent.length) {
    const first = urgent[0]!;
    rows.push({
      kind: "priority",
      title: `${plural(urgent.length, "high-priority task")} done`,
      detail: urgent.length > 1 ? `“${first.title}” and ${urgent.length - 1} more` : `“${first.title}”`,
      href: `/tasks/${first.id}`,
    });
  }
  const best = busiestDay(input.days);
  if (best?.by === "completed" && best.completed >= 2) {
    rows.push({ kind: "best_day", title: `${weekdayOf(best.date)} was your best day`, detail: `${plural(best.completed, "task")} done` });
  } else if (best?.by === "active" && best.activeMinutes >= 15) {
    rows.push({ kind: "best_day", title: `Most focused on ${weekdayOf(best.date)}`, detail: `${formatMinutes(best.activeMinutes)} active in Ensemble` });
  }
  const push = input.projects.find((project) => project.completed >= 3);
  if (push) rows.push({ kind: "project_push", title: `Most progress on ${push.name}`, detail: `${plural(push.completed, "task")} done`, href: push.href });
  const elapsed = input.days.filter((day) => !day.future);
  const active = elapsed.filter((day) => day.completedByYou + day.completedByAgents + day.created > 0 || day.activeMinutes >= 5).length;
  if (active >= 3) {
    rows.push({ kind: "streak", title: `Active ${active} of ${elapsed.length} days`, detail: active === elapsed.length ? (input.current ? "Every day so far" : "Every day of the week") : "A steady week" });
  }
  if (input.firstRun) rows.push({ kind: "first_run", title: "Your first agent run", detail: "An agent took on a task for you", href: "/runs" });
  if (input.current && input.waiting === 0 && (input.decided > 0 || input.stats.agentRuns > 0)) {
    rows.push({ kind: "clear", title: "Needs me is clear", detail: "Nothing is waiting on you", href: "/needs-me" });
  }
  if (input.stats.agentRuns >= 3 && input.stats.agentSucceeded / input.stats.agentRuns >= 0.8) {
    rows.push({ kind: "agents", title: `Agents finished ${input.stats.agentSucceeded} of ${input.stats.agentRuns} runs`, detail: "Successful runs this week", href: "/runs" });
  }
  if (input.decided >= 3) rows.push({ kind: "decisions", title: `${plural(input.decided, "decision")} made`, detail: "From meetings and Needs me" });
  return rows.slice(0, 6);
}

export interface RecapSummary {
  narrative: string;
  stats: RecapStats;
  previous: RecapStats;
  current: boolean;
  highlights: RecapHighlight[];
  dueSoon: Array<{ title: string; href: string; due: string; detail?: string }>;
}

function deltaWords(now: number, before: number, against: string): string {
  const words = comparison(now, before, against);
  return words ? ` (${words})` : "";
}

/** The "At a glance" block of the Markdown export. */
export function renderSummary(summary: RecapSummary): string {
  const { stats, previous } = summary;
  const against = summary.current ? "this time last week" : "the week before";
  const split = stats.completed ? ` (${stats.completed - stats.completedByAgents} by you, ${stats.completedByAgents} by agents)` : "";
  const lines = [
    `- Done: ${plural(stats.completed, "task")}${split}${deltaWords(stats.completed, previous.completed, against)}`,
    `- Created: ${plural(stats.created, "task")}`,
    `- Agent runs: ${stats.agentRuns}${stats.agentRuns ? ` (${stats.agentSucceeded} succeeded)` : ""}`,
    `- Active in Ensemble: ${formatMinutes(stats.activeMinutes)}`,
    `- Meetings: ${stats.meetings} · Decisions: ${stats.decisions} · Pages edited: ${stats.pagesEdited}`,
  ];
  const parts = [summary.narrative, "", "## At a glance", "", ...lines];
  if (summary.highlights.length) parts.push("", "## Highlights", "", ...summary.highlights.map((row) => `- ${row.title}: ${row.detail}`));
  if (summary.dueSoon.length) parts.push("", "## Coming up", "", ...summary.dueSoon.map((row) => `- ${row.title} — due ${dueLabel(row.due, row.due)}${row.detail ? ` (${row.detail})` : ""}`));
  return parts.join("\n");
}
