/**
 * Meeting notes that came from outside Ensemble's own editor (docs/03 §2.3, §2.4): meeting-notes
 * connectors, transcript files and pastes, and transcripts fetched from Teams, Google Meet and
 * Zoom. Each has the source's summary, decisions, action items, the calendar event it matched,
 * the people in it, the whole transcript, and the tasks made from it.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { catalogWithState } from "../connectors/catalog.js";
import { itemKey } from "../connectors/meetings/actions.js";
import { MEETING_SOURCES } from "../connectors/meetings/index.js";
import { importMeetMeeting, listMeetMeetings } from "../connectors/meetings/google-meet.js";
import { REMOTE, REMOTE_PROVIDERS, MeetingFetchProblem, providerForUrl, type RemoteProvider } from "../connectors/meetings/remote.js";
import { importRequestedMeetings } from "../connectors/meetings/requested-import.js";
import { importTeamsMeeting, listTeamsMeetings } from "../connectors/meetings/teams.js";
import { importTranscript, previewTranscript, transcriptFileLimit, TranscriptError } from "../connectors/meetings/transcript-import.js";
import { readTranscript } from "../connectors/meetings/transcript-parse.js";
import { isMeetingVendor, MEETING_VENDORS, originLabel } from "../connectors/meetings/types.js";
import { importZoomMeeting, listZoomMeetings } from "../connectors/meetings/zoom.js";
import { ConnectorError } from "../connectors/types.js";
import { createTask } from "../services/tasks.js";
import { lastUndoId } from "../lib/undo.js";

export const NOTE_SELECT = {
  id: true,
  title: true,
  answer: true,
  source: true,
  externalSource: true,
  externalId: true,
  occurredAt: true,
  askedAt: true,
  personIds: true,
  projectId: true,
  extraction: true,
  eventArtifact: { select: { id: true, title: true, url: true, ts: true, deletedAt: true } },
  transcriptArtifact: { select: { id: true, url: true } },
  project: { select: { id: true, name: true } },
  tasks: { where: { deletedAt: null }, select: { id: true, title: true, status: true, sourceRef: true }, orderBy: { createdAt: "asc" as const }, take: 50 },
} satisfies Prisma.MeetingNoteSelect;

export type NoteRow = Prisma.MeetingNoteGetPayload<{ select: typeof NOTE_SELECT }>;

type Item = { text?: unknown; owner?: { name?: unknown; email?: unknown } | null; mine?: unknown; completed?: unknown; due?: unknown; url?: unknown; at?: unknown };

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Where a note came from, as people say it: the vendor, the meeting app, or the kind of file. */
function sourceLabel(row: Pick<NoteRow, "externalSource" | "source">, extraction: Record<string, unknown>): string {
  if (row.externalSource === "transcript") return text(extraction.formatLabel) ?? (row.source === "paste" ? "Pasted transcript" : "Transcript file");
  return row.externalSource ? originLabel(row.externalSource) : row.source;
}

/** An imported note as the Meetings page and the assistant show it. */
export function importedNoteView(row: NoteRow, people: Map<string, string>) {
  const extraction = (row.extraction && typeof row.extraction === "object" ? row.extraction : {}) as Record<string, unknown>;
  const owner = (item: Item) => (item.owner ? { name: text(item.owner.name), email: text(item.owner.email) } : null);
  const event = row.eventArtifact && !row.eventArtifact.deletedAt ? row.eventArtifact : null;
  const duration = count(extraction.durationSeconds);
  const madeFrom = new Map(row.tasks.filter((task) => task.sourceRef).map((task) => [task.sourceRef!, task.id]));
  const key = (value: string) => `meeting:${row.externalSource ?? row.source}:${row.externalId ?? row.id}:${itemKey(value)}`;
  return {
    id: row.id,
    title: row.title,
    source: row.externalSource ?? row.source,
    sourceLabel: sourceLabel(row, extraction),
    occurredAt: (row.occurredAt ?? row.askedAt).toISOString(),
    summary: row.answer.slice(0, 6000),
    decisions: list<unknown>(extraction.decisions).map(text).filter((value): value is string => Boolean(value)),
    actionItems: list<Item>(extraction.actionItems)
      .filter((item) => text(item.text))
      .map((item) => ({
        text: String(item.text),
        owner: owner(item),
        mine: item.mine === true,
        completed: item.completed === true,
        due: text(item.due),
        url: text(item.url),
        at: text(item.at),
        taskId: madeFrom.get(key(String(item.text))) ?? null,
      })),
    waitingOn: list<Item>(extraction.waitingOn)
      .filter((item) => text(item.text))
      .map((item) => ({ text: String(item.text), owner: owner(item) })),
    /** Decisions and action items were found by phrases in what was said, not written by a tool. */
    suggested: extraction.suggested === true,
    speakers: list<unknown>(extraction.speakers).map(text).filter((value): value is string => Boolean(value)),
    lineCount: count(extraction.lineCount) ?? 0,
    durationMinutes: duration ? Math.max(1, Math.round(duration / 60)) : null,
    format: text(extraction.format),
    transcriptUrl: row.transcriptArtifact?.url ?? null,
    event: event ? { id: event.id, title: event.title, url: event.url, startsAt: event.ts.toISOString() } : null,
    project: row.project,
    people: row.personIds.map((id) => ({ id, name: people.get(id) ?? null })).filter((row) => row.name),
    tasks: row.tasks.map(({ id, title, status }) => ({ id, title, status })),
  };
}

