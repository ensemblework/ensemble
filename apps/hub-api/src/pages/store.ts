import { Prisma, type PrismaClient, type Task } from "@prisma/client";
import {
  EMPTY_PAGE,
  PageAnnotation,
  PageDocument,
  PageMention,
  SaveTaskPage,
  restoreMentionLinks,
  type TaskPageContent,
} from "@ensemble/shared-types";
import { pageSearchText } from "./markdown.js";

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
  const found: Array<{ kind: string; entityId: string; label: string }> = [];
  const walk = (nodes: typeof doc.content) => {
    for (const node of nodes) {
      if (node.type === "mention" && node.attrs) {
        found.push({
          kind: String(node.attrs.kind ?? "people"),
          entityId: String(node.attrs.id ?? ""),
          label: String(node.attrs.label ?? ""),
        });
      }
      if (node.content) walk(node.content);
    }
  };
  walk(doc.content);
  return found.filter((m) => m.entityId);
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

export { EMPTY_PAGE };
