/**
 * iCalendar (RFC 5545) subscription feeds for the Today calendar (docs/03 §2.4):
 * parses VEVENTs and expands recurring series inside a window. Pure: no
 * network, no database. Supports DTSTART/DTEND/DURATION with TZID (IANA names,
 * Windows names, VTIMEZONE X-LIC-LOCATION or its STANDARD/DAYLIGHT rules),
 * floating and UTC times, all-day dates, RRULE (DAILY, WEEKLY, MONTHLY, YEARLY
 * with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS, WKST),
 * RDATE, EXDATE and RECURRENCE-ID overrides. Other RRULE parts are ignored.
 */
import { createHash } from "node:crypto";
import { findJoinUrl } from "./dedupe.js";

export interface IcsAttendee {
  email: string | null;
  name: string | null;
}

export interface IcsEvent {
  uid: string;
  title: string;
  description: string;
  location: string | null;
  url: string | null;
  joinUrl: string | null;
  start: Date;
  end: Date | null;
  allDay: boolean;
  /** All-day span, end exclusive. */
  startDate: string | null;
  endDate: string | null;
  /** The occurrence's original start, for a recurring series. */
  instanceStart: Date | null;
  cancelled: boolean;
  organizer: string | null;
  attendees: IcsAttendee[];
}

export interface IcsCalendar {
  name: string | null;
  timeZone: string | null;
  events: IcsEvent[];
  /** More events than `maxEvents` were in the window. */
  truncated: boolean;
}

export interface ParseOptions {
  from: Date;
  to: Date;
  /** For floating times when the feed names no zone. */
  defaultTimeZone: string;
  maxEvents?: number;
}

const DAY = 86_400_000;
const MAX_LINES = 400_000;
const MAX_PERIODS = 3000;

// ── content lines ───────────────────────────────────────────────────────────

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface Component {
  type: string;
  props: Prop[];
  children: Component[];
}

function parseLine(line: string): Prop | null {
  let quoted = false;
  let nameEnd = -1;
  let valueStart = -1;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === ";" && nameEnd < 0) nameEnd = i;
    else if (!quoted && char === ":") {
      valueStart = i + 1;
      if (nameEnd < 0) nameEnd = i;
      break;
    }
  }
  if (valueStart < 0) return null;
  const name = line.slice(0, nameEnd).trim().toUpperCase();
  const params: Record<string, string> = {};
  const rawParams = line.slice(nameEnd, valueStart - 1);
  for (const match of rawParams.matchAll(/;([^=;:]+)=("[^"]*"|[^;:]*)/g)) {
    params[match[1]!.trim().toUpperCase()] = match[2]!.replace(/^"|"$/g, "");
  }
  return { name, params, value: line.slice(valueStart) };
}

function parseComponents(text: string): Component {
  const root: Component = { type: "ROOT", props: [], children: [] };
  const stack: Component[] = [root];
  const lines = text.replace(/\r\n[ \t]|\n[ \t]|\r[ \t]/g, "").split(/\r\n|\n|\r/);
  if (lines.length > MAX_LINES) lines.length = MAX_LINES;
  for (const line of lines) {
    if (!line.trim()) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    const top = stack[stack.length - 1]!;
    if (prop.name === "BEGIN") {
      const child: Component = { type: prop.value.trim().toUpperCase(), props: [], children: [] };
      top.children.push(child);
      stack.push(child);
    } else if (prop.name === "END") {
      if (stack.length > 1 && top.type === prop.value.trim().toUpperCase()) stack.pop();
    } else {
      top.props.push(prop);
    }
  }
  return root;
}

function prop(component: Component, name: string): Prop | undefined {
  return component.props.find((row) => row.name === name);
}

function props(component: Component, name: string): Prop[] {
  return component.props.filter((row) => row.name === name);
}

export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) => (char === "n" || char === "N" ? "\n" : char));
}

function text(component: Component, name: string): string {
  const row = prop(component, name);
  return row ? unescapeText(row.value).trim() : "";
}

