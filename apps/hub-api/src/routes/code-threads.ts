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
import { canUseHostCredentials } from "../lib/hosted-access.js";
import { appendLedger } from "../lib/ledger.js";
import { CODE_THREAD_PREFIX, codeThreadRef } from "../lib/node-tasks.js";
import { sseHub } from "../lib/sse.js";
import { keepAgentOutput } from "../pages/agent-output.js";
import { collabHub } from "../pages/live.js";
import { createStandalonePage, TaskPageError } from "../pages/store.js";
import { codeTurnOf } from "../workspace/trust.js";
import { card, onCurrentDevices } from "./agents.js";

/** The run event that records where a turn's reply was kept. */
export const SAVED_EVENT = "code_saved";

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
      .object({ deviceId: z.string().uuid().optional(), folder: z.string().trim().max(1000).nullish(), title: z.string().trim().min(1).max(200) })
      .parse(request.body);
    const task = await prisma.task.create({
      data: { userId: request.userId, title: body.title, owner: "agent", status: "todo", sourceKind: "other", sourceRef: codeThreadRef(body.deviceId, body.folder || null), createdBy: "me" },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
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
    const saved = new Map<string, Array<{ pageId: string; taskId: string | null; title: string }>>();
    for (const event of events) {
      const data = (event.data ?? {}) as { pageId?: unknown; taskId?: unknown; title?: unknown };
      if (typeof data.pageId !== "string") continue;
      const list = (saved.get(event.jobId) ?? []).filter((row) => row.pageId !== data.pageId);
      saved.set(event.jobId, [...list, { pageId: data.pageId, taskId: typeof data.taskId === "string" ? data.taskId : null, title: typeof data.title === "string" ? data.title : "Page" }]);
    }
    return {
      thread: { ...task, place: threadPlace(jobs[0] ?? null, paths) },
      turns: jobs.map((job) => ({ ...card(job, undefined, { paths }), reviewId: job.review?.id ?? null, saved: saved.get(job.id) ?? [] })),
    };
  });

  /** Keeps a finished turn's reply on a page: a new one, a standalone one, or a task's. */
  app.post("/api/agent/threads/:id/save", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        jobId: z.string().uuid(),
        pageId: z.string().uuid().optional(),
        taskId: z.string().uuid().optional(),
        newPage: z.object({ title: z.string().trim().min(1).max(200) }).optional(),
      })
      .refine((value) => [value.pageId, value.taskId, value.newPage].filter(Boolean).length === 1, "Name one page: pageId, taskId or newPage.")
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
    try {
      let target: { pageId: string } | { taskId: string };
      if (body.newPage) {
        const created = await prisma.$transaction((tx) => createStandalonePage(tx, request.userId, { title: body.newPage!.title, content: { type: "doc", content: [{ type: "paragraph" }] }, sourceFileId: null }));
        sseHub.publish(request.userId, { event: "page", data: { id: created.id, action: "create" } });
        target = { pageId: created.id };
      } else {
        target = body.pageId ? { pageId: body.pageId } : { taskId: body.taskId! };
        // Whatever people are typing on the page now is written back first, so the block lands after it.
        await collabHub.flush({ space: request.userId, kind: body.pageId ? "page" : "task", id: body.pageId ?? body.taskId! }).catch(() => undefined);
      }
      const page = await keepAgentOutput(prisma, request.userId, target, keptMarkdown({ instructions: job.instructions, summary: job.summary, evidence: job.evidence }), {
        source: "code-agent",
        jobId: job.id,
        runId: job.runId,
        engine: job.provider ?? "",
        model: typeof evidence.model === "string" && evidence.model ? evidence.model : job.model === "default" ? "" : job.model,
        title: `${engine}${folderName ? ` in ${folderName}` : ""} · ${thread.title}`.slice(0, 200),
        threadId: thread.id,
        folder: place.folder ?? "",
        computer: job.device?.name ?? place.deviceName ?? "",
      });
      await prisma.workspaceEvent.create({ data: { jobId: job.id, kind: SAVED_EVENT, data: { pageId: page.id, taskId: page.taskId, title: page.title } } });
      await appendLedger({ userId: request.userId, actor: "me", action: "code.agent_output_kept", taskId: page.taskId ?? undefined, payload: { threadId: thread.id, jobId: job.id, pageId: page.id } });
      return { page: { ...page, href: page.taskId ? `/tasks/${page.taskId}` : `/pages/${page.id}` } };
    } catch (error) {
      if (error instanceof TaskPageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
