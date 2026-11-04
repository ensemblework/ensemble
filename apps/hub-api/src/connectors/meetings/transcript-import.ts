/**
 * A transcript the person uploads or pastes, or one fetched from the meeting app for one
 * meeting (docs/03 §2.4), saved the way meeting-notes vendors are: the transcript, the people
 * who spoke, the calendar event, decisions and action items (meetings/ingest.ts).
 */
import { createHash } from "node:crypto";
import { decodeText, readFileText } from "../../files/extract.js";
import { maxFileBytes } from "../../files/store.js";
import { zonedDateTimeToUtc } from "../../lib/clock.js";
import { requireVerifiedUser } from "../../lib/hosted-access.js";
import { prisma } from "../../lib/prisma.js";
import { loadSettings } from "../../lib/settings.js";
import { normalisedName } from "../../people/identity.js";
import { isGuestIn } from "../../sharing/context.js";
import { isMine } from "./actions.js";
import { ingestMeetings, whoAmI } from "./ingest.js";
import { FORMAT_LABEL, parseTranscript, speakersOf, transcriptDocument, type ParsedTranscript, type TranscriptFormat } from "./transcript-parse.js";
import type { MeetingPerson, MeetingRecord, TranscriptLine, TranscriptOrigin } from "./types.js";

const MIB = 1024 * 1024;
/** Transcript files are text: even a full day of captions is a few megabytes. */
export const TRANSCRIPT_FILE_MAX_BYTES = 10 * MIB;
export const TRANSCRIPT_PASTE_MAX_CHARS = 2_000_000;
export const TRANSCRIPT_EXTENSIONS = ["vtt", "srt", "txt", "text", "md", "docx", "json"] as const;

export class TranscriptError extends Error {
  readonly expose = true;
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export interface TranscriptInput {
  filename?: string | null;
  text?: string | null;
  dataBase64?: string | null;
}

export function transcriptFileLimit(): number {
  return Math.min(maxFileBytes(), TRANSCRIPT_FILE_MAX_BYTES);
}

/** The text of an uploaded file or a paste. Word files are read in the file worker (files/extract.ts). */
export async function transcriptText(input: TranscriptInput): Promise<{ text: string; filename: string | null }> {
  const filename = input.filename?.trim() || null;
  if (input.dataBase64) {
    const ext = /\.([a-z0-9]+)$/i.exec(filename ?? "")?.[1]?.toLowerCase() ?? "";
    if (ext === "doc") throw new TranscriptError("Save the transcript as .docx (Word: File → Save As), then upload it.");
    if (!(TRANSCRIPT_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new TranscriptError("Ensemble reads transcripts saved as .vtt, .srt, .txt, .docx or .json. Save it as one of those, or paste the text.");
    }
    const bytes = new Uint8Array(Buffer.from(input.dataBase64, "base64"));
    const limit = transcriptFileLimit();
    if (bytes.byteLength > limit) throw new TranscriptError(`That file is ${(bytes.byteLength / MIB).toFixed(1)} MB. Transcripts up to ${Math.round(limit / MIB)} MB can be imported.`, 413);
    if (!bytes.byteLength) throw new TranscriptError("That file is empty.");
    if (ext === "docx") {
      const read = await readFileText(filename!, bytes);
      if (read.status !== "ready") throw new TranscriptError(read.warnings[0] ?? "Ensemble couldn't read that Word file. Save it again as .docx, or paste the text.", 422);
      return { text: read.text, filename };
    }
    return { text: decodeText(bytes), filename };
  }
  const text = input.text ?? "";
  if (text.length > TRANSCRIPT_PASTE_MAX_CHARS) throw new TranscriptError(`That is ${text.length.toLocaleString("en-US")} characters. Paste up to ${TRANSCRIPT_PASTE_MAX_CHARS.toLocaleString("en-US")}, or upload the file.`, 413);
  if (!text.trim()) throw new TranscriptError("Paste the transcript text first.");
  return { text, filename };
}

function readable(parsed: ParsedTranscript): ParsedTranscript {
  if (!parsed.lines.length) throw new TranscriptError("Ensemble couldn't find what was said in that. Check it is the transcript, not the recording or the chat.", 422);
  return parsed;
}

const OFFSET = /([+-])(\d{1,2})(?::?(\d{2}))?/;

/** When the meeting started: a stated instant, a written date and time (in the person's time zone unless the file names one), or unknown. */
export function meetingStart(parsed: Pick<ParsedTranscript, "startedAt" | "when">, timeZone: string): Date | null {
  if (parsed.startedAt) return parsed.startedAt;
  const when = parsed.when;
  if (!when) return null;
  const time = when.time ?? "12:00";
  if (when.zone) {
    const offset = OFFSET.exec(when.zone);
    const minutes = offset ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3] ?? 0)) : 0;
    const at = new Date(`${when.date}T${time}:00Z`);
    return Number.isNaN(at.getTime()) ? null : new Date(at.getTime() - minutes * 60_000);
  }
  try {
    return zonedDateTimeToUtc(when.date, time, timeZone);
  } catch {
    return null;
  }
}

