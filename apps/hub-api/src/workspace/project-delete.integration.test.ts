/**
 * Deleting an Ensemble project, on the person's computers (workspace/project-delete.ts): the project goes
 * to Trash at once; the computers that may have a Codex project for it (the account's, and any that ran a
 * Codex task of it) are asked to remove theirs once it has been there 10 minutes, an online one then and
 * one that is away when it connects. A project back from Trash by then keeps them.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DEFAULT_SETTINGS, OPTIONAL_MODULES, serializeModules } from "@ensemble/shared-types";
import { createHttpHarness } from "../test/http.js";

const h = await createHttpHarness();
const { sseHub } = await import("../lib/sse.js");
const { drainProjectDeletes, PROJECT_UNDO_MS, sendProjectDeletes } = await import("./project-delete.js");
const { getTool } = await import("../assistant/registry.js");
after(() => h.close());

const CAPS = { projectDelete: 1 };
const until = async (check: () => Promise<boolean>, what: string) => {
  for (let tries = 0; tries < 100; tries += 1) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const pending = async (userId: string) => ((await h.prisma.preference.findUnique({ where: { userId_key: { userId, key: "projects.codex-project-deletes" } } }))?.value ?? {}) as Record<string, Array<{ key: string }>>;
const later = () => Date.now() + PROJECT_UNDO_MS + 1000;

test("a deleted project's Codex projects go from its computers once it has been in Trash 10 minutes", async () => {
  const mira = await h.asUser();
  const ben = await h.asUser();
  const device = async (owner: typeof mira, name: string, data: { lastSeenAt: Date; capabilities: object; revokedAt?: Date }) => {
    const key = await h.asToken(owner, "device");
    const row = await h.prisma.device.create({ data: { userId: owner.id, name, platform: "darwin", tokenId: key.id, ...data, capabilities: data.capabilities as never } });
    return { row, key };
  };
  const laptop = await device(mira, "Laptop", { lastSeenAt: new Date(), capabilities: CAPS });
  const desktop = await device(mira, "Desktop", { lastSeenAt: new Date(Date.now() - 86_400_000), capabilities: CAPS });
  const old = await device(mira, "Old Mac", { lastSeenAt: new Date(), capabilities: { engines: ["codex"] } });
  await device(mira, "Removed", { lastSeenAt: new Date(), capabilities: CAPS, revokedAt: new Date() });
  // Ben's computer ran a Codex task of the project; his other one never did.
  const bens = await device(ben, "Ben's Mac", { lastSeenAt: new Date(), capabilities: CAPS });
  await device(ben, "Ben's other Mac", { lastSeenAt: new Date(), capabilities: CAPS });

  const created = await mira.inject({ method: "POST", url: "/api/projects", payload: { name: "Launch" } });
  const projectId = (created.json() as { project: { id: string } }).project.id;
  const task = await h.prisma.task.create({ data: { userId: mira.id, title: "Ship the launch page", projectId } });
  await h.prisma.workspaceJob.create({ data: { userId: mira.id, taskId: task.id, provider: "codex", model: "default", executionMode: "device", deviceId: bens.row.id } });

  const asked: Array<{ device: string; projectId: unknown }> = [];
  const keys = new Map([laptop, desktop, bens].map((computer) => [`device:${computer.row.id}`, computer.key]));
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (frame.event !== "project.delete") return;
    const data = frame.data as { id: string; projectId: unknown };
    asked.push({ device: userId, projectId: data.projectId });
    void keys.get(userId)?.inject({ method: "POST", url: `/api/devices/self/code-requests/${data.id}`, payload: { status: 200, body: { deleted: true, found: 1, owed: false } } });
  });
  try {
    const deleted = await mira.inject({ method: "DELETE", url: `/api/projects/${projectId}` });
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.ok((await h.prisma.project.findUnique({ where: { id: projectId } }))?.deletedAt, "in Trash at once");
    await until(async () => Boolean((await pending(ben.id))[bens.row.id]), "the computers to be noted");
    assert.deepEqual(Object.keys(await pending(mira.id)).sort(), [laptop.row.id, desktop.row.id, old.row.id].sort(), "the account's paired computers");
    assert.deepEqual(Object.keys(await pending(ben.id)), [bens.row.id], "and the one that ran a Codex task of it");

    // Within the 10 minutes Undo has, nothing is asked.
    await sendProjectDeletes(h.app);
    assert.equal(asked.length, 0);

    await sendProjectDeletes(h.app, later());
    assert.deepEqual(asked.map((row) => row.device).sort(), [`device:${laptop.row.id}`, `device:${bens.row.id}`].sort(), "the online computers that can");
    assert.ok(asked.every((row) => row.projectId === projectId));
    assert.deepEqual(Object.keys(await pending(mira.id)).sort(), [desktop.row.id, old.row.id].sort(), "the away one, and one to update, wait");
    assert.deepEqual(await pending(ben.id), {});

    // The desktop connects again: asked, confirms, done.
    await drainProjectDeletes(h.app, { ...desktop.row, lastSeenAt: new Date() }, later());
    assert.deepEqual(asked.at(-1), { device: `device:${desktop.row.id}`, projectId });
    assert.deepEqual(Object.keys(await pending(mira.id)), [old.row.id]);

    // Unpaired: its wait goes.
    await h.prisma.device.update({ where: { id: old.row.id }, data: { revokedAt: new Date() } });
    await sendProjectDeletes(h.app, later());
    assert.deepEqual(await pending(mira.id), {});
    assert.equal(asked.length, 3);
  } finally {
    stop();
  }
});

test("a project back from Trash within the 10 minutes keeps its Codex projects; one the assistant deleted, or Redo put back in Trash, goes", async () => {
  const ana = await h.asUser();
  const key = await h.asToken(ana, "device");
  const laptop = await h.prisma.device.create({ data: { userId: ana.id, name: "Laptop", platform: "darwin", tokenId: key.id, lastSeenAt: new Date(), capabilities: CAPS as never } });
  const project = async (name: string) => ((await ana.inject({ method: "POST", url: "/api/projects", payload: { name } })).json() as { project: { id: string } }).project.id;
  const noted = (id: string) => until(async () => Boolean((await pending(ana.id))[laptop.id]?.some((row) => row.key === id)), `${id} to be noted`);
  const back = await project("Brought back");
  const byAssistant = await project("Deleted by the assistant");

  const asked: unknown[] = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (frame.event !== "project.delete" || userId !== `device:${laptop.id}`) return;
    const data = frame.data as { id: string; projectId: unknown };
    asked.push(data.projectId);
    void key.inject({ method: "POST", url: `/api/devices/self/code-requests/${data.id}`, payload: { status: 200, body: { deleted: true, found: 0, owed: false } } });
  });
  try {
    // Deleted, then restored from Trash: nothing goes.
    assert.equal((await ana.inject({ method: "DELETE", url: `/api/projects/${back}` })).statusCode, 204);
    await noted(back);
    await h.prisma.project.update({ where: { id: back }, data: { deletedAt: null } });

    // The assistant deletes one, the person undoes it, then redoes it: it goes once it is back in Trash.
    const tool = getTool("hub_delete_entity")!;
    const ctx = { app: h.app, prisma: h.prisma, userId: ana.id, actor: "agent" as const, settings: DEFAULT_SETTINGS, modules: serializeModules(OPTIONAL_MODULES) };
    await tool.run(ctx as never, tool.input.parse({ kind: "project", id: byAssistant }));
    await noted(byAssistant);
    assert.equal((await ana.inject({ method: "POST", url: "/api/undo", payload: {} })).statusCode, 200);
    assert.equal((await h.prisma.project.findUnique({ where: { id: byAssistant } }))?.deletedAt, null);
    await sendProjectDeletes(h.app, later());
    assert.equal(asked.length, 0, "a project back from Trash is not asked for");
    assert.deepEqual(await pending(ana.id), {});

    assert.equal((await ana.inject({ method: "POST", url: "/api/redo", payload: {} })).statusCode, 200);
    await noted(byAssistant);
    await sendProjectDeletes(h.app, later());
    assert.deepEqual(asked, [byAssistant]);
    assert.deepEqual(await pending(ana.id), {});
  } finally {
    stop();
  }
});
