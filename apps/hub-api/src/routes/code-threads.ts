/**
 * Threads of the Code tab's agent (docs/16 §9). A thread is an internal task off the board (`sourceRef`
 * `code:<key>`, `codeThreadRef`), keyed by the computer and the folder it works in, or by the computer
 * alone when it has no folder (it then works in a new folder in Ensemble's workspace). Its turns are the
 * chat runs on that task, each continuing the one before it in the agent's own session, so the thread is
 * the agent session (docs/41) and has no store of its own. Rename and delete are the task's own routes.
 *
 * A turn's reply can be kept on a page with no model involved: an `agentBlock` that says which agent,
 * model, thread, folder and computer wrote it (`pages/agent-output.ts`), recorded on the run too.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ENGINE_LABELS, isCodeEngine } from "@ensemble/shared-types";
import { MODULE_DENIED, hasModule } from "@ensemble/shared-types/modules";
import { unwatchThread, watchThread } from "../lib/code-watch.js";
import { publicDecision } from "../lib/decisions.js";
import { canUseHostCredentials } from "../lib/hosted-access.js";
import { appendLedger } from "../lib/ledger.js";
import { CODE_THREAD_PREFIX, codeThreadRef } from "../lib/node-tasks.js";
import { complete } from "../lib/runtime.js";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";
import { keepAgentOutput, keepAgentOutputOnDeliverable, keepAgentOutputOnMeeting, KeepTargetError } from "../pages/agent-output.js";
import { collabHub } from "../pages/live.js";
import { createStandalonePage, TaskPageError } from "../pages/store.js";
import { createTask } from "../services/tasks.js";
import { Assign, createJob } from "../workspace/assign.js";
import { codeTurnOf, steerOf } from "../workspace/trust.js";
import { stopJob } from "../workspace/worker.js";
import { card, onCurrentDevices } from "./agents.js";

/** The run event that records where a turn's reply was kept. */
export const SAVED_EVENT = "code_saved";

/** Where a reply was kept: a page, a task's page, meeting notes or a deliverable's notes. */
export type KeptPlace = { kind: "page" | "task" | "meeting" | "deliverable"; id: string; pageId: string | null; taskId: string | null; title: string; href: string };

/** A kept-reply event as a place; events from before kinds were kept are pages or tasks' pages. */
export function keptPlace(data: unknown): KeptPlace | null {
  const row = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  const title = text(row.title) ?? "Page";
  if (row.kind === "meeting" || row.kind === "deliverable") {
    const id = text(row.id);
    const href = text(row.href);
    return id && href ? { kind: row.kind, id, pageId: null, taskId: null, title, href } : null;
  }
  const pageId = text(row.pageId);
  if (!pageId) return null;
  const taskId = text(row.taskId);
  return taskId ? { kind: "task", id: taskId, pageId, taskId, title, href: `/tasks/${taskId}` } : { kind: "page", id: pageId, pageId, taskId: null, title, href: `/pages/${pageId}` };
}

const JOB_INCLUDE = { task: { select: { id: true, title: true, priority: true, status: true } }, review: { select: { id: true } }, device: { select: { name: true, lastSeenAt: true, revokedAt: true } } } as const;

type PlaceJob = { deviceId: string | null; externalRoot: string | null; repoPath: string | null; context: unknown; device?: { name: string } | null };

/**
 * Where a thread works, read from its first turn: the computer, the folder it was started in (null:
 * a new folder in the workspace), and the folder the agent actually works in. On Ensemble on the web
 * a run on this server keeps its paths to itself.
 */
export function threadPlace(job: PlaceJob | null, paths: boolean): { deviceId: string | null; deviceName: string | null; folder: string | null; workdir: string | null } {
  if (!job) return { deviceId: null, deviceName: null, folder: null, workdir: null };
  if (job.deviceId) return { deviceId: job.deviceId, deviceName: job.device?.name ?? null, folder: codeTurnOf(job.context)?.codeFolder ?? null, workdir: null };
  return { deviceId: null, deviceName: null, folder: paths ? job.externalRoot : null, workdir: paths ? job.repoPath || job.externalRoot : null };
}

/** The person's own words in a turn: its message without the mentions written after it for the agent. */
export function askedText(instructions: string): string {
  const at = instructions.indexOf("\n\n(Mentioned in Ensemble:");
  return (at >= 0 ? instructions.slice(0, at) : instructions).trim();
}

