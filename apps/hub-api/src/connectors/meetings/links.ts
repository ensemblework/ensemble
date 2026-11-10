/**
 * A meeting's series and project, without a model (docs/03 §7): the series key on notes and notes
 * sessions, the project an earlier meeting of the series gives one that has none, and a project set
 * on a meeting carried to its note, its notes session and the open tasks made from it.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { meetingsInSeries, seriesKeyOf } from "../../cowork/series.js";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The project of the newest earlier meeting of the series that has a live one, or null.
 * "" (no series) never links.
 */
export async function seriesProject(
  db: Db,
  userId: string,
  input: { seriesKey: string | null | undefined; before: Date; excludeIds?: Array<string | null | undefined>; personIds?: string[] },
): Promise<string | null> {
  if (!input.seriesKey) return null;
  const rows = await meetingsInSeries(db, userId, {
    seriesKey: input.seriesKey,
    before: input.before,
    excludeIds: (input.excludeIds ?? []).filter((id): id is string => Boolean(id)),
    personIds: input.personIds,
    limit: 5,
  });
  const ids = rows.map((row) => row.projectId).filter((id): id is string => Boolean(id));
  if (!ids.length) return null;
  const live = new Set((await db.project.findMany({ where: { userId, deletedAt: null, id: { in: ids } }, select: { id: true } })).map((row) => row.id));
  return ids.find((id) => live.has(id)) ?? null;
}

/**
 * A meeting's project, set on its note and notes session, and on the open tasks made from the note
 * that have no project yet. Null unlinks the note and session and leaves tasks alone.
 * Returns how many tasks took the project.
 */
export async function propagateMeetingProject(db: Db, userId: string, input: { noteId?: string | null; sessionId?: string | null; projectId: string | null }): Promise<number> {
  const { noteId, sessionId, projectId } = input;
  if (noteId) await db.meetingNote.updateMany({ where: { id: noteId, userId }, data: { projectId } });
  const sessions = [...(sessionId ? [{ id: sessionId }] : []), ...(noteId ? [{ meetingNoteId: noteId }] : [])];
  if (sessions.length) await db.meetingSession.updateMany({ where: { userId, OR: sessions }, data: { projectId } });
  if (!noteId || !projectId) return 0;
  const tasks = await db.task.updateMany({
    where: { userId, meetingNoteId: noteId, projectId: null, deletedAt: null, status: { notIn: ["done", "dropped"] } },
    data: { projectId },
  });
  return tasks.count;
}

/**
 * Series keys for notes and sessions saved before they had one: at most `limit` rows a pass.
 * "" marks a meeting with no series, so it is not read again.
 */
export async function backfillSeriesKeys(db: PrismaClient, limit = 50): Promise<number> {
  const settled = new Date(Date.now() - 60_000);
  const notes = await db.meetingNote.findMany({
    where: { seriesKey: null, createdAt: { lt: settled } },
    select: { id: true, userId: true, title: true, eventArtifactId: true, artifactId: true },
    take: limit,
  });
  for (const note of notes) {
    const key = (await seriesKeyOf(db, note.userId, { artifactId: note.eventArtifactId ?? note.artifactId, title: note.title })) ?? "";
    await db.meetingNote.updateMany({ where: { id: note.id, seriesKey: null }, data: { seriesKey: key } });
  }
  const room = limit - notes.length;
  if (room <= 0) return notes.length;
  const sessions = await db.meetingSession.findMany({
    where: { seriesKey: null, createdAt: { lt: settled } },
    select: { id: true, userId: true, title: true, artifactId: true },
    take: room,
  });
  for (const session of sessions) {
    const key = (await seriesKeyOf(db, session.userId, { artifactId: session.artifactId, title: session.title })) ?? "";
    await db.meetingSession.updateMany({ where: { id: session.id, seriesKey: null }, data: { seriesKey: key } });
  }
  return notes.length + sessions.length;
}