// ── time zones ──────────────────────────────────────────────────────────────

/** Windows zone names (Outlook and Exchange feeds) to IANA, for the zones people use most. */
const WINDOWS_ZONES: Readonly<Record<string, string>> = {
  "dateline standard time": "Etc/GMT+12",
  "hawaiian standard time": "Pacific/Honolulu",
  "alaskan standard time": "America/Anchorage",
  "pacific standard time": "America/Los_Angeles",
  "us mountain standard time": "America/Phoenix",
  "mountain standard time": "America/Denver",
  "central standard time": "America/Chicago",
  "canada central standard time": "America/Regina",
  "central america standard time": "America/Guatemala",
  "eastern standard time": "America/New_York",
  "atlantic standard time": "America/Halifax",
  "newfoundland standard time": "America/St_Johns",
  "e. south america standard time": "America/Sao_Paulo",
  "sa pacific standard time": "America/Bogota",
  "argentina standard time": "America/Buenos_Aires",
  utc: "UTC",
  "coordinated universal time": "UTC",
  "gmt standard time": "Europe/London",
  "greenwich standard time": "Atlantic/Reykjavik",
  "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Budapest",
  "central european standard time": "Europe/Warsaw",
  "romance standard time": "Europe/Paris",
  "e. europe standard time": "Europe/Chisinau",
  "fle standard time": "Europe/Kiev",
  "gtb standard time": "Europe/Bucharest",
  "turkey standard time": "Europe/Istanbul",
  "israel standard time": "Asia/Jerusalem",
  "egypt standard time": "Africa/Cairo",
  "south africa standard time": "Africa/Johannesburg",
  "w. central africa standard time": "Africa/Lagos",
  "e. africa standard time": "Africa/Nairobi",
  "russian standard time": "Europe/Moscow",
  "arabian standard time": "Asia/Dubai",
  "arab standard time": "Asia/Riyadh",
  "iran standard time": "Asia/Tehran",
  "pakistan standard time": "Asia/Karachi",
  "india standard time": "Asia/Kolkata",
  "sri lanka standard time": "Asia/Colombo",
  "nepal standard time": "Asia/Kathmandu",
  "bangladesh standard time": "Asia/Dhaka",
  "se asia standard time": "Asia/Bangkok",
  "singapore standard time": "Asia/Singapore",
  "china standard time": "Asia/Shanghai",
  "taipei standard time": "Asia/Taipei",
  "w. australia standard time": "Australia/Perth",
  "tokyo standard time": "Asia/Tokyo",
  "korea standard time": "Asia/Seoul",
  "aus central standard time": "Australia/Darwin",
  "cen. australia standard time": "Australia/Adelaide",
  "aus eastern standard time": "Australia/Sydney",
  "e. australia standard time": "Australia/Brisbane",
  "new zealand standard time": "Pacific/Auckland",
};

const validZones = new Map<string, boolean>();

export function isTimeZone(name: string): boolean {
  const cached = validZones.get(name);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    ok = true;
  } catch {
    ok = false;
  }
  if (validZones.size < 500) validZones.set(name, ok);
  return ok;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Minutes east of UTC in `timeZone` at `at`. */
function offsetMinutes(timeZone: string, at: number): number {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    if (formatters.size < 200) formatters.set(timeZone, format);
  }
  const parts = format.formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const hour = get("hour") === 24 ? 0 : get("hour");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
}

/** Turns a wall-clock time (written as UTC milliseconds) into an instant. */
type Zone = (wall: number) => number;

const UTC_ZONE: Zone = (wall) => wall;

function ianaZone(name: string): Zone {
  return (wall) => {
    const first = offsetMinutes(name, wall);
    const instant = wall - first * 60_000;
    const second = offsetMinutes(name, instant);
    return second === first ? instant : wall - second * 60_000;
  };
}

