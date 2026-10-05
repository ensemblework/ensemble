/**
 * Context board order against Postgres. Skips when the database is down.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ZodError } from "zod";
import "../config.js";
import { prisma } from "../lib/prisma.js";
import { contextRoutes } from "../routes/context.js";
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
    data: { email: `board-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@ensemble.test`, name: label },
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
  await app.register(contextRoutes);
  return app;
}

async function cleanup(userId: string) {
  await prisma.meetingNote.deleteMany({ where: { userId } });
  await prisma.projectPerson.deleteMany({ where: { project: { userId } } });
  await prisma.person.deleteMany({ where: { userId } });
  await prisma.project.deleteMany({ where: { userId } });
  await prisma.undoEntry.deleteMany({ where: { userId } });
  await prisma.preference.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

test("board order is owned, bounded, and stays off the undo stack", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner");
  const other = await user("other");
  const app = await appFor(owner.id);
  try {
    const mine = await prisma.person.create({ data: { userId: owner.id, name: "Ada Lovelace" } });
    const theirs = await prisma.person.create({ data: { userId: other.id, name: "Not yours" } });
    const project = await prisma.project.create({ data: { userId: owner.id, name: "Essay", summary: "A draft", createdBy: "me" } });
    const before = await prisma.undoEntry.count({ where: { userId: owner.id } });
    const saved = await app.inject({
      method: "PUT",
      url: "/api/context/order",
      payload: {
        view: "list",
        group: "kind",
        lanes: { people: [theirs.id, mine.id], projects: [project.id] },
      },
    });
    assert.equal(saved.statusCode, 200);
    const body = saved.json() as { order: { lanes: { people: string[]; projects: string[] }; view: string } };
    assert.deepEqual(body.order.lanes.people, [mine.id]);
    assert.deepEqual(body.order.lanes.projects, [project.id]);
    assert.equal(body.order.view, "list");
    assert.equal(await prisma.undoEntry.count({ where: { userId: owner.id } }), before);

    const board = await app.inject({ method: "GET", url: "/api/context/board" });
    assert.equal(board.statusCode, 200);
    const lanes = board.json() as { view: string; lanes: Array<{ id: string; cards: Array<{ id: string; title: string }> }> };
    assert.equal(lanes.view, "list");
    const people = lanes.lanes.find((lane) => lane.id === "people");
    assert.deepEqual(people?.cards.map((card) => card.id), [mine.id]);
    assert.equal(JSON.stringify(board.json()).includes(theirs.id), false);

    const huge = await app.inject({
      method: "PUT",
      url: "/api/context/order",
      payload: { lanes: { people: "x".repeat(9_000) } },
    });
    assert.equal(huge.statusCode, 400);
  } finally {
    await app.close();
    await cleanup(owner.id);
    await cleanup(other.id);
  }
});
