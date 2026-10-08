import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { STARTER_SOURCE, explainDiagram, looksLikeMermaid, parseDiagram, printDiagram, renderDiagramSvg, toMermaid, type DiagramModel } from "@ensemble/block-diagrams";
import { rememberRevision } from "../diagrams/history.js";
import { declareModule } from "../lib/module-gate.js";
import { sseHub } from "../lib/sse.js";

const writeBody = z.object({
  title: z.string().trim().max(200).optional(),
  source: z.string().max(200_000).optional(),
});

const linkKinds = z.enum(["page", "task", "deliverable", "project", "repo"]);

const linkWrite = z.object({
  targetKind: linkKinds,
  targetId: z.string().min(1).max(80),
  diagramIds: z.array(z.string().uuid()).max(40),
});

function notFound(reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  return reply.code(404).send({ error: "That diagram is not on your account." });
}

function normalize(source: string): { source: string; model: DiagramModel } {
  const parsed = parseDiagram(source);
  if (!looksLikeMermaid(source)) return { source, model: parsed.model };
  const text = printDiagram(parsed.model);
  return { source: text, model: parseDiagram(text).model };
}

function targetMissing(kind: z.infer<typeof linkKinds>): string {
  if (kind === "project") return "That project is not on your account.";
  if (kind === "repo") return "That repo is not on your account.";
  if (kind === "deliverable") return "That deliverable is not on your account.";
  return "That task is not on your account.";
}

function titleFor(requested: string | undefined, model: DiagramModel, fallback: string): string {
  const fromRequest = requested?.trim();
  if (fromRequest) return fromRequest.slice(0, 200);
  const fromModel = model.meta.title.trim();
  if (fromModel) return fromModel.slice(0, 200);
  return fallback;
}

