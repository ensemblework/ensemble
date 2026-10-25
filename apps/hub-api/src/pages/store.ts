import { checkpointPage, pageEditor } from "./history.js";
import { Prisma, type Actor, type PrismaClient, type Task } from "@prisma/client";
import {
  EMPTY_PAGE,
  PageAnnotation,
  PageDocument,
  PageMention,
  SaveTaskPage,
  type PageNode,
  restoreMentionLinks,
  type TaskPageContent,
} from "@ensemble/shared-types";
import { markdownToNodes, pageSearchText } from "./markdown.js";
import { storable } from "./content.js";
import { assertNewPageImages } from "../files/page-image.js";
import { lockUserTransaction } from "../lib/user-lock.js";
import { recordUndoInTransaction, withUndoGroup } from "../lib/undo.js";
import { createTask } from "../services/tasks.js";
import { currentScope, isGuestIn } from "../sharing/context.js";

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

const PAGE_INCLUDE = {
  mentions: { orderBy: [{ kind: "asc" as const }, { entityId: "asc" as const }] },
  sourceFile: { select: { id: true, filename: true, format: true, style: true, deletedAt: true } },
  parent: { select: { userId: true, taskId: true, deletedAt: true, task: { select: { deletedAt: true } } } },
} satisfies Prisma.TaskPageInclude;
type StoredPage = Prisma.TaskPageGetPayload<{ include: typeof PAGE_INCLUDE }>;

/** The file a page was converted from, while that file is still kept. */
function sourceFileOf(page: StoredPage | null): TaskPageContent["sourceFile"] {
  const file = page?.sourceFile;
  if (!file || file.deletedAt) return null;
  return { id: file.id, filename: file.filename, format: file.format, hasStyle: Boolean(file.style) };
}

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
  return db.taskPage.findFirst({ where: { userId, taskId }, include: PAGE_INCLUDE });
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
    sourceFile: sourceFileOf(page),
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

/** The mentions to index. One the index cannot hold (an unknown kind) is left out rather than failing the save. */
function collectMentions(doc: PageDocument): Array<{ kind: string; entityId: string; label: string }> {
  const found = new Map<string, { kind: string; entityId: string; label: string }>();
  const walk = (node: PageNode) => {
    if (node.type === "mention" && node.attrs) {
      const mention = PageMention.safeParse({ kind: String(node.attrs.kind ?? "people"), id: String(node.attrs.id ?? ""), label: String(node.attrs.label ?? "") });
      if (mention.success && mention.data.id) found.set(JSON.stringify([mention.data.kind, mention.data.id]), { kind: mention.data.kind, entityId: mention.data.id, label: mention.data.label });
    }
    node.content?.forEach(walk);
  };
  doc.content.forEach(walk);
  return [...found.values()];
}

