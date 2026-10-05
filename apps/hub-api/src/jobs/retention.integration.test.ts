/**
 * Retention and reminder dispatch against the local database.
 * Skips when Postgres is not reachable so `pnpm test` still runs offline.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import "../config.js";
import { prisma } from "../lib/prisma.js";
import { createReminder } from "../services/records.js";
import { completionSummary, dispatchDueReminders, runRetention } from "./retention.js";

const app = { prisma } as unknown as FastifyInstance;

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

test("history retention drops old ledger rows and status transitions", async (t) => {
  if (!(await databaseReady())) {
    t.skip("Postgres is not reachable");
    return;
  }
  const owner = await prisma.user.create({ data: { email: `history-${Date.now()}@ensemble.test`, name: "History" } });
  const old = new Date(Date.now() - 120 * 86_400_000);
  const task = await prisma.task.create({ data: { userId: owner.id, title: "history", createdBy: "me" } });
  try {
    await prisma.auditLedger.create({
      data: { userId: owner.id, actor: "me", action: "old.note", hash: `old-${owner.id}`, ts: old, payload: {} },
    });
    await prisma.taskTransition.create({
      data: { userId: owner.id, taskId: task.id, toStatus: "todo", actor: "me", at: old },
    });
    const fresh = await prisma.auditLedger.create({
      data: { userId: owner.id, actor: "me", action: "fresh.note", hash: `fresh-${owner.id}`, payload: {} },
    });
    const counts = await runRetention(app, owner.id, { deletedDays: 30, completedDays: 60, historyDays: 90 });
    assert.ok(counts.historyPurged >= 2);
    assert.equal(await prisma.auditLedger.count({ where: { id: fresh.id } }), 1);
    assert.equal(await prisma.auditLedger.count({ where: { userId: owner.id, action: "old.note" } }), 0);
    assert.equal(await prisma.taskTransition.count({ where: { taskId: task.id } }), 0);
  } finally {
    await prisma.taskTransition.deleteMany({ where: { userId: owner.id } });
    await prisma.auditLedger.deleteMany({ where: { userId: owner.id } });
    await prisma.task.deleteMany({ where: { userId: owner.id } });
    await prisma.user.delete({ where: { id: owner.id } }).catch(() => undefined);
  }
});

test("retention deletes log chunks older than 30 days in batches", async (t) => {
  if (!(await databaseReady())) {
    t.skip("Postgres is not reachable");
    return;
  }
  const user = await prisma.user.create({ data: { email: `logs-${Date.now()}@ensemble.test`, name: "Logs" } });
  const other = await prisma.user.create({ data: { email: `logs-other-${Date.now()}@ensemble.test`, name: "Other" } });
  const task = await prisma.task.create({ data: { userId: user.id, title: "logs", createdBy: "me" } });
  const otherTask = await prisma.task.create({ data: { userId: other.id, title: "logs-other", createdBy: "me" } });
  const job = await prisma.workspaceJob.create({
    data: { userId: user.id, taskId: task.id, executionMode: "native", model: "test" },
  });
  const otherJob = await prisma.workspaceJob.create({
    data: { userId: other.id, taskId: otherTask.id, executionMode: "native", model: "test" },
  });
  const old = new Date(Date.now() - 31 * 86_400_000);
  const kept = new Date(Date.now() - 29 * 86_400_000);
  try {
    await prisma.workspaceLogChunk.createMany({
      data: [
        { jobId: job.id, seqFrom: 0, seqTo: 1, text: "old-a", bytes: 5, createdAt: old },
        { jobId: job.id, seqFrom: 1, seqTo: 2, text: "old-b", bytes: 5, createdAt: new Date(old.getTime() + 1000) },
        { jobId: job.id, seqFrom: 2, seqTo: 3, text: "old-c", bytes: 5, createdAt: new Date(old.getTime() + 2000) },
        { jobId: job.id, seqFrom: 3, seqTo: 4, text: "kept", bytes: 4, createdAt: kept },
        { jobId: otherJob.id, seqFrom: 0, seqTo: 1, text: "other-old", bytes: 9, createdAt: old },
      ],
    });
    const counts = await runRetention(app, user.id, { deletedDays: 30, completedDays: 60, logChunkBatchSize: 2 });
    assert.equal(counts.logChunksPurged, 3);
    const left = await prisma.workspaceLogChunk.findMany({ where: { jobId: job.id }, orderBy: { seqFrom: "asc" } });
    assert.deepEqual(left.map((row) => row.text), ["kept"]);
    assert.equal(await prisma.workspaceLogChunk.count({ where: { jobId: otherJob.id } }), 1);
  } finally {
    await prisma.workspaceLogChunk.deleteMany({ where: { jobId: { in: [job.id, otherJob.id] } } });
    await prisma.auditLedger.deleteMany({ where: { userId: { in: [user.id, other.id] } } });
    await prisma.workspaceJob.deleteMany({ where: { userId: { in: [user.id, other.id] } } });
    await prisma.task.deleteMany({ where: { userId: { in: [user.id, other.id] } } });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: other.id } }).catch(() => undefined);
  }
});

test("completion summary collapses whitespace", () => {
  assert.equal(completionSummary("  filed   the memo \n today "), "filed the memo today");
  assert.equal(completionSummary("x".repeat(800)).length, 500);
});

test("retention records a completion, skips pinned rows, purges old trash, and fires due reminders", async (t) => {
  if (!(await databaseReady())) {
    t.skip("Postgres is not reachable");
    return;
  }
  const user = await prisma.user.create({
    data: { email: `retention-${Date.now()}@ensemble.test`, name: "Retention" },
  });
  const old = new Date(Date.now() - 90 * 86_400_000);
  const title = `retention-${user.id.slice(0, 8)}`;
  const task = await prisma.task.create({
    data: { userId: user.id, title, status: "done", completedAt: old, pinned: false, createdBy: "me", description: "Filed the brief." },
  });
  const pinned = await prisma.task.create({
    data: { userId: user.id, title: `${title}-pinned`, status: "done", completedAt: old, pinned: true, createdBy: "me" },
  });
  let reminderId = "";
  try {
    const first = await runRetention(app, user.id, { deletedDays: 30, completedDays: 60 });
    assert.equal(first.completionRecords, 1);
    assert.equal(first.completedSoftDeleted, 1);
    const archived = await prisma.task.findUnique({ where: { id: task.id } });
    assert.ok(archived?.deletedAt);
    const kept = await prisma.task.findUnique({ where: { id: pinned.id } });
    assert.equal(kept?.deletedAt, null);
    const record = await prisma.completionRecord.findFirst({ where: { userId: user.id, entityId: task.id } });
    assert.equal(record?.title, title);
    assert.equal(record?.outcome, "done");
    assert.match(record?.summary ?? "", /Filed the brief/);

    await prisma.task.update({ where: { id: task.id }, data: { deletedAt: new Date(Date.now() - 40 * 86_400_000) } });
    const second = await runRetention(app, user.id, { deletedDays: 30, completedDays: 60 });
    assert.equal(second.purged, 1);
    assert.equal(await prisma.task.findUnique({ where: { id: task.id } }), null);
    assert.equal(await prisma.completionRecord.count({ where: { entityId: task.id } }), 1);

    const reminder = await prisma.$transaction((tx) =>
      createReminder(tx, user.id, { title: `${title}-remind`, dueDate: "2020-01-02", dueTime: "09:00", timeZone: "UTC" }, "me"),
    );
    reminderId = reminder.id;
    await prisma.reminder.update({ where: { id: reminder.id }, data: { nextNotificationAt: new Date(Date.now() - 60_000) } });
    const sent = await dispatchDueReminders(app, user.id);
    assert.equal(sent, 1);
    const note = await prisma.notification.findFirst({ where: { userId: user.id, title: `${title}-remind` } });
    assert.ok(note);
    const fired = await prisma.reminder.findUnique({ where: { id: reminder.id } });
    assert.equal(fired?.nextNotificationAt, null);
    assert.equal(fired?.notificationSequence, 1);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: user.id } });
    await prisma.completionRecord.deleteMany({ where: { userId: user.id } });
    await prisma.auditLedger.deleteMany({ where: { userId: user.id } });
    await prisma.undoEntry.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
    if (reminderId) await prisma.reminder.deleteMany({ where: { id: reminderId } });
    await prisma.task.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});