/** A kept reply as Markdown: what was asked, the answer, and the files the turn changed. */
export function keptMarkdown(turn: { instructions: string; summary: string | null; evidence: unknown }): string {
  const asked = askedText(turn.instructions);
  const evidence = (turn.evidence && typeof turn.evidence === "object" ? turn.evidence : {}) as { files?: Array<{ path?: unknown; added?: unknown; removed?: unknown }> };
  const files = (Array.isArray(evidence.files) ? evidence.files : []).filter((row) => typeof row.path === "string").slice(0, 30);
  return [
    asked ? asked.split("\n").map((line) => `> ${line}`).join("\n") : "",
    (turn.summary ?? "").trim(),
    files.length ? `Files changed: ${files.map((row) => `\`${String(row.path)}\` (+${Number(row.added) || 0} −${Number(row.removed) || 0})`).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const MENTIONS_MARK = "\n\n(Mentioned in Ensemble:";

/** A turn's message in two parts: the person's words and the mentions written after them (`withMentions` on the web). */
function messageParts(instructions: string): { text: string; mentions: string } {
  const at = instructions.indexOf(MENTIONS_MARK);
  if (at < 0) return { text: instructions.trim(), mentions: "" };
  return { text: instructions.slice(0, at).trim(), mentions: instructions.slice(at + MENTIONS_MARK.length).replace(/\)\s*$/, "").trim() };
}

/** A message that has not started yet with more of the person's words: one message, its mentions together. */
export function amendedMessage(before: string, more: string): string {
  const a = messageParts(before);
  const b = messageParts(more);
  const mentions = [a.mentions, b.mentions].filter(Boolean).join("; ");
  return `${[a.text, b.text].filter(Boolean).join("\n\n")}${mentions ? `${MENTIONS_MARK} ${mentions})` : ""}`;
}

const TITLE_SYSTEM =
  "Name a conversation with a coding agent from its first message. Reply with the name only: 2 to 6 words, sentence case, like a short headline of the work. No quotes, no trailing period, no emoji, no \"Help with\" or \"Request to\".";

