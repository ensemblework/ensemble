/**
 * Diagram routes against Postgres. Skips when the database is down.
 * A second user must not be able to read, change, or delete the first user's diagram.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { FULL_MODULE_SET } from "@ensemble/shared-types";
import { ZodError } from "zod";
import "../config.js";
import { prisma } from "../lib/prisma.js";
import { diagramRoutes } from "./diagrams.js";
import { diagramTools } from "../assistant/tools/diagrams.js";
import type { ToolContext } from "../assistant/types.js";
import { readItem } from "../bridge/service.js";
import "../types.js";

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
    data: { email: `diagram-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@ensemble.test`, name: label },
  });
}

async function appFor(userId: string, modules: string = FULL_MODULE_SET) {
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.addHook("onRequest", async (request) => {
    request.userId = userId;
    // Real requests carry the account's modules. Diagrams are their own module.
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

test("diagrams are private to the signed-in user", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner");
  const other = await user("other");
  const own = await appFor(owner.id);
  const theirs = await appFor(other.id);
  try {
    const created = await own.inject({
      method: "POST",
      url: "/api/diagrams",
      payload: {
        source: `title Secret flow\ndirection down\n\nnode start "Start" shape circle\nnode next "Next" shape rectangle\n\nedge start > next\n`,
      },
    });
    assert.equal(created.statusCode, 201);
    const diagram = created.json().diagram as { id: string; title: string; version: number; source: string };
    assert.equal(diagram.title, "Secret flow");
    assert.equal(diagram.version, 1);
    assert.match(diagram.source, /node start/);

    const list = await own.inject({ method: "GET", url: "/api/diagrams" });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().diagrams.some((row: { id: string }) => row.id === diagram.id), true);

    const hidden = await theirs.inject({ method: "GET", url: "/api/diagrams" });
    assert.equal(hidden.json().diagrams.some((row: { id: string }) => row.id === diagram.id), false);
    assert.equal((await theirs.inject({ method: "GET", url: `/api/diagrams/${diagram.id}` })).statusCode, 404);
    assert.equal(
      (await theirs.inject({ method: "PATCH", url: `/api/diagrams/${diagram.id}`, payload: { version: 1, title: "Stolen" } })).statusCode,
      404,
    );
    assert.equal((await theirs.inject({ method: "DELETE", url: `/api/diagrams/${diagram.id}` })).statusCode, 404);

    const stale = await own.inject({
      method: "PATCH",
      url: `/api/diagrams/${diagram.id}`,
      payload: { version: 9, source: `title Secret flow\ndirection down\n\nnode start "Start" shape circle\n` },
    });
    assert.equal(stale.statusCode, 409);

    const saved = await own.inject({
      method: "PATCH",
      url: `/api/diagrams/${diagram.id}`,
      payload: {
        version: 1,
        source: `title Secret flow\ndirection down\n\nnode start "Start" shape circle\nbad !!!\nnode next "Next" shape rectangle\n\nedge start > next\n`,
      },
    });
    assert.equal(saved.statusCode, 200);
    const body = saved.json().diagram as { version: number; model: { nodes: Record<string, { label: string }> } };
    assert.equal(body.version, 2);
    assert.equal(body.model.nodes.start?.label, "Start");
    assert.equal(body.model.nodes.next?.label, "Next");

    const removed = await own.inject({ method: "DELETE", url: `/api/diagrams/${diagram.id}` });
    assert.equal(removed.statusCode, 204);
    assert.equal((await own.inject({ method: "GET", url: `/api/diagrams/${diagram.id}` })).statusCode, 404);
    const trashed = await prisma.blockDiagram.findFirst({ where: { id: diagram.id } });
    assert.ok(trashed?.deletedAt, "delete moves the diagram to trash");
    const hiddenList = await own.inject({ method: "GET", url: "/api/diagrams" });
    assert.equal(hiddenList.json().diagrams.some((row: { id: string }) => row.id === diagram.id), false);
    await prisma.blockDiagram.update({ where: { id: diagram.id }, data: { deletedAt: null } });
    assert.equal((await own.inject({ method: "GET", url: `/api/diagrams/${diagram.id}` })).statusCode, 200);
  } finally {
    await own.close();
    await theirs.close();
    await prisma.blockDiagram.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
  }
});

test("agent diagram tools and links stay with the owner", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("tool-owner");
  const other = await user("tool-other");
  const own = await appFor(owner.id);
  const theirs = await appFor(other.id);
  const tool = (name: string) => diagramTools.find((item) => item.name === name)!;
  const ctx = (userId: string): ToolContext =>
    ({ prisma, userId, actor: "agent", app: own, settings: { assistant: { allowedWriteAreas: ["context"] } } }) as ToolContext;
  try {
    const validate = await tool("hub_validate_diagram").run(ctx(owner.id), {
      text: "edge only\nnode a \"A\" shape rectangle\nnode b \"B\" shape rectangle\nedge a > b\n",
    });
    const report = validate.data as { ok: boolean; errors: number };
    assert.equal(report.ok, false);
    assert.ok(report.errors > 0);
    const clean = `title Owned\ndirection down\n\nnode a "A" shape rectangle\nnode b "B" shape rectangle\n\nedge a > b\n`;
    const again = await tool("hub_validate_diagram").run(ctx(owner.id), { text: clean });
    assert.equal((again.data as { ok: boolean }).ok, true);

    const created = await tool("hub_create_diagram").run(ctx(owner.id), { title: "Owned", text: clean });
    const id = (created.data as { id: string }).id;
    await assert.rejects(() => tool("hub_get_diagram").run(ctx(other.id), { diagramId: id }));
    const patched = await tool("hub_update_diagram").run(ctx(owner.id), {
      diagramId: id,
      find: 'node a "A" shape rectangle',
      replace: 'node a "Alpha" shape rectangle',
    });
    assert.equal((patched.data as { id: string }).id, id);
    const read = await tool("hub_get_diagram").run(ctx(owner.id), { diagramId: id });
    assert.match((read.data as { source: string }).source, /Alpha/);

    const dangling = "44444444-4444-4444-8444-444444444444";
    const rejected = await own.inject({
      method: "PUT",
      url: "/api/diagrams/links",
      payload: { targetKind: "task", targetId: dangling, diagramIds: [id] },
    });
    assert.equal(rejected.statusCode, 404);
    const foreignTask = await prisma.task.create({ data: { userId: other.id, title: "Not yours", status: "todo" } });
    const foreign = await own.inject({
      method: "PUT",
      url: "/api/diagrams/links",
      payload: { targetKind: "task", targetId: foreignTask.id, diagramIds: [id] },
    });
    assert.equal(foreign.statusCode, 404);
    const task = await prisma.task.create({ data: { userId: owner.id, title: "Linked matter", status: "todo" } });
    const target = task.id;
    const linked = await own.inject({
      method: "PUT",
      url: "/api/diagrams/links",
      payload: { targetKind: "task", targetId: target, diagramIds: [id] },
    });
    assert.equal(linked.statusCode, 200);
    const listed = await own.inject({ method: "GET", url: `/api/diagrams/links?targetKind=task&targetId=${target}` });
    assert.equal(listed.json().links.some((row: { diagram: { id: string } }) => row.diagram.id === id), true);
    const hidden = await theirs.inject({ method: "GET", url: `/api/diagrams/links?targetKind=task&targetId=${target}` });
    assert.equal(hidden.json().links.some((row: { diagram: { id: string } }) => row.diagram.id === id), false);
    const stolen = await theirs.inject({
      method: "PUT",
      url: "/api/diagrams/links",
      payload: { targetKind: "task", targetId: target, diagramIds: [id] },
    });
    assert.equal(stolen.statusCode, 404);
  } finally {
    await own.close();
    await theirs.close();
    await prisma.diagramLink.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.task.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.blockDiagram.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
  }
});

test("diagrams off: routes, bridge reads, and agent tools refuse, and the diagram is kept", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("diagramsoff");
  const on = await appFor(owner.id);
  const offModules = "code,metrics,runs,skills,workspace";
  const off = await appFor(owner.id, offModules);
  try {
    const created = await on.inject({ method: "POST", url: "/api/diagrams", payload: { source: "title Kept\n\nnode a \"A\"\n" } });
    assert.equal(created.statusCode, 201);
    const id = created.json().diagram.id as string;
    for (const [method, url] of [
      ["GET", "/api/diagrams"],
      ["POST", "/api/diagrams"],
      ["GET", `/api/diagrams/${id}`],
      ["GET", "/api/diagrams/links"],
      ["DELETE", `/api/diagrams/${id}`],
    ] as const) {
      const response = await off.inject({ method, url, ...(method === "POST" ? { payload: { source: "title X\n" } } : {}) });
      assert.equal(response.statusCode, 404, `${method} ${url}`);
      assert.equal(response.json().error, "Not part of this template.");
    }
    assert.deepEqual(await readItem(prisma, owner.id, "diagram", id, 0, 8000, offModules), { found: false });
    const still = await on.inject({ method: "GET", url: `/api/diagrams/${id}` });
    assert.equal(still.statusCode, 200);
  } finally {
    await on.close();
    await off.close();
    await prisma.user.delete({ where: { id: owner.id } }).catch(() => undefined);
  }
});

test("code off with diagrams on: diagram routes and bridge reads work", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("codeoff");
  const modules = "diagrams,metrics,runs,skills,workspace";
  const app = await appFor(owner.id, modules);
  try {
    const created = await app.inject({ method: "POST", url: "/api/diagrams", payload: { source: "title Journey\n\nnode a \"Intake\"\nnode b \"Hearing\"\n\nedge a > b\n" } });
    assert.equal(created.statusCode, 201);
    const id = created.json().diagram.id as string;
    assert.equal((await app.inject({ method: "GET", url: "/api/diagrams" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/api/diagrams/${id}` })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/diagrams/links" })).statusCode, 200);
    const read = await readItem(prisma, owner.id, "diagram", id, 0, 8000, modules);
    assert.equal(read.found, true);
    const tool = diagramTools.find((entry) => entry.name === "hub_list_diagrams")!;
    const ctx = { app, prisma, userId: owner.id, actor: "agent", settings: {}, modules } as unknown as ToolContext;
    const listed = await tool.run(ctx, {});
    assert.equal(listed.summary, "1 diagram.");
  } finally {
    await app.close();
    await prisma.user.delete({ where: { id: owner.id } }).catch(() => undefined);
  }
});
