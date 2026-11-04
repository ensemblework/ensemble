/**
 * One calendar from many (docs/03 §2.4). Merges copies of the same event that
 * reach Ensemble from several calendars (Google, Outlook, ICS feeds) by fixed
 * rules, strongest first, with a union–find so A≈B and B≈C collapse once:
 *
 * 1. Same iCalendar UID and the same instance (original start of a recurring
 *    occurrence, else the start) within two minutes. Only this rule may join
 *    two copies from one calendar.
 * 2. Same online-meeting link after normalization (meetingKey: Teams thread,
 *    Meet code, Zoom or Webex meeting) and overlapping times. A personal room
 *    (Zoom /my/, Webex /meet/) is reused across meetings, so it also needs
 *    matching titles.
 * 3. Timed events: start and end each within two minutes (compared as UTC
 *    instants) and matching titles (titlesMatch).
 * 4. All-day events: the same date span and matching titles after a small
 *    holiday vocabulary (holidayTitlesMatch).
 *
 * Rules 2–4 never join two copies from the same source calendar. No rule
 * joins a cancelled copy to an active one: the cancelled duplicate is dropped.
 * No model is involved.
 *
 * A merged event keeps the earliest-created copy's id. Its time and title come
 * from the best copy (Google or Outlook over a calendar link, then the copy with
 * the most fields), the title without a mail prefix when one has none; other
 * fields are the first non-empty value in that order; attendees are the union
 * by address; `sources` lists every copy, best first.
 */

export const TOLERANCE_MS = 2 * 60_000;
export const JACCARD_MIN = 0.6;

export interface CalendarAttendee {
  email: string | null;
  name: string | null;
}

/** One stored copy of an event, from one source calendar. */
export interface CalendarRecord {
  id: string;
  /** google_calendar, outlook_calendar, ics_calendar, or another source id. */
  connector: string;
  /** The calendar inside the connector (Google calendar id, ICS feed id). */
  calendarId?: string | null;
  calendarName?: string | null;
  eventId?: string | null;
  /** The event at its source. */
  url?: string | null;
  /** iCalendar UID (Google iCalUID, Graph iCalUId, ICS UID). */
  uid?: string | null;
  /** Original start of a recurring occurrence (RECURRENCE-ID, originalStartTime, originalStart). */
  instanceStart?: Date | null;
  title: string;
  start: Date;
  end: Date | null;
  allDay: boolean;
  /** All-day span as calendar dates, end exclusive. */
  startDate?: string | null;
  endDate?: string | null;
  cancelled?: boolean;
  joinUrl?: string | null;
  location?: string | null;
  hasDescription?: boolean;
  attendees?: readonly CalendarAttendee[];
  organizer?: string | null;
  createdAt?: Date | null;
}

export interface MergedSource {
  connector: string;
  calendarId: string | null;
  calendarName: string | null;
  eventId: string | null;
  url: string | null;
}

export interface MergedEvent {
  /** The earliest-created copy's id: stable while that copy exists. Time and title come from the best copy (`better`). */
  id: string;
  memberIds: string[];
  title: string;
  start: Date;
  end: Date | null;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  cancelled: boolean;
  joinUrl: string | null;
  location: string | null;
  hasDescription: boolean;
  attendees: CalendarAttendee[];
  organizer: string | null;
  uid: string | null;
  sources: MergedSource[];
}

// ── titles ──────────────────────────────────────────────────────────────────

/** Mail-client and calendar prefixes that say nothing about the event itself. */
const TITLE_PREFIX =
  /^(?:\[(?:ext|external)\]\s*|(?:fwd?|fw|re)\s*:\s*|(?:updated\s+)?invitation(?:\s+from\s+google\s+calendar)?\s*:\s*|(?:new|updated)\s+event\s*:\s*|accepted\s*:\s*|declined\s*:\s*|tentative(?:ly\s+accepted)?\s*:\s*|cancell?ed(?:\s+event)?\s*:\s*)/u;

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u200d\ufe0f\u20e3]/gu;
const PUNCTUATION = /[\p{P}\p{S}]+/gu;

