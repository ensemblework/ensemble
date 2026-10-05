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
