/**
 * Deleting an assistant chat (assistant/delete-chat.ts): the chat goes at once; an online computer that
 * runs the person's subscription is asked to drop the chat's agent session; a computer that is away is
 * asked when it next connects, and the request stays until it confirms.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";

const h = await createHttpHarness();
const { sseHub } = await import("../lib/sse.js");
const { drainAssistantSessionDeletes } = await import("./delete-chat.js");
after(() => h.close());

const CAPS = { assistantTurns: 3, assistantSessionDelete: 1 };
const until = async (check: () => Promise<boolean>, what: string) => {
  for (let tries = 0; tries < 100; tries += 1) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const pending = async (userId: string) => ((await h.prisma.preference.findUnique({ where: { userId_key: { userId, key: "assistant.session-deletes" } } }))?.value ?? {}) as Record<string, Array<{ key: string }>>;

test("the chat goes at once; online computers drop its session now, a computer that is away does when it connects", async () => {
  const mira = await h.asUser();
  const laptopKey = await h.asToken(mira, "device");
  const desktopKey = await h.asToken(mira, "device");
  const oldKey = await h.asToken(mira, "device");
  const laptop = await h.prisma.device.create({ data: { userId: mira.id, name: "Laptop", platform: "darwin", tokenId: laptopKey.id, lastSeenAt: new Date(), capabilities: CAPS as never } });
  const desktop = await h.prisma.device.create({ data: { userId: mira.id, name: "Desktop", platform: "linux", tokenId: desktopKey.id, lastSeenAt: new Date(Date.now() - 86_400_000), capabilities: CAPS as never } });
  // A computer that never ran the assistant on a subscription keeps no chat sessions.
  await h.prisma.device.create({ data: { userId: mira.id, name: "Runner", platform: "linux", tokenId: oldKey.id, lastSeenAt: new Date(), capabilities: { engines: ["claude-code"] } as never } });
  const created = await mira.inject({ method: "POST", url: "/api/assistant/conversations", payload: { title: "Plan the launch" } });
  const id = (created.json() as { conversation: { id: string } }).conversation.id;
  await h.prisma.assistantMessage.create({ data: { userId: mira.id, conversationId: id, role: "user", content: "Plan it" } });

  const asked: Array<{ device: string; key: unknown }> = [];
  const keys = new Map([[`device:${laptop.id}`, laptopKey], [`device:${desktop.id}`, desktopKey]]);
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (frame.event !== "assistant.session.delete") return;
    const data = frame.data as { id: string; key: unknown };
    asked.push({ device: userId, key: data.key });
    void keys.get(userId)?.inject({ method: "POST", url: `/api/devices/self/code-requests/${data.id}`, payload: { status: 200, body: { deleted: true, found: true } } });
  });
  try {
    const deleted = await mira.inject({ method: "DELETE", url: `/api/assistant/conversations/${id}` });
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.equal(await h.prisma.assistantConversation.count({ where: { id } }), 0);
    assert.equal(await h.prisma.assistantMessage.count({ where: { conversationId: id } }), 0);
    await until(async () => Boolean((await pending(mira.id))[desktop.id]), "the away computer's request to be kept");
    assert.deepEqual(asked, [{ device: `device:${laptop.id}`, key: id }], "only the online computer is asked now");
    assert.deepEqual(Object.keys(await pending(mira.id)), [desktop.id], "the online one confirmed; the runner keeps no chats");

    // The desktop comes back: it is asked, confirms, and the request is done.
    await drainAssistantSessionDeletes(h.app, { ...desktop, lastSeenAt: new Date() });
    assert.deepEqual(asked.at(-1), { device: `device:${desktop.id}`, key: id });
    assert.deepEqual(await pending(mira.id), {});
  } finally {
    stop();
  }
});

test("a computer that does not confirm keeps the request for its next connection", async () => {
  const ben = await h.asUser();
  const key = await h.asToken(ben, "device");
  const laptop = await h.prisma.device.create({ data: { userId: ben.id, name: "Laptop", platform: "darwin", tokenId: key.id, lastSeenAt: new Date(), capabilities: CAPS as never } });
  const created = await ben.inject({ method: "POST", url: "/api/assistant/conversations", payload: { title: "Notes" } });
  const id = (created.json() as { conversation: { id: string } }).conversation.id;
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (frame.event !== "assistant.session.delete" || userId !== `device:${laptop.id}`) return;
    const data = frame.data as { id: string };
    void key.inject({ method: "POST", url: `/api/devices/self/code-requests/${data.id}`, payload: { status: 409, body: { error: "Busy" } } });
  });
  try {
    assert.equal((await ben.inject({ method: "DELETE", url: `/api/assistant/conversations/${id}` })).statusCode, 204);
    await until(async () => Boolean((await pending(ben.id))[laptop.id]), "the unconfirmed request to be kept");
    assert.deepEqual((await pending(ben.id))[laptop.id]!.map((row) => row.key), [id]);
  } finally {
    stop();
  }
});