export async function saveTaskPage(
  prisma: PrismaClient,
  userId: string,
  taskId: string,
  input: unknown,
): Promise<TaskPageContent> {
  const body = SaveTaskPage.parse(input);
  const content = storable(restoreMentionLinks(body.content));
  return prisma.$transaction(
    async (db) => {
      const task = await taskForPage(db, userId, taskId, true);
      const existing = await readPage(db, userId, taskId);
      if (existing && existing.revision !== body.revision) {
        throw new TaskPageError("REVISION_CONFLICT", "This page changed in another tab.", 409);
      }
      await assertNewPageImages(db, userId, content, existing?.content ?? null);
      if (existing) await checkpointPage(db, existing, existing.title || task.title);
      const notes = body.notes ?? task.notes;
      const mentions = collectMentions(content);
      const data = {
        userId,
        taskId,
        revision: (existing?.revision ?? 0) + 1,
        editorAccountId: await pageEditor(db, userId),
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
  parentId: string | null;
  id: string;
  title: string;
  updatedAt: string;
  createdAt?: string;
  /** With a search: the words around the first match in the page's text. */
  snippet?: string;
};

export type StandalonePageContent = {
  parentId: string | null;
  parentTaskId: string | null;
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
  sourceFile: TaskPageContent["sourceFile"];
};

function standaloneDto(page: StoredPage & { title: string }): StandalonePageContent {
  const state = snapshot(page, page.notesSnapshot);
  const scope = currentScope();
  const item = scope?.spaceId === page.userId && (scope.access.kind === "share" || scope.access.kind === "link");
  const parent = !item && page.parent?.userId === page.userId && !page.parent.deletedAt && !page.parent.task?.deletedAt ? page.parent : null;
  return {
    id: page.id,
    parentId: parent ? page.parentId : null,
    parentTaskId: parent?.taskId ?? null,
    title: page.title,
    taskId: null,
    revision: page.revision,
    content: state.content,
    notes: page.notesSnapshot,
    annotations: state.annotations,
    mentions: state.mentions,
    notesChangedExternally: false,
    updatedAt: page.updatedAt.toISOString(),
    sourceFile: sourceFileOf(page),
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
  return db.taskPage.findFirst({ where: { id, userId, taskId: null, deletedAt: null }, include: PAGE_INCLUDE });
}

export async function listStandalonePages(prisma: PrismaClient, userId: string, query = ""): Promise<StandalonePageSummary[]> {
  const words = query.trim().slice(0, 200);
  const rows = await prisma.taskPage.findMany({
    where: { userId, taskId: null, deletedAt: null, ...(words ? { searchText: { contains: words, mode: "insensitive" as const } } : {}) },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true, title: true, updatedAt: true, createdAt: true, parentId: true, ...(words ? { searchText: true } : {}) },
    ...(words ? { take: 200 } : {}),
  });
  return rows.map((row) => ({
    id: row.id,
    parentId: row.parentId,
    title: row.title || "Untitled",
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    ...(words ? { snippet: searchSnippet((row as { searchText?: string | null }).searchText ?? "", row.title, words) } : {}),
  }));
}

/** About 120 characters of the page's text around the first match, title left out. */
export function searchSnippet(text: string, title: string, query: string): string {
  const body = text.startsWith(title.trim()) ? text.slice(title.trim().length) : text;
  const flat = body.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return "";
  let start = Math.max(0, at - 50);
  let end = Math.min(flat.length, at + query.length + 70);
  // Whole words only at the cut ends.
  if (start > 0) start = Math.min(at, flat.indexOf(" ", start) + 1 || at);
  if (end < flat.length) end = Math.max(at + query.length, flat.lastIndexOf(" ", end));
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

/** A new note: empty, or made from a file (`sourceFileId`) or from text with its title and content. */
export async function createStandalonePage(
  prisma: Db,
  userId: string,
  from: { title: string; content: PageDocument; sourceFileId: string | null; externalSource?: string; externalId?: string } | null = null,
): Promise<StandalonePageSummary> {
  const title = from?.title.trim() || "Untitled";
  const content = from ? storable(restoreMentionLinks(PageDocument.parse(from.content))) : EMPTY_PAGE;
  const mentions = from ? collectMentions(content) : [];
  const page = await prisma.taskPage.create({
    data: {
      userId,
      taskId: null,
      editorAccountId: await pageEditor(prisma, userId),
      title,
      revision: 1,
      content: content as Prisma.InputJsonValue,
      annotations: [],
      notesSnapshot: "",
      searchText: pageSearchText(title, content, ""),
      sourceFileId: from?.sourceFileId ?? null,
      ...(from?.externalSource && from.externalId ? { externalSource: from.externalSource, externalId: from.externalId } : {}),
      ...(mentions.length ? { mentions: { createMany: { data: mentions.map((mention) => ({ kind: mention.kind, entityId: mention.entityId, label: mention.label })) } } } : {}),
    },
    select: { id: true, title: true, updatedAt: true, parentId: true },
  });
  return { id: page.id, parentId: page.parentId, title: page.title, updatedAt: page.updatedAt.toISOString() };
}

/**
 * A page to open. A page in Trash answers 404 `PAGE_IN_TRASH` to the space owner, so the
 * Hub can offer Restore; with `trashed`, the owner gets it to read, with `deletedAt` set.
 */
export async function getStandalonePage(
  prisma: PrismaClient,
  userId: string,
  id: string,
  options: { trashed?: boolean } = {},
): Promise<StandalonePageContent & { deletedAt?: string }> {
  const page = await ownedStandalone(prisma, userId, id);
  if (page) return standaloneDto(page);
  const binned = isGuestIn(userId)
    ? null
    : await prisma.taskPage.findFirst({ where: { id, userId, taskId: null, deletedAt: { not: null } }, include: PAGE_INCLUDE });
  if (binned?.deletedAt && options.trashed) return { ...standaloneDto(binned), deletedAt: binned.deletedAt.toISOString() };
  if (binned) throw new TaskPageError("PAGE_IN_TRASH", "This page is in Trash.", 404);
  throw new TaskPageError("PAGE_NOT_FOUND", "Page not found.", 404);
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
    await checkpointPage(db, page);
    const content = page.content ? PageDocument.parse(page.content) : null;
    const updated = await db.taskPage.update({
      where: { id: page.id },
      data: { title: trimmed, editorAccountId: await pageEditor(db, userId), searchText: pageSearchText(trimmed, content, page.notesSnapshot) },
      select: { id: true, title: true, updatedAt: true, parentId: true },
    });
    return { id: updated.id, parentId: updated.parentId, title: updated.title, updatedAt: updated.updatedAt.toISOString() };
  });
}

export async function saveStandalonePage(
  prisma: PrismaClient,
  userId: string,
  id: string,
  input: unknown,
): Promise<StandalonePageContent> {
  const body = SaveTaskPage.parse(input);
  const content = storable(restoreMentionLinks(body.content));
  return prisma.$transaction(async (db) => {
    const existing = await ownedStandalone(db, userId, id, true);
    if (!existing) throw new TaskPageError("PAGE_NOT_FOUND", "Page not found.", 404);
    if (existing.revision !== body.revision) {
      throw new TaskPageError("REVISION_CONFLICT", "This page changed in another tab.", 409);
    }
    await assertNewPageImages(db, userId, content, existing.content);
    await checkpointPage(db, existing);
    const notes = body.notes ?? existing.notesSnapshot;
    const mentions = collectMentions(content);
    const page = await db.taskPage.update({
      where: { id: existing.id },
      data: {
        revision: existing.revision + 1,
        editorAccountId: await pageEditor(db, userId),
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

/** Standalone notes stay recoverable, including their content, mentions, and discussions. */
export async function deleteStandalonePage(prisma: PrismaClient, userId: string, id: string): Promise<void> {
  await prisma.$transaction((db) => trashStandalonePage(db, userId, id));
}

/** Moves a standalone note to Trash inside the caller's transaction, with its undo entry. */
export async function trashStandalonePage(db: Db, userId: string, id: string, actor: Actor = "me"): Promise<{ title: string }> {
  const result = await trashStandalonePages(db, userId, [id], actor);
  return { title: result.pages.find((page) => page.id === id)!.title };
}

/** Validate every selected page first; the complete set and descendants share one atomic undo entry. */
export async function trashStandalonePages(db: Db, userId: string, ids: string[], actor: Actor = "me") {
  await lockUserTransaction(db, userId);
  const unique = [...new Set(ids)];
  const selected = await db.taskPage.findMany({ where: { userId, id: { in: unique }, taskId: null, deletedAt: null } });
  if (selected.length !== unique.length) throw new TaskPageError("PAGE_NOT_FOUND", "One or more pages are unavailable or belong to a task. List pages again before deleting.", 404);
  const pages = new Map(selected.map((page) => [page.id, page]));
  let frontier = unique;
  while (frontier.length) {
    const children = await db.taskPage.findMany({ where: { userId, parentId: { in: frontier }, taskId: null, deletedAt: null } });
    frontier = [];
    for (const child of children) if (!pages.has(child.id)) { pages.set(child.id, child); frontier.push(child.id); }
  }
  const result = await withUndoGroup(db, { userId, actor, subject: "page" }, async () => {
    const deletedAt = new Date();
    for (const page of pages.values()) {
      const updated = await db.taskPage.update({ where: { id: page.id }, data: { deletedAt } });
      const op = { op: "update" as const, model: "taskPage" as const, id: page.id, before: { deletedAt: page.deletedAt }, after: { deletedAt: updated.deletedAt, updatedAt: updated.updatedAt } };
      await recordUndoInTransaction(db, { userId, label: `Deleted “${page.title || "Untitled"}”`, kind: "delete", actor, subject: "page", href: `/pages/${page.id}`, inverse: op, forward: op });
    }
    return [...pages.values()].map((page) => ({ id: page.id, title: page.title || "Untitled" }));
  });
  return { pages: result.result, undoEntryId: result.undoEntryId };
}

export type PageTarget = { pageId: string } | { taskId: string };

/** A page to edit: a standalone note or a task's page, by its page id or its task id. Its task is checked too. */
export async function editablePage(db: Db, userId: string, target: PageTarget, lock = false) {
  if ("taskId" in target) {
    const task = await taskForPage(db, userId, target.taskId, lock).catch((error: unknown) => {
      if (error instanceof TaskPageError) throw new TaskPageError(error.code, "No task with that id. Call hub_list_tasks and use an id it returns.", 404);
      throw error;
    });
    return { task, page: await readPage(db, userId, task.id) };
  }
  if (lock) {
    await db.$queryRaw`SELECT id FROM task_pages WHERE id = ${target.pageId} AND user_id = ${userId} FOR UPDATE`;
  }
  const page = await db.taskPage.findFirst({ where: { id: target.pageId, userId, deletedAt: null }, include: PAGE_INCLUDE });
  if (!page) throw new TaskPageError("PAGE_NOT_FOUND", "No page with that id. Call hub_list_pages and use an id it returns.", 404);
  const task = page.taskId ? await taskForPage(db, userId, page.taskId, lock) : null;
  return { task, page };
}

export interface CurrentPage {
  title: string;
  taskId: string | null;
  content: PageDocument | null;
  notes: string;
}

/**
 * Writes new content (and, for a standalone note, a new title) inside the caller's transaction,
 * keeping the mention index and search text in step and journaling one undo entry. `next` sees
 * the page as it is once locked and may throw to refuse. A task with no page gets an empty one
 * first, so undo returns it to "no content" rather than removing it. Images the write adds are
 * held to the page-image rules (`assertNewPageImages`) unless `restoring` a saved version, whose
 * images the page already held.
 */
export async function writePageContent(
  db: Db,
  userId: string,
  target: PageTarget,
  next: (current: CurrentPage) => { content: PageDocument; title?: string },
  actor: Actor = "me",
  options: { restoring?: boolean } = {},
): Promise<{ id: string; taskId: string | null; title: string; revision: number }> {
  await lockUserTransaction(db, userId);
  const found = await editablePage(db, userId, target, true);
  const { task } = found;
  const currentTitle = task ? task.title : found.page?.title || "Untitled";
  const notesNow = task ? task.notes : (found.page?.notesSnapshot ?? "");
  const wanted = next({ title: currentTitle, taskId: task?.id ?? null, content: found.page?.content ? PageDocument.parse(found.page.content) : null, notes: notesNow });
  const page = found.page ?? (task ? await db.taskPage.create({ data: { userId, taskId: task.id, notesSnapshot: task.notes, searchText: pageSearchText(task.title, null, task.notes) }, include: PAGE_INCLUDE }) : null);
  if (!page) throw new TaskPageError("PAGE_NOT_FOUND", "Page not found.", 404);
  const content = storable(restoreMentionLinks(PageDocument.parse(wanted.content)));
  if (!options.restoring) await assertNewPageImages(db, userId, content, found.page?.content ?? null);
  const title = task ? task.title : wanted.title?.trim() || currentTitle;
  await checkpointPage(db, page, currentTitle);
  const updated = await db.taskPage.update({
    where: { id: page.id },
    data: {
      editorAccountId: await pageEditor(db, userId),
      revision: page.revision + 1,
      content: content as Prisma.InputJsonValue,
      searchText: pageSearchText(task ? page.title || task.title : title, content, notesNow),
      ...(task ? {} : { title }),
    },
  });
  await db.taskPageMention.deleteMany({ where: { pageId: page.id } });
  const mentions = collectMentions(content);
  if (mentions.length) {
    await db.taskPageMention.createMany({ data: mentions.map((mention) => ({ pageId: page.id, kind: mention.kind, entityId: mention.entityId, label: mention.label })) });
  }
  const before = { content: page.content, searchText: page.searchText, ...(task ? {} : { title: page.title }), updatedAt: page.updatedAt };
  const after = { content: updated.content, searchText: updated.searchText, ...(task ? {} : { title: updated.title }), updatedAt: updated.updatedAt };
  const op = { op: "update" as const, model: "taskPage" as const, id: page.id, before, after };
  const href = task ? `/tasks/${task.id}` : `/pages/${page.id}`;
  await recordUndoInTransaction(db, { userId, label: `Edited “${title}”`, kind: "update", actor, subject: "page", href, inverse: op, forward: op });
  return { id: page.id, taskId: task?.id ?? null, title, revision: updated.revision };
}

/** Generic page discussions and diagram links have no foreign key to a standalone note. */
export async function purgeDeletedStandalonePages(prisma: PrismaClient, userId: string, cutoff?: Date): Promise<number> {
  return prisma.$transaction(async (db) => {
    const age = cutoff ? Prisma.sql`AND deleted_at < ${cutoff}` : Prisma.empty;
    const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM task_pages
      WHERE user_id = ${userId} AND task_id IS NULL AND deleted_at IS NOT NULL ${age}
      ORDER BY id FOR UPDATE
    `);
    const ids = rows.map((row) => row.id);
    if (!ids.length) return 0;
    await db.pageDiscussion.deleteMany({ where: { userId, pageKind: "page", pageId: { in: ids } } });
    await db.diagramLink.deleteMany({ where: { userId, targetKind: "page", targetId: { in: ids } } });
    return (await db.taskPage.deleteMany({ where: { userId, id: { in: ids }, taskId: null, deletedAt: { not: null } } })).count;
  });
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
          taskId: targetId, revision: page!.revision + 1, boardId: null, boardColumnId: null, boardOrder: 0,
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

export type CollabTarget = { pageId: string } | { taskId: string };
/**
 * A page's stored copy for live editing (`collab.ts`). `fallback` is shown while `content` is null.
 * `trashed`: the page (or its task) is in Trash.
 */
export type CollabRow = {
  revision: number;
  content: unknown;
  fallback: PageDocument;
  trashed: boolean;
  /** The live authority (epoch, version) that wrote `content`, while no other write came since. */
  marker?: { epoch: string; version: number };
};

/** A task's plain notes as paragraphs, the way its page shows them before it is first written. */
export function notesDoc(notes: string): PageDocument {
  return { type: "doc", content: notes.split("\n").map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" })) };
}

/** Also finds pages and tasks in Trash, so typing that was not yet written back still is. */
async function collabRow(db: Db, userId: string, target: CollabTarget, lock: boolean) {
  if ("taskId" in target) {
    if (lock) await db.$queryRaw`SELECT id FROM tasks WHERE id = ${target.taskId} AND user_id = ${userId} FOR UPDATE`;
    const task = await db.task.findFirst({ where: { id: target.taskId, userId } });
    if (!task) return null;
    if (lock) await db.$queryRaw`SELECT id FROM task_pages WHERE user_id = ${userId} AND task_id = ${task.id} FOR UPDATE`;
    const page = await readPage(db, userId, task.id);
    const row: CollabRow = { revision: page?.revision ?? 0, content: page?.content ?? null, fallback: notesDoc(task.notes), trashed: task.deletedAt !== null, ...(page ? await markerOf(db, page.id, page.revision) : {}) };
    return { task, page, row };
  }
  if (lock) await db.$queryRaw`SELECT id FROM task_pages WHERE id = ${target.pageId} AND user_id = ${userId} AND task_id IS NULL FOR UPDATE`;
  const page = await db.taskPage.findFirst({ where: { id: target.pageId, userId, taskId: null }, include: PAGE_INCLUDE });
  if (!page) return null;
  const row: CollabRow = { revision: page.revision, content: page.content, fallback: EMPTY_PAGE, trashed: page.deletedAt !== null, ...(await markerOf(db, page.id, page.revision)) };
  return { task: null, page, row };
}

/** The authority marker, while the page is still at the revision it wrote. */
async function markerOf(db: Db, pageId: string, revision: number): Promise<{ marker?: CollabRow["marker"] }> {
  const [row] = await db.$queryRaw<Array<{ epoch: string | null; version: number | null; revision: number | null }>>`
    SELECT collab_epoch AS epoch, collab_version AS version, collab_revision AS revision FROM task_pages WHERE id = ${pageId}
  `;
  return row?.epoch && row.version !== null && row.revision === revision ? { marker: { epoch: row.epoch, version: row.version } } : {};
}

export async function readCollabPage(prisma: PrismaClient, userId: string, target: CollabTarget): Promise<CollabRow | null> {
  return (await collabRow(prisma, userId, target, false))?.row ?? null;
}

/**
 * The live document's write-back. Locks the page (and its task) like the other writers, shows the
 * stored copy to `decide`, and saves what it returns as the next revision with its mention index
 * and search text, into a page in Trash too (it stays there). No undo entry: typing is undone in
 * the editor.
 */
export async function writeCollabPage(
  prisma: PrismaClient,
  userId: string,
  target: CollabTarget,
  decide: (row: CollabRow) => { content: PageDocument; marker: { epoch: string; version: number }; editorAccountId?: string | null } | null,
): Promise<{ revision: number; wrote: boolean } | null> {
  return prisma.$transaction(async (db) => {
    const found = await collabRow(db, userId, target, true);
    if (!found) return null;
    const next = decide(found.row);
    if (!next) return { revision: found.row.revision, wrote: false };
    const { marker } = next;
    const content = storable(next.content);
    const { task, page } = found;
    if (page && !found.row.trashed) await checkpointPage(db, page, page.title || task?.title);
    const editorAccountId = next.editorAccountId !== undefined ? next.editorAccountId : await pageEditor(db, userId);
    const revision = found.row.revision + 1;
    const searchText = task ? pageSearchText(page?.title || task.title, content, task.notes) : pageSearchText(page!.title, content, page!.notesSnapshot);
    // A page in Trash keeps its time, which Undo of the delete checks.
    const saved = page
      ? await db.taskPage.update({ where: { id: page.id }, data: { revision, editorAccountId, content: content as Prisma.InputJsonValue, searchText, ...(found.row.trashed ? { updatedAt: page.updatedAt } : {}) } })
      : await db.taskPage.create({ data: { userId, taskId: task!.id, revision, editorAccountId, content: content as Prisma.InputJsonValue, notesSnapshot: task!.notes, searchText } });
    await db.taskPageMention.deleteMany({ where: { pageId: saved.id } });
    const mentions = collectMentions(content);
    if (mentions.length) {
      await db.taskPageMention.createMany({ data: mentions.map((mention) => ({ pageId: saved.id, kind: mention.kind, entityId: mention.entityId, label: mention.label })) });
    }
    await db.$executeRaw`UPDATE task_pages SET collab_epoch = ${marker.epoch}, collab_version = ${marker.version}, collab_revision = ${revision} WHERE id = ${saved.id}`;
    return { revision, wrote: true };
  });
}

export { EMPTY_PAGE };
