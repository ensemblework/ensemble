/**
 * A person can turn their own modules on and off. That does not delete data,
 * does not touch another account, and does not open the tester marketplace.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { ZodError } from "zod";
import "../config.js";
import { prisma } from "../lib/prisma.js";
import { sha256 } from "../lib/auth.js";
import { marketplaceRoutes } from "../routes/marketplace.js";
import { settingsRoutes } from "../routes/settings.js";
import "../types.js";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function account(label: string, moduleSet: string, tester = false) {
  const owner = await prisma.user.create({
    data: {
      email: `feat-${label}-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`,
      name: label,
      moduleSet,
      tester,
    },
  });
  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: { id: sha256(token), userId: owner.id, expiresAt: new Date(Date.now() + 60_000), modules: moduleSet },
  });
  return owner;
}

async function appFor(userId: string) {
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.addHook("onRequest", async (request) => {
    request.userId = userId;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: error.issues.map((issue) => issue.message).join("; ") });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(statusCode).send({ error: statusCode >= 500 ? "Something went wrong on the Hub." : message });
  });
  await app.register(settingsRoutes);
  await app.register(marketplaceRoutes);
  return app;
}

async function cleanup(ids: string[]) {
  await prisma.blockDiagram.deleteMany({ where: { userId: { in: ids } } });
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

test("own module switches stay on the account, keep data, and leave the marketplace closed", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await account("owner", "diagrams");
  const other = await account("other", "skills");
  const tester = await account("tester", "diagrams", true);
  const diagram = await prisma.blockDiagram.create({
    data: { userId: owner.id, title: "Keep me", source: "", document: {} },
  });
  await prisma.blockDiagram.create({ data: { userId: other.id, title: "Theirs", source: "", document: {} } });
  const app = await appFor(owner.id);
  const testerApp = await appFor(tester.id);
  const previousDev = process.env.ENSEMBLE_DEV_TOOLS;
  delete process.env.ENSEMBLE_DEV_TOOLS;
  try {
    const missing = await app.inject({ method: "PUT", url: "/api/settings/modules", payload: { id: "code" } });
    assert.equal(missing.statusCode, 400);

    const unknown = await app.inject({ method: "PUT", url: "/api/settings/modules", payload: { id: "marketplace", on: true } });
    assert.equal(unknown.statusCode, 400);

    const enabled = await app.inject({ method: "PUT", url: "/api/settings/modules", payload: { id: "code", on: true } });
    assert.equal(enabled.statusCode, 200);
    assert.equal((enabled.json() as { modules: string }).modules, "code,diagrams");

    const ownerRow = await prisma.user.findUnique({ where: { id: owner.id }, select: { moduleSet: true } });
    const ownerSession = await prisma.session.findFirst({ where: { userId: owner.id }, select: { modules: true } });
    assert.equal(ownerRow?.moduleSet, "code,diagrams");
    assert.equal(ownerSession?.modules, "code,diagrams");

    const otherRow = await prisma.user.findUnique({ where: { id: other.id }, select: { moduleSet: true } });
    const otherSession = await prisma.session.findFirst({ where: { userId: other.id }, select: { modules: true } });
    assert.equal(otherRow?.moduleSet, "skills");
    assert.equal(otherSession?.modules, "skills");

    const off = await app.inject({ method: "PUT", url: "/api/settings/modules", payload: { id: "diagrams", on: false } });
    assert.equal(off.statusCode, 200);
    assert.equal((off.json() as { modules: string }).modules, "code");
    const kept = await prisma.blockDiagram.findFirst({ where: { id: diagram.id, userId: owner.id } });
    assert.equal(kept?.title, "Keep me");
    assert.equal(await prisma.blockDiagram.count({ where: { userId: other.id } }), 1);

    const again = await app.inject({ method: "PUT", url: "/api/settings/modules", payload: { id: "diagrams", on: true } });
    assert.equal((again.json() as { modules: string }).modules, "code,diagrams");
    assert.equal(await prisma.blockDiagram.count({ where: { userId: owner.id, title: "Keep me" } }), 1);

    const market = await app.inject({ method: "POST", url: "/api/marketplace/apply", payload: { id: "mkt.exam-season" } });
    assert.equal(market.statusCode, 403);
    assert.match((market.json() as { error: string }).error, /testers/);
    const list = await app.inject({ method: "GET", url: "/api/marketplace/templates" });
    assert.equal(list.statusCode, 403);

    const allowed = await testerApp.inject({ method: "GET", url: "/api/marketplace/templates" });
    assert.equal(allowed.statusCode, 200);
    assert.equal(ownerRow && (await prisma.user.findUnique({ where: { id: owner.id }, select: { moduleSet: true } }))?.moduleSet, "code,diagrams");
  } finally {
    if (previousDev === undefined) delete process.env.ENSEMBLE_DEV_TOOLS;
    else process.env.ENSEMBLE_DEV_TOOLS = previousDev;
    await app.close();
    await testerApp.close();
    await cleanup([owner.id, other.id, tester.id]);
  }
});
