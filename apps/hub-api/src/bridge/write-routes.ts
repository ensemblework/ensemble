import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient, TaskStatus } from "@prisma/client";
import { env } from "../config.js";
import { hubPath, parseItemRef, refOf, type ItemRef } from "../context/graph/refs.js";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { canTransition } from "../lib/state-machine.js";
import { writeAgentBlock } from "../pages/markdown.js";
import { createTask, titlesMatch, updateTask } from "../services/tasks.js";
import { defaultSpaceName } from "../spaces/store.js";
import { bridgeAppsRejected, bridgeAuthRejected, bridgeWriteRejected } from "./auth.js";
import { hubUrl, isUuid } from "./text.js";
import { maxFileBytes } from "../files/store.js";

const STATUSES: TaskStatus[] = ["proposed", "todo", "in_progress", "waiting_approval", "blocked", "done", "dropped"];

const CreateBody = z.object({
  title: z.string().trim().min(1, "title is required.").max(200),
  page: z.string().max(20_000).optional(),
  projectId: z.string().uuid("projectId is a project id; use projectName for a name.").optional(),
  projectName: z.string().trim().min(1).max(120).optional(),
  due: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "due is a date written YYYY-MM-DD.")
    .refine((value) => !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()), "due is not a real date.")
    .optional(),
  people: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  status: z.enum(["proposed", "todo"]).default("proposed"),
  from: z.string().max(400).optional(),
});

const UploadBody = z.object({
  filename: z.string().trim().min(1, "filename is required.").max(255),
  dataBase64: z.string().min(1, "dataBase64 is the file's bytes in base64."),
  mediaType: z.string().max(255).optional(),
  attachTo: z.string().max(400).optional(),
  summarize: z.boolean().optional(),
});

const UpdateBody = z
  .object({
    status: z.enum(["in_progress", "waiting_approval", "done", "blocked", "todo"]).optional(),
    note: z.string().trim().min(1).max(20_000).optional(),
    matchTitle: z.string().trim().min(1).max(200).optional(),
  })
  .refine((body) => Boolean(body.status || body.note), "Pass status, note, or both.");

async function connectedAppNames(app: FastifyInstance, request: FastifyRequest): Promise<string[]> {
  const [{ bridgeContext }, { appToolsFor }, { loadConnections }] = await Promise.all([import("./actions.js"), import("../assistant/apps.js"), import("../assistant/connections.js")]);
  const ctx = await bridgeContext(app, request);
  const connections = await loadConnections(ctx, await appToolsFor(ctx));
  return connections.connected.map((row) => row.name).slice(0, 40);
}

function fail(reply: FastifyReply, error: unknown) {
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (!statusCode || statusCode >= 500) throw error;
  return reply.code(statusCode).send({ error: error instanceof Error ? error.message : String(error) });
}

async function keyNameOf(prisma: PrismaClient, request: FastifyRequest): Promise<string> {
  if (!request.tokenId) return request.authVia === "session" ? "the Hub" : "an editor";
  const key = await prisma.apiToken.findUnique({ where: { id: request.tokenId }, select: { name: true } });
  return key?.name || "an editor";
}

/** People by id or by exact name; a name with no match is kept as written. */
async function peopleIds(prisma: PrismaClient, userId: string, people: string[]): Promise<string[]> {
  const names = people.filter((value) => !isUuid(value));
  const found = names.length
    ? await prisma.person.findMany({
        where: { userId, deletedAt: null, OR: names.map((name) => ({ name: { equals: name, mode: "insensitive" as const } })) },
        select: { id: true, name: true },
      })
    : [];
  const byName = new Map(found.map((person) => [person.name.toLowerCase(), person.id]));
  return [...new Set(people.map((value) => (isUuid(value) ? value.toLowerCase() : (byName.get(value.toLowerCase()) ?? value))))];
}

async function recordTitle(prisma: PrismaClient, userId: string, ref: ItemRef): Promise<string | null> {
  const id = ref.id;
  switch (ref.kind) {
    case "task":
      return (await prisma.task.findFirst({ where: { id, userId, deletedAt: null }, select: { title: true } }))?.title ?? null;
    case "project":
      return (await prisma.project.findFirst({ where: { id, userId, deletedAt: null }, select: { name: true } }))?.name ?? null;
    case "person":
      return (await prisma.person.findFirst({ where: { id, userId, deletedAt: null }, select: { name: true } }))?.name ?? null;
    case "repo":
      return (await prisma.repo.findFirst({ where: { id, userId, deletedAt: null }, select: { fullName: true } }))?.fullName ?? null;
    case "deliverable":
      return (await prisma.deliverable.findFirst({ where: { id, userId, deletedAt: null }, select: { title: true } }))?.title ?? null;
    case "meeting":
      return (
        (await prisma.meetingNote.findFirst({ where: { id, userId, deletedAt: null }, select: { title: true } }))?.title ??
        (await prisma.meetingSession.findFirst({ where: { id, userId, deletedAt: null }, select: { title: true } }))?.title ??
        null
      );
    case "file":
      return (await prisma.document.findFirst({ where: { id, userId, deletedAt: null }, select: { filename: true } }))?.filename ?? null;
    case "page": {
      const page = await prisma.taskPage.findFirst({ where: { id, userId, deletedAt: null }, select: { title: true } });
      return page ? page.title || "Untitled page" : null;
    }
    case "event":
      return (await prisma.artifact.findFirst({ where: { id, userId, deletedAt: null, kind: "event" }, select: { title: true } }))?.title ?? null;
    default:
      return null;
  }
}

