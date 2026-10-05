/**
 * Turns a typed reminder into a task title, people, and a due date.
 * No model call: the words in the sentence are the whole parser.
 */
import { addCalendarDays, calendarDate, isWeekdayName, weekdayIndex } from "./dates.js";

export interface CaptureClock {
  /** YYYY-MM-DD in the user's zone. */
  date: string;
  /** English weekday, e.g. Wednesday. */
  weekday: string;
}

export interface ParsedCapture {
  title: string;
  personNames: string[];
  due: string | null;
  dueLabel: string | null;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const STOP = new Set(["about", "the", "a", "an", "to", "that", "on", "by", "for", "with", "and", "of", "me", "my"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namePattern(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "iu");
}

function upcomingWeekday(clock: CaptureClock, target: string, nextWeek: boolean): string {
  const today = weekdayIndex(clock.weekday);
  const want = weekdayIndex(target);
  if (today < 0 || want < 0) return clock.date;
  let delta = (want - today + 7) % 7;
  if (nextWeek) delta = delta === 0 ? 7 : delta + 7;
  return addCalendarDays(clock.date, delta);
}

interface FoundDate {
  due: string;
  label: string;
  start: number;
  end: number;
}

function findDate(text: string, clock: CaptureClock): FoundDate | null {
  const patterns: Array<{ re: RegExp; pick: (match: RegExpMatchArray) => FoundDate | null }> = [
    {
      re: /\b(\d{4})-(\d{2})-(\d{2})\b/,
      pick: (match) => {
        const due = calendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
        if (!due) return null;
        return { due, label: due, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length };
      },
    },
    {
      re: /\b(next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      pick: (match) => {
        const due = upcomingWeekday(clock, match[2]!, true);
        return { due, label: `next ${match[2]}`, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length };
      },
    },
    {
      re: /\b(?:this|on|by|due)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      pick: (match) => {
        const due = upcomingWeekday(clock, match[1]!, false);
        return { due, label: match[1]!, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length };
      },
    },
    {
      re: /\b(tomorrow|today|tonight)\b/i,
      pick: (match) => {
        const word = match[1]!.toLowerCase();
        const due = word === "tomorrow" ? addCalendarDays(clock.date, 1) : clock.date;
        return { due, label: word === "tonight" ? "today" : word, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length };
      },
    },
    {
      re: /\bin\s+(\d+)\s+days?\b/i,
      pick: (match) => {
        const days = Number(match[1]);
        if (!Number.isInteger(days) || days > 3660) return null;
        const due = addCalendarDays(clock.date, days);
        return { due, label: `in ${days} day${days === 1 ? "" : "s"}`, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length };
      },
    },
    {
      re: /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i,
      pick: (match) => {
        const month = MONTHS[match[1]!.toLowerCase()];
        const day = Number(match[2]);
        if (!month) return null;
        const explicitYear = Boolean(match[3]);
        let year = explicitYear ? Number(match[3]) : Number(clock.date.slice(0, 4));
        let due = calendarDate(year, month, day);
        if (!due) return null;
        if (!explicitYear && due < clock.date) due = calendarDate(year + 1, month, day);
        if (!due) return null;
        return { due, label: match[0], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length };
      },
    },
    {
      re: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      pick: (match) => {
        const due = upcomingWeekday(clock, match[1]!, false);
        return { due, label: match[1]!, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length };
      },
    },
  ];
  const founds: FoundDate[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(new RegExp(pattern.re.source, pattern.re.flags.includes("g") ? pattern.re.flags : `${pattern.re.flags}g`))) {
      const found = pattern.pick(match);
      if (found) founds.push(found);
    }
  }
  const kept = founds.filter(
    (candidate) =>
      !founds.some(
        (other) =>
          other !== candidate &&
          other.start <= candidate.start &&
          other.end >= candidate.end &&
          other.end - other.start > candidate.end - candidate.start,
      ),
  );
  kept.sort((left, right) => left.start - right.start);
  return kept.at(-1) ?? null;
}

function matchKnown(text: string, knownPeople: string[]): string[] {
  const found: string[] = [];
  let masked = text;
  const sorted = [...knownPeople].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const re = namePattern(name);
    if (re.test(masked)) {
      found.push(name);
      masked = masked.replace(re, " ");
    }
  }
  const firstCounts = new Map<string, string[]>();
  for (const name of knownPeople) {
    const first = name.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (first.length < 3) continue;
    const list = firstCounts.get(first) ?? [];
    list.push(name);
    firstCounts.set(first, list);
  }
  for (const [first, names] of firstCounts) {
    if (names.length !== 1) continue;
    if (found.some((name) => name.toLowerCase() === names[0]!.toLowerCase())) continue;
    const re = namePattern(first);
    if (re.test(masked)) found.push(names[0]!);
  }
  return found;
}

function explicitNames(text: string): string[] {
  const names: string[] = [];
  const remind = text.match(/\bremind\s+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)?)/u);
  const withName = text.match(/\bwith\s+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)?)/u);
  for (const match of [remind, withName]) {
    const raw = match?.[1]?.trim();
    if (!raw) continue;
    const cleaned = raw
      .split(/\s+/)
      .filter((part) => !STOP.has(part.toLowerCase()) && !isWeekdayName(part))
      .join(" ");
    if (cleaned) names.push(cleaned);
  }
  return names;
}

function titleCase(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "").trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function parseCapture(text: string, clock: CaptureClock, knownPeople: string[] = []): ParsedCapture {
  const original = text.replace(/\s+/g, " ").trim();
  const found = findDate(original, clock);
  let rest = original;
  if (found) rest = `${original.slice(0, found.start)} ${original.slice(found.end)}`;
  const known = matchKnown(original, knownPeople);
  const explicit = explicitNames(original);
  const personNames: string[] = [];
  for (const name of [...known, ...explicit]) {
    const lower = name.toLowerCase();
    if (personNames.some((have) => have.toLowerCase() === lower || have.toLowerCase().startsWith(`${lower} `))) continue;
    personNames.push(name);
  }
  const title = titleCase(rest).slice(0, 200) || titleCase(original).slice(0, 200);
  return {
    title,
    personNames,
    due: found?.due ?? null,
    dueLabel: found?.label ?? null,
  };
}