function cleanTitle(title: string): { normalized: string; prefixed: boolean } {
  let text = title.normalize("NFKC").toLowerCase().replace(EMOJI, " ").trim();
  let prefixed = false;
  for (let guard = 0; guard < 6; guard++) {
    const next = text.replace(TITLE_PREFIX, "");
    if (next === text) break;
    prefixed = true;
    text = next.trim();
  }
  const normalized = text.replace(PUNCTUATION, " ").replace(/\s+/g, " ").trim();
  return { normalized, prefixed };
}

/** Lowercase NFKC, without mail prefixes ("Fwd:", "Updated invitation:", "Canceled:"…), emoji and punctuation, single-spaced. */
export function normalizeTitle(title: string): string {
  return cleanTitle(title).normalized;
}

function tokens(normalized: string): string[] {
  return normalized ? normalized.split(" ") : [];
}

function containsTokens(longer: readonly string[], shorter: readonly string[]): boolean {
  if (!shorter.length || shorter.length > longer.length) return false;
  outer: for (let i = 0; i + shorter.length <= longer.length; i++) {
    for (let j = 0; j < shorter.length; j++) if (longer[i + j] !== shorter[j]) continue outer;
    return true;
  }
  return false;
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function tokensMatch(left: readonly string[], right: readonly string[]): boolean {
  if (!left.length || !right.length) return false;
  if (left.join(" ") === right.join(" ")) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.join(" ").length >= 3 && containsTokens(longer, shorter)) return true;
  return jaccard(left, right) >= JACCARD_MIN;
}

/** Equal, one inside the other as whole words (at least 3 characters), or token Jaccard ≥ 0.6, after normalizeTitle. */
export function titlesMatch(a: string, b: string): boolean {
  return tokensMatch(tokens(normalizeTitle(a)), tokens(normalizeTitle(b)));
}

/**
 * Holiday and festival names differ between calendar vendors. Kept small on
 * purpose: spellings of the same day, nothing that could join two different days.
 */
export const HOLIDAY_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdeepavali\b/g, "diwali"],
  [/\bx ?mas\b/g, "christmas"],
  [/\b(?:vijaya ?dashami|dasara|dussera)\b/g, "dussehra"],
  [/\b(?:chanukah|hanukah|chanukkah)\b/g, "hanukkah"],
  [/\bramzan\b/g, "ramadan"],
  [/\beid (?:al|ul|e) /g, "eid "],
  [/\bnavroz\b/g, "nowruz"],
  [/\blabour\b/g, "labor"],
];

/** Words one vendor adds and another leaves out: "Christmas Day" is "Christmas", "New Year's Day" is "New Year". "eve" is not one of them. */
export const HOLIDAY_STOPWORDS: ReadonlySet<string> = new Set(["day", "holiday", "holidays", "observed", "the", "of", "festival", "s", "bank", "public"]);

function holidayTokens(title: string): string[] {
  let text = normalizeTitle(title);
  for (const [pattern, replacement] of HOLIDAY_PHRASES) text = text.replace(pattern, replacement);
  const all = tokens(text.replace(/\s+/g, " ").trim());
  const kept = all.filter((word) => !HOLIDAY_STOPWORDS.has(word));
  return kept.length ? kept : all;
}

/** Title match for all-day events: titlesMatch after the holiday vocabulary. "Christmas Eve" never matches "Christmas". */
export function holidayTitlesMatch(a: string, b: string): boolean {
  const left = holidayTokens(a);
  const right = holidayTokens(b);
  if (left.includes("eve") !== right.includes("eve")) return false;
  return tokensMatch(left, right);
}

// ── online-meeting links ────────────────────────────────────────────────────

/**
 * The meeting a join link opens, comparable across calendars: `teams:<thread>`,
 * `teams:meet:<id>`, `meet:<code>`, `zoom:<id>`, `zoom:my:<room>`, `webex:<id>`,
 * or null for any other link.
 */
