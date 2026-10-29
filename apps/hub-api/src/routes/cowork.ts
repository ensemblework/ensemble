import { ensureMorningSkill } from "../cowork/morning-skill.js";
import { briefPromptAvailable, claimBriefPrompt, finishBriefPrompt } from "../cowork/brief-prompt.js";
import { accountIdOf } from "../lib/auth.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PageDocument } from "@ensemble/shared-types";
import {
  actOnNudge,
  askEnsemble,
  searchWorkspace,
  attachMeetingNotes,
  commitQuickCapture,
  declineMeetingAttach,
  deliverMorningBrief,
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

  app.get("/api/brief/today", async (request) => deliverMorningBrief(db, request.userId));

  app.post("/api/brief/deliver", async (request) => deliverMorningBrief(db, request.userId));

  app.get("/api/brief/skill", async (request) => {
    const skill = await ensureMorningSkill(db, request.userId);
    const notification = await db.notification.findFirst({ where: { userId: request.userId, kind: "morning_brief" }, orderBy: { createdAt: "desc" } });
    const scope = skill.scope as { customized?: boolean } | null;
    return { skill: { id: skill.id, body: skill.body }, notification, customize: Boolean(!skill.deletedAt && !scope?.customized && await briefPromptAvailable(db, accountIdOf(request))) };
  });

  app.post("/api/brief/prompt", async request => {
    const { action } = z.object({ action: z.enum(["show", "dismiss"]) }).strict().parse(request.body);
    const account = accountIdOf(request);
    if (action === "dismiss") {
      await finishBriefPrompt(db, account, "dismissed");
      return { show: false };
    }
    return { show: await claimBriefPrompt(db, account) };
  });

  app.patch("/api/brief/skill", async (request) => {
    const { instructions } = z.object({ instructions: z.string().trim().min(1).max(20_000) }).parse(request.body);
    const initial = await ensureMorningSkill(db, request.userId);
    const body = `# My morning brief\n\n${instructions}\n\nUse only the supplied context. Never invent tasks or facts. Do not send anything to anyone.\n`;
    const skill = await db.$transaction(async (tx) => {
      const current = await tx.skill.findUniqueOrThrow({ where: { id: initial.id } });
      const next = await tx.skill.update({ where: { id: initial.id }, data: { body, scope: { purpose: "morning-brief", customized: true }, version: { increment: 1 }, enabled: true, deletedAt: null } });
      await tx.skillVersion.create({ data: { skillId: next.id, version: current.version + 1, body, note: "Personal morning brief preferences" } });
      const stale = await tx.skillVersion.findMany({ where: { skillId: next.id }, orderBy: { version: "desc" }, skip: 3, select: { id: true } });
      await tx.skillVersion.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
      await finishBriefPrompt(tx, accountIdOf(request), "saved");
      return next;
    });
    return { skill };
  });

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

  app.get("/api/context/search", async (request) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(500) }).parse(request.query);
    return searchWorkspace(db, request.userId, q);
  });

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
