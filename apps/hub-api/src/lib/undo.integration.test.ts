/**
 * Bounded undo against Postgres. Skips when the database is down.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Settings } from "@ensemble/shared-types";
import "../config.js";
import { prisma } from "./prisma.js";
import { recordUndoInTransaction, redoLast, undoLast, withUndoGroup, UndoConflict } from "./undo.js";
import { saveTaskPage } from "../pages/store.js";
import { softDelete } from "../services/records.js";
import { createTask, updateTask } from "../services/tasks.js";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function user(label: string) {
  return prisma.user.create({ data: { email: `undo-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@ensemble.test`, name: label } });
}

async function add(userId: string, title: string, extra: Record<string, unknown> = {}) {
  return prisma.$transaction((tx) => createTask(tx, userId, { title, ...extra }, "me"));
}

async function cleanup(userId: string) {
  await prisma.undoEntry.deleteMany({ where: { userId } });
  await prisma.taskTransition.deleteMany({ where: { userId } });
  await prisma.taskPage.deleteMany({ where: { userId } });
  await prisma.auditLedger.deleteMany({ where: { userId } });
  await prisma.preference.deleteMany({ where: { userId } });
  await prisma.task.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

test("create undo moves the row to Trash and redo restores it", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("create");
  try {
    const task = await add(owner.id, "File the brief");
    const undone = await undoLast(prisma, owner.id);
    assert.match(undone.label, /File the brief/);
    const trashed = await prisma.task.findUnique({ where: { id: task.id } });
    assert.ok(trashed);
    assert.ok(trashed.deletedAt);
    const redone = await redoLast(prisma, owner.id);
    assert.equal(redone.entryId, undone.entryId);
    const back = await prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(back?.deletedAt, null);
  } finally {
    await cleanup(owner.id);
  }
});

test("board move undo uses the pre-move row even when inverse is swapped", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("board");
  try {
    const task = await add(owner.id, "Drag me", { status: "todo" });
    await prisma.$transaction(async (tx) => {
      const existing = await tx.task.findUniqueOrThrow({ where: { id: task.id } });
      const updated = await tx.task.update({ where: { id: task.id }, data: { status: "in_progress", boardOrder: 4 } });
      await recordUndoInTransaction(tx, {
        userId: owner.id,
        label: `Moved “${existing.title}”`,
        kind: "update",
        subject: "task",
        inverse: { op: "update", model: "task", id: task.id, before: updated as never, after: existing as never },
        forward: { op: "update", model: "task", id: task.id, before: existing as never, after: updated as never },
      });
    });
    await undoLast(prisma, owner.id);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(row.status, "todo");
    assert.equal(row.boardOrder, task.boardOrder);
  } finally {
    await cleanup(owner.id);
  }
});

test("targeted undo restores the toast's own task", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("toast");
  try {
    const first = await add(owner.id, "First toast", { status: "todo" });
    const second = await add(owner.id, "Second toast", { status: "todo" });
    await prisma.$transaction((tx) => updateTask(tx, owner.id, first.id, { status: "done" }, "me"));
    const firstEntry = await prisma.undoEntry.findFirst({ where: { userId: owner.id, undoneAt: null }, orderBy: { seq: "desc" } });
    await prisma.$transaction((tx) => updateTask(tx, owner.id, second.id, { status: "done" }, "me"));
    assert.ok(firstEntry);
    await undoLast(prisma, owner.id, firstEntry.id);
    assert.equal((await prisma.task.findUnique({ where: { id: first.id } }))?.status, "todo");
    assert.equal((await prisma.task.findUnique({ where: { id: second.id } }))?.status, "done");
  } finally {
    await cleanup(owner.id);
  }
});

test("a later pin blocks undo and the entry does not stay on top", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("pin");
  try {
    const task = await add(owner.id, "Pin after", { status: "todo" });
    const other = await add(owner.id, "Still undoable", { status: "todo" });
    await prisma.$transaction((tx) => updateTask(tx, owner.id, task.id, { priority: "p0" }, "me"));
    await prisma.task.update({ where: { id: task.id }, data: { pinned: true } });
    await assert.rejects(() => undoLast(prisma, owner.id), (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 409);
      assert.match((error as Error).message, /changed since/);
      return true;
    });
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(row.pinned, true);
    assert.equal(row.priority, "p0");
    assert.equal(row.deletedAt, null);
    await undoLast(prisma, owner.id);
    assert.ok((await prisma.task.findUnique({ where: { id: other.id } }))?.deletedAt);
    assert.equal((await prisma.task.findUnique({ where: { id: task.id } }))?.pinned, true);
  } finally {
    await cleanup(owner.id);
  }
});

test("undo of an earlier edit does not resurrect a trashed or purged task", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("trash");
  try {
    const task = await add(owner.id, "Gone soon");
    await prisma.$transaction((tx) => updateTask(tx, owner.id, task.id, { priority: "p0" }, "me"));
    const edit = await prisma.undoEntry.findFirst({ where: { userId: owner.id, label: { contains: "Updated" } } });
    await prisma.$transaction((tx) => softDelete(tx, owner.id, "task", task.id, "me"));
    assert.ok(edit);
    await assert.rejects(() => undoLast(prisma, owner.id, edit.id), (error: unknown) => error instanceof UndoConflict);
    assert.ok((await prisma.task.findUnique({ where: { id: task.id } }))?.deletedAt);

    const purged = await add(owner.id, "Emptied");
    await prisma.task.delete({ where: { id: purged.id } });
    await assert.rejects(() => undoLast(prisma, owner.id), (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 409);
      assert.equal(error instanceof Error && /500|P2025|Prisma/.test(error.message), false);
      return true;
    });
    assert.equal(await prisma.task.findUnique({ where: { id: purged.id } }), null);
  } finally {
    await cleanup(owner.id);
  }
});

test("page autosave is not an undo entry", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("page");
  try {
    const task = await add(owner.id, "Page");
    const before = await prisma.undoEntry.count({ where: { userId: owner.id } });
    await saveTaskPage(prisma, owner.id, task.id, {
      revision: 0,
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "typed" }] }] },
    });
    assert.equal(await prisma.undoEntry.count({ where: { userId: owner.id } }), before);
  } finally {
    await cleanup(owner.id);
  }
});

test("one group undoes every create, and a conflict undoes none of them", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("batch");
  try {
    const { result } = await prisma.$transaction((tx) =>
      withUndoGroup(tx, { userId: owner.id, subject: "tasks" }, async () => {
        const rows = [];
        for (const title of ["One", "Two", "Three"]) rows.push(await createTask(tx, owner.id, { title }, "agent"));
        return rows;
      }),
    );
    assert.equal(await prisma.undoEntry.count({ where: { userId: owner.id, undoneAt: null } }), 1);
    await undoLast(prisma, owner.id);
    for (const row of result) assert.ok((await prisma.task.findUnique({ where: { id: row.id } }))?.deletedAt);
    await redoLast(prisma, owner.id);

    const again = await prisma.$transaction((tx) =>
      withUndoGroup(tx, { userId: owner.id, subject: "tasks" }, async () => {
        const rows = [];
        for (const title of ["A", "B", "C"]) rows.push(await createTask(tx, owner.id, { title }, "agent"));
        return rows;
      }),
    );
    await prisma.task.update({ where: { id: again.result[1]!.id }, data: { title: "B edited" } });
    await assert.rejects(() => undoLast(prisma, owner.id), (error: unknown) => error instanceof UndoConflict);
    for (const row of again.result) assert.equal((await prisma.task.findUnique({ where: { id: row.id } }))?.deletedAt, null);
    assert.equal(await prisma.undoEntry.count({ where: { userId: owner.id, undoneAt: null, label: { contains: "“A”" } } }), 0);
  } finally {
    await cleanup(owner.id);
  }
});

test("undo moves updatedAt forward and appends a reverse transition", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("clock");
  try {
    const task = await add(owner.id, "Status", { status: "todo" });
    const updated = await prisma.$transaction((tx) => updateTask(tx, owner.id, task.id, { status: "in_progress" }, "me"));
    const beforeUndo = updated.updatedAt.getTime();
    await undoLast(prisma, owner.id);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(row.status, "todo");
    assert.ok(row.updatedAt.getTime() >= beforeUndo);
    const transitions = await prisma.taskTransition.findMany({ where: { taskId: task.id }, orderBy: { at: "asc" } });
    assert.ok(transitions.some((item) => item.toStatus === "in_progress" && item.reason !== "undo"));
    const reverse = transitions.find((item) => item.reason === "undo");
    assert.equal(reverse?.fromStatus, "in_progress");
    assert.equal(reverse?.toStatus, "todo");
  } finally {
    await cleanup(owner.id);
  }
});

test("depth keeps the last N live entries and a new action clears redo", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("depth");
  try {
    await prisma.preference.create({
      data: { userId: owner.id, key: "hub.settings", value: Settings.parse({ undoDepth: 3 }) },
    });
    const titles = ["n1", "n2", "n3", "n4"];
    for (const title of titles) await add(owner.id, title);
    const live = await prisma.undoEntry.findMany({ where: { userId: owner.id, undoneAt: null }, orderBy: { seq: "asc" } });
    assert.equal(live.length, 3);
    assert.equal(live.some((entry) => entry.label.includes("n1")), false);
    await undoLast(prisma, owner.id);
    await add(owner.id, "n5");
    assert.equal(await prisma.undoEntry.count({ where: { userId: owner.id, undoneAt: { not: null } } }), 0);
  } finally {
    await cleanup(owner.id);
  }
});

test("a legacy empty entry is dropped instead of blocking the stack", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("legacy");
  try {
    const task = await add(owner.id, "Older");
    const last = await prisma.undoEntry.findFirst({ where: { userId: owner.id }, orderBy: { seq: "desc" } });
    await prisma.undoEntry.create({
      data: {
        userId: owner.id,
        seq: (last?.seq ?? 0n) + 1n,
        label: "Jammed create",
        kind: "create",
        actor: "me",
        subject: "task",
        inverse: { op: "delete", model: "task", id: task.id },
        forward: { op: "create", model: "task", id: task.id },
        ops: [],
      },
    });
    await assert.rejects(() => undoLast(prisma, owner.id), (error: unknown) => error instanceof UndoConflict);
    assert.equal(await prisma.undoEntry.count({ where: { userId: owner.id, label: "Jammed create" } }), 0);
    await undoLast(prisma, owner.id);
    assert.ok((await prisma.task.findUnique({ where: { id: task.id } }))?.deletedAt);
  } finally {
    await cleanup(owner.id);
  }
});
