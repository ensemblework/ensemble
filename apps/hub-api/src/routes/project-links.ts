/**
 * Project links (docs/03 §4.8): "this Slack channel / repo / Linear project /
 * Notion database is Project Atlas", set once on the project page and applied
 * at ingest. Containers lists what synced artifacts and imports have seen, so
 * the page can offer them.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { appendLedger } from "../lib/ledger.js";
import { containerKey, forgetLinkCache, LINK_SOURCES } from "../projects/links.js";

const Source = z.enum(LINK_SOURCES);
const CreateLink = z.object({
  projectId: z.string().min(1).max(100),
  source: Source,
  containerId: z.string().trim().min(1).max(300),
  containerName: z.string().trim().max(200).optional(),
});

type LinkRow = { id: string; projectId: string; source: string; containerId: string; containerName: string; createdBy: string; createdAt: Date; project: { name: string } };

const view = (row: LinkRow) => ({
  id: row.id,
  projectId: row.projectId,
  projectName: row.project.name,
  source: row.source,
  containerId: row.containerId,
  containerName: row.containerName || row.containerId,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

const LINK_SELECT = { id: true, projectId: true, source: true, containerId: true, containerName: true, createdBy: true, createdAt: true, project: { select: { name: true } } } as const;

export async function projectLinkRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  app.get("/api/project-links", async (request) => {
    const { projectId } = z.object({ projectId: z.string().max(100).optional() }).parse(request.query);
    const rows = await prisma.projectLink.findMany({
      where: { userId: request.userId, project: { deletedAt: null }, ...(projectId ? { projectId } : {}) },
      select: LINK_SELECT,
      orderBy: [{ source: "asc" }, { containerName: "asc" }],
      take: 500,
    });
    return { links: rows.map(view) };
  });

  app.post("/api/project-links", async (request, reply) => {
    const body = CreateLink.parse(request.body);
    const userId = request.userId;
    const project = await prisma.project.findFirst({ where: { id: body.projectId, userId, deletedAt: null }, select: { id: true } });
    if (!project) return reply.code(404).send({ error: "Project not found." });
    const containerId = containerKey(body.source, body.containerId);
    const existing = await prisma.projectLink.findUnique({ where: { userId_source_containerId: { userId, source: body.source, containerId } }, select: { id: true } });
    const row = existing
      ? await prisma.projectLink.update({
          where: { id: existing.id },
          data: { projectId: project.id, createdBy: "me", ...(body.containerName ? { containerName: body.containerName } : {}) },
          select: LINK_SELECT,
        })
      : await prisma.projectLink.create({
          data: { userId, projectId: project.id, source: body.source, containerId, containerName: body.containerName ?? "", createdBy: "me" },
          select: LINK_SELECT,
        });
    forgetLinkCache(userId);
    // What already arrived from this container joins the project too, unless something else placed it.
    const container = JSON.stringify([{ source: body.source, id: containerId }]);
    const tasks = await prisma.$executeRaw`
      UPDATE "tasks" SET "project_id" = ${project.id}, "updated_at" = NOW()
      WHERE "user_id" = ${userId} AND "project_id" IS NULL AND "status" = 'proposed' AND "deleted_at" IS NULL
        AND "id" IN (SELECT "task_id" FROM "artifacts" WHERE "user_id" = ${userId} AND "task_id" IS NOT NULL AND "metadata"->'containers' @> ${container}::jsonb)`;
    const artifacts = await prisma.$executeRaw`
      UPDATE "artifacts" SET "project_id" = ${project.id}
      WHERE "user_id" = ${userId} AND "project_id" IS NULL AND "deleted_at" IS NULL AND "metadata"->'containers' @> ${container}::jsonb`;
    await appendLedger({ userId, actor: "me", action: "project.link", payload: { projectId: project.id, source: body.source, containerId, artifacts, tasks } });
    return reply.code(existing ? 200 : 201).send({ link: view(row), applied: { artifacts, tasks } });
  });

  app.delete("/api/project-links/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await prisma.projectLink.findFirst({ where: { id, userId: request.userId }, select: { id: true, source: true, containerId: true, projectId: true } });
    if (!row) return reply.code(404).send({ error: "Link not found." });
    await prisma.projectLink.delete({ where: { id: row.id } });
    forgetLinkCache(request.userId);
    await appendLedger({ userId: request.userId, actor: "me", action: "project.unlink", payload: { projectId: row.projectId, source: row.source, containerId: row.containerId } });
    return reply.code(204).send();
  });

  app.get("/api/project-links/containers", async (request) => {
    const { source } = z.object({ source: Source.optional() }).parse(request.query);
    const userId = request.userId;
    const seen = await prisma.$queryRaw<Array<{ source: string; id: string; name: string | null; count: number; last: Date | null }>>`
      SELECT c->>'source' AS source, c->>'id' AS id, max(c->>'name') AS name, count(*)::int AS count, max(a."ts") AS last
      FROM "artifacts" a
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a."metadata"->'containers') = 'array' THEN a."metadata"->'containers' ELSE '[]'::jsonb END) c
      WHERE a."user_id" = ${userId} AND a."deleted_at" IS NULL AND c->>'id' IS NOT NULL
        ${source ? Prisma.sql`AND c->>'source' = ${source}` : Prisma.empty}
      GROUP BY 1, 2
      ORDER BY count(*) DESC
      LIMIT 300`;
    const [imported, links] = await Promise.all([
      prisma.project.findMany({
        where: { userId, deletedAt: null, externalSource: source ? source : { in: [...LINK_SOURCES] }, externalId: { not: null } },
        select: { id: true, name: true, externalSource: true, externalId: true },
        take: 300,
      }),
      prisma.projectLink.findMany({
        where: { userId, project: { deletedAt: null }, ...(source ? { source } : {}) },
        select: { source: true, containerId: true, containerName: true, projectId: true, project: { select: { name: true } } },
      }),
    ]);
    const out = new Map<string, { source: string; id: string; name: string; count: number; lastSeenAt: string | null; projectId: string | null; projectName: string | null }>();
    const put = (src: string, id: string, name: string | null, count = 0, last: Date | null = null) => {
      const key = `${src}\u0000${containerKey(src, id)}`;
      const row = out.get(key);
      if (row) {
        row.count += count;
        if (!row.name || row.name === row.id) row.name = name || row.name;
        if (last && (!row.lastSeenAt || last.toISOString() > row.lastSeenAt)) row.lastSeenAt = last.toISOString();
        return;
      }
      out.set(key, { source: src, id: containerKey(src, id), name: name || id, count, lastSeenAt: last?.toISOString() ?? null, projectId: null, projectName: null });
    };
    for (const row of seen) put(row.source, row.id, row.name, row.count, row.last ? new Date(row.last) : null);
    for (const project of imported) put(project.externalSource!, project.externalId!, project.name);
    for (const link of links) {
      put(link.source, link.containerId, link.containerName);
      const row = out.get(`${link.source}\u0000${link.containerId}`)!;
      row.projectId = link.projectId;
      row.projectName = link.project.name;
    }
    return { containers: [...out.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) };
  });
}