function offsetValue(value: string | undefined): number | null {
  const match = value?.trim().match(/^([+-])(\d{2}):?(\d{2})(?::?(\d{2}))?$/);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** A VTIMEZONE without a known name: the latest STANDARD or DAYLIGHT onset before the time decides the offset. */
function observanceZone(component: Component): Zone | null {
  const observances = component.children
    .filter((child) => child.type === "STANDARD" || child.type === "DAYLIGHT")
    .map((child) => {
      const start = parseMoment(prop(child, "DTSTART"));
      const to = offsetValue(prop(child, "TZOFFSETTO")?.value);
      const from = offsetValue(prop(child, "TZOFFSETFROM")?.value) ?? to;
      const rule = prop(child, "RRULE") ? parseRule(prop(child, "RRULE")!.value) : null;
      return start && to !== null ? { wall: start.wall, to, from: from!, rule } : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  if (!observances.length) return null;
  return (wall) => {
    const year = new Date(wall).getUTCFullYear();
    let best: { at: number; to: number } | null = null;
    for (const row of observances) {
      const onsets = row.rule
        ? expandWall(row.wall, row.rule, Date.UTC(year - 1, 0, 1), Date.UTC(year + 1, 0, 1), 64)
        : [row.wall];
      for (const onset of onsets) if (onset <= wall && (!best || onset > best.at)) best = { at: onset, to: row.to };
    }
    const offset = best?.to ?? observances.reduce((a, b) => (a.wall <= b.wall ? a : b)).from;
    return wall - offset * 60_000;
  };
}

class Zones {
  private readonly cache = new Map<string, Zone>();
  constructor(
    private readonly timezones: Map<string, Component>,
    private readonly floating: Zone,
  ) {}

  get(tzid: string | undefined): Zone {
    if (!tzid) return this.floating;
    const key = tzid.trim();
    const cached = this.cache.get(key);
    if (cached) return cached;
    const zone = this.resolve(key);
    this.cache.set(key, zone);
    return zone;
  }

  private resolve(tzid: string): Zone {
    const bare = tzid.replace(/^"|"$/g, "");
    if (/^(utc|gmt|z|etc\/utc)$/i.test(bare)) return UTC_ZONE;
    if (isTimeZone(bare)) return ianaZone(bare);
    const tail = bare.match(/([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/)?.[1];
    if (tail && isTimeZone(tail)) return ianaZone(tail);
    const windows = WINDOWS_ZONES[bare.toLowerCase()];
    if (windows) return windows === "UTC" ? UTC_ZONE : ianaZone(windows);
    const component = this.timezones.get(bare);
    if (component) {
      const location = text(component, "X-LIC-LOCATION");
      if (location && isTimeZone(location)) return ianaZone(location);
      const zone = observanceZone(component);
      if (zone) return zone;
    }
    return this.floating;
  }
}

// ── dates ───────────────────────────────────────────────────────────────────

interface Moment {
  /** Wall clock as UTC milliseconds; midnight for a date. */
  wall: number;
  date: boolean;
  utc: boolean;
  tzid?: string;
}

function parseDateTime(value: string, params: Record<string, string>): Moment | null {
  const raw = value.trim();
  const date = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (date) return { wall: Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])), date: true, utc: false };
  const time = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i);
  if (!time) return null;
  const wall = Date.UTC(Number(time[1]), Number(time[2]) - 1, Number(time[3]), Number(time[4]), Number(time[5]), Number(time[6] ?? 0));
  if (Number.isNaN(wall)) return null;
  return { wall, date: params.VALUE?.toUpperCase() === "DATE", utc: Boolean(time[7]), tzid: time[7] ? undefined : params.TZID };
}

function parseMoment(row: Prop | undefined): Moment | null {
  return row ? parseDateTime(row.value, row.params) : null;
}

function momentList(rows: Prop[]): Moment[] {
  return rows.flatMap((row) => row.value.split(",").map((value) => parseDateTime(value, row.params)).filter((value): value is Moment => value !== null));
}

function parseDuration(value: string | undefined): number | null {
  const match = value?.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!match) return null;
  const ms = (Number(match[2] ?? 0) * 7 + Number(match[3] ?? 0)) * DAY + Number(match[4] ?? 0) * 3_600_000 + Number(match[5] ?? 0) * 60_000 + Number(match[6] ?? 0) * 1000;
  return match[1] === "-" ? -ms : ms;
}

