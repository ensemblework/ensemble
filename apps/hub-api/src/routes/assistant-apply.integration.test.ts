/**
 * Apply rewrites the saved assistant sentence, not only the tool rows.
 * Skips when Postgres is not reachable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import "../config.js";
import { assistantRoutes } from "./assistant.js";
import { prisma } from "../lib/prisma.js";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

test("Apply replaces the stale prompt on a full and a partial batch", async (t) => {
  if (!(await databaseReady())) {
    t.skip("Postgres is not reachable");
    return;
  }
  const stamp = Date.now().toString(36);
  const owner = await prisma.user.create({ data: { email: `apply-${stamp}@ensemble.test`, name: "Apply" } });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { set: async () => "OK" } as never);
  app.addHook("onRequest", async (request) => {
    request.userId = owner.id;
    request.modules = null;
  });
  await app.register(assistantRoutes);
  const conversation = await prisma.assistantConversation.create({
    data: { userId: owner.id, title: "Launch" },
  });
  try {
    const full = await prisma.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        userId: owner.id,
        role: "assistant",
        content: `Create project “Launch ${stamp}”.\n\nNothing has changed yet — press Apply.`,
        toolCalls: [
          {
            id: "call-project",
            name: "hub_create_project",
            state: "awaiting_approval",
            isWrite: true,
            summary: `Create project “Launch ${stamp}”`,
            input: { name: `Launch ${stamp}` },
          },
        ],
      },
    });
    const applied = await app.inject({
      method: "POST",
      url: "/api/assistant/apply",
      payload: {
        conversationId: conversation.id,
        calls: [{ name: "hub_create_project", input: { name: `Launch ${stamp}` }, callId: "call-project" }],
      },
    });
    assert.equal(applied.statusCode, 200, applied.body);
    const body = applied.json() as { replies: Array<{ id: string; content: string; toolCalls: Array<{ state: string }> }> };
    assert.equal(body.replies[0]?.id, full.id);
    assert.equal(body.replies[0]?.content.includes("Nothing has changed yet"), false);
    assert.match(body.replies[0]?.content ?? "", /Applied\./);
    assert.equal(body.replies[0]?.toolCalls[0]?.state, "ok");
    const stored = await prisma.assistantMessage.findUnique({ where: { id: full.id } });
    assert.equal(stored?.content.includes("Nothing has changed yet"), false);
    assert.match(stored?.content ?? "", /Applied\./);

    const partial = await prisma.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        userId: owner.id,
        role: "assistant",
        content: "Two changes.\n\nNothing has changed yet — press Apply.",
        toolCalls: [
          {
            id: "call-project-2",
            name: "hub_create_project",
            state: "awaiting_approval",
            isWrite: true,
            summary: `Create project “Second ${stamp}”`,
            input: { name: `Second ${stamp}` },
          },
          {
            id: "call-task",
            name: "hub_create_tasks",
            state: "awaiting_approval",
            isWrite: true,
            summary: "Add 1 task(s)",
            input: { tasks: [{ title: `Brief ${stamp}`, projectName: `Second ${stamp}` }] },
          },
        ],
      },
    });
    const half = await app.inject({
      method: "POST",
      url: "/api/assistant/apply",
      payload: {
        conversationId: conversation.id,
        name: "hub_create_project",
        callId: "call-project-2",
        input: { name: `Second ${stamp}` },
      },
    });
    assert.equal(half.statusCode, 200, half.body);
    const reloaded = await prisma.assistantMessage.findUnique({ where: { id: partial.id } });
    assert.equal(reloaded?.content.includes("Nothing has changed yet"), false);
    assert.match(reloaded?.content ?? "", /Applied:/);
    assert.match(reloaded?.content ?? "", /Still waiting — press Apply/);
    const calls = reloaded?.toolCalls as Array<{ id: string; state: string }>;
    assert.equal(calls.find((call) => call.id === "call-project-2")?.state, "ok");
    assert.equal(calls.find((call) => call.id === "call-task")?.state, "awaiting_approval");

    const again = await app.inject({ method: "GET", url: `/api/assistant/conversations/${conversation.id}/messages` });
    const messages = (again.json() as { messages: Array<{ id: string; content: string }> }).messages;
    const shown = messages.find((row) => row.id === partial.id);
    assert.equal(shown?.content.includes("Nothing has changed yet"), false);
  } finally {
    await app.close();
    await prisma.task.deleteMany({ where: { userId: owner.id } });
    await prisma.undoEntry.deleteMany({ where: { userId: owner.id } });
    await prisma.project.deleteMany({ where: { userId: owner.id } });
    await prisma.auditLedger.deleteMany({ where: { userId: owner.id } });
    await prisma.assistantConversation.delete({ where: { id: conversation.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  }
});
