/** Formatting for the weekly recap (components/recap). Dates are calendar days (YYYY-MM-DD). */

const noon = (day: string) => new Date(`${day.slice(0, 10)}T12:00:00Z`);

export function addDays(day: string, days: number): string {
  const date = noon(day);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export const weekdayShort = (day: string) => noon(day).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
export const weekdayLong = (day: string) => noon(day).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
export const dayMonth = (day: string) => noon(day).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export const dayLabel = (day: string) => `${weekdayShort(day)} ${dayMonth(day)}`;

/** "45 min", "2 h", "6 h 20 min". */
export function duration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** "50m", "8h", "8h 50m". */
export function shortDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total}m`;
  return total % 60 ? `${Math.floor(total / 60)}h ${total % 60}m` : `${Math.floor(total / 60)}h`;
}

/** "6 am", "12 pm". */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const suffix = h < 12 ? "am" : "pm";
  return `${h % 12 === 0 ? 12 : h % 12} ${suffix}`;
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;

const SURFACES: Record<string, string> = {
  home: "Home",
  today: "Today",
  brief: "Brief and recap",
  onboarding: "Getting started",
  board: "Board",
  tasks: "Tasks",
  "needs-me": "Needs me",
  projects: "Projects",
  pages: "Pages",
  meetings: "Meeting notes",
  files: "Files",
  plots: "Plots",
  diagrams: "Diagrams",
  context: "Context",
  connections: "Connections",
  code: "Code",
  workspace: "Workspace",
  runs: "Runs",
  skills: "Skills",
  metrics: "Metrics",
  marketplace: "Marketplace",
  settings: "Settings",
  spaces: "Spaces",
  sharing: "Sharing",
  trash: "Trash",
  other: "Other",
};

export const surfaceLabel = (surface: string) => SURFACES[surface] ?? surface.charAt(0).toUpperCase() + surface.slice(1).replace(/-/g, " ");

/** The consecutive hours with the most screen time across the week, or null. */
export function peakWindow(rhythm: number[][], span = 3): { from: number; to: number; minutes: number } | null {
  const byHour = Array.from({ length: 24 }, (_, hour) => rhythm.reduce((sum, row) => sum + (row[hour] ?? 0), 0));
  let best: { from: number; to: number; minutes: number } | null = null;
  for (let from = 0; from + span <= 24; from++) {
    const minutes = byHour.slice(from, from + span).reduce((a, b) => a + b, 0);
    if (minutes > 0 && (!best || minutes > best.minutes)) best = { from, to: from + span, minutes };
  }
  return best;
}
