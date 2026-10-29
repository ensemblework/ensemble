/**
 * Five-field cron schedules in a time zone, for routines (ensemble-node docs/design B14). Pure: no
 * clock and no database. Fields are minute, hour, day of month, month and day of week, each `*`, a
 * number, a range `a-b`, a step `*\/n` or `a-b/n`, or a list of those; months and weekdays also take
 * names (jan, mon). As in cron, when both day fields are restricted a day matching either runs.
 */

export class CronError extends Error {}

export type Cron = { minutes: number[]; hours: number[]; days: Set<number>; months: Set<number>; weekdays: Set<number>; anyDay: boolean; anyWeekday: boolean };

const PRESETS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function value(text: string, min: number, max: number, names: string[] | null, name: string): number {
  const lower = text.toLowerCase();
  const named = names ? names.indexOf(lower.slice(0, 3)) : -1;
  const number = named >= 0 && /^[a-z]+$/.test(lower) ? named + (names === MONTHS ? 1 : 0) : /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(number) || number < min || number > max) throw new CronError(`“${text}” is not a valid ${name} (${min}–${max}).`);
  return number;
}

function field(text: string, min: number, max: number, name: string, names: string[] | null = null): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  if (text === "*" || text === "?") {
    for (let at = min; at <= max; at += 1) values.add(at);
    return { values, any: true };
  }
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    if (range === undefined || range === "") throw new CronError(`“${text}” is not a valid ${name}.`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`“${part}” has a step that is not a whole number above 0.`);
    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [low, high] = range.split("-");
      from = value(low ?? "", min, max, names, name);
      to = value(high ?? "", min, max, names, name);
      if (to < from) throw new CronError(`“${range}” runs backwards.`);
    } else {
      from = value(range, min, max, names, name);
      to = stepText === undefined ? from : max;
    }
    for (let at = from; at <= to; at += step) values.add(at);
  }
  return { values, any: false };
}

export function parseCron(expression: string): Cron {
  const text = (PRESETS[expression.trim().toLowerCase()] ?? expression).trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new CronError("A schedule has five fields: minute, hour, day of month, month and day of week (for example “0 9 * * 1-5”).");
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  const minutes = field(minute, 0, 59, "minute");
  const hours = field(hour, 0, 23, "hour");
  const days = field(day, 1, 31, "day of month");
  const months = field(month, 1, 12, "month", MONTHS);
  const weekdays = field(weekday, 0, 7, "day of week", WEEKDAYS);
  // Sunday is 0 or 7.
  if (weekdays.values.has(7)) weekdays.values.add(0);
  weekdays.values.delete(7);
  return {
    minutes: [...minutes.values].sort((a, b) => a - b),
    hours: [...hours.values].sort((a, b) => a - b),
    days: days.values,
    months: months.values,
    weekdays: weekdays.values,
    anyDay: days.any,
    anyWeekday: weekdays.any,
  };
}

/** Whether the runtime knows the time zone. */
export function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
    formatters.set(zone, found);
  }
  return found;
}

export type LocalTime = { year: number; month: number; day: number; hour: number; minute: number };

/** The wall clock in `zone` at an instant. */
export function localTime(at: Date, zone: string): LocalTime {
  const parts = formatter(zone).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

function offsetAt(instant: number, zone: string): number {
  const local = localTime(new Date(instant), zone);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - Math.floor(instant / 60_000) * 60_000;
}

/** The instant a wall-clock time in `zone` happens (a time a clock change skips moves forward with it). */
export function zonedInstant(local: LocalTime, zone: string): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const first = offsetAt(guess, zone);
  const instant = guess - first;
  const second = offsetAt(instant, zone);
  if (second === first) return new Date(instant);
  // The guess was on the other side of a clock change: the other offset is right if it gives this wall
  // time; otherwise the time does not exist (the clock skipped it) and the first instant is just after.
  const other = guess - second;
  const back = localTime(new Date(other), zone);
  return new Date(back.hour === local.hour && back.minute === local.minute && back.day === local.day ? other : instant);
}

function dayMatches(cron: Cron, day: number, month: number, weekday: number): boolean {
  if (!cron.months.has(month)) return false;
  if (cron.anyDay && cron.anyWeekday) return true;
  if (cron.anyDay) return cron.weekdays.has(weekday);
  if (cron.anyWeekday) return cron.days.has(day);
  return cron.days.has(day) || cron.weekdays.has(weekday);
}

/** Whether a wall-clock minute is one the schedule runs at. */
export function cronMatches(cron: Cron, local: LocalTime): boolean {
  const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  return cron.minutes.includes(local.minute) && cron.hours.includes(local.hour) && dayMatches(cron, local.day, local.month, weekday);
}

/** The first time after `after` the schedule runs in `zone`, or null when it never does (31 February). */
export function nextRun(cron: Cron, zone: string, after: Date): Date | null {
  const start = localTime(after, zone);
  // Five years covers 29 February in any year a schedule can name.
  for (let offset = 0; offset < 366 * 5; offset += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const day = date.getUTCDate();
    const month = date.getUTCMonth() + 1;
    if (!dayMatches(cron, day, month, date.getUTCDay())) continue;
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const at = zonedInstant({ year: date.getUTCFullYear(), month, day, hour, minute }, zone);
        if (at.getTime() > after.getTime()) return at;
      }
    }
  }
  return null;
}

/** "0 9 * * 1-5" in words, for cards and the routines list: short, not exhaustive. */
export function describeCron(expression: string, zone: string): string {
  const cron = parseCron(expression);
  const time = cron.hours.length === 1 && cron.minutes.length === 1 ? `${String(cron.hours[0]).padStart(2, "0")}:${String(cron.minutes[0]).padStart(2, "0")}` : null;
  const zoneText = zone === "UTC" ? "UTC" : zone;
  if (time && cron.anyDay && cron.anyWeekday && cron.months.size === 12) return `Every day at ${time} (${zoneText})`;
  if (time && cron.anyDay && cron.months.size === 12 && [1, 2, 3, 4, 5].every((day) => cron.weekdays.has(day)) && cron.weekdays.size === 5) return `Weekdays at ${time} (${zoneText})`;
  if (time && cron.anyDay && cron.months.size === 12 && cron.weekdays.size === 1) return `Every ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][[...cron.weekdays][0]!]} at ${time} (${zoneText})`;
  if (time && cron.anyWeekday && cron.days.size === 1 && cron.months.size === 12) return `Every month on day ${[...cron.days][0]} at ${time} (${zoneText})`;
  if (cron.minutes.length === 1 && cron.hours.length === 24 && cron.anyDay && cron.anyWeekday) return `Every hour at :${String(cron.minutes[0]).padStart(2, "0")}`;
  return `${expression.trim()} (${zoneText})`;
}