export function meetingKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "teams.microsoft.com" || host === "teams.live.com" || host.endsWith(".teams.microsoft.com")) {
    const join = parts.indexOf("meetup-join");
    if (join >= 0 && parts[join + 1]) {
      let thread = parts[join + 1]!;
      for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(thread); i++) {
        try {
          thread = decodeURIComponent(thread);
        } catch {
          break;
        }
      }
      return `teams:${thread.toLowerCase()}`;
    }
    const meet = parts.indexOf("meet");
    if (meet >= 0 && parts[meet + 1]) return `teams:meet:${parts[meet + 1]!.toLowerCase()}`;
    return null;
  }
  if (host === "meet.google.com") {
    const code = parts[0]?.toLowerCase();
    if (code && /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code)) return `meet:${code}`;
    if (code === "lookup" && parts[1]) return `meet:lookup:${parts[1].toLowerCase()}`;
    return null;
  }
  if (host === "zoom.us" || host.endsWith(".zoom.us") || host === "zoomgov.com" || host.endsWith(".zoomgov.com")) {
    if (parts[0]?.toLowerCase() === "my" && parts[1]) return `zoom:my:${parts[1].toLowerCase()}`;
    const at = parts.findIndex((part) => ["j", "w", "s", "wc"].includes(part.toLowerCase()));
    const id = (at >= 0 ? parts[at + 1] : null) ?? url.searchParams.get("confno");
    const digits = id?.replace(/\D/g, "");
    return digits && digits.length >= 9 ? `zoom:${digits}` : null;
  }
  if (host === "webex.com" || host.endsWith(".webex.com")) {
    const mtid = url.searchParams.get("MTID") ?? url.searchParams.get("mtid");
    if (mtid) return `webex:${mtid.toLowerCase()}`;
    const meet = parts.indexOf("meet");
    if (meet >= 0 && parts[meet + 1]) return `webex:room:${host}/${parts[meet + 1]!.toLowerCase()}`;
    return null;
  }
  return null;
}

/** A link that opens the same room for many meetings. */
function personalRoom(key: string): boolean {
  return key.startsWith("zoom:my:") || key.startsWith("webex:room:");
}

const LINK = /https?:\/\/[^\s<>"')\]]+/gi;

/** The first Teams, Meet, Zoom or Webex join link in free text (a location or a description). */
export function findJoinUrl(...texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    for (const match of text?.matchAll(LINK) ?? []) {
      const link = match[0].replace(/[.,;>]+$/, "");
      if (meetingKey(link)) return link;
    }
  }
  return null;
}

// ── merging ─────────────────────────────────────────────────────────────────

function sourceKey(record: CalendarRecord): string {
  return `${record.connector}:${record.calendarId ?? ""}`;
}

function dateMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function nextDate(date: string): string {
  return new Date(dateMs(date) + 86_400_000).toISOString().slice(0, 10);
}

/** All-day span as dates. A copy saved without dates falls back to the UTC dates of its start and end. */
export function allDaySpan(record: Pick<CalendarRecord, "start" | "end" | "startDate" | "endDate">): { startDate: string; endDate: string } {
  const startDate = record.startDate ?? record.start.toISOString().slice(0, 10);
  const fromEnd = record.end ? record.end.toISOString().slice(0, 10) : null;
  const endDate = record.endDate && record.endDate > startDate ? record.endDate : fromEnd && fromEnd > startDate ? fromEnd : nextDate(startDate);
  return { startDate, endDate };
}

function instanceMs(record: CalendarRecord): number {
  if (record.allDay) return dateMs(record.instanceStart ? record.instanceStart.toISOString().slice(0, 10) : allDaySpan(record).startDate);
  return (record.instanceStart ?? record.start).getTime();
}

function endMs(record: CalendarRecord): number {
  const start = record.start.getTime();
  const end = record.end?.getTime() ?? Number.NaN;
  return Number.isFinite(end) && end > start ? end : start + TOLERANCE_MS;
}

