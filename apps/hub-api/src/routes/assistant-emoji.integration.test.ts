/**
 * Conversation titles and saved replies survive an emoji on the length boundary.
 * Skips when Postgres is not reachable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import "../config.js";
import { assistantRoutes } from "./assistant.js";
import { hasLoneSurrogate, truncateText } from "../lib/text.js";
import { prisma } from "../lib/prisma.js";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

test("an emoji on the title boundary is stored whole or dropped, never split", async (t) => {
  if (!(await databaseReady())) {
    t.skip("Postgres is not reachable");
    return;
  }
  const stamp = Date.now().toString(36);
  const owner = await prisma.user.create({ data: { email: `emoji-${stamp}@ensemble.test`, name: "Emoji" } });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.addHook("onRequest", async (request) => {
    request.userId = owner.id;
  });
  await app.register(assistantRoutes);
  const ids: string[] = [];
  try {
    const overflowing = `${"a".repeat(79)}😀`;
    const created = await app.inject({ method: "POST", url: "/api/assistant/conversations", payload: { title: overflowing } });
    assert.equal(created.statusCode, 201);
    const title = (created.json() as { conversation: { id: string; title: string } }).conversation;
    ids.push(title.id);
    assert.equal(title.title, "a".repeat(79));
    assert.equal(hasLoneSurrogate(title.title), false);

    const fitting = `${"a".repeat(78)}😀`;
    const kept = await app.inject({ method: "POST", url: "/api/assistant/conversations", payload: { title: fitting } });
    assert.equal(kept.statusCode, 201);
    const second = (kept.json() as { conversation: { id: string; title: string } }).conversation;
    ids.push(second.id);
    assert.equal(second.title, fitting);

    const reply = truncateText(`${"a".repeat(3999)}😀`, 4000);
    const message = await prisma.assistantMessage.create({
      data: { conversationId: title.id, userId: owner.id, role: "assistant", content: reply, model: "gemini-3.5-flash" },
    });
    assert.equal(message.content, "a".repeat(3999));
    assert.equal(hasLoneSurrogate(message.content), false);
  } finally {
    await app.close();
    await prisma.assistantMessage.deleteMany({ where: { userId: owner.id } });
    await prisma.assistantConversation.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.delete({ where: { id: owner.id } });
  }
});