const taskOut = (task: { id: string; title: string; status: string; projectId: string | null; due: Date | null }) => ({
  id: task.id,
  ref: refOf("task", task.id),
  title: task.title,
  status: task.status,
  projectId: task.projectId,
  due: task.due ? task.due.toISOString().slice(0, 10) : null,
  url: hubUrl(`/tasks/${task.id}`),
});

/**
 * Task writes for editors (docs/CONTEXT_BRIDGE.md §5): add a task, move its status, add a
 * progress note to its page. A bridge key reaches these only when it was made with task updates
 * allowed (`ApiToken.canWrite`); `readOnlyTokenRejected` and `bridgeWriteRejected` both check.
 */
export async function bridgeWriteRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;
  const fileBodyLimit = Math.ceil((maxFileBytes() * 4) / 3) + 64 * 1024;

  app.addHook("preHandler", async (request, reply) => {
    const message = bridgeAuthRejected(request.authVia, env.ENSEMBLE_INTERNAL_TOKEN);
    if (message) return reply.code(401).send({ error: message });
    if (request.method === "GET" || request.method === "HEAD") return;
    const refused = bridgeWriteRejected(request);
    if (refused) return reply.code(403).send({ error: refused });
  });

  app.get("/api/bridge/whoami", async (request) => {
    const [space, keyName] = await Promise.all([
      prisma.user.findUnique({ where: { id: request.userId }, select: { name: true, spaceName: true, ownerId: true } }),
      request.tokenId ? keyNameOf(prisma, request) : Promise.resolve(undefined),
    ]);
    const canUseApps = bridgeAppsRejected(request) === null;
    // The connected apps by name, so an editor's tool descriptions can say what it may reach.
    const apps = canUseApps ? await connectedAppNames(app, request).catch(() => []) : [];
    return {
      canWrite: bridgeWriteRejected(request) === null,
      canUseApps,
      apps,
      spaceName: space ? space.spaceName || (space.ownerId ? "Untitled space" : defaultSpaceName(space.name)) : undefined,
      keyName,
    };
  });

  app.post("/api/bridge/write/tasks", async (request, reply) => {
    const body = CreateBody.parse(request.body ?? {});
    const userId = request.userId;
    let related = "";
    if (body.from) {
      const ref = parseItemRef(body.from);
      const title = ref ? await recordTitle(prisma, userId, ref) : null;
      if (!ref || title === null) return reply.code(400).send({ error: "from must name a record in this space: ensemble://<kind>/<id> or a Hub link." });
      related = `Related: [${title.replace(/[[\]]/g, "")}](${refOf(ref.kind, ref.id)})`;
    }
    const page = [body.page?.trim(), related].filter(Boolean).join("\n\n");
    const key = await keyNameOf(prisma, request);
    const people = body.people ? await peopleIds(prisma, userId, body.people) : undefined;
    try {
      const task = await prisma.$transaction(async (tx) =>
        createTask(
          tx,
          userId,
          {
            title: body.title,
            description: page || undefined,
            status: body.status,
            due: body.due ?? null,
            projectId: body.projectId,
            projectName: body.projectName,
            people,
            sourceRef: "bridge",
          },
          "agent",
        ),
      );
      await appendLedger({ userId, actor: "agent", action: "bridge.task.create", taskId: task.id, payload: { title: task.title, status: task.status, key } });
      sseHub.publish(userId, { event: "task", data: { id: task.id, action: "create" } });
      return reply.code(201).send({
        task: taskOut(task),
        message: `Added “${task.title}” as ${task.status === "proposed" ? "a proposed task: the person accepts or drops it in Ensemble" : "a to-do"}.`,
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * A file from the editor's computer into Files (the same checks and limits as an upload in the Hub),
   * attached to a task or page (a file mention at the end of its page; a task's file is also tagged with
   * it), or tagged with a project, person or repository.
   */
  app.post("/api/bridge/write/files", { bodyLimit: fileBodyLimit }, async (request, reply) => {
    const body = UploadBody.parse(request.body ?? {});
    const userId = request.userId;
    const target = body.attachTo ? parseItemRef(body.attachTo) : null;
    if (body.attachTo && (!target || !["task", "page", "project", "person", "repo"].includes(target.kind))) {
      return reply.code(400).send({ error: "attachTo names a task, page, project, person or repository: ensemble://<kind>/<id> or a Hub link." });
    }
    const title = target ? await recordTitle(prisma, userId, target) : null;
    if (target && title === null) return reply.code(404).send({ error: "attachTo is not in this Ensemble space, or it is in Trash." });
    const tags = {
      taskIds: target?.kind === "task" ? [target.id] : [],
      projectIds: target?.kind === "project" ? [target.id] : [],
      personIds: target?.kind === "person" ? [target.id] : [],
      repoIds: target?.kind === "repo" ? [target.id] : [],
    };
    const internal = { "x-ensemble-internal": env.ENSEMBLE_INTERNAL_TOKEN, "x-ensemble-user": userId };
    const saved = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: { ...internal, "content-type": "application/json" },
      payload: { filename: body.filename, dataBase64: body.dataBase64, ...(body.mediaType ? { mediaType: body.mediaType } : {}), summarize: body.summarize ?? true, tags },
    });
    const result = saved.json<{ file?: { id: string; filename: string; byteSize?: number }; error?: string }>();
    if (saved.statusCode >= 400 || !result.file) return reply.code(saved.statusCode >= 400 ? saved.statusCode : 500).send({ error: result.error ?? "The file could not be saved." });
    const file = result.file;
    const key = await keyNameOf(prisma, request);
    let attached: { kind: string; id: string; title: string } | null = null;
    let attachProblem: string | null = null;
    if (target && (target.kind === "task" || target.kind === "page") && title !== null) {
      // The file at the end of the page, as a mention (files/attached.ts reads it back as the page's file).
      const mention = `[@${file.filename.replace(/[[\]]/g, "")}](ensemble://file/${file.id})`;
      const { appendToPage } = await import("../assistant/tools/pages.js");
      try {
        await prisma.$transaction((tx) => appendToPage(tx, userId, target.kind === "task" ? { taskId: target.id } : { pageId: target.id }, mention));
      } catch (error) {
        // The file is saved either way; say what did not happen rather than fail the upload.
        attachProblem = error instanceof Error ? error.message : "The page could not be changed.";
      }
    }
    if (target && title !== null && !attachProblem) attached = { kind: target.kind, id: target.id, title: title || "Untitled" };
    await appendLedger({ userId, actor: "agent", action: "bridge.file.upload", ...(target?.kind === "task" ? { taskId: target.id } : {}), payload: { fileId: file.id, filename: file.filename, attachTo: attached ? refOf(attached.kind as ItemRef["kind"], attached.id) : null, key } });
    sseHub.publish(userId, { event: "documents", data: { id: file.id } });
    return reply.code(201).send({
      file: { id: file.id, ref: refOf("file", file.id), filename: file.filename, url: hubUrl(hubPath("file", file.id) ?? "/files") },
      attached: attached ? { ...attached, ref: refOf(attached.kind as ItemRef["kind"], attached.id) } : null,
      message: `Saved “${file.filename}” in Files${attached ? ` and attached it to “${attached.title}”` : ""}.${attachProblem ? ` It was not added to the page: ${attachProblem}` : ""}`,
    });
  });

  app.patch("/api/bridge/write/tasks/:id", async (request, reply) => {
    const { id: raw } = z.object({ id: z.string().min(1).max(400) }).parse(request.params);
    const ref = parseItemRef(raw, "task");
    if (!ref || ref.kind !== "task") return reply.code(400).send({ error: "Name the task by its id or ensemble://task/<id>." });
    const body = UpdateBody.parse(request.body ?? {});
    const userId = request.userId;
    const existing = await prisma.task.findFirst({ where: { id: ref.id, userId, deletedAt: null } });
    if (!existing) return reply.code(404).send({ error: "That task is not in this Ensemble space, or it is in Trash." });
    if (body.matchTitle && !titlesMatch(body.matchTitle, existing.title)) {
      return reply.code(409).send({ error: `That id is “${existing.title}”, not “${body.matchTitle}”. Check the task with ensemble_context before changing it.` });
    }
    const status = body.status && body.status !== existing.status ? body.status : undefined;
    if (status && !canTransition(existing.status, status)) {
      const next = STATUSES.filter((to) => to !== existing.status && canTransition(existing.status, to));
      return reply.code(409).send({ error: `A ${existing.status} task cannot move to ${status}. From ${existing.status} it can move to: ${next.join(", ")}.` });
    }
    const key = await keyNameOf(prisma, request);
    try {
      const task = status ? await prisma.$transaction(async (tx) => updateTask(tx, userId, existing.id, { status }, "agent")) : existing;
      if (body.note) await writeAgentBlock(prisma, userId, existing.id, body.note, { jobId: `bridge-${randomUUID()}`, runId: null, model: "", title: `Update from ${key}` });
      await appendLedger({
        userId,
        actor: "agent",
        action: "bridge.task.update",
        taskId: existing.id,
        payload: { ...(status ? { from: existing.status, to: status } : {}), note: Boolean(body.note), key },
      });
      sseHub.publish(userId, { event: "task", data: { id: existing.id, action: "update" } });
      const done = [status ? `moved to ${status}` : null, body.note ? "note added to its page" : null].filter(Boolean).join(", ");
      return { task: taskOut(task), noted: Boolean(body.note), message: `“${task.title}”: ${done || "no change (already in that status)"}.` };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
