import { morningBriefView } from "../routines/service.js";
import { accountIdOf } from "../lib/auth.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PageDocument } from "@ensemble/shared-types";
import {
  actOnNudge,
  askEnsemble,
  attachMeetingNotes,
  commitQuickCapture,
  declineMeetingAttach,
  endMeetingSession,
  ensureStaleNotice,
  getMeetingSession,
  listMeetingCues,
  listMeetingSessions,
  listNotifications,
  listNudges,
  markAllNotificationsRead,
  markNotificationRead,
  previewQuickCapture,
  refreshMeetingRecap,
  suggestFromSession,
  saveMeetingNotes,
  startMeetingSession,
  summarizeMeetings,
  trashMeetingSession,
  weeklyRecap,
  setMeetingProject,
} from "../cowork/service.js";

const textBody = z.object({ text: z.string().min(1).max(2000) });

export async function coworkRoutes(app: FastifyInstance): Promise<void> {
  const db = app.prisma;

  app.get("/api/notifications", async (request) => ({ notifications: await listNotifications(db, request.userId) }));

  app.post("/api/notifications/read", async (request) => {
    const body = z.object({ ids: z.array(z.string().uuid()).max(200).optional() }).nullish().parse(request.body);
    return markAllNotificationsRead(db, request.userId, body?.ids);
  });

  app.post("/api/notifications/:id/read", async (request) => {
    const { id } = request.params as { id: string };
    return markNotificationRead(db, request.userId, id);
  });

  app.get("/api/brief/today", async (request) => morningBriefView(db, request.userId));

  app.post("/api/capture/preview", async (request) => {
    const body = textBody.parse(request.body);
    const parsed = await previewQuickCapture(db, request.userId, body.text);
    return { parsed };
  });

  app.post("/api/capture", async (request, reply) => {
    const body = textBody.parse(request.body);
    const created = await commitQuickCapture(db, request.userId, body.text);
    return reply.code(201).send(created);
  });

  app.get("/api/meetings/cues", async (request) => listMeetingCues(db, request.userId));

  app.get("/api/meetings/sessions", async (request) => listMeetingSessions(db, request.userId));

  app.get("/api/meetings/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    return getMeetingSession(db, request.userId, id);
  });

  app.post("/api/meetings/sessions", async (request, reply) => {
    const body = z.object({ artifactId: z.string().nullable().optional(), title: z.string().max(200).optional(), projectId: z.string().uuid().nullable().optional() }).parse(request.body ?? {});
    const created = await startMeetingSession(db, request.userId, body);
    return reply.code(201).send(created);
  });

  app.patch("/api/meetings/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({ notes: z.string().max(100_000).optional(), content: PageDocument.optional(), title: z.string().trim().min(1).max(200).optional(), projectId: z.string().uuid().nullable().optional() })
      .strict()
      .refine((value) => value.notes !== undefined || value.content !== undefined || value.title !== undefined || value.projectId !== undefined, "Supply notes, content, a title or a project.")
      .parse(request.body);
    const { projectId, ...notes } = body;
    if (projectId !== undefined && notes.notes === undefined && notes.content === undefined && notes.title === undefined) return setMeetingProject(db, request.userId, id, projectId);
    if (projectId !== undefined) await setMeetingProject(db, request.userId, id, projectId);
    return saveMeetingNotes(db, request.userId, id, notes);
  });

  app.post("/api/meetings/sessions/:id/end", async (request) => {
    const { id } = request.params as { id: string };
    return endMeetingSession(db, request.userId, id);
  });

  app.post("/api/meetings/sessions/:id/attach", async (request) => {
    const { id } = request.params as { id: string };
    return attachMeetingNotes(db, request.userId, id);
  });

  app.post("/api/meetings/sessions/:id/decline", async (request) => {
    const { id } = request.params as { id: string };
    return declineMeetingAttach(db, request.userId, id);
  });

  app.post("/api/meetings/sessions/:id/suggest", async (request) => {
    const { id } = request.params as { id: string };
    return suggestFromSession(db, request.userId, id);
  });

  app.post("/api/meetings/sessions/:id/recap", async (request) => {
    const { id } = request.params as { id: string };
    return refreshMeetingRecap(db, request.userId, id);
  });

  app.delete("/api/meetings/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    return trashMeetingSession(db, request.userId, id);
  });

  app.post("/api/meetings/summarize", async (request) => {
    const body = z.object({ question: z.string().min(1).max(500) }).parse(request.body);
    return summarizeMeetings(db, request.userId, body.question);
  });

  // GET /api/context/search lives in routes/context.ts: one route answers the search box and ranked search.

  app.post("/api/ask", async (request) => {
    const body = z.object({ question: z.string().min(1).max(500) }).parse(request.body);
    return askEnsemble(db, request.userId, body.question);
  });

  app.get("/api/recap/week", async (request) => {
    const query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(request.query);
    return weeklyRecap(db, request.userId, query.date, accountIdOf(request));
  });

  app.get("/api/nudges", async (request) => {
    await ensureStaleNotice(db, request.userId);
    return listNudges(db, request.userId);
  });

  app.post("/api/nudges/:taskId", async (request) => {
    const { taskId } = request.params as { taskId: string };
    const body = z.object({ action: z.enum(["keep", "snooze", "done", "trash"]) }).parse(request.body);
    return actOnNudge(db, request.userId, taskId, body.action);
  });
}
