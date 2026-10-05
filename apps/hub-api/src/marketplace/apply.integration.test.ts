/**
 * Apply, revert, and history against Postgres. Skips when the database is down.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ZodError } from "zod";
import "../config.js";
import { prisma } from "../lib/prisma.js";
import { marketplaceRoutes } from "../routes/marketplace.js";
import { marketSourceRef } from "./seed.js";
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
    data: { email: `mkt-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@ensemble.test`, name: label },
  });
}

async function appFor(userId: string) {
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.addHook("onRequest", async (request) => {
    request.userId = userId;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map((issue) => issue.message).join("; ") });
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(statusCode).send({ error: message });
  });
  await app.register(marketplaceRoutes);
  return app;
}

async function cleanup(userId: string) {
  await prisma.taskPage.deleteMany({ where: { userId } });
  await prisma.artifact.deleteMany({ where: { userId } });
  await prisma.reminder.deleteMany({ where: { userId } });
  await prisma.deliverable.deleteMany({ where: { userId } });
  await prisma.task.deleteMany({ where: { userId } });
  await prisma.projectPerson.deleteMany({ where: { project: { userId } } });
  await prisma.person.deleteMany({ where: { userId } });
  await prisma.project.deleteMany({ where: { userId } });
  await prisma.widgetLayout.deleteMany({ where: { userId } });
  await prisma.templateApplication.deleteMany({ where: { userId } });
  await prisma.undoEntry.deleteMany({ where: { userId } });
  await prisma.preference.deleteMany({ where: { userId } });
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

test("apply is idempotent, revert keeps starters, and history stays capped", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const previous = process.env.ENSEMBLE_DEV_TOOLS;
  process.env.ENSEMBLE_DEV_TOOLS = "1";
  const owner = await user("owner");
  const other = await user("other");
  const app = await appFor(owner.id);
  const theirs = await appFor(other.id);
  try {
    const listed = await app.inject({ method: "GET", url: "/api/marketplace/templates" });
    assert.equal(listed.statusCode, 200);
    assert.equal((listed.json() as { templates: unknown[] }).templates.length, 8);

    const extra = await app.inject({
      method: "POST",
      url: "/api/marketplace/apply",
      payload: { id: "mkt.chambers", layouts: { today: { v: 1, placements: [] } } },
    });
    assert.equal(extra.statusCode, 400);

    const applied = await app.inject({ method: "POST", url: "/api/marketplace/apply", payload: { id: "mkt.chambers" } });
    assert.equal(applied.statusCode, 200);
    assert.equal((applied.json() as { modules: string }).modules, "diagrams");
    const ref = marketSourceRef("mkt.chambers", "limitation");
    assert.equal(await prisma.task.count({ where: { userId: owner.id, sourceRef: ref } }), 1);
    assert.equal(await prisma.person.count({ where: { userId: owner.id, email: { not: null } } }), 0);
    assert.equal(await prisma.undoEntry.count({ where: { userId: owner.id } }), 0);

    await prisma.task.updateMany({ where: { userId: owner.id, sourceRef: ref }, data: { deletedAt: new Date() } });
    const away = await app.inject({ method: "POST", url: "/api/marketplace/apply", payload: { id: "mkt.semester-desk" } });
    assert.equal(away.statusCode, 200);
    const back = await app.inject({ method: "POST", url: "/api/marketplace/apply", payload: { id: "mkt.chambers" } });
    assert.equal(back.statusCode, 200);
    assert.equal(await prisma.task.count({ where: { userId: owner.id, sourceRef: ref } }), 1);

    const reverted = await app.inject({ method: "POST", url: "/api/marketplace/revert", payload: {} });
    assert.equal(reverted.statusCode, 200);
    assert.equal(await prisma.task.count({ where: { userId: owner.id, sourceRef: ref } }), 1);

    const restored = await app.inject({ method: "POST", url: "/api/marketplace/apply", payload: { id: "default" } });
    assert.equal(restored.statusCode, 200);
    assert.match((restored.json() as { modules: string }).modules, /code/);
    assert.match((restored.json() as { modules: string }).modules, /diagrams/);
    assert.equal(await prisma.task.count({ where: { userId: owner.id, sourceRef: ref } }), 1);

    for (let i = 0; i < 22; i += 1) {
      const id = i % 2 === 0 ? "mkt.exam-season" : "mkt.literature-desk";
      const step = await app.inject({ method: "POST", url: "/api/marketplace/apply", payload: { id } });
      assert.equal(step.statusCode, 200, id);
    }
    assert.ok((await prisma.templateApplication.count({ where: { userId: owner.id } })) <= 20);

    const untouched = await prisma.user.findUnique({ where: { id: other.id } });
    assert.equal(untouched?.moduleSet.includes("code"), true);
    const foreign = await theirs.inject({ method: "GET", url: "/api/marketplace/templates/mkt.chambers" });
    assert.equal(foreign.statusCode, 200);
    assert.equal((foreign.json() as { applied: boolean }).applied, false);
  } finally {
    if (previous === undefined) delete process.env.ENSEMBLE_DEV_TOOLS;
    else process.env.ENSEMBLE_DEV_TOOLS = previous;
    await app.close();
    await theirs.close();
    await cleanup(owner.id);
    await cleanup(other.id);
  }
});

test("a regular account cannot switch desks", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const previous = process.env.ENSEMBLE_DEV_TOOLS;
  delete process.env.ENSEMBLE_DEV_TOOLS;
  const owner = await user("closed");
  const app = await appFor(owner.id);
  try {
    const listed = await app.inject({ method: "GET", url: "/api/marketplace/templates" });
    assert.equal(listed.statusCode, 403);
    const applied = await app.inject({ method: "POST", url: "/api/marketplace/apply", payload: { id: "mkt.chambers" } });
    assert.equal(applied.statusCode, 403);
    await prisma.user.update({ where: { id: owner.id }, data: { tester: true } });
    const allowed = await app.inject({ method: "POST", url: "/api/marketplace/apply", payload: { id: "mkt.chambers" } });
    assert.equal(allowed.statusCode, 200);
  } finally {
    if (previous === undefined) delete process.env.ENSEMBLE_DEV_TOOLS;
    else process.env.ENSEMBLE_DEV_TOOLS = previous;
    await app.close();
    await cleanup(owner.id);
  }
});