function present(row: {
  id: string;
  title: string;
  source: string;
  document: Prisma.JsonValue;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    model: row.document,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function diagramRoutes(app: FastifyInstance): Promise<void> {
  declareModule(app, "diagrams");
  const db = app.prisma;

  app.get("/api/diagrams/links", async (request) => {
    const query = z
      .object({
        targetKind: linkKinds.optional(),
        targetId: z.string().min(1).max(80).optional(),
      })
      .parse(request.query);
    const rows = await db.diagramLink.findMany({
      where: {
        userId: request.userId,
        diagram: { deletedAt: null },
        ...(query.targetKind ? { targetKind: query.targetKind } : {}),
        ...(query.targetId ? { targetId: query.targetId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { diagram: { select: { id: true, title: true, updatedAt: true, source: true, document: true } } },
    });
    return {
      links: rows.map((row) => ({
        id: row.id,
        targetKind: row.targetKind,
        targetId: row.targetId,
        diagram: {
          id: row.diagram.id,
          title: row.diagram.title,
          updatedAt: row.diagram.updatedAt.toISOString(),
          source: row.diagram.source,
          model: row.diagram.document,
        },
      })),
    };
  });

  app.put("/api/diagrams/links", async (request, reply) => {
    const body = linkWrite.parse(request.body ?? {});
    const owned = await db.blockDiagram.findMany({
      where: { userId: request.userId, deletedAt: null, id: { in: body.diagramIds } },
      select: { id: true },
    });
    if (owned.length !== new Set(body.diagramIds).size) {
      return reply.code(404).send({ error: "One of those diagrams is not on your account." });
    }
    const standalone = body.targetKind === "page"
      ? await db.taskPage.findFirst({ where: { id: body.targetId, userId: request.userId, taskId: null }, select: { id: true } })
      : null;
    const target = standalone ?? (
      body.targetKind === "project"
        ? await db.project.findFirst({ where: { id: body.targetId, userId: request.userId, deletedAt: null }, select: { id: true } })
        : body.targetKind === "repo"
          ? await db.repo.findFirst({ where: { id: body.targetId, userId: request.userId, deletedAt: null }, select: { id: true } })
          : body.targetKind === "deliverable"
            ? await db.deliverable.findFirst({ where: { id: body.targetId, userId: request.userId, deletedAt: null }, select: { id: true } })
            : await db.task.findFirst({ where: { id: body.targetId, userId: request.userId, deletedAt: null }, select: { id: true } }));
    if (!target) return reply.code(404).send({ error: targetMissing(body.targetKind) });
    await db.$transaction(async (tx) => {
      await tx.diagramLink.deleteMany({
        where: {
          userId: request.userId,
          targetKind: body.targetKind,
          targetId: body.targetId,
          ...(body.diagramIds.length ? { diagramId: { notIn: body.diagramIds } } : {}),
        },
      });
      for (const diagramId of body.diagramIds) {
        await tx.diagramLink.upsert({
          where: { diagramId_targetKind_targetId: { diagramId, targetKind: body.targetKind, targetId: body.targetId } },
          create: { userId: request.userId, diagramId, targetKind: body.targetKind, targetId: body.targetId },
          update: {},
        });
      }
    });
    return { ok: true };
  });

  app.get("/api/diagrams", async (request) => {
    const rows = await db.blockDiagram.findMany({
      where: { userId: request.userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, version: true, createdAt: true, updatedAt: true },
    });
    return {
      diagrams: rows.map((row) => ({
        id: row.id,
        title: row.title,
        version: row.version,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  });

  app.post("/api/diagrams", async (request, reply) => {
    const body = writeBody.parse(request.body ?? {});
    const normalized = normalize(body.source && body.source.trim() ? body.source : STARTER_SOURCE);
    const created = await db.blockDiagram.create({
      data: {
        userId: request.userId,
        title: titleFor(body.title, normalized.model, "Untitled diagram"),
        source: normalized.source,
        document: normalized.model as unknown as Prisma.InputJsonValue,
      },
    });
    return reply.code(201).send({ diagram: present(created) });
  });

  app.get("/api/diagrams/:id/svg", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await db.blockDiagram.findFirst({ where: { id, userId: request.userId, deletedAt: null }, select: { document: true } });
    if (!row) return notFound(reply);
    const svg = renderDiagramSvg(row.document as unknown as DiagramModel, { theme: "dark" });
    return reply.type("image/svg+xml; charset=utf-8").send(svg);
  });

  app.get("/api/diagrams/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await db.blockDiagram.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!row) return notFound(reply);
    return { diagram: present(row) };
  });

  app.patch("/api/diagrams/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = writeBody
      .extend({ version: z.number().int().positive() })
      .parse(request.body);
    const current = await db.blockDiagram.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!current) return notFound(reply);
    if (current.version !== body.version) {
      return reply.code(409).send({ error: "This diagram was updated somewhere else. Reload it and try again." });
    }
    if (body.source !== undefined) {
      await rememberRevision(db, {
        id: current.id,
        userId: current.userId,
        version: current.version,
        title: current.title,
        source: current.source,
        document: current.document as object,
      });
    }
    const normalized = body.source === undefined ? null : normalize(body.source);
    const title = body.title?.trim()
      ? body.title.trim().slice(0, 200)
      : normalized
        ? titleFor(undefined, normalized.model, current.title)
        : current.title;
    const updated = await db.blockDiagram.updateMany({
      where: { id, userId: request.userId, deletedAt: null, version: body.version },
      data: {
        title,
        ...(normalized
          ? { source: normalized.source, document: normalized.model as unknown as Prisma.InputJsonValue }
          : {}),
        version: { increment: 1 },
      },
    });
    if (!updated.count) {
      return reply.code(409).send({ error: "This diagram was updated somewhere else. Reload it and try again." });
    }
    const row = await db.blockDiagram.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!row) return notFound(reply);
    // Anyone else with it open (another tab, or someone it is shared with) picks up the change.
    sseHub.publish(request.userId, { event: "diagram", data: { id, version: row.version }, about: { kind: "diagram", id } });
    return { diagram: present(row) };
  });

  app.get("/api/diagrams/:id/revisions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await db.blockDiagram.findFirst({ where: { id, userId: request.userId, deletedAt: null }, select: { id: true, version: true, title: true, updatedAt: true } });
    if (!row) return notFound(reply);
    const revisions = await db.blockDiagramRevision.findMany({
      where: { diagramId: id, userId: request.userId },
      orderBy: { version: "desc" },
      take: 30,
      select: { version: true, title: true, createdAt: true },
    });
    return {
      current: { version: row.version, title: row.title, updatedAt: row.updatedAt.toISOString() },
      revisions: revisions.map((item) => ({ version: item.version, title: item.title, createdAt: item.createdAt.toISOString() })),
    };
  });

  app.post("/api/diagrams/:id/restore", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ version: z.number().int().positive() }).parse(request.body ?? {});
    const current = await db.blockDiagram.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!current) return notFound(reply);
    const revision = await db.blockDiagramRevision.findFirst({ where: { diagramId: id, userId: request.userId, version: body.version } });
    if (!revision) return reply.code(404).send({ error: "That version is not in the history." });
    await rememberRevision(db, {
      id: current.id,
      userId: current.userId,
      version: current.version,
      title: current.title,
      source: current.source,
      document: current.document as object,
    });
    const updated = await db.blockDiagram.update({
      where: { id },
      data: {
        title: revision.title,
        source: revision.source,
        document: revision.document as object,
        version: { increment: 1 },
      },
    });
    sseHub.publish(request.userId, { event: "diagram", data: { id, version: updated.version }, about: { kind: "diagram", id } });
    return { diagram: present(updated) };
  });

  app.post("/api/diagrams/:id/duplicate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const current = await db.blockDiagram.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!current) return notFound(reply);
    const created = await db.blockDiagram.create({
      data: {
        userId: request.userId,
        title: `Copy of ${current.title}`.slice(0, 200),
        source: current.source,
        document: current.document as object,
      },
    });
    return reply.code(201).send({ diagram: present(created) });
  });

  app.get("/api/diagrams/:id/freshness", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await db.blockDiagram.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!row) return notFound(reply);
    const links = await db.diagramLink.findMany({ where: { diagramId: id, userId: request.userId } });
    const reasons: string[] = [];
    for (const link of links) {
      if (link.targetKind === "task" || link.targetKind === "page") {
        if (link.targetKind === "page") {
          const page = await db.taskPage.findFirst({ where: { id: link.targetId, userId: request.userId, taskId: null }, select: { title: true, updatedAt: true } });
          if (page) {
            if (page.updatedAt > row.updatedAt) reasons.push(`Page “${page.title}” changed`);
            continue;
          }
        }
        const task = await db.task.findFirst({ where: { id: link.targetId, userId: request.userId, deletedAt: null }, select: { title: true, updatedAt: true } });
        if (task && task.updatedAt > row.updatedAt) reasons.push(`Task “${task.title}” changed`);
      } else if (link.targetKind === "project") {
        const project = await db.project.findFirst({ where: { id: link.targetId, userId: request.userId, deletedAt: null }, select: { name: true, updatedAt: true } });
        if (project && project.updatedAt > row.updatedAt) reasons.push(`Project “${project.name}” changed`);
      } else if (link.targetKind === "deliverable") {
        const deliverable = await db.deliverable.findFirst({ where: { id: link.targetId, userId: request.userId, deletedAt: null }, select: { title: true, updatedAt: true } });
        if (deliverable && deliverable.updatedAt > row.updatedAt) reasons.push(`Deliverable “${deliverable.title}” changed`);
      } else if (link.targetKind === "repo") {
        const repo = await db.repo.findFirst({ where: { id: link.targetId, userId: request.userId, deletedAt: null }, select: { fullName: true, updatedAt: true } });
        if (repo && repo.updatedAt > row.updatedAt) reasons.push(`Repo ${repo.fullName} changed`);
      }
    }
    return { stale: reasons.length > 0, reasons };
  });

  app.get("/api/diagrams/:id/explain", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await db.blockDiagram.findFirst({ where: { id, userId: request.userId, deletedAt: null } });
    if (!row) return notFound(reply);
    const parsed = parseDiagram(row.source);
    return { explanation: explainDiagram(parsed.model), mermaid: toMermaid(parsed.model) };
  });

  app.delete("/api/diagrams/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await db.blockDiagram.updateMany({
      where: { id, userId: request.userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (!deleted.count) return notFound(reply);
    return reply.code(204).send();
  });
}
