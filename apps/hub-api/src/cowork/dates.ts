const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/** A real calendar day, or null when the month does not contain that day. */
export function calendarDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1970 || year > 2199 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return utc.toISOString().slice(0, 10);
}

export function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year!, month! - 1, day!));
  if (Number.isNaN(utc.getTime()) || !Number.isFinite(days)) return date;
  utc.setUTCDate(utc.getUTCDate() + days);
  if (Number.isNaN(utc.getTime())) return date;
  return utc.toISOString().slice(0, 10);
}

export function weekdayIndex(weekday: string): number {
  return WEEKDAYS.indexOf(weekday.toLowerCase() as (typeof WEEKDAYS)[number]);
}

/** "30 Sept", en-IN, from a YYYY-MM-DD calendar day. */
export function calendarLabel(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso;
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso.slice(0, 10)}T12:00:00Z`));
}

/** Monday-start week containing `date`. `end` is the next Monday (exclusive). */
export function weekBounds(date: string, weekday: string): { start: string; end: string; label: string } {
  const index = weekdayIndex(weekday);
  const mondayOffset = index <= 0 ? (index === 0 ? -6 : 0) : 1 - index;
  const start = addCalendarDays(date, index < 0 ? 0 : mondayOffset);
  const end = addCalendarDays(start, 7);
  return { start, end, label: `${calendarLabel(start)} – ${calendarLabel(addCalendarDays(end, -1))}` };
}

export function isWeekdayName(value: string): boolean {
  return WEEKDAYS.includes(value.toLowerCase() as (typeof WEEKDAYS)[number]);
}
