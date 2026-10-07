import { Prisma, type PrismaClient, type Task } from "@prisma/client";
import {
  EMPTY_PAGE,
  PageAnnotation,
  PageDocument,
  PageMention,
  SaveTaskPage,
  documentMentions,
  type PageNode,
  restoreMentionLinks,
  type TaskPageContent,
} from "@ensemble/shared-types";
import { markdownToNodes, pageSearchText } from "./markdown.js";
import { createTask } from "../services/tasks.js";

export class TaskPageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
  }
}

type Db = Prisma.TransactionClient;
type StoredPage = Prisma.TaskPageGetPayload<{ include: { mentions: true } }>;

function snapshot(page: StoredPage | null, notes: string) {
  return {
    notes: page?.notesSnapshot ?? notes,
    content: page?.content ? PageDocument.parse(page.content) : null,
    annotations: page ? PageAnnotation.array().parse(page.annotations) : [],
    notesSnapshot: page?.notesSnapshot ?? notes,
    mentions: (page?.mentions ?? []).map((mention) =>
      PageMention.parse({ kind: mention.kind, id: mention.entityId, label: mention.label }),
    ),
  };
}

async function readPage(db: Db, userId: string, taskId: string): Promise<StoredPage | null> {
  return db.taskPage.findFirst({
    where: { userId, taskId },
    include: { mentions: { orderBy: [{ kind: "asc" }, { entityId: "asc" }] } },
  });
}

export async function taskForPage(db: Db, userId: string, taskId: string, lock = false): Promise<Task> {
  if (lock) {
    await db.$queryRaw`
      SELECT id FROM tasks WHERE id = ${taskId} AND user_id = ${userId} FOR UPDATE
    `;
  }
  const task = await db.task.findFirst({ where: { id: taskId, userId, deletedAt: null } });
  if (!task) throw new TaskPageError("TASK_NOT_FOUND", "Task not found.", 404);
  return task;
}

async function pageDto(db: Db, task: Task, page: StoredPage | null): Promise<TaskPageContent> {
  const state = snapshot(page, task.notes);
  return {
    taskId: task.id,
    revision: page?.revision ?? 0,
    content: state.content,
    notes: task.notes,
    annotations: state.annotations,
    mentions: state.mentions,
    notesChangedExternally: state.notesSnapshot !== task.notes,
    updatedAt: page?.updatedAt.toISOString() ?? null,
  };
}