/** A model's name for a thread, cleaned: one line, no quotes or Markdown, at most 60 characters. Null when unusable. */
export function cleanThreadName(text: string): string | null {
  const line = text.replace(/<think>[\s\S]*?<\/think>/g, "").split("\n").map((row) => row.trim()).find(Boolean) ?? "";
  const plain = line.replace(/^(title|name)\s*:\s*/i, "").replace(/[*_`#>]+/g, "").replace(/^["'“”‘’\s]+|["'“”‘’.\s]+$/g, "").replace(/\s+/g, " ").trim();
  if (plain.length < 3 || plain.length > 60 || plain.split(" ").length > 9) return null;
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

/**
 * Names a new thread from its first message with the person's Low tier, after it was made with a
 * name from the message itself. A name the person typed meanwhile is kept; a failed call keeps the first.
 */
async function nameThread(app: FastifyInstance, userId: string, threadId: string, draft: string, message: string): Promise<void> {
  try {
    const settings = await loadSettings(app.prisma, userId);
    if (!settings.models.easy?.model) return;
    const answer = await complete({ userId, settings, tier: "easy", purpose: "Thread title", system: TITLE_SYSTEM, prompt: message.slice(0, 2000) });
    const title = cleanThreadName(answer.text);
    if (!title || title === draft) return;
    const changed = await app.prisma.task.updateMany({ where: { id: threadId, userId, title: draft, deletedAt: null }, data: { title } });
    if (changed.count) sseHub.publish(userId, { event: "task", data: { id: threadId, action: "update" } });
  } catch (error) {
    app.log.debug({ err: error, threadId }, "could not name a Code tab thread");
  }
}

const LIVE_TURN = new Set(["claimed", "running", "waiting_approval", "stopping"]);

export async function codeThreadRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    if (!hasModule(request.modules, "workspace")) return reply.code(404).send({ error: MODULE_DENIED });
  });
  const { prisma } = app;

  app.get("/api/agent/threads", async (request) => {
    // With a folder: that folder's threads on that computer (the IDE). Without: every thread (the sessions list).
    const query = z.object({ deviceId: z.string().uuid().optional(), folder: z.string().trim().min(1).max(1000).optional() }).parse(request.query);
    const tasks = await prisma.task.findMany({
      where: { userId: request.userId, deletedAt: null, sourceRef: query.folder ? codeThreadRef(query.deviceId, query.folder) : { startsWith: CODE_THREAD_PREFIX } },
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    const jobs = tasks.length
      ? await prisma.workspaceJob.findMany({
          where: { userId: request.userId, taskId: { in: tasks.map((task) => task.id) } },
          orderBy: { createdAt: "asc" },
          take: 4000,
          select: { id: true, taskId: true, status: true, provider: true, model: true, createdAt: true, deviceId: true, externalRoot: true, repoPath: true, context: true, device: { select: { name: true } } },
        })
      : [];
    const byTask = new Map<string, typeof jobs>();
    for (const job of jobs) byTask.set(job.taskId, [...(byTask.get(job.taskId) ?? []), job]);
    const paths = await canUseHostCredentials(request.userId);
    return {
      threads: tasks
        .map((task) => {
          const turns = byTask.get(task.id) ?? [];
          const last = turns[turns.length - 1] ?? null;
          return {
            id: task.id,
            title: task.title,
            createdAt: task.createdAt.toISOString(),
            updatedAt: (last && last.createdAt > task.updatedAt ? last.createdAt : task.updatedAt).toISOString(),
            turns: turns.length,
            last: last ? { id: last.id, status: last.status, engine: last.provider, model: last.model } : null,
            place: threadPlace(turns[0] ?? null, paths),
          };
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  });

  app.post("/api/agent/threads", async (request) => {
    const body = z
      .object({ deviceId: z.string().uuid().optional(), folder: z.string().trim().max(1000).nullish(), title: z.string().trim().min(1).max(200), message: z.string().trim().max(8000).optional() })
      .parse(request.body);
    const task = await prisma.task.create({
      data: { userId: request.userId, title: body.title, owner: "agent", status: "todo", sourceKind: "other", sourceRef: codeThreadRef(body.deviceId, body.folder || null), createdBy: "me" },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    // A better name follows from the first message; the thread is usable at once with the first one.
    if (body.message) void nameThread(app, request.userId, task.id, task.title, body.message);
    return {
      thread: {
        id: task.id,
        title: task.title,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
        turns: 0,
        last: null,
        place: { deviceId: body.deviceId ?? null, deviceName: null, folder: body.folder || null, workdir: null },
      },
    };
  });

  app.get("/api/agent/threads/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const task = await prisma.task.findFirst({ where: { id, userId: request.userId, deletedAt: null, sourceRef: { startsWith: CODE_THREAD_PREFIX } }, select: { id: true, title: true } });
    if (!task) return reply.code(404).send({ error: "That thread is gone." });
    const jobs = await prisma.workspaceJob.findMany({ where: { userId: request.userId, taskId: id }, orderBy: { createdAt: "asc" }, take: 200, include: JOB_INCLUDE });
    await onCurrentDevices(prisma, jobs);
    const paths = await canUseHostCredentials(request.userId);
    const events = jobs.length ? await prisma.workspaceEvent.findMany({ where: { jobId: { in: jobs.map((job) => job.id) }, kind: SAVED_EVENT }, orderBy: { sequence: "asc" } }) : [];
    const saved = new Map<string, KeptPlace[]>();
    for (const event of events) {
      const place = keptPlace(event.data);
      if (!place) continue;
      const list = (saved.get(event.jobId) ?? []).filter((row) => !(row.kind === place.kind && row.id === place.id));
      saved.set(event.jobId, [...list, place]);
    }
    // The thread's own requests: it answers them in place while open (lib/code-watch.ts).
    const asks = jobs.length
      ? await prisma.agentDecision.findMany({ where: { userId: request.userId, status: "pending", sessionId: { in: jobs.map((job) => job.id) }, expiresAt: { gt: new Date() } }, orderBy: { requestedAt: "asc" }, take: 20 })
      : [];
    // A turn steered by a later message: it stopped for that message, which carries on its work.
    const steeredBy = new Map(jobs.filter((job) => steerOf(job.context) && job.continueFromJobId).map((job) => [job.continueFromJobId!, job.id]));
    return {
      thread: { ...task, place: threadPlace(jobs[0] ?? null, paths) },
      turns: jobs.map((job) => ({ ...card(job, undefined, { paths }), reviewId: job.review?.id ?? null, saved: saved.get(job.id) ?? [], steer: Boolean(steerOf(job.context)), steeredBy: steeredBy.get(job.id) ?? null })),
      asks: asks.map(publicDecision),
    };
  });

  /** The thread is open on a screen now: its requests are answered there, not in Needs me (lib/code-watch.ts). */
  app.post("/api/agent/threads/:id/watch", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { open } = z.object({ open: z.boolean().default(true) }).parse(request.body ?? {});
    const thread = await prisma.task.findFirst({ where: { id, userId: request.userId, deletedAt: null, sourceRef: { startsWith: CODE_THREAD_PREFIX } }, select: { id: true } });
    if (!thread) return reply.code(404).send({ error: "That thread is gone." });
    const changed = await (open ? watchThread(request.userId, id) : unwatchThread(request.userId, id)).catch(() => false);
    // Needs me reads again when the thread opens or closes: its requests leave it or come back.
    if (changed) sseHub.publish(request.userId, { event: "decision", data: { thread: id, watched: open } });
    return reply.code(204).send();
  });

  /**
   * A message while a turn is going on. A turn not started yet takes it into its own message. A turn at
   * work is steered: a new turn continues the same agent session with only the change (`context.steer`,
   * as Ensemble Node steers), and the one at work stops for it, keeping what it did.
   */
  app.post("/api/agent/threads/:id/steer", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ jobId: z.string().uuid(), turn: z.record(z.unknown()) }).parse(request.body);
    const input = Assign.parse({ ...body.turn, taskId: id, continueFromJobId: body.jobId });
    if (!input.chat || input.surface !== "code") return reply.code(400).send({ error: "Steer works on a message to the Code tab's agent." });
    const thread = await prisma.task.findFirst({ where: { id, userId: request.userId, deletedAt: null, sourceRef: { startsWith: CODE_THREAD_PREFIX } }, select: { id: true } });
    if (!thread) return reply.code(404).send({ error: "That thread is gone." });
    const active = await prisma.workspaceJob.findFirst({ where: { id: body.jobId, userId: request.userId, taskId: id }, select: { id: true, status: true, instructions: true, cancelRequestedAt: true } });
    if (!active) return reply.code(404).send({ error: "That turn is not in this thread." });
    if (active.status === "queued") {
      const changed = await prisma.workspaceJob.updateMany({ where: { id: active.id, status: "queued" }, data: { instructions: amendedMessage(active.instructions, input.instructions).slice(0, 16_000) } });
      if (changed.count === 1) {
        sseHub.publish(request.userId, { event: "workspace", data: { id: active.id } });
        return { jobId: active.id, delivery: "amended" as const };
      }
    }
    const steering = LIVE_TURN.has(active.status) || (active.status === "queued");
    const created = await createJob(prisma, request.userId, input, steering ? { context: { steer: { update: input.instructions } } } : {});
    if (!created) return reply.code(404).send({ error: "That thread is gone." });
    if (steering) {
      // What waited after the stopped turn now waits after this one.
      await prisma.workspaceJob.updateMany({ where: { continueFromJobId: active.id, status: "queued", id: { not: created.jobId } }, data: { continueFromJobId: created.jobId } });
      const now = await prisma.workspaceJob.findUnique({ where: { id: active.id }, select: { status: true, cancelRequestedAt: true } });
      if (now && LIVE_TURN.has(now.status) && now.status !== "stopping" && !now.cancelRequestedAt) await stopJob(app, request.userId, active.id);
      await appendLedger({ userId: request.userId, actor: "me", action: "code.agent_steer", taskId: id, payload: { from: active.id, jobId: created.jobId } });
    }
    return { jobId: created.jobId, delivery: steering ? ("steered" as const) : ("queued" as const) };
  });

  /**
   * Keeps a finished turn's reply somewhere in Ensemble with no model involved: a page (new or any), a
   * task's page (a new task on a board, or any task), meeting notes (new or any), or a deliverable's notes.
   */
  app.post("/api/agent/threads/:id/save", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const title = z.string().trim().min(1).max(200);
    const body = z
      .object({
        jobId: z.string().uuid(),
        pageId: z.string().uuid().optional(),
        taskId: z.string().uuid().optional(),
        newPage: z.object({ title }).optional(),
        newTask: z.object({ title, projectId: z.string().uuid().nullish() }).optional(),
        meetingId: z.string().uuid().optional(),
        newMeeting: z.object({ title }).optional(),
        deliverableId: z.string().uuid().optional(),
      })
      .refine((value) => [value.pageId, value.taskId, value.newPage, value.newTask, value.meetingId, value.newMeeting, value.deliverableId].filter(Boolean).length === 1, "Name one place to keep it.")
      .parse(request.body);
    const thread = await prisma.task.findFirst({ where: { id, userId: request.userId, deletedAt: null, sourceRef: { startsWith: CODE_THREAD_PREFIX } }, select: { id: true, title: true } });
    if (!thread) return reply.code(404).send({ error: "That thread is gone." });
    const job = await prisma.workspaceJob.findFirst({ where: { id: body.jobId, userId: request.userId, taskId: id }, include: { device: { select: { name: true } } } });
    if (!job) return reply.code(404).send({ error: "That turn is not in this thread." });
    if (!job.summary?.trim()) return reply.code(409).send({ error: "This turn has no reply to keep yet." });
    if (body.taskId === id) return reply.code(400).send({ error: "Pick a page or a task on your board." });
    const paths = await canUseHostCredentials(request.userId);
    const place = threadPlace(await prisma.workspaceJob.findFirst({ where: { taskId: id, userId: request.userId }, orderBy: { createdAt: "asc" }, select: { deviceId: true, externalRoot: true, repoPath: true, context: true, device: { select: { name: true } } } }), paths);
    const engine = job.provider && isCodeEngine(job.provider) ? ENGINE_LABELS[job.provider] : "The agent";
    const folderName = place.folder ? place.folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || place.folder : null;
    const evidence = (job.evidence && typeof job.evidence === "object" ? job.evidence : {}) as { model?: unknown };
    const markdown = keptMarkdown({ instructions: job.instructions, summary: job.summary, evidence: job.evidence });
    const meta = {
      source: "code-agent",
      jobId: job.id,
      runId: job.runId,
      engine: job.provider ?? "",
      model: typeof evidence.model === "string" && evidence.model ? evidence.model : job.model === "default" ? "" : job.model,
      title: `${engine}${folderName ? ` in ${folderName}` : ""} · ${thread.title}`.slice(0, 200),
      threadId: thread.id,
      folder: place.folder ?? "",
      computer: job.device?.name ?? place.deviceName ?? "",
    };
    try {
      let kept: KeptPlace;
      if (body.meetingId || body.newMeeting) {
        const meeting = await keepAgentOutputOnMeeting(prisma, request.userId, body.meetingId ? { meetingId: body.meetingId } : { newMeeting: body.newMeeting! }, markdown, meta);
        kept = { kind: "meeting", id: meeting.id, pageId: null, taskId: null, title: meeting.title, href: `/meetings?session=${encodeURIComponent(meeting.id)}` };
      } else if (body.deliverableId) {
        const deliverable = await keepAgentOutputOnDeliverable(prisma, request.userId, body.deliverableId, markdown, meta);
        kept = { kind: "deliverable", id: deliverable.id, pageId: null, taskId: null, title: deliverable.title, href: `/projects/${deliverable.projectId}` };
      } else {
        let target: { pageId: string } | { taskId: string };
        if (body.newPage) {
          const created = await prisma.$transaction((tx) => createStandalonePage(tx, request.userId, { title: body.newPage!.title, content: { type: "doc", content: [{ type: "paragraph" }] }, sourceFileId: null }));
          sseHub.publish(request.userId, { event: "page", data: { id: created.id, action: "create" } });
          target = { pageId: created.id };
        } else if (body.newTask) {
          const task = await prisma.$transaction((tx) => createTask(tx, request.userId, { title: body.newTask!.title, projectId: body.newTask!.projectId ?? null, status: "todo", owner: "me" }, "me"));
          await appendLedger({ userId: request.userId, actor: "me", action: "task.create", taskId: task.id, payload: { from: "code.agent_output", threadId: thread.id } });
          sseHub.publish(request.userId, { event: "task", data: { id: task.id, action: "create" } });
          target = { taskId: task.id };
        } else {
          target = body.pageId ? { pageId: body.pageId } : { taskId: body.taskId! };
          // Whatever people are typing on the page now is written back first, so the block lands after it.
          await collabHub.flush({ space: request.userId, kind: body.pageId ? "page" : "task", id: body.pageId ?? body.taskId! }).catch(() => undefined);
        }
        const page = await keepAgentOutput(prisma, request.userId, target, markdown, meta);
        kept = page.taskId
          ? { kind: "task", id: page.taskId, pageId: page.id, taskId: page.taskId, title: page.title, href: `/tasks/${page.taskId}` }
          : { kind: "page", id: page.id, pageId: page.id, taskId: null, title: page.title, href: `/pages/${page.id}` };
      }
      await prisma.workspaceEvent.create({ data: { jobId: job.id, kind: SAVED_EVENT, data: kept } });
      await appendLedger({ userId: request.userId, actor: "me", action: "code.agent_output_kept", taskId: kept.taskId ?? undefined, payload: { threadId: thread.id, jobId: job.id, kind: kept.kind, id: kept.id } });
      return { page: kept };
    } catch (error) {
      if (error instanceof TaskPageError || error instanceof KeepTargetError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