const isoDate = (wall: number) => new Date(wall).toISOString().slice(0, 10);

// ── recurrence ──────────────────────────────────────────────────────────────

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export interface Rule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  until: Moment | null;
  byDay: Array<{ n: number; day: number }>;
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  weekStart: number;
}

export function parseRule(value: string): Rule | null {
  const parts = Object.fromEntries(
    value.split(";").map((part) => {
      const [key, ...rest] = part.split("=");
      return [key!.trim().toUpperCase(), rest.join("=").trim()];
    }),
  );
  const freq = parts.FREQ?.toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const ints = (raw: string | undefined) => (raw ? raw.split(",").map(Number).filter((n) => Number.isInteger(n) && n !== 0) : []);
  const byDay = (parts.BYDAY ? parts.BYDAY.split(",") : [])
    .map((entry: string) => entry.trim().toUpperCase().match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/))
    .filter((match: RegExpMatchArray | null): match is RegExpMatchArray => match !== null)
    .map((match: RegExpMatchArray) => ({ n: match[1] ? Number(match[1]) : 0, day: WEEKDAYS.indexOf(match[2]!) }));
  const interval = Number(parts.INTERVAL ?? 1);
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  return {
    freq,
    interval: Number.isInteger(interval) && interval > 0 ? Math.min(interval, 1000) : 1,
    count: count !== null && Number.isInteger(count) && count > 0 ? count : null,
    until: parts.UNTIL ? parseDateTime(parts.UNTIL, {}) : null,
    byDay,
    byMonthDay: ints(parts.BYMONTHDAY).filter((n) => Math.abs(n) <= 31),
    byMonth: ints(parts.BYMONTH).filter((n) => n >= 1 && n <= 12),
    bySetPos: ints(parts.BYSETPOS),
    weekStart: Math.max(0, WEEKDAYS.indexOf((parts.WKST ?? "MO").toUpperCase())),
  };
}

const dayNumber = (wall: number) => Math.floor(wall / DAY);
const weekday = (day: number) => (((day + 4) % 7) + 7) % 7;
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** Days in [first, first + length) that are the n-th (n ≠ 0, negative from the end) or every (n = 0) `day` of the week. */
function weekdaysIn(first: number, length: number, n: number, day: number): number[] {
  const all: number[] = [];
  for (let d = first + ((day - weekday(first) + 7) % 7); d < first + length; d += 7) all.push(d);
  if (n === 0) return all;
  const pick = n > 0 ? all[n - 1] : all[all.length + n];
  return pick === undefined ? [] : [pick];
}

function monthDays(year: number, month: number, rule: Rule, startDay: number): number[] {
  const first = dayNumber(Date.UTC(year, month, 1));
  const length = daysIn(year, month);
  let days: number[] | null = null;
  if (rule.byMonthDay.length) {
    days = rule.byMonthDay.map((n) => (n > 0 ? n : length + n + 1)).filter((n) => n >= 1 && n <= length).map((n) => first + n - 1);
  }
  if (rule.byDay.length) {
    const fromDays = rule.byDay.flatMap(({ n, day }) => weekdaysIn(first, length, n, day));
    days = days ? days.filter((d) => fromDays.includes(d)) : fromDays;
  }
  if (!days) days = startDay <= length ? [first + startDay - 1] : [];
  return days;
}

