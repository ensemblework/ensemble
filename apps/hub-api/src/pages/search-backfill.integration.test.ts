/**
 * Startup indexing of pages the migration left with search_text NULL.
 * Skips when Postgres is not reachable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import "../config.js";
import { bridgeRoutes } from "../bridge/routes.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { miscRoutes } from "../routes/misc.js";
import { pageRoutes } from "../routes/pages.js";
import "../types.js";
import { searchHub } from "../bridge/service.js";
import { backfillPageSearchText } from "./search-backfill.js";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function doc(text: string) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

async function user(label: string) {
  return prisma.user.create({
    data: { email: `backfill-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@ensemble.test`, name: label },
  });
}

test.after(async () => {
  await prisma.$disconnect().catch(() => undefined);
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
});

let backfillTail: Promise<unknown> = Promise.resolve();

function oneBackfillAtATime<T>(run: () => Promise<T>): Promise<T> {
  const next = backfillTail.then(run, run);
  backfillTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

test("/health/ready returns 200 while the page search backfill is still running", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  return oneBackfillAtATime(() => readyWhileBackfillRuns());
});

async function readyWhileBackfillRuns() {
  const owner = await user("ready");
  const word = `readybody${owner.id.slice(0, 8)}`;
  const page = await prisma.taskPage.create({
    data: {
      userId: owner.id,
      title: "Waiting",
      content: doc(word),
      notesSnapshot: "ready-notes-not-body",
      searchText: null,
    },
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previousRuntime = process.env.ENSEMBLE_INPROCESS_RUNTIME;
  process.env.ENSEMBLE_INPROCESS_RUNTIME = "1";
  const app = Fastify();
  await app.register(miscRoutes);
  const pending = backfillPageSearchText(prisma, { pauseMs: 0, log: { warn() {} }, gate: () => held });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(ready.statusCode, 200);
    const mid = await prisma.taskPage.findUniqueOrThrow({ where: { id: page.id } });
    assert.equal(mid.searchText, null);
    release();
    await pending;
    const done = await prisma.taskPage.findUniqueOrThrow({ where: { id: page.id } });
    assert.match(done.searchText ?? "", new RegExp(word));
    assert.doesNotMatch(done.searchText ?? "", /ready-notes-not-body/);
  } finally {
    release();
    if (previousRuntime === undefined) delete process.env.ENSEMBLE_INPROCESS_RUNTIME;
    else process.env.ENSEMBLE_INPROCESS_RUNTIME = previousRuntime;
    await pending.catch(() => undefined);
    await app.close();
    await prisma.taskPage.deleteMany({ where: { userId: owner.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  }
}

test("a save during the page search backfill keeps the saved text", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  return oneBackfillAtATime(() => saveDuringBackfill());
});

async function saveDuringBackfill() {
  const owner = await user("race");
  const oldWord = `oldbody${owner.id.slice(0, 8)}`;
  const liveWord = `livebody${owner.id.slice(0, 8)}`;
  const page = await prisma.taskPage.create({
    data: {
      userId: owner.id,
      title: "Race",
      content: doc(oldWord),
      searchText: null,
      revision: 1,
    },
  });
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.addHook("onRequest", async (request) => {
    request.userId = owner.id;
  });
  await app.register(pageRoutes);
  try {
    const result = await backfillPageSearchText(prisma, {
      pauseMs: 0,
      batchSize: 50,
      log: { warn() {} },
      beforeWrite: async (row) => {
        if (row.id !== page.id) return;
        const saved = await app.inject({
          method: "PUT",
          url: `/api/pages/${page.id}`,
          payload: { revision: 1, content: doc(liveWord) },
        });
        assert.equal(saved.statusCode, 200);
      },
    });
    assert.equal(result.updated >= 0, true);
    const after = await prisma.taskPage.findUniqueOrThrow({ where: { id: page.id } });
    assert.match(after.searchText ?? "", new RegExp(liveWord));
    assert.doesNotMatch(after.searchText ?? "", new RegExp(oldWord));
  } finally {
    await app.close();
    await prisma.taskPage.deleteMany({ where: { userId: owner.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  }
}

test("a malformed page is findable by its title, and the next run does not read it", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  return oneBackfillAtATime(() => malformedMarkedByTitle());
});

async function malformedMarkedByTitle() {
  const owner = await user("malformed");
  const title = `Broken title ${owner.id.slice(0, 8)}`;
  const page = await prisma.taskPage.create({
    data: {
      userId: owner.id,
      title,
      content: { type: "nope" },
      notesSnapshot: "malformed-notes-not-indexed",
      searchText: null,
    },
  });
  const warnings: string[] = [];
  const log = {
    warn(_obj: unknown, msg?: string) {
      warnings.push(msg ?? "");
    },
  };
  try {
    const first = await backfillPageSearchText(prisma, { pauseMs: 0, log });
    assert.ok(first.skipped >= 1);
    const stored = await prisma.taskPage.findUniqueOrThrow({ where: { id: page.id } });
    assert.equal(stored.searchText, title);
    assert.doesNotMatch(stored.searchText ?? "", /malformed-notes-not-indexed/);
    const found = await searchHub(prisma, owner.id, title, 10);
    assert.equal(found.results.some((row) => row.id === page.id && row.kind === "page"), true);
    warnings.length = 0;
    const second = await backfillPageSearchText(prisma, { pauseMs: 0, log });
    assert.equal(second.updated, 0);
    assert.equal(second.skipped, 0);
    assert.deepEqual(warnings, []);
  } finally {
    await prisma.taskPage.deleteMany({ where: { userId: owner.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  }
}

test("bridge read rejects an unknown kind and names page as allowed", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.addHook("onRequest", async (request) => {
    request.userId = "bridge-kind";
    request.authVia = "session";
  });
  await app.register(bridgeRoutes);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/bridge/read?kind=nope&id=00000000-0000-4000-8000-000000000000",
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /kind must be one of:/);
    assert.match(response.json().error, /\bpage\b/);
  } finally {
    await app.close();
  }
});