function earlier(a: CalendarRecord, b: CalendarRecord): number {
  const at = a.createdAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bt = b.createdAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

class Groups {
  private readonly parent: number[];
  private readonly sources: Array<Set<string>>;
  readonly dropped = new Set<number>();

  constructor(private readonly records: readonly CalendarRecord[]) {
    this.parent = records.map((_, index) => index);
    this.sources = records.map((record) => new Set([sourceKey(record)]));
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root]!;
    let at = index;
    while (this.parent[at] !== root) {
      const next = this.parent[at]!;
      this.parent[at] = root;
      at = next;
    }
    return root;
  }

  /** Joins two copies; `sameUid` lets copies from one calendar join. A cancelled copy of an active one is dropped instead. */
  join(a: number, b: number, sameUid: boolean): void {
    const left = this.records[a]!;
    const right = this.records[b]!;
    if (!sameUid && sourceKey(left) === sourceKey(right)) return;
    if (Boolean(left.cancelled) !== Boolean(right.cancelled)) {
      this.dropped.add(left.cancelled ? a : b);
      return;
    }
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const sa = this.sources[ra]!;
    const sb = this.sources[rb]!;
    if (!sameUid) for (const key of sa) if (sb.has(key)) return;
    const [keep, gone] = sa.size >= sb.size ? [ra, rb] : [rb, ra];
    this.parent[gone] = keep;
    for (const key of this.sources[gone]!) this.sources[keep]!.add(key);
  }
}

function bucket(records: readonly CalendarRecord[], key: (record: CalendarRecord) => string | null): number[][] {
  const buckets = new Map<string, number[]>();
  records.forEach((record, index) => {
    const value = key(record);
    if (!value) return;
    const list = buckets.get(value);
    if (list) list.push(index);
    else buckets.set(value, [index]);
  });
  return [...buckets.values()].filter((list) => list.length > 1);
}

function byUid(records: readonly CalendarRecord[], groups: Groups): void {
  for (const list of bucket(records, (record) => record.uid?.trim().toLowerCase() || null)) {
    list.sort((a, b) => instanceMs(records[a]!) - instanceMs(records[b]!));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = records[list[i]!]!;
        const b = records[list[j]!]!;
        if (instanceMs(b) - instanceMs(a) > TOLERANCE_MS) break;
        if (a.allDay === b.allDay) groups.join(list[i]!, list[j]!, true);
      }
    }
  }
}

function byMeeting(records: readonly CalendarRecord[], groups: Groups): void {
  for (const list of bucket(records, (record) => (record.allDay ? null : meetingKey(record.joinUrl)))) {
    const room = personalRoom(meetingKey(records[list[0]!]!.joinUrl)!);
    list.sort((a, b) => records[a]!.start.getTime() - records[b]!.start.getTime());
    for (let i = 0; i < list.length; i++) {
      const a = records[list[i]!]!;
      for (let j = i + 1; j < list.length; j++) {
        const b = records[list[j]!]!;
        if (b.start.getTime() >= endMs(a)) break;
        if (room && !titlesMatch(a.title, b.title)) continue;
        groups.join(list[i]!, list[j]!, false);
      }
    }
  }
}

function endsAgree(a: CalendarRecord, b: CalendarRecord): boolean {
  if (!a.end || !b.end) return !a.end && !b.end;
  return Math.abs(a.end.getTime() - b.end.getTime()) <= TOLERANCE_MS;
}

function byTime(records: readonly CalendarRecord[], groups: Groups): void {
  const timed = records.map((record, index) => ({ record, index })).filter((row) => !row.record.allDay);
  timed.sort((a, b) => a.record.start.getTime() - b.record.start.getTime());
  for (let i = 0; i < timed.length; i++) {
    const a = timed[i]!;
    for (let j = i + 1; j < timed.length; j++) {
      const b = timed[j]!;
      if (b.record.start.getTime() - a.record.start.getTime() > TOLERANCE_MS) break;
      if (sourceKey(a.record) === sourceKey(b.record)) continue;
      if (endsAgree(a.record, b.record) && titlesMatch(a.record.title, b.record.title)) groups.join(a.index, b.index, false);
    }
  }
}

function byDay(records: readonly CalendarRecord[], groups: Groups): void {
  for (const list of bucket(records, (record) => {
    if (!record.allDay) return null;
    const days = allDaySpan(record);
    return `${days.startDate}|${days.endDate}`;
  })) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = records[list[i]!]!;
        const b = records[list[j]!]!;
        if (sourceKey(a) !== sourceKey(b) && holidayTitlesMatch(a.title, b.title)) groups.join(list[i]!, list[j]!, false);
      }
    }
  }
}