type PersonRow = { id: string; name: string; email: string | null };

/** An existing person with this name or address; a lone first name only when one person has it. */
export function matchPerson(name: string, people: readonly PersonRow[]): PersonRow | null {
  const wanted = normalisedName(name);
  if (!wanted) return null;
  const lower = name.trim().toLowerCase();
  const exact = people.find((person) => normalisedName(person.name) === wanted || person.email?.toLowerCase() === lower);
  if (exact) return exact;
  if (wanted.includes(" ")) return null;
  const first = people.filter((person) => normalisedName(person.name).split(" ")[0] === wanted);
  return first.length === 1 ? first[0]! : null;
}

async function owner(userId: string): Promise<void> {
  if (isGuestIn(userId)) throw new TranscriptError("Import meeting transcripts in a space you own.", 403);
  await requireVerifiedUser(userId);
}

export interface TranscriptPreview {
  format: TranscriptFormat;
  formatLabel: string;
  title: string | null;
  startedAt: string | null;
  durationMinutes: number | null;
  speakers: Array<{ name: string; turns: number; me: boolean; person: { id: string; name: string } | null }>;
  attendees: string[];
  lineCount: number;
  sample: TranscriptLine[];
  actionItems: number;
  decisions: number;
  /** Decisions and action items were found by phrases in what was said. */
  suggested: boolean;
  hasSummary: boolean;
  warnings: string[];
}

export async function previewTranscript(userId: string, input: TranscriptInput): Promise<TranscriptPreview> {
  await owner(userId);
  const { text, filename } = await transcriptText(input);
  const parsed = readable(parseTranscript(text, filename));
  const [settings, people] = await Promise.all([
    loadSettings(prisma, userId),
    prisma.person.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true, email: true }, take: 5000 }),
  ]);
  const me = await whoAmI(userId, settings.email);
  const start = meetingStart(parsed, settings.timezone);
  return {
    format: parsed.format,
    formatLabel: FORMAT_LABEL[parsed.format],
    title: parsed.title,
    startedAt: start?.toISOString() ?? null,
    durationMinutes: parsed.durationSeconds ? Math.max(1, Math.round(parsed.durationSeconds / 60)) : null,
    speakers: speakersOf(parsed.lines).slice(0, 40).map((speaker) => {
      const mine = isMine({ name: speaker.name }, me);
      const person = mine ? null : matchPerson(speaker.name, people);
      return { ...speaker, me: mine, person: person ? { id: person.id, name: person.name } : null };
    }),
    attendees: parsed.attendees.slice(0, 40),
    lineCount: parsed.lines.length,
    sample: parsed.lines.slice(0, 6),
    actionItems: parsed.actionItems.length,
    decisions: parsed.decisions.length,
    suggested: parsed.suggested,
    hasSummary: Boolean(parsed.summary),
    warnings: parsed.warnings,
  };
}

export interface SaveChoices {
  origin: TranscriptOrigin;
  externalId: string;
  source: "upload" | "paste" | "connector";
  title?: string | null;
  start?: Date | null;
  end?: Date | null;
  url?: string | null;
  eventArtifactId?: string | null;
  attendees?: MeetingPerson[];
  organizer?: string | null;
  /** Speakers the person asked to add to People. */
  addPeople?: readonly string[];
  extra?: Record<string, unknown>;
}

type EventRow = { id: string; title: string; ts: Date; participants: unknown; metadata: unknown };

async function eventFor(userId: string, id: string | null | undefined): Promise<EventRow | null> {
  if (!id) return null;
  const event = await prisma.artifact.findFirst({ where: { id, userId, kind: "event", deletedAt: null }, select: { id: true, title: true, ts: true, participants: true, metadata: true } });
  if (!event) throw new TranscriptError("That calendar event was not found.", 404);
  return event;
}

const participantsOf = (event: EventRow | null): MeetingPerson[] =>
  Array.isArray(event?.participants)
    ? (event.participants as Array<{ name?: unknown; email?: unknown }>).map((row) => ({ name: typeof row.name === "string" ? row.name : null, email: typeof row.email === "string" ? row.email : null })).filter((row) => row.email || row.name)
    : [];

