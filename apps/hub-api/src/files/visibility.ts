import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * A file's text (its file Artifact) is out of search, agents and MCP while the file is in Trash,
 * and comes back with it. Called wherever a file is trashed, restored, or its trashing undone.
 */
export async function syncFileText(db: PrismaClient | Prisma.TransactionClient, documentId: string): Promise<void> {
  const row = await db.document.findUnique({ where: { id: documentId }, select: { userId: true, artifactId: true, deletedAt: true } });
  if (!row?.artifactId) return;
  await db.artifact.updateMany({ where: { id: row.artifactId, userId: row.userId }, data: { deletedAt: row.deletedAt } });
}