/** Calendars that hold the event itself rank above calendar links (often a copy) and events kept by hand. */
const SOURCE_RANK: Readonly<Record<string, number>> = { google_calendar: 2, outlook_calendar: 2, ics_calendar: 1 };

function richness(record: CalendarRecord): number {
  return Number(Boolean(record.joinUrl)) + Number(Boolean(record.attendees?.length)) + Number(Boolean(record.hasDescription)) + Number(Boolean(record.location)) + Number(Boolean(record.uid));
}

/** The copy whose time and title are shown: a provider calendar's, then the one with the most fields, then the earliest-created. */
function better(a: CalendarRecord, b: CalendarRecord): number {
  return (SOURCE_RANK[b.connector] ?? 0) - (SOURCE_RANK[a.connector] ?? 0) || richness(b) - richness(a) || earlier(a, b);
}

function merge(members: CalendarRecord[]): MergedEvent {
  members.sort(earlier);
  const first = members[0]!;
  const ranked = [...members].sort(better);
  const lead = ranked[0]!;
  const plain = ranked.find((member) => member.title.trim() && !cleanTitle(member.title).prefixed);
  const pick = <T>(read: (member: CalendarRecord) => T | null | undefined): T | null => {
    for (const member of ranked) {
      const value = read(member);
      if (value !== null && value !== undefined && value !== "") return value;
    }
    return null;
  };
  const attendees: CalendarAttendee[] = [];
  const seen = new Set<string>();
  for (const member of ranked) {
    for (const person of member.attendees ?? []) {
      const email = person.email?.trim().toLowerCase() || null;
      const key = email ?? (person.name?.trim() ? `name:${person.name.trim().toLowerCase()}` : "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      attendees.push({ email, name: person.name?.trim() || null });
    }
  }
  const sources: MergedSource[] = [];
  const listed = new Set<string>();
  for (const member of ranked) {
    const key = `${sourceKey(member)}|${member.eventId ?? member.id}`;
    if (listed.has(key)) continue;
    listed.add(key);
    sources.push({ connector: member.connector, calendarId: member.calendarId ?? null, calendarName: member.calendarName ?? null, eventId: member.eventId ?? null, url: member.url ?? null });
  }
  const days = lead.allDay ? allDaySpan(lead) : null;
  return {
    id: first.id,
    memberIds: members.map((member) => member.id),
    title: (plain ?? lead).title.trim(),
    start: lead.start,
    end: lead.end,
    allDay: lead.allDay,
    startDate: days?.startDate ?? null,
    endDate: days?.endDate ?? null,
    cancelled: Boolean(lead.cancelled),
    joinUrl: pick((member) => (meetingKey(member.joinUrl) ? member.joinUrl : null)) ?? pick((member) => member.joinUrl),
    location: pick((member) => member.location?.trim()),
    hasDescription: members.some((member) => member.hasDescription),
    attendees,
    organizer: pick((member) => member.organizer?.trim().toLowerCase()),
    uid: pick((member) => member.uid?.trim()),
    sources,
  };
}

/** Collapses copies of the same event (rules above). Order is not kept; cancelled duplicates of active events are left out. */
export function dedupeEvents(records: readonly CalendarRecord[]): MergedEvent[] {
  const groups = new Groups(records);
  byUid(records, groups);
  byMeeting(records, groups);
  byTime(records, groups);
  byDay(records, groups);
  const members = new Map<number, CalendarRecord[]>();
  const droppedRoots = new Set<number>();
  records.forEach((record, index) => {
    const root = groups.find(index);
    if (groups.dropped.has(index)) droppedRoots.add(root);
    const list = members.get(root);
    if (list) list.push(record);
    else members.set(root, [record]);
  });
  const out: MergedEvent[] = [];
  for (const [root, list] of members) if (!droppedRoots.has(root)) out.push(merge(list));
  return out;
}