function periodDays(rule: Rule, period: number, start: { year: number; month: number; date: number; day: number }): number[] {
  const step = period * rule.interval;
  if (rule.freq === "DAILY") {
    const d = start.day + step;
    const date = new Date(d * DAY);
    if (rule.byMonth.length && !rule.byMonth.includes(date.getUTCMonth() + 1)) return [];
    if (rule.byMonthDay.length) {
      const length = daysIn(date.getUTCFullYear(), date.getUTCMonth());
      if (!rule.byMonthDay.some((n) => (n > 0 ? n : length + n + 1) === date.getUTCDate())) return [];
    }
    if (rule.byDay.length && !rule.byDay.some((row) => row.day === weekday(d))) return [];
    return [d];
  }
  if (rule.freq === "WEEKLY") {
    const weekFirst = start.day - ((weekday(start.day) - rule.weekStart + 7) % 7) + step * 7;
    const wanted = rule.byDay.length ? rule.byDay.map((row) => row.day) : [weekday(start.day)];
    return [...new Set(wanted)]
      .map((day) => weekFirst + ((day - rule.weekStart + 7) % 7))
      .filter((d) => !rule.byMonth.length || rule.byMonth.includes(new Date(d * DAY).getUTCMonth() + 1));
  }
  if (rule.freq === "MONTHLY") {
    const index = start.month + step;
    const year = start.year + Math.floor(index / 12);
    const month = ((index % 12) + 12) % 12;
    if (rule.byMonth.length && !rule.byMonth.includes(month + 1)) return [];
    return monthDays(year, month, rule, start.date);
  }
  const year = start.year + step;
  if (!rule.byMonth.length && rule.byDay.length && !rule.byMonthDay.length) {
    const first = dayNumber(Date.UTC(year, 0, 1));
    const length = dayNumber(Date.UTC(year + 1, 0, 1)) - first;
    return rule.byDay.flatMap(({ n, day }) => weekdaysIn(first, length, n, day));
  }
  const months = rule.byMonth.length ? rule.byMonth.map((m) => m - 1) : [start.month];
  return months.flatMap((month) => (rule.byMonthDay.length || rule.byDay.length ? monthDays(year, month, rule, start.date) : start.date <= daysIn(year, month) ? [dayNumber(Date.UTC(year, month, start.date))] : []));
}