/**
 * Saves one parsed transcript as a meeting note. Speakers become the note's people: by the
 * calendar event's attendee with that name, by an existing person, or as a new person when
 * the person asked for it. Returns the note's id.
 */
export async function saveTranscript(userId: string, parsed: ParsedTranscript, choices: SaveChoices): Promise<string> {
  const [settings, event] = await Promise.all([loadSettings(prisma, userId), eventFor(userId, choices.eventArtifactId)]);
  const people = await prisma.person.findMany({ where: { userId, deletedAt: null }, select: { id: true, name: true, email: true }, take: 5000 });
  const me = await whoAmI(userId, settings.email);
  const invited = [...participantsOf(event), ...(choices.attendees ?? [])];
  const personIds: string[] = [];
  const speakers: MeetingPerson[] = speakersOf(parsed.lines).map(({ name }) => {
    if (isMine({ name }, me)) return { name };
    const guest = matchPerson(name, invited.filter((row): row is PersonRow => Boolean(row.name)).map((row) => ({ id: row.email ?? row.name!, name: row.name!, email: row.email ?? null })));
    if (guest?.email) return { name, email: guest.email };
    const person = matchPerson(name, people);
    if (person && !personIds.includes(person.id)) personIds.push(person.id);
    return { name };
  });
  for (const name of choices.addPeople ?? []) {
    const clean = name.trim().replace(/\s+/g, " ").slice(0, 120);
    if (!clean || isMine({ name: clean }, me) || !speakers.some((row) => row.name === name)) continue;
    const existing = matchPerson(clean, people);
    const id = existing?.id ?? (await prisma.person.create({ data: { userId, name: clean }, select: { id: true } })).id;
    if (!personIds.includes(id)) personIds.push(id);
  }
  const start = choices.start ?? event?.ts ?? meetingStart(parsed, settings.timezone) ?? new Date();
  const eventEnd = event && typeof (event.metadata as { end?: unknown })?.end === "string" ? new Date((event.metadata as { end: string }).end) : null;
  const end = choices.end ?? (parsed.durationSeconds ? new Date(start.getTime() + parsed.durationSeconds * 1000) : eventEnd && !Number.isNaN(eventEnd.getTime()) ? eventEnd : null);
  const record: MeetingRecord = {
    id: choices.externalId,
    title: (choices.title?.trim() || event?.title || parsed.title || "Meeting transcript").slice(0, 300),
    start,
    end,
    url: choices.url ?? null,
    organizer: choices.organizer ?? null,
    attendees: [...invited, ...parsed.attendees.map((name) => ({ name }))],
    speakers,
    transcript: parsed.lines,
    summary: parsed.summary,
    decisions: parsed.decisions,
    actionItems: parsed.actionItems,
    extra: { format: parsed.format, ...(choices.extra ?? {}) },
  };
  const result = await ingestMeetings({ userId, settings, since: start, cursor: null }, choices.origin, [record], null, {
    source: choices.source === "connector" ? "connector" : choices.source,
    eventArtifactId: event?.id ?? null,
    personIds,
    revive: true,
    extraction: { format: parsed.format, formatLabel: FORMAT_LABEL[parsed.format], suggested: parsed.suggested, ...(choices.extra ?? {}) },
  });
  const id = result.noteIds[0];
  if (!id) throw new TranscriptError("This transcript was removed from Ensemble earlier, so it was not imported again.", 409);
  return id;
}

/** A stable id for a file's transcript, so importing the same file again updates its note. */
export function transcriptKey(parsed: ParsedTranscript): string {
  return createHash("sha256").update(transcriptDocument(parsed.lines)).digest("hex").slice(0, 24);
}

export interface ImportChoices {
  title?: string | null;
  occurredAt?: string | null;
  eventId?: string | null;
  addPeople?: string[];
}

/** Upload or paste → meeting note. */
export async function importTranscript(userId: string, input: TranscriptInput, choices: ImportChoices = {}): Promise<string> {
  await owner(userId);
  const { text, filename } = await transcriptText(input);
  const parsed = readable(parseTranscript(text, filename));
  const start = choices.occurredAt ? new Date(choices.occurredAt) : null;
  if (start && Number.isNaN(start.getTime())) throw new TranscriptError("That date is not valid.");
  return saveTranscript(userId, parsed, {
    origin: "transcript",
    externalId: transcriptKey(parsed),
    source: input.dataBase64 ? "upload" : "paste",
    title: choices.title,
    start,
    eventArtifactId: choices.eventId ?? null,
    addPeople: choices.addPeople,
    extra: filename ? { filename: filename.slice(0, 200) } : {},
  });
}
