/**
 * Layout routes and template seeding against Postgres. Skips when the database is down.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ZodError } from "zod";
import "../config.js";
import { prisma } from "../lib/prisma.js";
import { layoutsRoutes } from "../routes/layouts.js";
import { templateSourceRef } from "./apply.js";
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
    data: { email: `layout-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@ensemble.test`, name: label },
  });
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
    return reply.code(statusCode).send({ error: message });
  });
  await app.register(layoutsRoutes);
  return app;
}

async function cleanup(userId: string) {
  await prisma.taskPage.deleteMany({ where: { userId } });
  await prisma.meetingNote.deleteMany({ where: { userId } });
  await prisma.reminder.deleteMany({ where: { userId } });
  await prisma.deliverable.deleteMany({ where: { userId } });
  await prisma.task.deleteMany({ where: { userId } });
  await prisma.projectPerson.deleteMany({ where: { project: { userId } } });
  await prisma.person.deleteMany({ where: { userId } });
  await prisma.project.deleteMany({ where: { userId } });
  await prisma.widgetLayout.deleteMany({ where: { userId } });
  await prisma.undoEntry.deleteMany({ where: { userId } });
  await prisma.preference.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

test("onboarding seeds once per user and layouts stay off the undo stack", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner");
  const other = await user("other");
  const app = await appFor(owner.id);
  const theirs = await appFor(other.id);
  try {
    const cards = await app.inject({ method: "GET", url: "/api/onboarding/templates?role=student" });
    assert.equal(cards.statusCode, 200);
    assert.equal((cards.json() as { templates: unknown[] }).templates.length, 5);

    const applied = await app.inject({ method: "POST", url: "/api/onboarding", payload: { role: "student", templateId: "semester-desk" } });
    assert.equal(applied.statusCode, 200);
    const again = await app.inject({ method: "POST", url: "/api/onboarding", payload: { role: "student", templateId: "exam-week" } });
    assert.equal(again.statusCode, 409);

    const tasks = await prisma.task.count({ where: { userId: owner.id, sourceRef: { startsWith: "template:semester-desk:" } } });
    assert.equal(tasks, 3);
    const people = await prisma.person.findMany({ where: { userId: owner.id } });
    assert.equal(people.length, 1);
    assert.equal(people[0]?.email, null);
    assert.equal(people[0]?.upn, templateSourceRef("semester-desk", "instructor"));
    assert.equal(await prisma.task.count({ where: { userId: other.id } }), 0);

    const otherApply = await theirs.inject({
      method: "POST",
      url: "/api/onboarding",
      payload: { role: "student", templateId: "semester-desk" },
    });
    assert.equal(otherApply.statusCode, 200);
    assert.equal(await prisma.task.count({ where: { userId: other.id, sourceRef: templateSourceRef("semester-desk", "read-brief") } }), 1);
    assert.equal(await prisma.task.count({ where: { userId: owner.id, sourceRef: templateSourceRef("semester-desk", "read-brief") } }), 1);

    const before = await prisma.undoEntry.count({ where: { userId: owner.id } });
    const saved = await app.inject({
      method: "PUT",
      url: "/api/layouts/today",
      payload: { v: 1, placements: [{ type: "focus", size: "m" }] },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(await prisma.undoEntry.count({ where: { userId: owner.id } }), before);
    const mine = await app.inject({ method: "GET", url: "/api/layouts/today" });
    assert.equal((mine.json() as { document: { placements: Array<{ size: string }> } }).document.placements[0]?.size, "m");
    const stolen = await theirs.inject({ method: "GET", url: "/api/layouts/today" });
    const stolenSize = (stolen.json() as { document: { placements: Array<{ type: string; size: string }> } }).document.placements.find(
      (row) => row.type === "focus",
    )?.size;
    assert.equal(stolenSize, "l");

    const taskCount = await prisma.task.count({ where: { userId: owner.id } });
    const reset = await app.inject({ method: "POST", url: "/api/layouts/today/reset" });
    assert.equal(reset.statusCode, 200);
    assert.equal(await prisma.task.count({ where: { userId: owner.id } }), taskCount);
    const restored = await app.inject({ method: "GET", url: "/api/layouts/today" });
    assert.ok(
      (restored.json() as { document: { placements: Array<{ type: string; size: string }> } }).document.placements.some(
        (row) => row.type === "focus" && row.size === "l",
      ),
    );

    const bad = await app.inject({
      method: "PUT",
      url: "/api/layouts/today",
      payload: {
        v: 1,
        placements: [
          { type: "focus", size: "xl" },
          { type: "deliverables", size: "xl" },
        ],
      },
    });
    assert.equal(bad.statusCode, 400);
    const unknown = await app.inject({ method: "GET", url: "/api/layouts/nope" });
    assert.equal(unknown.statusCode, 400);
  } finally {
    await app.close();
    await theirs.close();
    await cleanup(owner.id);
    await cleanup(other.id);
  }
});

test("lawyer signup assigns Chambers and leaves finished accounts alone", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("lawyer");
  const prior = await user("prior");
  await prisma.user.update({
    where: { id: prior.id },
    data: { onboardingCompletedAt: new Date(), onboardingRole: "student", onboardingTemplateId: "semester-desk", activeTemplateId: null },
  });
  await prisma.session.create({
    data: { id: `sess-${owner.id}`, userId: owner.id, expiresAt: new Date(Date.now() + 86_400_000), modules: "code,diagrams,metrics,runs,skills,workspace" },
  });
  const app = await appFor(owner.id);
  const finished = await appFor(prior.id);
  try {
    const applied = await app.inject({ method: "POST", url: "/api/onboarding", payload: { role: "lawyer", templateId: "matter-desk" } });
    assert.equal(applied.statusCode, 200);
    const row = await prisma.user.findUnique({ where: { id: owner.id } });
    assert.equal(row?.activeTemplateId, "mkt.chambers");
    assert.equal(row?.moduleSet, "diagrams");
    assert.equal(row?.onboardingTemplateId, "matter-desk");
    assert.equal(await prisma.task.count({ where: { userId: owner.id, sourceRef: { startsWith: "template:matter-desk:" } } }), 3);
    const session = await prisma.session.findUnique({ where: { id: `sess-${owner.id}` } });
    assert.equal(session?.modules, "diagrams");

    const again = await finished.inject({ method: "POST", url: "/api/onboarding", payload: { role: "lawyer", templateId: "matter-desk" } });
    assert.equal(again.statusCode, 409);
    const kept = await prisma.user.findUnique({ where: { id: prior.id } });
    assert.equal(kept?.activeTemplateId, null);
    assert.equal(await prisma.task.count({ where: { userId: prior.id } }), 0);
  } finally {
    await app.close();
    await finished.close();
    await prisma.session.deleteMany({ where: { userId: owner.id } });
    await cleanup(owner.id);
    await cleanup(prior.id);
  }
});
