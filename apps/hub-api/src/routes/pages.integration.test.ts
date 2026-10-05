/**
 * Standalone notes: same page rows as linked pages, with no task.
 * Skips when Postgres is not reachable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Settings } from "@ensemble/shared-types";
import { ZodError } from "zod";
import "../config.js";
import { getTool } from "../assistant/registry.js";
import type { ToolContext } from "../assistant/types.js";
import { listProjects, listTasks, readItem, searchHub } from "../bridge/service.js";
import { prisma } from "../lib/prisma.js";
import { boardRoutes } from "./board.js";
import { pageRoutes } from "./pages.js";
import { systemRoutes } from "./system.js";
import { taskRoutes } from "./tasks.js";
import "../types.js";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function user(label: string) {
  return prisma.user.create({
    data: { email: `pages-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@ensemble.test`, name: label },
  });
}

async function appFor(userId: string) {
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.addHook("onRequest", async (request) => {
    request.userId = userId;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: error.issues.map((issue) => issue.message).join("; ") });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(statusCode).send({ error: message });
  });
  await app.register(taskRoutes);
  await app.register(pageRoutes);
  await app.register(boardRoutes);
  await app.register(systemRoutes);
  return app;
}

function doc(text: string) {
  return { type: "doc", content: text ? [{ type: "paragraph", content: [{ type: "text", text }] }] : [{ type: "paragraph" }] };
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

async function cleanup(ids: string[]) {
  await prisma.taskPage.deleteMany({ where: { userId: { in: ids } } });
  await prisma.deliverable.deleteMany({ where: { userId: { in: ids } } });
  await prisma.task.deleteMany({ where: { userId: { in: ids } } });
  await prisma.project.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

test("standalone pages list newest first and support create, rename, and delete", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner");
  const app = await appFor(owner.id);
  try {
    const first = await app.inject({ method: "POST", url: "/api/pages" });
    assert.equal(first.statusCode, 201);
    const older = first.json().page as { id: string; title: string };
    assert.equal(older.title, "Untitled");
    await prisma.$executeRaw`UPDATE task_pages SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ${older.id}`;

    const second = await app.inject({ method: "POST", url: "/api/pages" });
    assert.equal(second.statusCode, 201);
    const newer = second.json().page as { id: string; title: string };
    assert.equal(newer.title, "Untitled");

    const listed = await app.inject({ method: "GET", url: "/api/pages" });
    assert.equal(listed.statusCode, 200);
    const ids = (listed.json().pages as Array<{ id: string }>).map((row) => row.id);
    assert.deepEqual(ids, [newer.id, older.id]);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/pages/${older.id}`,
      payload: { title: "Renamed note" },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().page.title, "Renamed note");
    const afterRename = (await app.inject({ method: "GET", url: "/api/pages" })).json().pages as Array<{ id: string; title: string }>;
    assert.equal(afterRename[0]?.id, older.id);
    assert.equal(afterRename[0]?.title, "Renamed note");
    assert.equal(afterRename[1]?.id, newer.id);

    const unique = `retitled-${older.id.slice(0, 8)}`;
    const retitled = await app.inject({
      method: "PATCH",
      url: `/api/pages/${older.id}`,
      payload: { title: unique },
    });
    assert.equal(retitled.statusCode, 200);
    const oldTitle = await searchHub(prisma, owner.id, "Renamed note", 10);
    assert.equal(oldTitle.results.some((row) => row.id === older.id), false);
    const newTitle = await searchHub(prisma, owner.id, unique, 10);
    assert.equal(newTitle.results.some((row) => row.id === older.id && row.kind === "page"), true);

    const opened = await app.inject({ method: "GET", url: `/api/pages/${older.id}` });
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.json().title, unique);
    assert.equal(opened.json().taskId, null);

    const removed = await app.inject({ method: "DELETE", url: `/api/pages/${older.id}` });
    assert.equal(removed.statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: `/api/pages/${older.id}` })).statusCode, 404);
    const remaining = (await app.inject({ method: "GET", url: "/api/pages" })).json().pages as Array<{ id: string }>;
    assert.deepEqual(remaining.map((row) => row.id), [newer.id]);
    assert.equal(await prisma.task.count({ where: { userId: owner.id } }), 0);
  } finally {
    await app.close();
    await cleanup([owner.id]);
  }
});

test("another account cannot open, rename, delete, or list a standalone page, and delete leaves linked pages alone", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner");
  const other = await user("other");
  const own = await appFor(owner.id);
  const theirs = await appFor(other.id);
  try {
    const created = await own.inject({ method: "POST", url: "/api/pages" });
    const page = created.json().page as { id: string };
    const hidden = await theirs.inject({ method: "GET", url: "/api/pages" });
    assert.equal(hidden.json().pages.some((row: { id: string }) => row.id === page.id), false);
    assert.equal((await theirs.inject({ method: "GET", url: `/api/pages/${page.id}` })).statusCode, 404);
    assert.equal((await theirs.inject({ method: "PATCH", url: `/api/pages/${page.id}`, payload: { title: "Stolen" } })).statusCode, 404);
    assert.equal(
      (await theirs.inject({ method: "PUT", url: `/api/pages/${page.id}`, payload: { revision: 1, content: doc("nope") } })).statusCode,
      404,
    );
    assert.equal((await theirs.inject({ method: "DELETE", url: `/api/pages/${page.id}` })).statusCode, 404);
    assert.equal((await own.inject({ method: "GET", url: `/api/pages/${page.id}` })).statusCode, 200);

    const task = await prisma.task.create({ data: { userId: owner.id, title: "Stays on the board", createdBy: "me" } });
    const saved = await own.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/page`,
      payload: { revision: 0, content: doc("linked body") },
    });
    assert.equal(saved.statusCode, 200);
    const linked = await prisma.taskPage.findFirst({ where: { taskId: task.id, userId: owner.id } });
    assert.ok(linked);
    assert.equal((await own.inject({ method: "DELETE", url: `/api/pages/${linked.id}` })).statusCode, 404);
    assert.equal((await theirs.inject({ method: "DELETE", url: `/api/pages/${linked.id}` })).statusCode, 404);
    assert.equal((await theirs.inject({ method: "GET", url: `/api/tasks/${task.id}/page` })).statusCode, 404);
    const still = await prisma.task.findFirst({ where: { id: task.id, userId: owner.id, deletedAt: null } });
    const stillPage = await prisma.taskPage.findFirst({ where: { id: linked.id, taskId: task.id } });
    assert.ok(still);
    assert.ok(stillPage);
    const board = await own.inject({ method: "GET", url: "/api/tasks" });
    assert.equal(board.json().tasks.some((row: { id: string; title: string }) => row.id === task.id && row.title === "Stays on the board"), true);
    assert.equal(board.json().tasks.some((row: { id: string }) => row.id === page.id), false);
  } finally {
    await own.close();
    await theirs.close();
    await cleanup([owner.id, other.id]);
  }
});

test("standalone pages never show up as tasks, projects, or deliverables", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner");
  const app = await appFor(owner.id);
  const token = `quark-page-${owner.id.slice(0, 8)}`;
  try {
    const project = await prisma.project.create({ data: { userId: owner.id, name: "Project beta", createdBy: "me" } });
    await prisma.deliverable.create({ data: { userId: owner.id, projectId: project.id, title: "Deliverable delta" } });
    await prisma.task.create({ data: { userId: owner.id, title: "Board card alpha", createdBy: "me" } });
    const created = await app.inject({ method: "POST", url: "/api/pages" });
    const page = created.json().page as { id: string };
    const renamed = await app.inject({ method: "PATCH", url: `/api/pages/${page.id}`, payload: { title: "Standalone gamma note" } });
    assert.equal(renamed.statusCode, 200);
    const opened = await app.inject({ method: "GET", url: `/api/pages/${page.id}` });
    const saved = await app.inject({
      method: "PUT",
      url: `/api/pages/${page.id}`,
      payload: { revision: opened.json().revision, content: doc(token) },
    });
    assert.equal(saved.statusCode, 200);

    const tasks = await app.inject({ method: "GET", url: "/api/tasks" });
    const taskRows = tasks.json().tasks as Array<{ id: string; title: string }>;
    assert.equal(taskRows.some((row) => row.id === page.id || row.title === "Standalone gamma note"), false);
    assert.equal(taskRows.some((row) => row.title === "Board card alpha"), true);

    const deliverables = await app.inject({ method: "GET", url: "/api/deliverables" });
    const deliverableRows = deliverables.json().deliverables as Array<{ id: string; title: string }>;
    assert.equal(deliverableRows.some((row) => row.id === page.id || row.title.includes("gamma") || row.title.includes(token)), false);

    const taskSearch = await listTasks(prisma, owner.id, { q: token, limit: 20 });
    assert.equal(taskSearch.tasks.some((row) => row.id === page.id), false);
    const projectSearch = await listProjects(prisma, owner.id, { q: token, limit: 20 });
    assert.equal(projectSearch.projects.some((row) => row.id === page.id), false);
    const titleSearch = await listTasks(prisma, owner.id, { q: "Standalone gamma note", limit: 20 });
    assert.equal(titleSearch.tasks.length, 0);

    const listTool = getTool("hub_list_tasks");
    assert.ok(listTool);
    const listed = await listTool.run(ctx(owner.id), listTool.input.parse({ query: token }));
    const assistantTasks = (listed.data as { tasks: Array<{ id: string }> }).tasks;
    assert.equal(assistantTasks.some((row) => row.id === page.id), false);

    const found = await searchHub(prisma, owner.id, token, 10);
    assert.equal(found.results.some((row) => row.id === page.id && row.kind === "page"), true);
    assert.equal(found.results.some((row) => row.id === page.id && (row.kind === "task" || row.kind === "project" || row.kind === "deliverable")), false);
  } finally {
    await app.close();
    await cleanup([owner.id]);
  }
});

test("context search finds a standalone note, follows edits, drops it on delete, and hides it from other accounts", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner");
  const other = await user("other");
  const app = await appFor(owner.id);
  const fresh = `alpha-zebra-${owner.id.slice(0, 8)}`;
  const edited = `beta-quartz-${owner.id.slice(0, 8)}`;
  try {
    const created = await app.inject({ method: "POST", url: "/api/pages" });
    const page = created.json().page as { id: string };
    const opened = await app.inject({ method: "GET", url: `/api/pages/${page.id}` });
    const saved = await app.inject({
      method: "PUT",
      url: `/api/pages/${page.id}`,
      payload: { revision: opened.json().revision, content: doc(fresh) },
    });
    assert.equal(saved.statusCode, 200);

    const hit = await searchHub(prisma, owner.id, fresh, 10);
    assert.equal(hit.results.some((row) => row.id === page.id && row.kind === "page" && String(row.excerpt).includes(fresh)), true);
    const foreign = await searchHub(prisma, other.id, fresh, 10);
    assert.equal(foreign.results.some((row) => row.id === page.id || String(row.excerpt).includes(fresh)), false);
    const foreignRead = await readItem(prisma, other.id, "page", page.id, 0, 4000);
    assert.equal(foreignRead.found, false);

    const again = await app.inject({
      method: "PUT",
      url: `/api/pages/${page.id}`,
      payload: { revision: saved.json().revision, content: doc(edited) },
    });
    assert.equal(again.statusCode, 200);
    const stale = await searchHub(prisma, owner.id, fresh, 10);
    assert.equal(stale.results.some((row) => row.id === page.id || String(row.excerpt).includes(fresh)), false);
    const current = await searchHub(prisma, other.id, edited, 10);
    assert.equal(current.results.length, 0);
    const updated = await searchHub(prisma, owner.id, edited, 10);
    assert.equal(updated.results.some((row) => row.id === page.id && String(row.excerpt).includes(edited)), true);

    assert.equal((await app.inject({ method: "DELETE", url: `/api/pages/${page.id}` })).statusCode, 204);
    const gone = await searchHub(prisma, owner.id, edited, 10);
    assert.equal(gone.results.some((row) => row.id === page.id || String(row.excerpt).includes(edited)), false);
  } finally {
    await app.close();
    await cleanup([owner.id, other.id]);
  }
});

test("linked page edits replace context search text, and deleting the task removes the page from search", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner");
  const app = await appFor(owner.id);
  const fresh = `linked-violet-${owner.id.slice(0, 8)}`;
  const edited = `linked-amber-${owner.id.slice(0, 8)}`;
  try {
    const task = await prisma.task.create({ data: { userId: owner.id, title: "Linked writeup", createdBy: "me" } });
    const saved = await app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/page`,
      payload: { revision: 0, content: doc(fresh) },
    });
    assert.equal(saved.statusCode, 200);
    const page = await prisma.taskPage.findFirstOrThrow({ where: { taskId: task.id } });
    const hit = await searchHub(prisma, owner.id, fresh, 10);
    assert.equal(hit.results.some((row) => row.id === page.id && row.kind === "page"), true);
    await prisma.taskPage.update({
      where: { id: page.id },
      data: { searchText: `sentinel-not-the-body-${owner.id.slice(0, 8)}`, notesSnapshot: `notes-not-the-body-${owner.id.slice(0, 8)}` },
    });
    const read = await readItem(prisma, owner.id, "page", page.id, 0, 4000);
    assert.equal(read.found, true);
    if (read.found) {
      const body = (read.item.body as { text: string }).text;
      assert.match(body, new RegExp(fresh));
      assert.doesNotMatch(body, /sentinel-not-the-body/);
      assert.doesNotMatch(body, /notes-not-the-body/);
    }

    const next = await app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/page`,
      payload: { revision: saved.json().revision, content: doc(edited) },
    });
    assert.equal(next.statusCode, 200);
    const stale = await searchHub(prisma, owner.id, fresh, 10);
    assert.equal(stale.results.some((row) => row.id === page.id), false);
    const current = await searchHub(prisma, owner.id, edited, 10);
    assert.equal(current.results.some((row) => row.id === page.id && row.kind === "page"), true);

    const removed = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}` });
    assert.equal(removed.statusCode, 200);
    const after = await searchHub(prisma, owner.id, edited, 10);
    assert.equal(after.results.some((row) => row.id === page.id || row.id === task.id), false);
    const board = await app.inject({ method: "GET", url: "/api/tasks" });
    assert.equal(board.json().tasks.some((row: { id: string }) => row.id === task.id), false);
  } finally {
    await app.close();
    await cleanup([owner.id]);
  }
});

test("delete everything removes standalone notes and linked pages from the list, GET, and context search", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner");
  const app = await appFor(owner.id);
  const noteWord = `wipe-note-${owner.id.slice(0, 8)}`;
  const linkedWord = `wipe-linked-${owner.id.slice(0, 8)}`;
  try {
    const created = await app.inject({ method: "POST", url: "/api/pages" });
    assert.equal(created.statusCode, 201);
    const note = created.json().page as { id: string };
    const opened = await app.inject({ method: "GET", url: `/api/pages/${note.id}` });
    const saved = await app.inject({
      method: "PUT",
      url: `/api/pages/${note.id}`,
      payload: { revision: opened.json().revision, content: doc(noteWord) },
    });
    assert.equal(saved.statusCode, 200);

    const task = await prisma.task.create({ data: { userId: owner.id, title: "Linked and wiped", createdBy: "me" } });
    const linked = await app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/page`,
      payload: { revision: 0, content: doc(linkedWord) },
    });
    assert.equal(linked.statusCode, 200);
    const linkedPage = await prisma.taskPage.findFirstOrThrow({ where: { taskId: task.id } });

    const wiped = await app.inject({
      method: "POST",
      url: "/api/data/delete",
      payload: { scope: "everything", confirm: "you@ensemble.local" },
    });
    assert.equal(wiped.statusCode, 200);

    const list = await app.inject({ method: "GET", url: "/api/pages" });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().pages, []);
    assert.equal((await app.inject({ method: "GET", url: `/api/pages/${note.id}` })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/api/tasks/${task.id}/page` })).statusCode, 404);
    assert.equal(await prisma.taskPage.count({ where: { userId: owner.id } }), 0);
    const noteSearch = await searchHub(prisma, owner.id, noteWord, 10);
    const linkedSearch = await searchHub(prisma, owner.id, linkedWord, 10);
    assert.equal(noteSearch.results.some((row) => row.id === note.id || String(row.excerpt).includes(noteWord)), false);
    assert.equal(linkedSearch.results.some((row) => row.id === linkedPage.id || String(row.excerpt).includes(linkedWord)), false);
  } finally {
    await app.close();
    await cleanup([owner.id]);
  }
});

test("two saves at the same revision: one lands, the other is a conflict, and a racing rename keeps both", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("race");
  const app = await appFor(owner.id);
  try {
    const page = (await app.inject({ method: "POST", url: "/api/pages" })).json().page as { id: string };
    const url = `/api/pages/${page.id}`;
    const [a, b] = await Promise.all([
      app.inject({ method: "PUT", url, payload: { revision: 1, content: doc("from tab A") } }),
      app.inject({ method: "PUT", url, payload: { revision: 1, content: doc("from tab B") } }),
    ]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    const winner = a.statusCode === 200 ? "from tab A" : "from tab B";

    await Promise.all([
      app.inject({ method: "PATCH", url, payload: { title: "Race notes" } }),
      app.inject({ method: "PUT", url, payload: { revision: 2, content: doc("third draft") } }),
    ]);
    const row = await prisma.taskPage.findUniqueOrThrow({ where: { id: page.id } });
    assert.equal(row.title, "Race notes");
    assert.equal(row.revision, 3);
    assert.match(row.searchText ?? "", /Race notes/);
    assert.match(row.searchText ?? "", /third draft/);
    assert.equal((row.searchText ?? "").includes(winner), false);
  } finally {
    await app.close();
    await prisma.user.delete({ where: { id: owner.id } }).catch(() => {});
  }
});
