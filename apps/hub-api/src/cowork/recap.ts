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