export async function getTaskPage(prisma: PrismaClient, userId: string, taskId: string): Promise<TaskPageContent> {
  return prisma.$transaction(
    async (db) => {
      const task = await taskForPage(db, userId, taskId);
      return pageDto(db, task, await readPage(db, userId, taskId));
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

function collectMentions(doc: PageDocument): Array<{ kind: string; entityId: string; label: string }> {
  return documentMentions(doc).map((mention) => ({ kind: mention.kind, entityId: mention.id, label: mention.label }));
}

export async function saveTaskPage(
  prisma: PrismaClient,
  userId: string,
  taskId: string,
  input: unknown,
): Promise<TaskPageContent> {
  const body = SaveTaskPage.parse(input);
  const content = restoreMentionLinks(body.content);
  return prisma.$transaction(
    async (db) => {
      const task = await taskForPage(db, userId, taskId, true);
      const existing = await readPage(db, userId, taskId);
      if (existing && existing.revision !== body.revision) {
        throw new TaskPageError("REVISION_CONFLICT", "This page changed in another tab.", 409);
      }
      const notes = body.notes ?? task.notes;
      const mentions = collectMentions(content);
      const data = {
        userId,
        taskId,
        revision: (existing?.revision ?? 0) + 1,
        content: content as Prisma.InputJsonValue,
        annotations: (body.annotations ?? []) as Prisma.InputJsonValue,
        notesSnapshot: notes,
        searchText: pageSearchText(existing?.title || task.title, content, notes),
      };
      const page = existing
        ? await db.taskPage.update({
            where: { id: existing.id },
            data,
            include: { mentions: true },
          })
        : await db.taskPage.create({ data, include: { mentions: true } });

      await db.taskPageMention.deleteMany({ where: { pageId: page.id } });
      if (mentions.length) {
        await db.taskPageMention.createMany({
          data: mentions.map((m) => ({ pageId: page.id, kind: m.kind, entityId: m.entityId, label: m.label })),
        });
      }
      if (notes !== task.notes) {
        await db.task.update({ where: { id: task.id }, data: { notes } });
      }
      const fresh = await readPage(db, userId, taskId);
      return pageDto(db, { ...task, notes }, fresh);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export type StandalonePageSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export type StandalonePageContent = {
  id: string;
  title: string;
  taskId: null;
  revision: number;
  content: PageDocument | null;
  notes: string;
  annotations: PageAnnotation[];
  mentions: PageMention[];
  notesChangedExternally: false;
  updatedAt: string | null;
};

function standaloneDto(page: StoredPage & { title: string }): StandalonePageContent {
  const state = snapshot(page, page.notesSnapshot);
  return {
    id: page.id,
    title: page.title,
    taskId: null,
    revision: page.revision,
    content: state.content,
    notes: page.notesSnapshot,
    annotations: state.annotations,
    mentions: state.mentions,
    notesChangedExternally: false,
    updatedAt: page.updatedAt.toISOString(),
  };
}

async function ownedStandalone(db: Db, userId: string, id: string, lock = false): Promise<StoredPage | null> {
  if (lock) {
    // Saves and renames both rebuild search_text from the other's fields, and a
    // rename does not bump the revision. The row lock makes them take turns.
    await db.$queryRaw`
      SELECT id FROM task_pages WHERE id = ${id} AND user_id = ${userId} AND task_id IS NULL FOR UPDATE
    `;
  }
  return db.taskPage.findFirst({
    where: { id, userId, taskId: null },
    include: { mentions: { orderBy: [{ kind: "asc" }, { entityId: "asc" }] } },
  });
}

export async function listStandalonePages(prisma: PrismaClient, userId: string): Promise<StandalonePageSummary[]> {
  const rows = await prisma.taskPage.findMany({
    where: { userId, taskId: null },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true, title: true, updatedAt: true },
  });
  return rows.map((row) => ({ id: row.id, title: row.title || "Untitled", updatedAt: row.updatedAt.toISOString() }));
}

export async function createStandalonePage(prisma: PrismaClient, userId: string): Promise<StandalonePageSummary> {
  const page = await prisma.taskPage.create({
    data: {
      userId,
      taskId: null,
      title: "Untitled",
      revision: 1,
      content: EMPTY_PAGE as Prisma.InputJsonValue,
      annotations: [],
      notesSnapshot: "",
      searchText: pageSearchText("Untitled", EMPTY_PAGE, ""),
    },
    select: { id: true, title: true, updatedAt: true },
  });
  return { id: page.id, title: page.title, updatedAt: page.updatedAt.toISOString() };
}

export async function getStandalonePage(prisma: PrismaClient, userId: string, id: string): Promise<StandalonePageContent> {
  const page = await ownedStandalone(prisma, userId, id);
  if (!page) throw new TaskPageError("PAGE_NOT_FOUND", "Page not found.", 404);
  return standaloneDto(page);
}

export async function renameStandalonePage(
  prisma: PrismaClient,
  userId: string,
  id: string,
  title: string,
): Promise<StandalonePageSummary> {
  const trimmed = title.trim();
  if (!trimmed) throw new TaskPageError("TITLE_REQUIRED", "Give the page a title.", 400);
  return prisma.$transaction(async (db) => {
    const page = await ownedStandalone(db, userId, id, true);
    if (!page) throw new TaskPageError("PAGE_NOT_FOUND", "Page not found.", 404);
    const content = page.content ? PageDocument.parse(page.content) : null;
    const updated = await db.taskPage.update({
      where: { id: page.id },
      data: { title: trimmed, searchText: pageSearchText(trimmed, content, page.notesSnapshot) },
      select: { id: true, title: true, updatedAt: true },
    });
    return { id: updated.id, title: updated.title, updatedAt: updated.updatedAt.toISOString() };
  });
}

export async function saveStandalonePage(
  prisma: PrismaClient,
  userId: string,
  id: string,
  input: unknown,
): Promise<StandalonePageContent> {
  const body = SaveTaskPage.parse(input);
  const content = restoreMentionLinks(body.content);
  return prisma.$transaction(async (db) => {
    const existing = await ownedStandalone(db, userId, id, true);
    if (!existing) throw new TaskPageError("PAGE_NOT_FOUND", "Page not found.", 404);
    if (existing.revision !== body.revision) {
      throw new TaskPageError("REVISION_CONFLICT", "This page changed in another tab.", 409);
    }
    const notes = body.notes ?? existing.notesSnapshot;
    const mentions = collectMentions(content);
    const page = await db.taskPage.update({
      where: { id: existing.id },
      data: {
        revision: existing.revision + 1,
        content: content as Prisma.InputJsonValue,
        annotations: (body.annotations ?? []) as Prisma.InputJsonValue,
        notesSnapshot: notes,
        searchText: pageSearchText(existing.title, content, notes),
      },
      include: { mentions: true },
    });
    await db.taskPageMention.deleteMany({ where: { pageId: page.id } });
    if (mentions.length) {
      await db.taskPageMention.createMany({
        data: mentions.map((mention) => ({ pageId: page.id, kind: mention.kind, entityId: mention.entityId, label: mention.label })),
      });
    }
    const fresh = await ownedStandalone(db, userId, id);
    if (!fresh) throw new TaskPageError("PAGE_NOT_FOUND", "Page not found.", 404);
    return standaloneDto(fresh);
  });
}

/** Removes a standalone note only. A linked page is left on its task. */
export async function deleteStandalonePage(prisma: PrismaClient, userId: string, id: string): Promise<void> {
  const page = await prisma.taskPage.findFirst({ where: { id, userId, taskId: null }, select: { id: true } });
  if (!page) throw new TaskPageError("PAGE_NOT_FOUND", "Page not found.", 404);
  await prisma.taskPage.delete({ where: { id: page.id } });
}

function retargetReplies(content: PageDocument, kind: "page" | "task", id: string): PageDocument {
  const walk = (node: PageNode): PageNode => ({
    ...node,
    ...(node.type === "ensembleReply" ? { attrs: { ...node.attrs, pageKind: kind, pageId: id } } : {}),
    ...(node.content ? { content: node.content.map(walk) } : {}),
  });
  return { ...content, content: content.content.map(walk) };
}

export async function convertPage(
  prisma: PrismaClient,
  userId: string,
  kind: "page" | "task",
  id: string,
  revision: number,
): Promise<{ kind: "page" | "task"; id: string; pageId: string }> {
  return prisma.$transaction(async (db) => {
    const task = kind === "task" ? await taskForPage(db, userId, id, true) : null;
    const page = task ? await readPage(db, userId, id) : await ownedStandalone(db, userId, id, true);
    if (!task && !page) throw new TaskPageError("PAGE_NOT_FOUND", "Page not found.", 404);
    if ((page?.revision ?? 0) !== revision) {
      throw new TaskPageError("REVISION_CONFLICT", "This page changed in another tab. Save or reload before converting.", 409);
    }
    const streaming = await db.pageDiscussion.count({
      where: { userId, pageKind: kind, pageId: id, status: "streaming", deletedAt: null },
    });
    if (streaming) throw new TaskPageError("PAGE_BUSY", "Wait for Ensemble to finish before converting this page.", 409);
    if (task) {
      const [runs, jobs] = await Promise.all([
        db.run.count({ where: { userId, taskId: id, endedAt: null, deletedAt: null } }),
        db.workspaceJob.count({ where: { userId, taskId: id, status: { in: ["queued", "running", "stopping", "claimed", "waiting_approval", "blocked"] } } }),
      ]);
      if (runs || jobs) throw new TaskPageError("TASK_BUSY", "Finish or cancel this task's agent work before converting it.", 409);
    }
    const title = task?.title ?? page!.title;
    const notes = task?.notes ?? page!.notesSnapshot;
    const content = page?.content ? PageDocument.parse(page.content) : { type: "doc" as const, content: markdownToNodes(notes) };
    let targetId: string;
    const targetKind = task ? "page" as const : "task" as const;
    if (task) {
      const saved = page ?? await db.taskPage.create({
        data: { userId, taskId: id, title, content: content as Prisma.InputJsonValue, notesSnapshot: notes },
        include: { mentions: true },
      });
      targetId = saved.id;
      await db.taskPage.update({
        where: { id: saved.id },
        data: {
          taskId: null, title, revision: saved.revision + 1, notesSnapshot: notes,
          content: retargetReplies(content, "page", targetId) as Prisma.InputJsonValue,
          searchText: pageSearchText(title, content, notes),
        },
      });
      await db.task.update({ where: { id }, data: { deletedAt: new Date() } });
    } else {
      // Undoing a task creation deletes its linked page. Conversion must never journal that destructive inverse.
      const created = await createTask(db, userId, { title: title || "Untitled", notes, status: "todo" }, "me", false);
      targetId = created.id;
      await db.taskPage.update({
        where: { id: page!.id },
        data: {
          taskId: targetId, revision: page!.revision + 1,
          content: retargetReplies(content, "task", targetId) as Prisma.InputJsonValue,
        },
      });
    }
    await db.pageDiscussion.updateMany({
      where: { userId, pageKind: kind, pageId: id },
      data: { pageKind: targetKind, pageId: targetId, sourceKind: targetKind, sourceId: targetId, taskId: targetKind === "task" ? targetId : null },
    });
    await db.diagramLink.updateMany({
      where: { userId, targetKind: kind, targetId: id },
      data: { targetKind, targetId },
    });
    return { kind: targetKind, id: targetId, pageId: page?.id ?? targetId };
  });
}

export { EMPTY_PAGE };
