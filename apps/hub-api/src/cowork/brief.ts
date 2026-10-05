/** Plain-language morning brief from the existing today briefing. In-app text only. */

export interface BriefSlice {
  date: string;
  timezone?: string;
  focus: Array<{ title: string }>;
  proposed: Array<{ title: string }>;
  deliverables: Array<{ title: string; due?: string | null; project?: string }>;
  meetings: Array<{ title: string; start?: string | null }>;
  needsMe: { pendingApprovals: number; pendingEditorDecisions: number };
}

function line(items: string[], empty: string): string {
  if (!items.length) return empty;
  return items.map((item) => `• ${item}`).join("\n");
}

function when(iso: string | null | undefined, timezone: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(date);
  } catch {
    return "";
  }
}

export function formatMorningBrief(brief: BriefSlice): { title: string; body: string } {
  const zone = brief.timezone || "UTC";
  const pretty = (() => {
    const date = new Date(`${brief.date}T12:00:00Z`);
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(date);
    } catch {
      return brief.date;
    }
  })();
  const meetings = brief.meetings.slice(0, 6).map((meeting) => {
    const clock = when(meeting.start, zone);
    return clock ? `${clock} ${meeting.title}` : meeting.title;
  });
  const deliverables = brief.deliverables.slice(0, 6).map((row) => {
    const due = row.due ? row.due.slice(0, 10) : "";
    const project = row.project ? `${row.project}: ` : "";
    return due ? `${project}${row.title} (due ${due})` : `${project}${row.title}`;
  });
  const waiting = brief.needsMe.pendingApprovals + brief.needsMe.pendingEditorDecisions;
  const body = [
    "Good morning. Here is your day.",
    "",
    "Focus",
    line(brief.focus.slice(0, 8).map((row) => row.title), "Nothing pinned for today."),
    "",
    "Waiting on you",
    line(brief.proposed.slice(0, 8).map((row) => row.title), "No new proposals."),
    "",
    "Meetings",
    line(meetings, "No meetings on the calendar."),
    "",
    "Coming up",
    line(deliverables, "No deliverables due soon."),
    "",
    waiting === 0 ? "Nothing is waiting on a decision from you." : `Needs you: ${waiting} item${waiting === 1 ? "" : "s"}.`,
  ].join("\n");
  return { title: `Morning brief · ${pretty}`, body };
}
