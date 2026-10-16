import { safeDate } from "@/lib/safe-date";

const TIME = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });
const WEEKDAY = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short" });
const DATED = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });

function dayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** When a meeting started, with its time: "Today, 2:30 pm", "Yesterday, 9:05 am", "Mon, 13 Oct, 4:00 pm", "3 Sept 2025, 11:00 am". */
export function meetingWhen(value: string | Date | null | undefined, now = new Date()): string {
  const date = safeDate(value);
  if (!date) return "—";
  const time = TIME.format(date);
  const days = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAY.format(date)}, ${time}`;
  return `${date.getFullYear() === now.getFullYear() ? DAY.format(date) : DATED.format(date)}, ${time}`;
}

/** New notes are told apart by when they started: "Meeting notes · 16 Oct, 2:30 pm". */
export function newMeetingTitle(at = new Date()): string {
  return `Meeting notes · ${DAY.format(at)}, ${TIME.format(at)}`;
}

/** Newest first, by when each meeting started. */
export function newestFirst<T extends { startedAt: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (safeDate(b.startedAt)?.getTime() ?? 0) - (safeDate(a.startedAt)?.getTime() ?? 0));
}
