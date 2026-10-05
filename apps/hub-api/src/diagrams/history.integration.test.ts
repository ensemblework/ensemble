/**
 * Version history, restore, duplicate, freshness, and an edit preview that
 * keeps a locked block's id.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { FULL_MODULE_SET } from "@ensemble/shared-types";
import { ZodError } from "zod";
import "../config.js";
import { diagramTools } from "../assistant/tools/diagrams.js";
import type { ToolContext } from "../assistant/types.js";
import { prisma } from "../lib/prisma.js";
import { diagramRoutes } from "../routes/diagrams.js";
import "../types.js";

const SOURCE = `title Flow
direction down

node a "Alpha" shape rectangle locked
node b "Beta" shape rectangle

edge a > b

layout
  a 10 20 120 48 locked
  b 10 100 120 48
`;

const NEXT = `title Flow
direction down

node a "Alpha" shape rectangle locked
node b "Beta two" shape rectangle

edge a > b

layout
  a 10 20 120 48 locked
  b 10 100 120 48
`;

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function user(label: string) {
  return prisma.user.create({
    data: { email: `diagram-hist-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@ensemble.test`, name: label },
  });
}

async function appFor(userId: string, modules: string = FULL_MODULE_SET) {
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.addHook("onRequest", async (request) => {
    request.userId = userId;
    // Real requests carry the account's modules. Diagrams sit in the code module.
    request.modules = modules;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: error.issues.map((issue) => issue.message).join("; ") });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(statusCode).send({ error: message });
  });
  await app.register(diagramRoutes);
  return app;
}

test("restore keeps the old source as a new version, and edits keep locks", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner");
  const app = await appFor(owner.id);
  const tool = diagramTools.find((item) => item.name === "hub_edit_diagram")!;
  const ctx = { prisma, userId: owner.id, actor: "agent" } as ToolContext;
  try {
    const created = await app.inject({ method: "POST", url: "/api/diagrams", payload: { source: SOURCE } });
    assert.equal(created.statusCode, 201);
    const diagram = created.json().diagram as { id: string; version: number; source: string };
    assert.equal(diagram.version, 1);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/diagrams/${diagram.id}`,
      payload: { version: 1, source: NEXT },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().diagram.version, 2);

    const history = await app.inject({ method: "GET", url: `/api/diagrams/${diagram.id}/revisions` });
    assert.equal(history.statusCode, 200);
    const versions = (history.json().revisions as Array<{ version: number }>).map((item) => item.version);
    assert.ok(versions.includes(1));

    const restored = await app.inject({
      method: "POST",
      url: `/api/diagrams/${diagram.id}/restore`,
      payload: { version: 1 },
    });
    assert.equal(restored.statusCode, 200);
    const back = restored.json().diagram as { version: number; source: string };
    assert.equal(back.version, 3);
    assert.match(back.source, /node b "Beta"/);
    assert.match(back.source, /node a "Alpha" shape rectangle locked/);
    assert.match(back.source, /a 10 20 120 48/);

    const preview = await tool.preview!(ctx, {
      diagramId: diagram.id,
      ops: [
        { op: "rename_node", id: "b", label: "Beta two" },
        { op: "add_node", id: "cache", label: "Redis", shape: "cylinder" },
        { op: "add_edge", from: "b", to: "cache", label: "uses" },
      ],
    });
    assert.match(preview, /Added/);
    assert.match(preview, /Changed/);
    const edited = await tool.run(ctx, {
      diagramId: diagram.id,
      ops: [
        { op: "rename_node", id: "b", label: "Beta two" },
        { op: "add_node", id: "cache", label: "Redis", shape: "cylinder" },
        { op: "add_edge", from: "b", to: "cache", label: "uses" },
      ],
    });
    assert.match(String((edited.data as { changes: string[] }).changes.join("\n")), /Added block/);
    const saved = await prisma.blockDiagram.findFirst({ where: { id: diagram.id } });
    assert.match(saved?.source ?? "", /node a "Alpha" shape rectangle locked/);
    assert.match(saved?.source ?? "", /node cache "Redis"/);
    assert.match(saved?.source ?? "", /a 10 20 120 48/);

    await prisma.diagramLink.create({ data: { userId: owner.id, diagramId: diagram.id, targetKind: "task", targetId: "00000000-0000-0000-0000-000000000001" } });
    const copy = await app.inject({ method: "POST", url: `/api/diagrams/${diagram.id}/duplicate` });
    assert.equal(copy.statusCode, 201);
    const copyId = copy.json().diagram.id as string;
    assert.match(copy.json().diagram.title as string, /^Copy of /);
    const links = await prisma.diagramLink.count({ where: { diagramId: copyId } });
    assert.equal(links, 0);

    const task = await prisma.task.create({
      data: { userId: owner.id, title: "Clinic page", status: "todo" },
    });
    await prisma.diagramLink.create({ data: { userId: owner.id, diagramId: diagram.id, targetKind: "task", targetId: task.id } });
    await prisma.$executeRaw`UPDATE block_diagrams SET updated_at = NOW() - interval '2 days' WHERE id = ${diagram.id}`;
    await prisma.task.update({ where: { id: task.id }, data: { title: "Clinic page revised" } });
    const fresh = await app.inject({ method: "GET", url: `/api/diagrams/${diagram.id}/freshness` });
    assert.equal(fresh.statusCode, 200);
    assert.equal(fresh.json().stale, true);
    assert.match((fresh.json().reasons as string[]).join(" "), /Clinic page revised/);
  } finally {
    await app.close();
    await prisma.diagramLink.deleteMany({ where: { userId: owner.id } });
    await prisma.blockDiagram.deleteMany({ where: { userId: owner.id } });
    await prisma.task.deleteMany({ where: { userId: owner.id } });
    await prisma.user.deleteMany({ where: { id: owner.id } });
  }
});
