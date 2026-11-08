import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { FastifyInstance } from "fastify";
import { createHttpHarness } from "../test/http.js";

const h = await createHttpHarness();
after(() => h.close());
const db = h.prisma;
const app = { prisma: db, log: { warn: () => undefined } } as unknown as FastifyInstance;
const { runRetention } = await import("./retention.js");
const { RuntimeError } = await import("../lib/runtime-error.js");
const { saveSettings } = await import("../lib/settings.js");

const DAY = 86_400_000;
type Run = NonNullable<Parameters<typeof runRetention>[2]["miningRun"]>;
const answer = (skills: unknown[]): Awaited<ReturnType<Run>> => ({ text: JSON.stringify({ skills }), json: { skills }, model: "fixture", tokensIn: 0, tokensOut: 0 });

async function completed(userId: string, count: number, daysAgo: number) {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const task = await db.task.create({ data: { userId, title: `Write the weekly PR summary ${index}`, description: "Summarise merged PRs as bullets with links.", status: "done", completedAt: new Date(Date.now() - daysAgo * DAY), createdBy: "me" } });
    ids.push(task.id);
  }
  return ids;
}

const batch = (userId: string) => db.preference.findUnique({ where: { userId_key: { userId, key: "hub.retention-mining" } } });

test("learning waits for ten items past the window, gives notice, then learns and moves them to Trash", async () => {
  const user = await h.asUser();
  await completed(user.id, 9, 61);
  await runRetention(app, user.id, { deletedDays: 30, completedDays: 60, miningRun: async () => answer([]) });
  assert.equal(await batch(user.id), null, "nine items start nothing");
  const ids = [...(await completed(user.id, 1, 61))];
  await runRetention(app, user.id, { deletedDays: 30, completedDays: 60, miningRun: async () => { throw new Error("no model call before the notice"); } });
  const notice = await db.notification.findFirst({ where: { userId: user.id, title: "Learning from completed work tomorrow" } });
  assert.ok(notice, "the tenth starts a batch with a day's notice");
  const prompts: string[] = [];
  const run: Run = async (input) => {
    prompts.push(input.prompt);
    assert.equal(input.tier, "high");
    return answer([{ slug: "pr-summaries", name: "PR summaries", description: "Weekly PR summaries", body: "Bullets, one per merged PR, each with its link." }]);
  };
  const counts = await runRetention(app, user.id, { deletedDays: 30, completedDays: 60, miningRun: run, now: new Date(Date.now() + DAY + 60_000) });
  assert.equal(counts.completedSoftDeleted, 10);
  assert.match(prompts[0]!, /Summarise merged PRs/);
  assert.equal((await db.skill.findFirstOrThrow({ where: { userId: user.id, slug: "pr-summaries" } })).provenance, "mined");
  assert.equal(await db.task.count({ where: { id: { in: ids }, deletedAt: null } }), 0);
});

test("a model that cannot answer makes learning wait; after five days it falls back to a lower tier", async () => {
  const user = await h.asUser();
  await saveSettings(db, user.id, { models: { medium: { provider: "openai", model: "gpt-medium", effort: "default" }, high: { provider: "anthropic", model: "claude-high", effort: "default" } } });
  const ids = await completed(user.id, 10, 70);
  await db.preference.create({ data: { userId: user.id, key: "hub.retention-mining", value: { after: new Date(Date.now() - 1000).toISOString(), tasks: ids, deliverables: [] }, source: "system" } });
  const asked: string[] = [];
  const run: Run = async (input) => {
    const model = input.settings.models[input.tier ?? "easy"].model;
    asked.push(model);
    if (model === "claude-high") throw new RuntimeError("The High model is not reachable.", 503);
    return answer([]);
  };
  await runRetention(app, user.id, { deletedDays: 30, completedDays: 60, miningRun: run });
  assert.deepEqual(asked, ["claude-high"], "before the wait, only the chosen tier");
  assert.equal(await db.task.count({ where: { id: { in: ids }, deletedAt: null } }), 10, "the work stays in Completed");
  assert.ok(await db.notification.findFirst({ where: { userId: user.id, title: "Learning from completed work is waiting" } }));
  const state = (await batch(user.id))!.value as { waitingSince?: string };
  assert.ok(state.waitingSince);

  asked.length = 0;
  await runRetention(app, user.id, { deletedDays: 30, completedDays: 60, miningRun: run, now: new Date(Date.now() + 6 * DAY) });
  assert.deepEqual(asked.slice(0, 2), ["claude-high", "gpt-medium"], "after five days, the next tier down");
  assert.equal(await db.task.count({ where: { id: { in: ids }, deletedAt: null } }), 0);
  const done = await db.notification.findFirstOrThrow({ where: { userId: user.id, title: "Completed work reviewed" } });
  assert.match(done.body, /Medium model \(gpt-medium\)/);
});

test("with learning off, completed work moves to Trash without a model call", async () => {
  const user = await h.asUser();
  await saveSettings(db, user.id, { automations: { skillLearning: { enabled: false } } });
  const ids = await completed(user.id, 3, 61);
  await runRetention(app, user.id, { deletedDays: 30, completedDays: 60, miningRun: async () => { throw new Error("no model call when learning is off"); } });
  assert.equal(await db.task.count({ where: { id: { in: ids }, deletedAt: null } }), 0);
  assert.equal(await db.skill.count({ where: { userId: user.id } }), 0);
});
