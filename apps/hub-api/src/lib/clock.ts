/** Timezone helpers. "Today" and reminder instants follow the user's zone, not the server. */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

export function isHmTime(value: string): boolean {
  return TIME_RE.test(value);
}

export function zonedParts(timeZone: string, at = new Date()): { date: string; time: string; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${hour}:${get("minute")}`,
    weekday: get("weekday"),
  };
}

/** Minutes to add to a UTC instant to get the wall clock in `timeZone`. */
export function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Wall-clock date and time in `timeZone` as a UTC instant. */
export function zonedDateTimeToUtc(date: string, time: string, timeZone: string): Date {
  if (!isIsoDate(date)) throw new Error("dueDate must be YYYY-MM-DD.");
  if (!isHmTime(time)) throw new Error("dueTime must be HH:MM.");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const guess = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, 0));
  const offset = zoneOffsetMinutes(timeZone, guess);
  const instant = new Date(guess.getTime() - offset * 60_000);
  const corrected = zoneOffsetMinutes(timeZone, instant);
  if (corrected !== offset) return new Date(guess.getTime() - corrected * 60_000);
  return instant;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function addIsoDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year!, month! - 1, day!));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

/**
 * Monday–Sunday of the week that contains `date`.
 * The week starts on Monday (the same convention as cowork week bounds).
 * Saturday and Sunday stay in that week, so "this week" includes today.
 */
export function workWeekLine(date: string, weekday: string): string {
  if (!isIsoDate(date)) return `Today is ${weekday}, ${date}.`;
  const index = WEEKDAYS.findIndex((name) => name.toLowerCase() === weekday.toLowerCase());
  if (index < 0) return `Today is ${weekday}, ${date}.`;
  const [year, month, day] = date.split("-").map(Number);
  const anchor = new Date(Date.UTC(year!, month! - 1, day!));
  const mondayOffset = index === 0 ? -6 : 1 - index;
  const days = [0, 1, 2, 3, 4, 5, 6].map((offset) => {
    const next = new Date(anchor);
    next.setUTCDate(anchor.getUTCDate() + mondayOffset + offset);
    const iso = next.toISOString().slice(0, 10);
    const name = WEEKDAYS[next.getUTCDay()] ?? "Day";
    const today = name.toLowerCase() === weekday.toLowerCase() && iso === date;
    return `${name} ${iso}${today ? " (today)" : ""}`;
  });
  return `Today is ${weekday}, ${date}. This week is ${days.join(", ")}. Do not call today any other weekday.`;
}

/** The next midnight in America/Los_Angeles. Daily Gemini quotas reset then. */
export function nextPacificMidnight(at = new Date()): Date {
  const { date } = zonedParts("America/Los_Angeles", at);
  return zonedDateTimeToUtc(addIsoDays(date, 1), "00:00", "America/Los_Angeles");
}

export function nextNotificationAt(dueDate: string, dueTime: string | null | undefined, timeZone: string): Date {
  return zonedDateTimeToUtc(dueDate, dueTime && isHmTime(dueTime) ? dueTime : "09:00", timeZone);
}

/** A due value from a model: YYYY-MM-DD or a real ISO datetime. */
export function parseDue(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const leading = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (leading && !isIsoDate(leading[1]!)) {
    throw Object.assign(new Error("due must be a real YYYY-MM-DD date."), { statusCode: 400 });
  }
  if (leading && value === leading[1]) return new Date(`${value}T00:00:00.000Z`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw Object.assign(new Error("due must be YYYY-MM-DD or an ISO datetime."), { statusCode: 400 });
  }
  return date;
}

export function safeDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}

/** True when the last successful retention cursor is an earlier local date. */
export function retentionCatchUp(lastCursorDate: string | null, today: string): boolean {
  if (!lastCursorDate) return true;
  return lastCursorDate < today;
}

/**
 * Daily slot, plus catch-up. A missed local day runs even before the slot.
 * The first-ever run (no cursor) waits until the slot so a boot at noon
 * does not look like a missed night.
 */
export function retentionDue(
  lastCursorDate: string | null,
  now: { date: string; time: string },
  slot = "03:30",
): boolean {
  const missedDay = lastCursorDate !== null && lastCursorDate < now.date;
  return missedDay || (now.time >= slot && retentionCatchUp(lastCursorDate, now.date));
}
