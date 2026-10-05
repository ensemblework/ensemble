import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/** Keep the current text as a revision before it is replaced. Older than 30 versions are dropped. */
export async function rememberRevision(
  db: Db,
  row: { id: string; userId: string; version: number; title: string; source: string; document: Prisma.InputJsonValue },
): Promise<void> {
  await db.blockDiagramRevision.upsert({
    where: { diagramId_version: { diagramId: row.id, version: row.version } },
    create: {
      userId: row.userId,
      diagramId: row.id,
      version: row.version,
      title: row.title,
      source: row.source,
      document: row.document,
    },
    update: {},
  });
  const stale = await db.blockDiagramRevision.findMany({
    where: { diagramId: row.id },
    orderBy: { version: "desc" },
    skip: 30,
    select: { id: true },
  });
  if (stale.length) await db.blockDiagramRevision.deleteMany({ where: { id: { in: stale.map((item) => item.id) } } });
}
