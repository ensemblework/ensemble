import type { Prisma, PrismaClient } from "@prisma/client";
import { PageDocument, type PageNode } from "@ensemble/shared-types";
type Db = PrismaClient | Prisma.TransactionClient;
type Resource = { kind: string; resourceId: string; spaceId: string };
const keyOf = (row: Resource) => `${row.spaceId}/${row.kind}/${row.resourceId}`;
export function firstPageLine(value: unknown): string {
  const parsed = PageDocument.safeParse(value);
  if (!parsed.success) return "";
  const text = (node: PageNode): string => node.text ?? (node.type === "mention" ? String(node.attrs?.label ?? "") : node.content?.map(text).join(" ") ?? "");
  return (parsed.data.content ?? []).map(text).map(line => line.replace(/\s+/g, " ").trim()).find(Boolean)?.slice(0, 180) ?? "";
}
/** Bounded round trips, with exact space/id keys even when a directory contains many shares. */
export async function sharePreviews(db: Db, resources: Resource[]) {
  const pages = resources.filter(row => row.kind === "page"), tasks = resources.filter(row => row.kind === "task");
  const out = new Map<string, { title: string; excerpt: string }>();
  if (pages.length) for (const page of await db.taskPage.findMany({ where: { id: { in: pages.map(row => row.resourceId) }, userId: { in: pages.map(row => row.spaceId) }, deletedAt: null, taskId: null }, select: { id: true, userId: true, title: true, content: true } })) out.set(keyOf({ kind: "page", resourceId: page.id, spaceId: page.userId }), { title: page.title || "Untitled", excerpt: firstPageLine(page.content) });
  if (tasks.length) for (const task of await db.task.findMany({ where: { id: { in: tasks.map(row => row.resourceId) }, userId: { in: tasks.map(row => row.spaceId) }, deletedAt: null }, select: { id: true, userId: true, title: true, description: true, page: { select: { content: true } } } })) out.set(keyOf({ kind: "task", resourceId: task.id, spaceId: task.userId }), { title: task.title || "Untitled task", excerpt: firstPageLine(task.page?.content) || task.description.slice(0, 180) });
  return (row: Resource) => out.get(keyOf(row));
}