export async function peopleNames(prisma: FastifyInstance["prisma"], userId: string, rows: NoteRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((row) => row.personIds))];
  if (!ids.length) return new Map();
  const people = await prisma.person.findMany({ where: { userId, id: { in: ids }, deletedAt: null }, select: { id: true, name: true } });
  return new Map(people.map((person) => [person.id, person.name]));
}

const TranscriptBody = z.object({
  filename: z.string().trim().max(300).nullish(),
  text: z.string().nullish(),
  dataBase64: z.string().nullish(),
});

const ImportBody = TranscriptBody.extend({
  title: z.string().trim().max(300).nullish(),
  occurredAt: z.string().datetime({ offset: true }).nullish(),
  eventId: z.string().uuid().nullish(),
  addPeople: z.array(z.string().trim().min(1).max(120)).max(40).optional(),
}).strict();

const RemoteImportBody = z
  .object({
    ref: z.string().trim().min(1).max(2000).optional(),
    eventId: z.string().uuid().optional(),
    title: z.string().trim().max(300).optional(),
    start: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((value) => value.ref || value.eventId, "Send the meeting (ref) or the calendar event (eventId).");

/** Base64 grows a file by a third; the JSON around it is small. */
const uploadLimit = () => Math.ceil(transcriptFileLimit() * 1.4) + 64 * 1024;

const isUrl = (value: string) => /^https:\/\//i.test(value);

async function fetchOne(userId: string, provider: RemoteProvider, input: { ref?: string; eventId?: string | null; joinUrl?: string | null; title?: string | null; start?: Date | null }): Promise<string> {
  if (provider === "teams") return importTeamsMeeting(userId, { joinUrl: input.joinUrl ?? input.ref ?? "", eventId: input.eventId, title: input.title });
  if (provider === "google_meet") {
    return importMeetMeeting(userId, { record: input.ref && !isUrl(input.ref) ? input.ref : null, joinUrl: input.joinUrl ?? (input.ref && isUrl(input.ref) ? input.ref : null), start: input.start, eventId: input.eventId, title: input.title });
  }
  return importZoomMeeting(userId, { ref: input.ref && !isUrl(input.ref) ? input.ref : null, joinUrl: input.joinUrl ?? (input.ref && isUrl(input.ref) ? input.ref : null), eventId: input.eventId, title: input.title, start: input.start });
}

export async function meetingNoteRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  const noteById = async (userId: string, id: string) => {
    const row = await prisma.meetingNote.findFirst({ where: { id, userId, deletedAt: null }, select: NOTE_SELECT });
    return row ? importedNoteView(row, await peopleNames(prisma, userId, [row])) : null;
  };

  app.get("/api/meetings/imported", async (request) => {
    const rows = await prisma.meetingNote.findMany({
      where: { userId: request.userId, deletedAt: null, externalSource: { not: null } },
      select: NOTE_SELECT,
      orderBy: [{ occurredAt: "desc" }, { askedAt: "desc" }],
      take: 50,
    });
    const people = await peopleNames(prisma, request.userId, rows);
    return { notes: rows.map((row) => importedNoteView(row, people)) };
  });

  app.get("/api/meetings/notes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await prisma.meetingNote.findFirst({ where: { id, userId: request.userId, deletedAt: null }, select: { ...NOTE_SELECT, prompt: true } });
    if (!row) return reply.code(404).send({ error: "Meeting note not found." });
    const { prompt, ...note } = row;
    // Notes typed in Ensemble keep their text in the session; only imported notes carry a transcript.
    const transcript = row.externalSource && prompt.trim() ? readTranscript(prompt) : [];
    return { note: { ...importedNoteView(note, await peopleNames(prisma, request.userId, [note])), transcript } };
  });

  app.post("/api/meetings/transcripts/preview", { bodyLimit: uploadLimit() }, async (request) => {
    const body = TranscriptBody.strict().parse(request.body);
    return { preview: await previewTranscript(request.userId, body) };
  });

  app.post("/api/meetings/transcripts", { bodyLimit: uploadLimit() }, async (request, reply) => {
    const { title, occurredAt, eventId, addPeople, ...input } = ImportBody.parse(request.body);
    const id = await importTranscript(request.userId, input, { title, occurredAt, eventId, addPeople });
    return reply.code(201).send({ note: await noteById(request.userId, id) });
  });

  app.delete("/api/meetings/notes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await prisma.meetingNote.findFirst({ where: { id, userId: request.userId, deletedAt: null, externalSource: { not: null } }, select: { id: true, transcriptArtifactId: true } });
    if (!row) return reply.code(404).send({ error: "Meeting note not found." });
    const now = new Date();
    await prisma.$transaction([
      prisma.meetingNote.update({ where: { id: row.id }, data: { deletedAt: now } }),
      ...(row.transcriptArtifactId ? [prisma.artifact.updateMany({ where: { id: row.transcriptArtifactId, userId: request.userId, deletedAt: null }, data: { deletedAt: now } })] : []),
    ]);
    return { deleted: true };
  });

  app.post("/api/meetings/notes/:id/restore", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await prisma.meetingNote.findFirst({ where: { id, userId: request.userId, deletedAt: { not: null }, externalSource: { not: null } }, select: { id: true, deletedAt: true, transcriptArtifactId: true } });
    if (!row) return reply.code(404).send({ error: "Meeting note not found." });
    await prisma.$transaction([
      prisma.meetingNote.update({ where: { id: row.id }, data: { deletedAt: null } }),
      ...(row.transcriptArtifactId ? [prisma.artifact.updateMany({ where: { id: row.transcriptArtifactId, userId: request.userId, deletedAt: row.deletedAt }, data: { deletedAt: null } })] : []),
    ]);
    return { note: await noteById(request.userId, row.id) };
  });

  /** One action item → a task on the board that cites the meeting. Asking twice returns the same task. */
  app.post("/api/meetings/notes/:id/tasks", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ text: z.string().trim().min(3).max(500), owner: z.string().trim().max(120).nullish() }).strict().parse(request.body);
    const note = await prisma.meetingNote.findFirst({
      where: { id, userId: request.userId, deletedAt: null },
      select: { id: true, title: true, source: true, externalSource: true, externalId: true, occurredAt: true, askedAt: true, projectId: true, personIds: true },
    });
    if (!note) return reply.code(404).send({ error: "Meeting note not found." });
    const sourceRef = `meeting:${note.externalSource ?? note.source}:${note.externalId ?? note.id}:${itemKey(body.text)}`;
    const existing = await prisma.task.findFirst({ where: { userId: request.userId, sourceRef, deletedAt: null }, select: { id: true, title: true, status: true } });
    if (existing) return { task: existing, created: false };
    const people = body.owner
      ? await prisma.person.findMany({ where: { userId: request.userId, deletedAt: null, id: { in: note.personIds }, name: { equals: body.owner, mode: "insensitive" } }, select: { id: true }, take: 1 })
      : [];
    const when = (note.occurredAt ?? note.askedAt).toISOString().slice(0, 10);
    const created = await prisma.$transaction(async (tx) => {
      const task = await createTask(
        tx,
        request.userId,
        {
          title: body.text.replace(/[.\s]+$/, "").slice(0, 200),
          description: `From the meeting “${note.title}” (${when})${body.owner ? `, for ${body.owner}` : ""}.`,
          owner: "me",
          status: "todo",
          sourceKind: "meeting",
          sourceRef,
          projectId: note.projectId,
          people: people.map((row) => row.id),
        },
        "me",
      );
      await tx.task.update({ where: { id: task.id }, data: { meetingNoteId: note.id } });
      return { task: { id: task.id, title: task.title, status: task.status }, undoEntryId: lastUndoId(tx) ?? null };
    });
    return reply.code(201).send({ ...created, created: true });
  });

  /** Every way to bring a meeting in, and whether each is ready for this person. */
  app.get("/api/meetings/sources", async (request) => {
    const entries = await catalogWithState(prisma, request.userId);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const apps = REMOTE_PROVIDERS.map((id) => {
      const spec = REMOTE[id];
      const entry = byId.get(spec.connector);
      const product = spec.product ? entry?.state.products?.[spec.product] ?? false : true;
      const waiting = spec.product ? entry?.state.needsConsent?.includes(spec.product) ?? false : false;
      const state = !entry?.state.connected ? "not_connected" : !product || waiting ? "needs_access" : "ready";
      return { id, label: spec.label, connector: spec.connector, product: spec.product, productLabel: spec.productLabel, state, available: Boolean(entry?.state.oauthReady), account: entry?.state.account ?? null };
    });
    const vendors = MEETING_SOURCES.map((source) => {
      const entry = byId.get(source.id);
      return { id: source.id, label: source.label, connected: Boolean(entry?.state.connected), account: entry?.state.account ?? null, available: Boolean(entry?.state.appReady ?? true) };
    });
    const google = byId.get("google_workspace")?.state;
    const microsoft = byId.get("microsoft_365")?.state;
    const calendar = Boolean((google?.connected && google.products?.calendar) || (microsoft?.connected && microsoft.products?.outlook_calendar));
    return { apps, vendors, calendar, fileLimitBytes: transcriptFileLimit() };
  });

  /** A meeting-notes app's recent meetings, on request (the same import the assistant offers). */
  app.post("/api/meetings/vendors/:vendor/import", async (request, reply) => {
    const { vendor } = request.params as { vendor: string };
    if (!isMeetingVendor(vendor)) return reply.code(404).send({ error: `Unknown meeting app. Use one of: ${MEETING_VENDORS.join(", ")}.` });
    const body = z.object({ days: z.number().int().min(1).max(90).default(30) }).strict().parse(request.body ?? {});
    try {
      return await importRequestedMeetings(request.userId, vendor, new Date(Date.now() - body.days * 86_400_000), false);
    } catch (error) {
      if (error instanceof ConnectorError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/meetings/remote/:provider", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (!(REMOTE_PROVIDERS as readonly string[]).includes(provider)) return reply.code(404).send({ error: "Unknown meeting app." });
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(30).default(14) }).parse(request.query);
    try {
      const meetings = provider === "teams" ? await listTeamsMeetings(request.userId, days) : provider === "google_meet" ? await listMeetMeetings(request.userId, days) : await listZoomMeetings(request.userId, days);
      return { meetings, problem: null };
    } catch (error) {
      if (error instanceof MeetingFetchProblem) return { meetings: [], problem: error.problem };
      throw error;
    }
  });

  app.post("/api/meetings/remote/:provider/import", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (!(REMOTE_PROVIDERS as readonly string[]).includes(provider)) return reply.code(404).send({ error: "Unknown meeting app." });
    const body = RemoteImportBody.parse(request.body);
    let event: { id: string; joinUrl: string | null; title: string; ts: Date } | null = null;
    if (body.eventId) {
      const row = await prisma.artifact.findFirst({ where: { id: body.eventId, userId: request.userId, kind: "event", deletedAt: null }, select: { id: true, title: true, ts: true, metadata: true } });
      if (!row) return reply.code(404).send({ error: "That calendar event was not found." });
      const joinUrl = (row.metadata as { joinUrl?: unknown })?.joinUrl;
      event = { id: row.id, title: row.title, ts: row.ts, joinUrl: typeof joinUrl === "string" ? joinUrl : null };
    }
    try {
      const id = await fetchOne(request.userId, provider as RemoteProvider, {
        ref: body.ref,
        eventId: event?.id ?? null,
        joinUrl: event?.joinUrl ?? null,
        title: body.title ?? event?.title ?? null,
        start: body.start ? new Date(body.start) : event?.ts ?? null,
      });
      return { ok: true, note: await noteById(request.userId, id), problem: null };
    } catch (error) {
      if (error instanceof MeetingFetchProblem) return { ok: false, note: null, problem: error.problem };
      throw error;
    }
  });

  /** "Get transcript" on a calendar meeting: the app is the one its join link belongs to. */
  app.post("/api/meetings/events/:id/transcript", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await prisma.artifact.findFirst({ where: { id, userId: request.userId, kind: "event", deletedAt: null }, select: { id: true, title: true, ts: true, metadata: true } });
    if (!row) return reply.code(404).send({ error: "That calendar event was not found." });
    const joinUrl = (row.metadata as { joinUrl?: unknown })?.joinUrl;
    const provider = providerForUrl(typeof joinUrl === "string" ? joinUrl : null);
    if (!provider) throw new TranscriptError("This event has no Teams, Google Meet or Zoom link, so there is no transcript to fetch. Upload or paste one instead.", 422);
    try {
      const noteId = await fetchOne(request.userId, provider, { eventId: row.id, joinUrl: joinUrl as string, title: row.title, start: row.ts });
      return { ok: true, note: await noteById(request.userId, noteId), problem: null };
    } catch (error) {
      if (error instanceof MeetingFetchProblem) return { ok: false, note: null, problem: error.problem };
      throw error;
    }
  });
}
