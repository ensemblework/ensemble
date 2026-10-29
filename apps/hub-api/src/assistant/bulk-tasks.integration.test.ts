/**
 * Clearing a board through the assistant: one bulk tool, ids pinned before the preview, one
 * transaction and one undo entry; list results cut at whole items; "Just do it" as the default
 * write mode for new and existing accounts.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { createHttpHarness } from "../test/http.js";

const h = await createHttpHarness();
after(() => h.close());
const { Settings } = await import("@ensemble/shared-types");
const { getTool } = await import("./registry.js");
const { applyHeldCalls } = await import("./apply.js");
const { fitList, writeModeNote } = await import("./agent.js");
const { loadSettings, saveSettings } = await import("../lib/settings.js");
const { undoLast } = await import("../lib/undo.js");
type ToolContext = import("./types.js").ToolContext;

const app = { prisma: h.prisma, log: { error() {}, info() {}, warn() {} } } as unknown as FastifyInstance;
const ctx = (userId: string): ToolContext => ({ app, prisma: h.prisma, userId, actor: "agent", settings: Settings.parse({}) });

async function board(userId: string, count: number, status: "todo" | "done" = "todo") {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(await h.prisma.task.create({ data: { userId, title: `${status} task ${index} https://www.sciencedirect.com/science/article/pii/S15741192193046${index}`, status, boardOrder: index, createdBy: "me" } }));
  }
  return rows;
}

test("“delete all tasks” pins the board's ids, moves all 41 in one Apply and one Undo brings them back", async () => {
  const user = await h.asUser();
  const other = await h.asUser();
  await board(user.id, 41);
  const foreign = await h.prisma.task.create({ data: { userId: other.id, title: "Not yours", boardOrder: 0, createdBy: "me" } });
  const tool = getTool("hub_delete_tasks");
  assert.ok(tool?.prepare && tool.preview);

  const input = await tool.prepare(ctx(user.id), tool.input.parse({ all: true }));
  const ids = (input as { taskIds: string[] }).taskIds;
  assert.equal(ids.length, 41);
  assert.ok(!ids.includes(foreign.id));
  assert.deepEqual(tool.input.parse(input), input, "the pinned input is what Apply parses again");

  const preview = await tool.preview(ctx(user.id), input);
  assert.match(preview, /^Move 41 tasks to Trash:/);
  assert.match(preview, /…and 33 more/);

  // A task added after the preview is not swept up by Apply.
  const later = await h.prisma.task.create({ data: { userId: user.id, title: "Added after the preview", boardOrder: 99, createdBy: "me" } });
  const batch = await applyHeldCalls(app, ctx(user.id), [{ tool, input }]);
  assert.equal(batch.partial, false);
  assert.equal(batch.outcomes[0]!.ok && batch.outcomes[0]!.result.summary, "Moved 41 tasks to Trash.");
  assert.equal(await h.prisma.task.count({ where: { userId: user.id, deletedAt: null } }), 1);
  assert.equal((await h.prisma.task.findUnique({ where: { id: later.id } }))?.deletedAt, null);
  assert.equal((await h.prisma.task.findUnique({ where: { id: foreign.id } }))?.deletedAt, null);

  const entries = await h.prisma.undoEntry.findMany({ where: { userId: user.id, undoneAt: null } });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.label, "Moved 41 tasks to Trash");
  await undoLast(h.prisma, user.id);
  assert.equal(await h.prisma.task.count({ where: { userId: user.id, deletedAt: null } }), 42);
});

test("a filter takes only matching tasks, and a wrong id moves nothing", async () => {
  const user = await h.asUser();
  const open = await board(user.id, 3, "todo");
  await board(user.id, 2, "done");
  const tool = getTool("hub_delete_tasks")!;
  const done = await tool.prepare!(ctx(user.id), tool.input.parse({ status: "done" }));
  assert.equal((done as { taskIds: string[] }).taskIds.length, 2);
  await applyHeldCalls(app, ctx(user.id), [{ tool, input: done }]);
  assert.equal(await h.prisma.task.count({ where: { userId: user.id, deletedAt: null } }), 3);

  const wrong = { taskIds: [open[0]!.id, "00000000-0000-4000-8000-000000000000"] };
  await assert.rejects(() => Promise.resolve(tool.preview!(ctx(user.id), tool.input.parse(wrong))), /1 of those tasks are not on your board/);
  await assert.rejects(() => applyHeldCalls(app, ctx(user.id), [{ tool, input: tool.input.parse(wrong) }]), /not on the board/);
  assert.equal(await h.prisma.task.count({ where: { userId: user.id, deletedAt: null } }), 3);

  assert.throws(() => tool.input.parse({}), /taskIds, or all: true, or a filter/);
  await assert.rejects(() => tool.prepare!(ctx(user.id), tool.input.parse({ label: "nothing-tagged-this" })), /No tasks on the board match/);
});

test("deleting one task refuses an id that is not on the board before it is proposed", async () => {
  const user = await h.asUser();
  const [task] = await board(user.id, 1);
  const tool = getTool("hub_delete_task")!;
  await h.prisma.task.update({ where: { id: task!.id }, data: { deletedAt: new Date() } });
  await assert.rejects(() => Promise.resolve(tool.preview!(ctx(user.id), { taskId: task!.id })), /not on your board/);
});

test("a long task list is cut at whole tasks, with every id complete and where to continue", async () => {
  const user = await h.asUser();
  await board(user.id, 60);
  const list = getTool("hub_list_tasks")!;
  const result = await list.run(ctx(user.id), list.input.parse({ limit: 100 }));
  const full = result.data as { total: number; tasks: Array<{ id: string }> };
  assert.equal(full.total, 60);
  assert.ok(JSON.stringify(full).length > 6000, "the fixture must overflow the model's result budget");
  const fitted = fitList(full);
  assert.ok(fitted);
  const shown = (fitted.data as { tasks: Array<{ id: string }> }).tasks;
  assert.ok(shown.length > 20 && shown.length < 60);
  assert.ok(shown.every((row) => /^[0-9a-f-]{36}$/.test(row.id)));
  assert.ok(JSON.stringify(fitted).length <= 6000);
  assert.match(String(fitted.note), new RegExp(`offset ${shown.length}`));
  assert.equal(fitList({ text: "x".repeat(9000) }), null);
});

test("Just do it is the default write mode, and the upgrade moves saved Preview accounts to it", async () => {
  assert.equal(Settings.parse({}).assistant.writePolicy, "immediate");
  const preview = await h.asUser();
  const queued = await h.asUser();
  await saveSettings(h.prisma, preview.id, { assistant: { writePolicy: "preview" } });
  await saveSettings(h.prisma, queued.id, { assistant: { writePolicy: "needs-me" } });
  const sql = await readFile(new URL("../../prisma/migrations/20261018120000_assistant_writes_immediate/migration.sql", import.meta.url), "utf8");
  await h.prisma.$executeRawUnsafe(sql);
  assert.equal((await loadSettings(h.prisma, preview.id)).assistant.writePolicy, "immediate");
  assert.equal((await loadSettings(h.prisma, queued.id)).assistant.writePolicy, "needs-me");
  await saveSettings(h.prisma, preview.id, { assistant: { writePolicy: "preview" } });
  assert.equal((await loadSettings(h.prisma, preview.id)).assistant.writePolicy, "preview", "choosing Preview again sticks");

  assert.match(writeModeNote("immediate"), /Changes in Ensemble happen when you call the tool/);
  assert.match(writeModeNote("preview"), /ready to apply/);
  assert.match(writeModeNote("needs-me"), /Needs me/);
});