function skipPeriods(rule: Rule, startWall: number, windowStart: number): number {
  if (rule.count !== null || windowStart <= startWall) return 0;
  const from = new Date(startWall);
  const to = new Date(windowStart);
  const units =
    rule.freq === "DAILY"
      ? (dayNumber(windowStart) - dayNumber(startWall))
      : rule.freq === "WEEKLY"
        ? Math.floor((dayNumber(windowStart) - dayNumber(startWall)) / 7)
        : rule.freq === "MONTHLY"
          ? (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth()
          : to.getUTCFullYear() - from.getUTCFullYear();
  return Math.max(0, Math.floor(units / rule.interval) - 1);
}

/**
 * Occurrence wall times of a rule from `startWall` (always the first occurrence),
 * those in [windowStart, windowEnd), at most `limit`. `until` is compared as
 * wall time; the caller converts a UTC UNTIL first.
 */
export function expandWall(startWall: number, rule: Rule, windowStart: number, windowEnd: number, limit: number, untilWall: number | null = rule.until ? rule.until.wall + (rule.until.date ? DAY - 1 : 0) : null): number[] {
  const out: number[] = [];
  const timeOfDay = startWall - dayNumber(startWall) * DAY;
  const date = new Date(startWall);
  const start = { year: date.getUTCFullYear(), month: date.getUTCMonth(), date: date.getUTCDate(), day: dayNumber(startWall) };
  let count = 1;
  if (startWall >= windowStart && startWall < windowEnd) out.push(startWall);
  for (let period = skipPeriods(rule, startWall, windowStart), guard = 0; guard < MAX_PERIODS; period++, guard++) {
    let days = periodDays(rule, period, start).sort((a, b) => a - b);
    if (rule.bySetPos.length && days.length) {
      const all = days;
      days = rule.bySetPos.map((pos) => (pos > 0 ? all[pos - 1] : all[all.length + pos])).filter((d): d is number => d !== undefined).sort((a, b) => a - b);
    }
    let past = false;
    for (const day of days) {
      const wall = day * DAY + timeOfDay;
      if (wall <= startWall) continue;
      if (untilWall !== null && wall > untilWall) return out;
      count += 1;
      if (rule.count !== null && count > rule.count) return out;
      if (wall >= windowEnd) {
        past = true;
        break;
      }
      if (wall >= windowStart) out.push(wall);
      if (out.length >= limit) return out;
    }
    if (past) break;
    // A period entirely after the window ends the series for our purposes.
    const periodStart = rule.freq === "DAILY" ? (start.day + period * rule.interval) * DAY : rule.freq === "WEEKLY" ? (start.day + period * rule.interval * 7) * DAY : rule.freq === "MONTHLY" ? Date.UTC(start.year, start.month + period * rule.interval, 1) : Date.UTC(start.year + period * rule.interval, 0, 1);
    if (periodStart > windowEnd) break;
  }
  return out;
}

// ── events ──────────────────────────────────────────────────────────────────

function address(row: Prop): IcsAttendee {
  const email = row.value.replace(/^mailto:/i, "").trim().toLowerCase();
  return { email: email.includes("@") ? email : null, name: row.params.CN?.trim() || null };
}

function generatedUid(event: Component): string {
  const basis = [text(event, "SUMMARY"), prop(event, "DTSTART")?.value ?? "", prop(event, "DTEND")?.value ?? ""].join("|");
  return `generated-${createHash("sha256").update(basis).digest("hex").slice(0, 24)}`;
}

function conferenceLink(event: Component): string | null {
  for (const name of ["X-GOOGLE-CONFERENCE", "X-MICROSOFT-SKYPETEAMSMEETINGURL", "CONFERENCE", "URL"]) {
    for (const row of props(event, name)) {
      const link = findJoinUrl(row.value);
      if (link) return link;
    }
  }
  return null;
}

/** Events in the feed that overlap [from, to), recurring series expanded. */
export function parseIcs(input: string, options: ParseOptions): IcsCalendar {
  const max = options.maxEvents ?? 2000;
  const root = parseComponents(input);
  const calendar = root.children.find((child) => child.type === "VCALENDAR") ?? root;
  const name = text(calendar, "X-WR-CALNAME") || null;
  const declared = text(calendar, "X-WR-TIMEZONE");
  const timeZone = declared && isTimeZone(declared) ? declared : null;
  const timezones = new Map<string, Component>();
  for (const child of calendar.children) if (child.type === "VTIMEZONE") timezones.set(text(child, "TZID"), child);
  const floatingName = timeZone ?? (isTimeZone(options.defaultTimeZone) ? options.defaultTimeZone : "UTC");
  const zones = new Zones(timezones, floatingName === "UTC" ? UTC_ZONE : ianaZone(floatingName));
  const instant = (moment: Moment): number => (moment.utc ? moment.wall : zones.get(moment.tzid)(moment.wall));

  // Overrides of single occurrences, keyed by UID then by the original start.
  const vevents = calendar.children.filter((child) => child.type === "VEVENT");
  const overrides = new Map<string, Set<number>>();
  for (const event of vevents) {
    const recurrence = parseMoment(prop(event, "RECURRENCE-ID"));
    const uid = text(event, "UID");
    if (!recurrence || !uid) continue;
    const set = overrides.get(uid) ?? new Set<number>();
    set.add(recurrence.date ? recurrence.wall : instant(recurrence));
    overrides.set(uid, set);
  }

  const from = options.from.getTime();
  const to = options.to.getTime();
  const events: IcsEvent[] = [];
  let truncated = false;

  for (const event of vevents) {
    if (events.length >= max) {
      truncated = true;
      break;
    }
    const startMoment = parseMoment(prop(event, "DTSTART"));
    if (!startMoment) continue;
    const allDay = startMoment.date;
    const uid = text(event, "UID") || generatedUid(event);
    const endMoment = parseMoment(prop(event, "DTEND"));
    const duration = parseDuration(prop(event, "DURATION")?.value);
    const description = text(event, "DESCRIPTION");
    const location = text(event, "LOCATION") || null;
    const base = {
      uid,
      title: text(event, "SUMMARY") || "(busy)",
      description,
      location,
      url: findJoinUrl(prop(event, "URL")?.value) ? null : prop(event, "URL")?.value.trim() || null,
      joinUrl: conferenceLink(event) ?? findJoinUrl(location, description),
      cancelled: text(event, "STATUS").toUpperCase() === "CANCELLED",
      organizer: prop(event, "ORGANIZER") ? address(prop(event, "ORGANIZER")!).email : null,
      attendees: props(event, "ATTENDEE").map(address),
    };
    const recurrence = parseMoment(prop(event, "RECURRENCE-ID"));
    const zone = startMoment.utc ? UTC_ZONE : zones.get(startMoment.tzid);
    const startInstant = allDay ? startMoment.wall : zone(startMoment.wall);
    let days = 1;
    if (allDay && endMoment) days = Math.max(1, Math.round((endMoment.wall - startMoment.wall) / DAY));
    else if (allDay && duration && duration > 0) days = Math.max(1, Math.round(duration / DAY));
    const length = allDay ? days * DAY : endMoment ? instant(endMoment) - startInstant : duration;

    /** One occurrence from its wall-clock start; `original` is the recurring occurrence's original start. */
    const emit = (wall: number, original: number | null) => {
      const instanceStart = original === null ? null : new Date(original);
      if (allDay) {
        if (wall + length! <= from - DAY || wall >= to + DAY) return;
        events.push({ ...base, start: new Date(wall), end: new Date(wall + length!), allDay: true, startDate: isoDate(wall), endDate: isoDate(wall + length!), instanceStart });
        return;
      }
      const real = zone(wall);
      const endAt = length !== null && length >= 0 ? real + length : null;
      if ((endAt ?? real) < from || real >= to) return;
      events.push({ ...base, start: new Date(real), end: endAt === null ? null : new Date(endAt), allDay: false, startDate: null, endDate: null, instanceStart });
    };

    if (recurrence) {
      emit(startMoment.wall, recurrence.date ? recurrence.wall : instant(recurrence));
      continue;
    }
    const ruleProp = prop(event, "RRULE");
    const rule = ruleProp ? parseRule(ruleProp.value) : null;
    const rdates = momentList(props(event, "RDATE"));
    if (!rule && !rdates.length) {
      emit(startMoment.wall, null);
      continue;
    }
    // Expand in wall time with two days' margin each side; emit() checks the real instants.
    const toWall = (moment: Moment) => (moment.utc && !allDay ? moment.wall + offsetMs(zone, moment.wall) : moment.wall);
    const excluded = new Set(momentList(props(event, "EXDATE")).map((moment) => (allDay || moment.date ? isoDate(moment.wall) : String(instant(moment)))));
    const overridden = overrides.get(uid) ?? new Set<number>();
    const windowStart = from - Math.max(0, length ?? 0) - 2 * DAY;
    const windowEnd = to + 2 * DAY;
    const untilWall = rule?.until ? (rule.until.date ? rule.until.wall + DAY - 1 : toWall(rule.until)) : null;
    const walls = rule ? expandWall(startMoment.wall, rule, windowStart, windowEnd, max, untilWall) : startMoment.wall >= windowStart && startMoment.wall < windowEnd ? [startMoment.wall] : [];
    for (const extra of rdates) {
      const wall = toWall(extra);
      if (wall >= windowStart && wall < windowEnd && !walls.includes(wall)) walls.push(wall);
    }
    walls.sort((a, b) => a - b);
    for (const wall of walls) {
      const original = allDay ? wall : zone(wall);
      if (excluded.has(allDay ? isoDate(wall) : String(original)) || (!allDay && excluded.has(isoDate(wall)))) continue;
      if (overridden.has(original)) continue;
      if (events.length >= max) {
        truncated = true;
        break;
      }
      emit(wall, original);
    }
  }
  return { name, timeZone, events, truncated };
}

/** Milliseconds to add to a UTC time to read it on the zone's wall clock. */
function offsetMs(zone: Zone, utcMs: number): number {
  return utcMs - zone(utcMs);
}
