/** Prep, follow-up, recap, and cross-meeting quotes. Notes are typed; voice is not wired. */

const DECISION_RE = /\b(decid(?:e|ed|es)|agreed|agreement|decision|we(?:'ll| will))\b/i;

export function participantNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) names.push(item.trim());
    else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const name = record.name ?? record.displayName ?? record.email;
      if (typeof name === "string" && name.trim()) names.push(name.trim());
    }
  }
  return [...new Set(names)];
}

export function decisionLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0 && DECISION_RE.test(line))
    .slice(0, 8);
}

export type MeetingPhase = "upcoming" | "live" | "follow_up" | "past";

/** Upcoming within 24h, live during the event, follow-up for 36h after it ends. */
export function meetingPhase(start: Date, end: Date | null, now: Date): MeetingPhase {
  const startMs = start.getTime();
  if (Number.isNaN(startMs)) return "past";
  const statedEnd = end && !Number.isNaN(end.getTime()) ? end.getTime() : NaN;
  const endMs = Number.isNaN(statedEnd) || statedEnd <= startMs ? startMs + 60 * 60_000 : statedEnd;
  const nowMs = now.getTime();
  if (nowMs < startMs) return startMs - nowMs <= 24 * 3600_000 ? "upcoming" : "past";
  if (nowMs < endMs) return "live";
  if (nowMs - endMs <= 36 * 3600_000) return "follow_up";
  return "past";
}

export function buildMeetingRecap(input: {
  title: string;
  notes: string;
  attendees: string[];
  decisions: string[];
  openTasks: string[];
}): string {
  const notes = input.notes.trim();
  const lines = [
    input.title,
    input.attendees.length ? `With ${input.attendees.join(", ")}.` : "",
    notes ? notes : "No notes were typed.",
  ];
  if (input.decisions.length) lines.push(`Decisions: ${input.decisions.join("; ")}`);
  if (input.openTasks.length) lines.push(`Still open: ${input.openTasks.join("; ")}`);
  return lines.filter(Boolean).join("\n");
}

export interface CrossMeetingQuery {
  speaker: string | null;
  topic: string | null;
}

export function parseCrossMeetingQuestion(question: string): CrossMeetingQuery | null {
  const text = question.trim().replace(/[?.!]+$/g, "");
  const patterns = [
    /^(?:please\s+)?summarize\s+what\s+(.+?)\s+said\s+about\s+(.+)$/i,
    /^what\s+(?:did\s+)?(.+?)\s+say\s+about\s+(.+)$/i,
    /^what\s+(.+?)\s+said\s+about\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const speaker = match[1]?.trim() ?? "";
    const topic = match[2]?.trim() ?? "";
    if (!speaker || !topic) continue;
    return { speaker, topic };
  }
  return null;
}

export interface NoteQuote {
  text: string;
  title: string;
  href: string;
}

function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
}

export function extractiveAnswer(
  notes: Array<{ title: string; text: string; href: string }>,
  query: CrossMeetingQuery,
): { answer: string; quotes: NoteQuote[] } {
  const speaker = query.speaker?.toLowerCase() ?? "";
  const topic = query.topic?.toLowerCase() ?? "";
  const quotes: NoteQuote[] = [];
  for (const note of notes) {
    const blob = `${note.title}\n${note.text}`.toLowerCase();
    if (speaker && !blob.includes(speaker)) continue;
    for (const sentence of sentences(note.text)) {
      const hay = sentence.toLowerCase();
      if (topic && !hay.includes(topic)) continue;
      if (!topic && speaker && !hay.includes(speaker) && !note.title.toLowerCase().includes(speaker)) continue;
      quotes.push({ text: sentence, title: note.title, href: note.href });
      if (quotes.length >= 8) break;
    }
    if (quotes.length >= 8) break;
  }
  if (!quotes.length) {
    const who = query.speaker && query.topic ? `${query.speaker} about ${query.topic}` : "that";
    return { answer: `I couldn't find notes about ${who}.`, quotes: [] };
  }
  const lead =
    query.speaker && query.topic
      ? `From your meeting notes, here is what mentions ${query.speaker} on ${query.topic}.`
      : "From your meeting notes:";
  return { answer: lead, quotes };
}

export const CALENDAR_WRITE_MESSAGE =
  "Saved on this event inside Ensemble. Calendar apps are read-only today, so the notes were not written back to Google or Outlook.";
