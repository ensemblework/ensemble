/**
 * Meeting notes that meeting-notes connectors brought in (docs/03 §2.3), with
 * the vendor's summary, decisions, action items, the calendar event they
 * matched, and the todos proposed from them.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { isMeetingVendor, VENDOR_LABEL } from "../connectors/meetings/types.js";

const NOTE_SELECT = {
  id: true,
  title: true,
  answer: true,
  source: true,
  externalSource: true,
  occurredAt: true,
  askedAt: true,
  personIds: true,
  projectId: true,
  extraction: true,
  eventArtifact: { select: { id: true, title: true, url: true, ts: true, deletedAt: true } },
  transcriptArtifact: { select: { id: true, url: true } },
  project: { select: { id: true, name: true } },
  tasks: { where: { deletedAt: null }, select: { id: true, title: true, status: true }, orderBy: { createdAt: "asc" as const }, take: 50 },
} satisfies Prisma.MeetingNoteSelect;

type NoteRow = Prisma.MeetingNoteGetPayload<{ select: typeof NOTE_SELECT }>;

type Item = { text?: unknown; owner?: { name?: unknown; email?: unknown } | null; mine?: unknown; completed?: unknown; due?: unknown; url?: unknown };

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

function view(row: NoteRow, people: Map<string, string>) {
  const extraction = (row.extraction && typeof row.extraction === "object" ? row.extraction : {}) as Record<string, unknown>;
  const owner = (item: Item) => (item.owner ? { name: text(item.owner.name), email: text(item.owner.email) } : null);
  const vendor = row.externalSource && isMeetingVendor(row.externalSource) ? row.externalSource : null;
  const event = row.eventArtifact && !row.eventArtifact.deletedAt ? row.eventArtifact : null;
  return {
    id: row.id,
    title: row.title,
    source: row.externalSource ?? row.source,
    sourceLabel: vendor ? VENDOR_LABEL[vendor] : row.source,
    occurredAt: (row.occurredAt ?? row.askedAt).toISOString(),
    summary: row.answer.slice(0, 6000),
    decisions: list<unknown>(extraction.decisions).map(text).filter((value): value is string => Boolean(value)),
    actionItems: list<Item>(extraction.actionItems)
      .filter((item) => text(item.text))
      .map((item) => ({ text: String(item.text), owner: owner(item), mine: item.mine === true, completed: item.completed === true, due: text(item.due), url: text(item.url) })),
    waitingOn: list<Item>(extraction.waitingOn)
      .filter((item) => text(item.text))
      .map((item) => ({ text: String(item.text), owner: owner(item) })),
    transcriptUrl: row.transcriptArtifact?.url ?? null,
    event: event ? { id: event.id, title: event.title, url: event.url, startsAt: event.ts.toISOString() } : null,
    project: row.project,
    people: row.personIds.map((id) => ({ id, name: people.get(id) ?? null })).filter((row) => row.name),
    tasks: row.tasks,
  };
}

async function peopleNames(prisma: FastifyInstance["prisma"], userId: string, rows: NoteRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((row) => row.personIds))];
  if (!ids.length) return new Map();
  const people = await prisma.person.findMany({ where: { userId, id: { in: ids }, deletedAt: null }, select: { id: true, name: true } });
  return new Map(people.map((person) => [person.id, person.name]));
}

export async function meetingNoteRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.get("/api/meetings/imported", async (request) => {
    const rows = await prisma.meetingNote.findMany({
      where: { userId: request.userId, deletedAt: null, externalSource: { not: null } },
      select: NOTE_SELECT,
      orderBy: [{ occurredAt: "desc" }, { askedAt: "desc" }],
      take: 50,
    });
    const people = await peopleNames(prisma, request.userId, rows);
    return { notes: rows.map((row) => view(row, people)) };
  });

  app.get("/api/meetings/notes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await prisma.meetingNote.findFirst({ where: { id, userId: request.userId, deletedAt: null }, select: NOTE_SELECT });
    if (!row) return reply.code(404).send({ error: "Meeting note not found." });
    return { note: view(row, await peopleNames(prisma, request.userId, [row])) };
  });
}
