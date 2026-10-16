import type { Prisma, TaskPage } from "@prisma/client";
import { PageDocument, markdownToNodes } from "@ensemble/shared-types";
import { copyPageDocument } from "./copy.js";
import { currentScope } from "../sharing/context.js";

type Db = Prisma.TransactionClient;
export const PAGE_HISTORY_LIMIT = 30;
export const PAGE_CHECKPOINT_MS = 5 * 60_000;

/** Capture a bounded checkpoint before replacing content. Live typing shares a five-minute window. */
export async function checkpointPage(db: Db, page: TaskPage, title = page.title, force = false): Promise<void> {
  const now = new Date();
  if (!force && page.historySavedAt && now.getTime() - page.historySavedAt.getTime() < PAGE_CHECKPOINT_MS) return;
  const content = await copyPageDocument(db, page.userId, page.content ? PageDocument.parse(page.content) : { type: "doc", content: markdownToNodes(page.notesSnapshot || "") }, true);
  await db.pageRevision.create({ data: {
    userId: page.userId, pageId: page.id, revision: page.revision, title: title || "Untitled",
    content: content as Prisma.InputJsonValue,
    annotations: page.annotations as Prisma.InputJsonValue, authorAccountId: page.editorAccountId, createdAt: page.updatedAt,
  } });
  await db.taskPage.update({ where: { id: page.id }, data: { historySavedAt: now } });
  const stale = await db.pageRevision.findMany({ where: { pageId: page.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: PAGE_HISTORY_LIMIT, select: { id: true } });
  if (stale.length) await db.pageRevision.deleteMany({ where: { id: { in: stale.map(row => row.id) } } });
}

export async function pageEditor(db: Db, spaceId: string): Promise<string | null> {
  const scope = currentScope();
  if (scope) return scope.accountId;
  const space = await db.user.findUnique({ where: { id: spaceId }, select: { ownerId: true } });
  return space?.ownerId ?? spaceId;
}
