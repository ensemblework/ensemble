/**
 * Two overlapping processes must not both win a schedule slot or a watcher.
 * Skips when Postgres is down.
 */
import assert from "node:assert/strict";
import test from "node:test";
import "../config.js";
import { prisma } from "../lib/prisma.js";
import type { FastifyInstance } from "fastify";
import { createReminder } from "../services/records.js";
import { evaluateWatchers } from "../ensemble/watchers.js";
import { claimSlot } from "./claim.js";
import { dispatchDueReminders } from "./retention.js";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

test("one slot has a single winner even when two claims overlap", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await prisma.user.create({
    data: { email: `claim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@ensemble.test`, name: "Claim" },
  });
  try {
    const slot = "fetch@2026-10-01T09:00";
    const [first, second] = await Promise.all([
      claimSlot(prisma, user.id, "schedule:fetch", slot),
      claimSlot(prisma, user.id, "schedule:fetch", slot),
    ]);
    assert.equal(first !== second && (first || second), true);
    assert.equal(await claimSlot(prisma, user.id, "schedule:fetch", slot), false);
    assert.equal(await claimSlot(prisma, user.id, "schedule:fetch", "fetch@2026-10-01T09:01"), true);
    const row = await prisma.syncState.findUnique({ where: { userId_connector: { userId: user.id, connector: "schedule:fetch" } } });
    assert.equal(row?.cursor, "fetch@2026-10-01T09:01");

    const task = await prisma.task.create({
      data: { userId: user.id, title: "due", due: new Date(Date.now() + 60_000), createdBy: "me" },
    });
    const watcher = await prisma.watcher.create({
      data: {
        userId: user.id,
        scopeKind: "task",
        scopeId: task.id,
        condition: "days_before_due",
        daysBefore: 1,
        message: "Due soon",
        prompt: "remind",
      },
    });
    const [left, right] = await Promise.all([evaluateWatchers(prisma, user.id), evaluateWatchers(prisma, user.id)]);
    assert.equal(left + right, 1);
    assert.equal((await prisma.watcher.findUnique({ where: { id: watcher.id } }))?.status, "fired");
    assert.equal(await prisma.notification.count({ where: { userId: user.id, kind: "watcher" } }), 1);

    const reminder = await prisma.$transaction((tx) =>
      createReminder(tx, user.id, { title: "Standup", dueDate: "2020-01-02", dueTime: "09:00", timeZone: "UTC" }, "me"),
    );
    await prisma.reminder.update({ where: { id: reminder.id }, data: { nextNotificationAt: new Date(Date.now() - 60_000) } });
    const app = { prisma } as FastifyInstance;
    const [sentLeft, sentRight] = await Promise.all([dispatchDueReminders(app, user.id), dispatchDueReminders(app, user.id)]);
    assert.equal(sentLeft + sentRight, 1);
    assert.equal(await prisma.notification.count({ where: { userId: user.id, kind: "reminder" } }), 1);
    assert.equal((await prisma.reminder.findUnique({ where: { id: reminder.id } }))?.notificationSequence, 1);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: user.id } });
    await prisma.watcher.deleteMany({ where: { userId: user.id } });
    await prisma.reminder.deleteMany({ where: { userId: user.id } });
    await prisma.undoEntry.deleteMany({ where: { userId: user.id } });
    await prisma.syncState.deleteMany({ where: { userId: user.id } });
    await prisma.task.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
});
