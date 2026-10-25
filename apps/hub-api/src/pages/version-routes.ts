import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { EMPTY_PAGE, PageDocument } from "@ensemble/shared-types";
import { editablePage, writePageContent, createStandalonePage, getStandalonePage } from "./store.js";
import { pageMarkdown } from "./markdown.js";
import { checkpointPage } from "./history.js";
import { copyPageDocument } from "./copy.js";
import { collabHub } from "./live.js";
import { sseHub } from "../lib/sse.js";
import { lockUserTransaction } from "../lib/user-lock.js";

const Target = z.object({ kind: z.enum(["page", "task"]).default("page"), id: z.string().uuid() });
const targetOf = (input: z.infer<typeof Target>) => input.kind === "task" ? { taskId: input.id } : { pageId: input.id };
const problem = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

export async function pageVersionRoutes(app: FastifyInstance) {
  const { prisma } = app;
  app.get("/api/page-versions", async request => {
    const input = Target.parse(request.query);
    await collabHub.flush({ space: request.userId, ...input });
    const { page, task } = await editablePage(prisma, request.userId, targetOf(input));
    if (!page) return { revision: 0, updatedAt: null, versions: [] };
    const rows = await prisma.pageRevision.findMany({ where: { userId: request.userId, pageId: page.id }, orderBy: [{ createdAt: "desc" }, { revision: "desc" }], take: 30 });
    const authors = await prisma.user.findMany({ where: { id: { in: rows.flatMap(row => row.authorAccountId ? [row.authorAccountId] : []) } }, select: { id: true, name: true } });
    const names = new Map(authors.map(row => [row.id, row.name || "Workspace owner"]));
    return { revision: page.revision, updatedAt: page.updatedAt.toISOString(), title: task?.title ?? page.title, versions: rows.map(row => ({ id: row.id, revision: row.revision, title: row.title, createdAt: row.createdAt.toISOString(), author: row.authorAccountId ? row.authorAccountId.startsWith("visitor:") ? "Guest" : names.get(row.authorAccountId) ?? "Former member" : "Earlier version" })) };
  });
  app.get("/api/page-versions/:id", async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const version = await prisma.pageRevision.findFirst({ where: { id, userId: request.userId } });
    if (!version) throw problem("That saved version is no longer available.", 404);
    await editablePage(prisma, request.userId, { pageId: version.pageId });
    return { version: { id: version.id, title: version.title, content: version.content ?? EMPTY_PAGE, markdown: pageMarkdown(version.content ? PageDocument.parse(version.content) : null, "") } };
  });
  app.post("/api/page-versions/:id/restore", async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ revision: z.number().int().nonnegative(), updatedAt: z.string().datetime() }).parse(request.body);
    await collabHub.flushSpace(request.userId);
    const restored = await prisma.$transaction(async tx => {
      await lockUserTransaction(tx, request.userId);
      const version = await tx.pageRevision.findFirst({ where: { id, userId: request.userId } });
      if (!version) throw problem("That saved version is no longer available.", 404);
      const { page, task } = await editablePage(tx, request.userId, { pageId: version.pageId }, true);
      if (!page || page.revision !== body.revision || page.updatedAt.toISOString() !== body.updatedAt) throw problem("This page changed while you were viewing its history. Refresh the versions before restoring.", 409);
      await checkpointPage(tx, page, task?.title ?? page.title, true);
      const result = await writePageContent(tx, request.userId, { pageId: page.id }, () => ({ content: PageDocument.parse(version.content ?? EMPTY_PAGE), ...(task ? {} : { title: version.title }) }), "me", { restoring: true });
      await tx.taskPage.update({ where: { id: page.id }, data: { annotations: version.annotations as Prisma.InputJsonValue } });
      return result;
    });
    await collabHub.refresh({ space: request.userId, kind: restored.taskId ? "task" : "page", id: restored.taskId ?? restored.id });
    sseHub.publish(request.userId, { event: "page", data: { id: restored.id, taskId: restored.taskId, action: "restore" } });
    return { restored };
  });
  app.post("/api/pages/:id/duplicate", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await collabHub.flush({ space: request.userId, kind: "page", id });
    const page = await prisma.$transaction(async tx => {
      const { page: source } = await editablePage(tx, request.userId, { pageId: id }, true);
      if (!source || source.taskId) throw problem("Choose a standalone page to duplicate.", 400);
      const copied = await createStandalonePage(tx, request.userId, { title: Array.from(`Copy of ${source.title || "Untitled"}`).slice(0, 200).join(""), content: await copyPageDocument(tx, request.userId, source.content ? PageDocument.parse(source.content) : null), sourceFileId: null });
      if (source.parentId) await tx.taskPage.update({ where: { id: copied.id }, data: { parentId: source.parentId } });
      return copied;
    });
    sseHub.publish(request.userId, { event: "page", data: { id: page.id, action: "create" } });
    return reply.code(201).send({ page });
  });
  const profile = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { onboardingRole: true } })).onboardingRole ?? "general";
  app.get("/api/page-templates", async request => {
    const key = await profile(request.userId);
    const templates = await prisma.pageTemplate.findMany({ where: { userId: request.userId, profile: key }, select: { id: true, title: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 50 });
    return { profile: key, templates };
  });
  app.post("/api/pages/:id/template", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { title } = z.object({ title: z.string().trim().min(1).max(120) }).parse(request.body);
    await collabHub.flush({ space: request.userId, kind: "page", id });
    const key = await profile(request.userId);
    const template = await prisma.$transaction(async tx => {
      await lockUserTransaction(tx, request.userId);
      if (await tx.pageTemplate.count({ where: { userId: request.userId, profile: key } }) >= 50) throw problem("You have 50 page templates. Remove one from the new-page picker first.", 409);
      const { page } = await editablePage(tx, request.userId, { pageId: id }, true);
      if (!page || page.taskId) throw problem("Choose a standalone page to save as a template.", 400);
      return tx.pageTemplate.create({ data: { userId: request.userId, profile: key, title, content: await copyPageDocument(tx, request.userId, page.content ? PageDocument.parse(page.content) : null) as Prisma.InputJsonValue }, select: { id: true, title: true } });
    });
    return reply.code(201).send({ template });
  });
  app.post("/api/page-templates/:id/create", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const template = await prisma.pageTemplate.findFirst({ where: { id, userId: request.userId, profile: await profile(request.userId) } });
    if (!template) throw problem("That template is not available for your profile in this space.", 404);
    const page = await createStandalonePage(prisma, request.userId, { title: template.title, content: PageDocument.parse(template.content), sourceFileId: null });
    sseHub.publish(request.userId, { event: "page", data: { id: page.id, action: "create" } });
    return reply.code(201).send({ page });
  });
  app.delete("/api/page-templates/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await prisma.pageTemplate.deleteMany({ where: { id, userId: request.userId, profile: await profile(request.userId) } });
    return reply.code(204).send();
  });
}
