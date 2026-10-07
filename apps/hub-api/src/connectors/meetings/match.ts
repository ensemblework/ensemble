/**
 * Which calendar event a recorded meeting was (docs/03 §2.3). The vendor's
 * calendar event id wins when it names an event we stored. Otherwise an event
 * must fit in time (half the shorter meeting overlaps, or it starts within ten
 * minutes) and is scored by shared attendees and title words. Two events that
 * score about the same leave the meeting unmatched rather than guessing.
 */
import { prisma } from "../../lib/prisma.js";

export interface MeetingWindow {
  start: Date;
  end: Date | null;
  title: string;
  emails: readonly string[];
  calendarEventId?: string | null;
}

export interface EventCandidate {
  id: string;
  externalId: string;
  /** Provider event id when it differs from externalId (Outlook keeps it in metadata.eventId). */
  eventId?: string | null;
  title: string;
  start: Date;
  end: Date | null;
  emails: readonly string[];
  projectId?: string | null;
  url?: string | null;
}

export interface MatchResult {
  event: EventCandidate | null;
  reason: "event-id" | "scored" | "ambiguous" | "none";
  score: number;
}

const DEFAULT_MS = 30 * 60_000;
export const MIN_OVERLAP = 0.5;
export const START_SLACK_MIN = 10;
/** The best event must beat the next by this much, or the match is ambiguous. */
export const TIE_MARGIN = 0.1;

const STOP = new Set(["the", "a", "an", "and", "or", "of", "for", "to", "with", "on", "in", "at", "by", "meeting", "call", "sync", "weekly", "daily", "re", "fw", "fwd"]);

function words(title: string): Set<string> {
  return new Set(
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 2 && !STOP.has(word)),
  );
}

export function titleSimilarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function span(start: Date, end: Date | null): [number, number] {
  const from = start.getTime();
  const to = end && end.getTime() > from ? end.getTime() : from + DEFAULT_MS;
  return [from, to];
}

/** Overlap as a share of the shorter of the two, and how far apart they start, in minutes. */
export function timeFit(meeting: Pick<MeetingWindow, "start" | "end">, event: Pick<EventCandidate, "start" | "end">): { overlap: number; startGapMin: number; fits: boolean } {
  const [ms, me] = span(meeting.start, meeting.end);
  const [es, ee] = span(event.start, event.end);
  const overlap = Math.max(0, Math.min(me, ee) - Math.max(ms, es)) / Math.min(me - ms, ee - es);
  const startGapMin = Math.abs(ms - es) / 60_000;
  return { overlap, startGapMin, fits: overlap >= MIN_OVERLAP || startGapMin <= START_SLACK_MIN };
}

/** Shared attendees (not counting me) as a share of the smaller list. */
export function attendeeOverlap(a: readonly string[], b: readonly string[], self: ReadonlySet<string>): number {
  const left = new Set(a.map((value) => value.toLowerCase()).filter((value) => value && !self.has(value)));
  const right = new Set(b.map((value) => value.toLowerCase()).filter((value) => value && !self.has(value)));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const email of left) if (right.has(email)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

export function pickEvent(meeting: MeetingWindow, candidates: readonly EventCandidate[], self: ReadonlySet<string> = new Set()): MatchResult {
  const wanted = meeting.calendarEventId?.trim();
  if (wanted) {
    const exact = candidates.find((row) => row.externalId === wanted || row.externalId === `outlook:${wanted}` || row.eventId === wanted);
    if (exact) return { event: exact, reason: "event-id", score: 1 };
  }
  const scored = candidates
    .map((event) => {
      const fit = timeFit(meeting, event);
      if (!fit.fits) return null;
      const timeScore = Math.max(Math.min(1, fit.overlap), fit.startGapMin <= START_SLACK_MIN ? 1 - fit.startGapMin / (2 * START_SLACK_MIN) : 0);
      const people = attendeeOverlap(meeting.emails, event.emails, self);
      const title = titleSimilarity(meeting.title, event.title);
      return { event, people, title, timeScore, score: 0.5 * timeScore + 0.3 * people + 0.2 * title };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return { event: null, reason: "none", score: 0 };
  // Time alone is only enough when nothing else is on the calendar then and the times line up closely.
  const evidence = best.people > 0 || best.title >= 0.3 || (scored.length === 1 && best.timeScore >= 0.8);
  if (!evidence) return { event: null, reason: "none", score: best.score };
  const next = scored[1];
  if (next && best.score - next.score < TIE_MARGIN) return { event: null, reason: "ambiguous", score: best.score };
  return { event: best.event, reason: "scored", score: best.score };
}

type ArtifactRow = { id: string; externalId: string; title: string; ts: Date; url: string | null; participants: unknown; metadata: unknown; projectId: string | null };

function candidate(row: ArtifactRow): EventCandidate {
  const metadata = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>;
  const participants = Array.isArray(row.participants) ? (row.participants as Array<{ email?: unknown }>) : [];
  const end = typeof metadata.end === "string" ? new Date(metadata.end) : null;
  return {
    id: row.id,
    externalId: row.externalId,
    eventId: typeof metadata.eventId === "string" ? metadata.eventId : null,
    title: row.title,
    start: row.ts,
    end: end && !Number.isNaN(end.getTime()) ? end : null,
    emails: [
      ...participants.map((row) => (typeof row.email === "string" ? row.email : "")).filter(Boolean),
      ...(typeof metadata.organizer === "string" ? [metadata.organizer] : []),
    ],
    projectId: row.projectId,
    url: row.url,
  };
}

const SELECT = { id: true, externalId: true, title: true, ts: true, url: true, participants: true, metadata: true, projectId: true } as const;

/** Stored calendar events near the meeting, plus the one its calendar event id names. */
export async function matchEvent(userId: string, meeting: MeetingWindow, self: ReadonlySet<string>): Promise<MatchResult> {
  const window = 12 * 3_600_000;
  const rows = await prisma.artifact.findMany({
    where: { userId, kind: "event", deletedAt: null, ts: { gte: new Date(meeting.start.getTime() - window), lte: new Date(meeting.start.getTime() + window) } },
    select: SELECT,
    orderBy: { ts: "asc" },
    take: 60,
  });
  const wanted = meeting.calendarEventId?.trim();
  if (wanted && !rows.some((row) => row.externalId === wanted || row.externalId === `outlook:${wanted}`)) {
    const exact = await prisma.artifact.findFirst({
      where: { userId, kind: "event", deletedAt: null, externalId: { in: [wanted, `outlook:${wanted}`] } },
      select: SELECT,
    });
    if (exact) rows.push(exact);
  }
  return pickEvent(meeting, rows.map(candidate), self);
}
