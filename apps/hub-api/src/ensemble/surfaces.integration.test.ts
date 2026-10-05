/**
 * Every surface read is scoped to the invoking user.
 * Skips when Postgres is not reachable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import "../config.js";
import { prisma } from "../lib/prisma.js";
import { undoLast } from "../lib/undo.js";
import { SURFACE_IDS, loadSurfaceContext } from "./surfaces.js";
import { createWatcher, evaluateWatchers } from "./watchers.js";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

test("surface providers hide another user's rows, and watchers fire only inside their condition", async (t) => {
  if (!(await databaseReady())) {
    t.skip("Postgres is not reachable");
    return;
  }
  const stamp = Date.now().toString(36);
  const owner = await prisma.user.create({ data: { email: `surf-a-${stamp}@ensemble.test`, name: "Owner" } });
  const other = await prisma.user.create({ data: { email: `surf-b-${stamp}@ensemble.test`, name: "Other" } });
  const secret = `secret-${stamp}`;
  const project = await prisma.project.create({ data: { userId: other.id, name: `other-${stamp}`, createdBy: "me" } });
  const deliverable = await prisma.deliverable.create({
    data: { userId: owner.id, projectId: (await prisma.project.create({ data: { userId: owner.id, name: `mine-${stamp}`, createdBy: "me" } })).id, title: `Brief ${stamp}`, notes: "File the memo.", due: new Date(Date.now() + 86_400_000), createdBy: "me" },
  });
  const mine = await prisma.task.create({
    data: { userId: owner.id, title: `mine-${stamp}`, status: "done", deliverableId: deliverable.id, due: new Date(Date.now() + 86_400_000), createdBy: "me" },
  });
  const foreign = await prisma.task.create({ data: { userId: other.id, title: secret, status: "todo", createdBy: "me" } });
  const foreignDeleted = await prisma.task.create({
    data: { userId: other.id, title: `${secret}-trash`, status: "todo", deletedAt: new Date(), createdBy: "me" },
  });
  const foreignRecord = await prisma.completionRecord.create({
    data: { userId: other.id, entityKind: "task", entityId: foreign.id, title: secret, outcome: "done", projectId: project.id },
  });
  const foreignComment = await prisma.pageDiscussion.create({
    data: {
      userId: other.id,
      pageKind: "task",
      pageId: foreign.id,
      sourceKind: "task",
      sourceId: foreign.id,
      kind: "comment",
      body: { text: secret },
      quote: secret,
    },
  });
  try {
    for (const surface of SURFACE_IDS) {
      const entityIds =
        surface === "deliverable"
          ? [deliverable.id, foreign.id]
          : surface === "comment"
            ? [foreignComment.id]
            : surface === "trash"
              ? [foreignDeleted.id]
              : surface === "completed"
                ? [foreignRecord.id]
                : [foreign.id];
      const context = await loadSurfaceContext(prisma, owner.id, {
        surface,
        entityIds,
        projectId: surface === "completed" ? project.id : undefined,
        codeText: surface === "code" ? "const answer = 1;" : undefined,
        path: surface === "code" ? "line.ts" : undefined,
        line: surface === "code" ? 1 : undefined,
        selection: surface === "page" ? "selected clause" : undefined,
      });
      assert.equal(context.facts.includes(secret), false, surface);
      assert.ok(context.hiddenIds.length > 0, surface);
      if (surface === "deliverable") {
        assert.ok(context.entities.some((entity) => entity.id === deliverable.id));
        assert.ok(context.scopes.some((scope) => scope.id === deliverable.id));
      }
      if (surface === "code") assert.match(context.facts, /const answer = 1/);
    }

    const graph = await loadSurfaceContext(prisma, owner.id, { surface: "graph", entityIds: [mine.id, foreign.id] });
    assert.ok(graph.entities.some((entity) => entity.id === mine.id));
    assert.ok(graph.hiddenIds.includes(foreign.id));

    const watcher = await prisma.$transaction((tx) =>
      createWatcher(tx, owner.id, {
        scopeKind: "deliverable",
        scopeId: deliverable.id,
        condition: "all_tasks_done",
        daysBefore: null,
        message: "All done",
        actor: "me",
      }),
    );
    const fired = await evaluateWatchers(prisma, owner.id);
    assert.equal(fired, 1);
    assert.equal((await prisma.watcher.findUnique({ where: { id: watcher.id } }))?.status, "fired");
    assert.ok(await prisma.notification.findFirst({ where: { userId: owner.id, kind: "watcher" } }));

    const later = await prisma.task.create({
      data: { userId: owner.id, title: `later-${stamp}`, due: new Date(Date.now() + 20 * 86_400_000), createdBy: "me" },
    });
    const quiet = await prisma.$transaction((tx) =>
      createWatcher(tx, owner.id, {
        scopeKind: "task",
        scopeId: later.id,
        condition: "days_before_due",
        daysBefore: 2,
        message: "Too early",
        actor: "me",
      }),
    );
    assert.equal(await evaluateWatchers(prisma, owner.id), 0);
    assert.equal((await prisma.watcher.findUnique({ where: { id: quiet.id } }))?.status, "active");

    const soon = await prisma.task.create({
      data: { userId: owner.id, title: `soon-${stamp}`, due: new Date(Date.now() + 86_400_000), createdBy: "me" },
    });
    const due = await prisma.$transaction((tx) =>
      createWatcher(tx, owner.id, {
        scopeKind: "task",
        scopeId: soon.id,
        condition: "days_before_due",
        daysBefore: 2,
        message: "Due soon",
        actor: "me",
      }),
    );
    assert.equal(await evaluateWatchers(prisma, owner.id), 1);
    await assert.rejects(() => undoLast(prisma, owner.id), /changed since/);
    assert.equal((await prisma.watcher.findUnique({ where: { id: due.id } }))?.status, "fired");
    const quietEntry = await prisma.undoEntry.findFirst({ where: { userId: owner.id, label: { contains: "Too early" } } });
    assert.ok(quietEntry);
    const undone = await undoLast(prisma, owner.id, quietEntry.id);
    assert.ok(undone);
    assert.equal((await prisma.watcher.findUnique({ where: { id: quiet.id } }))?.status, "cancelled");
  } finally {
    await prisma.notification.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.watcher.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.undoEntry.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.auditLedger.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.pageDiscussion.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.completionRecord.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.task.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.deliverable.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.project.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
  }
});
