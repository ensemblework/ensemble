/**
 * Task search and ownership. Skips when Postgres is not reachable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Settings } from "@ensemble/shared-types";
import "../../config.js";
import { getTool } from "../registry.js";
import { prisma } from "../../lib/prisma.js";
import { createTask, updateTask } from "../../services/tasks.js";
import type { ToolContext } from "../types.js";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function ctx(userId: string): ToolContext {
  return {
    app: { log: { warn() {}, error() {} } } as unknown as ToolContext["app"],
    prisma,
    userId,
    actor: "agent",
    settings: Settings.parse({}),
  };
}

test("list search finds a task past the old first page, and Apply checks the title", async (t) => {
  if (!(await databaseReady())) {
    t.skip("Postgres is not reachable");
    return;
  }
  const stamp = Date.now().toString(36);
  const owner = await prisma.user.create({ data: { email: `tasks-a-${stamp}@ensemble.test`, name: "Owner" } });
  const other = await prisma.user.create({ data: { email: `tasks-b-${stamp}@ensemble.test`, name: "Other" } });
  const foreign = await prisma.project.create({ data: { userId: other.id, name: `Foreign ${stamp}`, createdBy: "me" } });
  try {
    const target = await prisma.task.create({
      data: { userId: owner.id, title: "LIVE2 draft Q4 roadmap", boardOrder: 0, createdBy: "me" },
    });
    await prisma.task.create({
      data: { userId: owner.id, title: "LIVE2 draft Q4 notes", boardOrder: 1, createdBy: "me" },
    });
    for (let index = 0; index < 24; index += 1) {
      await prisma.task.create({
        data: { userId: owner.id, title: `Alpha ${index} LIVE2 draft`, boardOrder: 10 + index, createdBy: "me" },
      });
    }
    const list = getTool("hub_list_tasks");
    assert.ok(list);
    const page = await list.run(ctx(owner.id), list.input.parse({ limit: 20 }));
    const listed = (page.data as { tasks: Array<{ id: string }> }).tasks;
    assert.equal(listed.some((row) => row.id === target.id), false);
    const found = await list.run(ctx(owner.id), list.input.parse({ query: "LIVE2 draft Q4", limit: 20 }));
    const matches = (found.data as { tasks: Array<{ id: string; title: string }>; total: number }).tasks;
    assert.equal((found.data as { total: number }).total, 2);
    assert.ok(matches.some((row) => row.id === target.id && row.title === "LIVE2 draft Q4 roadmap"));

    const update = getTool("hub_update_task");
    assert.ok(update);
    const preview = update.preview;
    assert.ok(preview);
    await assert.rejects(
      () => Promise.resolve(preview(ctx(owner.id), { taskId: target.id, matchTitle: "LIVE2 draft Q4 notes", status: "done" })),
      /LIVE2 draft Q4 roadmap/,
    );
    try {
      await prisma.$transaction((tx) => updateTask(tx, owner.id, target.id, { matchTitle: "Board card", status: "done" }, "agent"));
      assert.fail("wrong title was applied");
    } catch (error) {
      assert.equal((error as { statusCode?: number }).statusCode, 409);
    }
    const done = await prisma.$transaction((tx) =>
      updateTask(tx, owner.id, target.id, { matchTitle: "LIVE2 draft Q4 roadmap", status: "in_progress" }, "agent"),
    );
    assert.equal(done.status, "in_progress");
    assert.equal(done.title, "LIVE2 draft Q4 roadmap");

    try {
      await prisma.$transaction((tx) => createTask(tx, owner.id, { title: "Should not land", projectId: foreign.id }, "me"));
      assert.fail("foreign project was accepted");
    } catch (error) {
      assert.equal((error as { statusCode?: number }).statusCode, 404);
    }
    assert.equal(await prisma.task.count({ where: { userId: owner.id, title: "Should not land" } }), 0);

    const reminder = await prisma.reminder.create({
      data: {
        userId: other.id,
        title: "Foreign",
        titleContent: { type: "doc", content: [] },
        dueDate: "2026-12-01",
        timeZone: "UTC",
        actionTokenHash: stamp,
      },
    });
    const dismiss = getTool("hub_dismiss_reminder");
    assert.ok(dismiss);
    try {
      await dismiss.run(ctx(owner.id), { reminderId: reminder.id });
      assert.fail("foreign reminder was dismissed");
    } catch (error) {
      assert.equal((error as { statusCode?: number }).statusCode, 404);
    }
    const still = await prisma.reminder.findUnique({ where: { id: reminder.id } });
    assert.equal(still?.dismissedAt, null);
  } finally {
    await prisma.task.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.reminder.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.project.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
  }
});

test("Apply can attach tasks to a project created earlier in the same transaction", async (t) => {
  if (!(await databaseReady())) {
    t.skip("Postgres is not reachable");
    return;
  }
  const stamp = Date.now().toString(36);
  const owner = await prisma.user.create({ data: { email: `batch-${stamp}@ensemble.test`, name: "Batch" } });
  const name = `Launch ${stamp}`;
  try {
    const projectTool = getTool("hub_create_project");
    const taskTool = getTool("hub_create_tasks");
    assert.ok(projectTool);
    assert.ok(taskTool);
    const base = ctx(owner.id);
    await prisma.$transaction(async (tx) => {
      const withTx = { ...base, tx };
      await projectTool.run(withTx, projectTool.input.parse({ name }));
      await taskTool.run(withTx, taskTool.input.parse({ tasks: [{ title: "Write the brief", projectName: name }] }));
    });
    const task = await prisma.task.findFirst({ where: { userId: owner.id, title: "Write the brief" } });
    const project = await prisma.project.findFirst({ where: { userId: owner.id, name } });
    assert.ok(project);
    assert.equal(task?.projectId, project.id);
    const preview = taskTool.preview;
    assert.ok(preview);
    await assert.rejects(
      () => Promise.resolve(preview({ ...base, pendingProjectNames: [] }, { tasks: [{ title: "Nope", projectName: `Missing ${stamp}` }] })),
      /No project named/,
    );
  } finally {
    await prisma.task.deleteMany({ where: { userId: owner.id } });
    await prisma.undoEntry.deleteMany({ where: { userId: owner.id } });
    await prisma.project.deleteMany({ where: { userId: owner.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  }
});
