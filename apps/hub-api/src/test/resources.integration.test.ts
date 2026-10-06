import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import { createHttpHarness, type HttpUser } from "./http.js";
import { MISSING_ID, type HttpMethod } from "../lib/route-inventory.js";
import { resourceRouteCoverage as routeCoverage, type RouteCheck } from "./route-coverage.js";

const harness = await createHttpHarness();
const a = await harness.asUser();
const b = await harness.asUser();
const covered = new Map<string, Set<RouteCheck>>();
after(async () => {
  try {
    for (const [route, checks] of Object.entries(routeCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted coverage claim: ${check} ${route}`);
    }
  } finally {
    await harness.close();
  }
});

function pattern(path: string): string {
  return path.split("?")[0]!
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":id")
    .replace(/^\/api\/pages\/[^/]+\/:id\//, "/api/pages/:kind/:id/")
    .replace(/^\/api\/preferences\/[^/]+$/, "/api/preferences/:key")
    .replace(/^\/api\/layouts\/[^/]+/, "/api/layouts/:surface");
}

function track(method: HttpMethod, url: string, category: RouteCheck): void {
  const key = `${method} ${pattern(url)}`;
  const checks = covered.get(key) ?? new Set<RouteCheck>();
  checks.add(category);
  covered.set(key, checks);
}

async function check(user: HttpUser, method: HttpMethod, url: string, expected: number, category: RouteCheck, payload?: unknown, internal = false) {
  const options: InjectOptions = { method, url, ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { "content-type": "application/json" } }) };
  const response = internal ? await harness.internal(user, options) : await user.inject(options);
  assert.equal(response.statusCode, expected, `${category} ${method} ${url}: ${response.body}`);
  track(method, url, category);
  return response.body ? (String(response.headers["content-type"]).includes("json") ? response.json() : response.body) : null;
}

async function created(path: string, field: string, body?: unknown): Promise<string> {
  const response = await check(a, "POST", path, 201, "happy-path", body);
  assert.equal(typeof response[field].id, "string");
  return response[field].id;
}

async function hidden(method: HttpMethod, path: string, body?: unknown, internal = false) {
  await check(b, method, path, 404, "isolation", body, internal);
  await check(a, method, path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, MISSING_ID), 404, "unknown-id", body, internal);
}

test("task CRUD, page, board and nested histories are private and preserve owner writes", async () => {
  const id = await created("/api/tasks", "task", { title: "Private task" });
  assert.equal((await check(a, "GET", `/api/tasks/${id}`, 200, "happy-path")).task.title, "Private task");
  assert.ok((await check(a, "GET", "/api/tasks", 200, "happy-path")).tasks.some((row: { id: string }) => row.id === id));
  assert.ok(!(await check(b, "GET", "/api/tasks", 200, "isolation")).tasks.some((row: { id: string }) => row.id === id));
  await hidden("GET", `/api/tasks/${id}`);
  await hidden("PATCH", `/api/tasks/${id}`, { title: "Stolen" });
  assert.equal((await check(a, "PATCH", `/api/tasks/${id}`, 200, "happy-path", { title: "Changed" })).task.title, "Changed");
  const page = { revision: 0, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Private notes" }] }] } };
  await hidden("GET", `/api/tasks/${id}/page`);
  await hidden("PUT", `/api/tasks/${id}/page`, page);
  assert.equal((await check(a, "GET", `/api/tasks/${id}/page`, 200, "happy-path")).taskId, id);
  assert.equal((await check(a, "PUT", `/api/tasks/${id}/page`, 200, "happy-path", page)).revision, 1);
  await check(a, "PUT", `/api/tasks/${id}/page`, 400, "invalid-input", { revision: "bad", content: [] });
  await hidden("POST", `/api/tasks/${id}/move`, { status: "todo" });
  assert.equal((await check(a, "POST", `/api/tasks/${id}/move`, 200, "happy-path", { status: "todo" })).task.status, "todo");
  await check(a, "POST", `/api/tasks/${id}/move`, 400, "invalid-input", { status: "bogus" });
  for (const suffix of ["transitions", "runs"]) {
    await hidden("GET", `/api/tasks/${id}/${suffix}`);
    const history = await check(a, "GET", `/api/tasks/${id}/${suffix}`, 200, "happy-path");
    assert.ok(Array.isArray(history[suffix]));
  }
  await check(a, "POST", "/api/tasks", 400, "invalid-input", { title: 42 });
  await check(a, "PATCH", `/api/tasks/${id}`, 400, "invalid-input", { priority: "invalid" });
  await hidden("DELETE", `/api/tasks/${id}`);
  await check(a, "DELETE", `/api/tasks/${id}`, 200, "happy-path");
  await check(a, "GET", `/api/tasks/${id}`, 404, "unknown-id");
});

test("projects, people and repos reject foreign reads/writes and preserve CRUD", async () => {
  const families = [
    { path: "/api/projects", field: "project", body: { name: "Private project" }, patch: { summary: "updated" }, bad: { name: 4 }, read: true },
    { path: "/api/people", field: "person", body: { name: "Private person" }, patch: { role: "updated" }, bad: { name: 4 }, read: false },
    { path: "/api/repos", field: "repo", body: { fullName: "fictional/private" }, patch: { description: "updated" }, bad: { fullName: false, tracked: "wrong" }, read: false },
  ];
  for (const family of families) {
    const id = await created(family.path, family.field, family.body);
    const listKey = family.path.slice("/api/".length);
    assert.ok((await check(a, "GET", family.path, 200, "happy-path"))[listKey].some((row: { id: string }) => row.id === id));
    assert.ok(!(await check(b, "GET", family.path, 200, "isolation"))[listKey].some((row: { id: string }) => row.id === id));
    if (family.read) {
      await hidden("GET", `${family.path}/${id}`);
      assert.equal((await check(a, "GET", `${family.path}/${id}`, 200, "happy-path"))[family.field].id, id);
    }
    await hidden("PATCH", `${family.path}/${id}`, family.patch);
    await check(a, "PATCH", `${family.path}/${id}`, 200, "happy-path", family.patch);
    await check(a, "PATCH", `${family.path}/${id}`, 400, "invalid-input", family.path === "/api/repos" ? { tracked: "wrong" } : { name: 4 });
    await check(a, "POST", family.path, 400, "invalid-input", family.bad);
    await hidden("DELETE", `${family.path}/${id}`);
    await check(a, "DELETE", `${family.path}/${id}`, family.path === "/api/repos" ? 200 : 204, "happy-path");
  }
});

test("linked writes cannot cross user boundaries or silently ignore missing neighbors", async () => {
  const ownProject = await created("/api/projects", "project", { name: "Relations" });
  const foreignProject = (await check(b, "POST", "/api/projects", 201, "happy-path", { name: "Foreign" })).project.id;
  const foreignPerson = (await check(b, "POST", "/api/people", 201, "happy-path", { name: "Foreign" })).person.id;
  const foreignRepo = (await check(b, "POST", "/api/repos", 201, "happy-path", { fullName: "fictional/foreign" })).repo.id;
  const foreignTask = (await check(b, "POST", "/api/tasks", 201, "happy-path", { title: "Foreign" })).task.id;
  const foreignSkill = (await check(b, "POST", "/api/skills", 201, "happy-path", { name: "Foreign" })).skill.id;
  const foreignDeliverable = (await check(b, "POST", "/api/deliverables", 201, "happy-path", { title: "Foreign", projectId: foreignProject })).deliverable.id;
  const ownTask = await created("/api/tasks", "task", { title: "Relations" });
  for (const [key, id] of [["projectId", foreignProject], ["repoId", foreignRepo], ["deliverableId", foreignDeliverable], ["people", [foreignPerson]]] as const) {
    if (key === "projectId" || key === "people") await check(a, "POST", "/api/tasks", 404, "relation-isolation", { title: "Illegal", [key]: id });
    await check(a, "PATCH", `/api/tasks/${ownTask}`, 404, "relation-isolation", { [key]: id });
  }
  await check(a, "PATCH", `/api/tasks/${ownTask}`, 404, "relation-isolation", { skillIds: [foreignSkill] });
  await check(a, "PATCH", `/api/tasks/${ownTask}`, 404, "relation-isolation", { skillIds: [MISSING_ID] });
  for (const key of ["beforeId", "afterId"]) {
    await check(a, "POST", `/api/tasks/${ownTask}/move`, 404, "relation-isolation", { status: "todo", [key]: foreignTask });
    await check(a, "POST", `/api/tasks/${ownTask}/move`, 404, "relation-isolation", { status: "todo", [key]: MISSING_ID });
  }
  for (const body of [{ personIds: [foreignPerson] }, { repoIds: [foreignRepo] }, { personIds: [MISSING_ID] }]) {
    await check(a, "PATCH", `/api/projects/${ownProject}`, 404, "relation-isolation", body);
  }
  assert.equal(await harness.prisma.projectPerson.count({ where: { projectId: ownProject } }), 0);
  assert.equal(await harness.prisma.projectRepo.count({ where: { projectId: ownProject } }), 0);
  await check(a, "POST", "/api/deliverables", 404, "relation-isolation", { title: "Illegal", projectId: foreignProject });
  await check(a, "POST", "/api/deliverables", 404, "relation-isolation", { title: "Missing", projectId: MISSING_ID });
});

test("deliverables and reminders have isolated CRUD, and invalid dates are 400", async () => {
  const projectId = await created("/api/projects", "project", { name: "Delivery" });
  const id = await created("/api/deliverables", "deliverable", { title: "Private deliverable", projectId, due: "2030-01-01" });
  assert.ok((await check(a, "GET", "/api/deliverables", 200, "happy-path")).deliverables.some((row: { id: string }) => row.id === id));
  assert.ok(!(await check(b, "GET", "/api/deliverables", 200, "isolation")).deliverables.some((row: { id: string }) => row.id === id));
  await hidden("PATCH", `/api/deliverables/${id}`, { notes: "stolen" });
  assert.equal((await check(a, "PATCH", `/api/deliverables/${id}`, 200, "happy-path", { notes: "updated" })).deliverable.notes, "updated");
  await check(a, "PATCH", `/api/deliverables/${id}`, 400, "invalid-input", { due: "not-a-date" });
  await check(a, "POST", "/api/deliverables", 400, "invalid-input", { title: "bad", projectId, due: "bad" });
  await hidden("DELETE", `/api/deliverables/${id}`);
  await check(a, "DELETE", `/api/deliverables/${id}`, 200, "happy-path");
  const reminder = await created("/api/reminders", "reminder", { title: "Private reminder", dueDate: "2030-01-01", timeZone: "UTC" });
  assert.ok((await check(a, "GET", "/api/reminders", 200, "happy-path")).reminders.some((row: { id: string }) => row.id === reminder));
  assert.ok(!(await check(b, "GET", "/api/reminders", 200, "isolation")).reminders.some((row: { id: string }) => row.id === reminder));
  await hidden("POST", `/api/reminders/${reminder}/dismiss`);
  await check(a, "POST", `/api/reminders/${reminder}/dismiss`, 204, "happy-path");
  await check(a, "POST", "/api/reminders", 400, "invalid-input", { title: "bad", dueDate: "not-a-date" });
  await hidden("DELETE", `/api/reminders/${reminder}`);
  await check(a, "DELETE", `/api/reminders/${reminder}`, 200, "happy-path");
  await check(a, "GET", "/api/calendar?from=bad&to=worse", 400, "invalid-input");
  await check(a, "GET", "/api/calendar?from=2030-01-02&to=2030-01-01", 400, "invalid-input");
  assert.ok(Array.isArray((await check(a, "GET", "/api/calendar?from=2030-01-01&to=2030-02-01", 200, "happy-path")).events));
});

test("comments are scoped to both the author and an owned page; no model call is needed", async () => {
  const task = await created("/api/tasks", "task", { title: "Comment page" });
  const project = await created("/api/projects", "project", { name: "Comment project" });
  const comment = await created(`/api/pages/task/${task}/comments`, "comment", { body: { text: "private" } });
  assert.equal((await check(a, "GET", `/api/pages/task/${task}/comments`, 200, "happy-path")).comments[0].id, comment);
  for (const [kind, id] of [["task", task], ["project", project]]) {
    await hidden("GET", `/api/pages/${kind}/${id}/comments`);
    await hidden("POST", `/api/pages/${kind}/${id}/comments`, { body: { text: "stolen" } });
    await hidden("POST", `/api/pages/${kind}/${id}/ensemble`, { prompt: "stolen" });
    await check(b, "POST", `/api/pages/${kind}/${id}/comments`, 404, "relation-isolation", { body: { text: "stolen" } });
    await check(b, "POST", `/api/pages/${kind}/${id}/ensemble`, 404, "relation-isolation", { prompt: "stolen" });
  }
  const secondTask = await created("/api/tasks", "task", { title: "Other comment page" });
  await check(a, "POST", `/api/pages/task/${secondTask}/ensemble`, 404, "relation-isolation", { prompt: "wrong parent", parentId: comment });
  await check(a, "GET", `/api/pages/unsupported/${task}/comments`, 400, "invalid-input");
  await check(a, "POST", `/api/pages/task/${task}/comments`, 400, "invalid-input", { body: 12 });
  await check(a, "POST", `/api/pages/task/${task}/ensemble`, 400, "invalid-input", { prompt: 12 });
  await hidden("PATCH", `/api/comments/${comment}`, { body: { text: "stolen" } });
  assert.equal((await check(a, "PATCH", `/api/comments/${comment}`, 200, "happy-path", { body: { text: "updated" } })).comment.body.text, "updated");
  await check(a, "PATCH", `/api/comments/${comment}`, 400, "invalid-input", { status: "bogus" });
  await hidden("DELETE", `/api/comments/${comment}`);
  await check(a, "DELETE", `/api/comments/${comment}`, 204, "happy-path");
  assert.equal(await harness.prisma.pageDiscussion.count({ where: { userId: b.id, pageId: task } }), 0);
  assert.equal(await harness.prisma.assistantConversation.count({ where: { userId: b.id } }), 0);
});

test("standalone pages preserve save/read/rename/delete while hiding foreign ids", async () => {
  const id = await created("/api/pages", "page");
  assert.ok((await check(a, "GET", "/api/pages", 200, "happy-path")).pages.some((row: { id: string }) => row.id === id));
  assert.ok(!(await check(b, "GET", "/api/pages", 200, "isolation")).pages.some((row: { id: string }) => row.id === id));
  const body = { revision: 1, content: { type: "doc", content: [] } };
  await hidden("GET", `/api/pages/${id}`);
  await hidden("PATCH", `/api/pages/${id}`, { title: "stolen" });
  await hidden("PUT", `/api/pages/${id}`, body);
  await check(a, "GET", `/api/pages/${id}`, 200, "happy-path");
  assert.equal((await check(a, "PATCH", `/api/pages/${id}`, 200, "happy-path", { title: "Renamed" })).page.title, "Renamed");
  await check(a, "PUT", `/api/pages/${id}`, 200, "happy-path", body);
  await check(a, "PATCH", `/api/pages/${id}`, 400, "invalid-input", { title: false });
  await check(a, "PUT", `/api/pages/${id}`, 400, "invalid-input", { revision: "bad" });
  await hidden("DELETE", `/api/pages/${id}`);
  await check(a, "DELETE", `/api/pages/${id}`, 204, "happy-path");
});

test("runs and internal steps enforce owner isolation and reject invalid status/index", async () => {
  const taskId = await created("/api/tasks", "task", { title: "Run task" });
  const run = await harness.prisma.run.create({ data: { userId: a.id, taskId, worker: "test-worker" } });
  assert.ok((await check(a, "GET", "/api/runs", 200, "happy-path")).runs.some((row: { id: string }) => row.id === run.id));
  assert.ok(!(await check(b, "GET", "/api/runs", 200, "isolation")).runs.some((row: { id: string }) => row.id === run.id));
  await hidden("GET", `/api/runs/${run.id}`);
  assert.equal((await check(a, "GET", `/api/runs/${run.id}`, 200, "happy-path")).run.task.id, taskId);
  await check(a, "GET", "/api/runs?take=-1", 400, "invalid-input");
  await check(a, "GET", "/api/runs?take=1.5", 400, "invalid-input");
  await hidden("POST", `/api/internal/runs/${run.id}/steps`, { index: 0, status: "done" }, true);
  const step = await check(a, "POST", `/api/internal/runs/${run.id}/steps`, 200, "happy-path", { index: 0, status: "done", title: "Safe fixture" }, true);
  assert.equal(step.step.runId, run.id);
  await check(a, "POST", `/api/internal/runs/${run.id}/steps`, 400, "invalid-input", { index: -1, status: "bogus" }, true);
  await check(a, "POST", "/api/internal/ledger", 204, "happy-path", { action: "http.test", taskId, runId: run.id }, true);
  for (const body of [{ taskId }, { runId: run.id }, { taskId: MISSING_ID }, { runId: MISSING_ID }]) {
    await check(b, "POST", "/api/internal/ledger", 404, "relation-isolation", { action: "http.test", ...body }, true);
  }
  await check(a, "POST", "/api/internal/ledger", 400, "invalid-input", { action: 5 }, true);
  await hidden("DELETE", `/api/runs/${run.id}`);
  await check(a, "DELETE", `/api/runs/${run.id}`, 204, "happy-path");
  await check(a, "GET", `/api/runs/${run.id}`, 404, "unknown-id");
});

test("skills have isolated edit/restore/score/delete and malformed input is a client error", async () => {
  const id = await created("/api/skills", "skill", { name: "Private skill" });
  assert.ok((await check(a, "GET", "/api/skills", 200, "happy-path")).skills.some((row: { id: string }) => row.id === id));
  assert.ok(!(await check(b, "GET", "/api/skills", 200, "isolation")).skills.some((row: { id: string }) => row.id === id));
  for (const [method, suffix, body] of [
    ["PATCH", "", { name: "Updated" }],
    ["POST", "/restore", { version: 1 }],
    ["POST", "/score", { draft: "Test draft" }],
  ] as const) {
    await hidden(method, `/api/skills/${id}${suffix}`, body);
    await check(a, method, `/api/skills/${id}${suffix}`, 200, "happy-path", body);
    await check(a, method, `/api/skills/${id}${suffix}`, 400, "invalid-input", suffix === "/restore" ? { version: "bad" } : suffix === "/score" ? { draft: false } : { name: false });
  }
  await check(a, "POST", "/api/skills", 400, "invalid-input", { name: 4 });
  await hidden("DELETE", `/api/skills/${id}`);
  await check(a, "DELETE", `/api/skills/${id}`, 204, "happy-path");
});

test("settings and preferences never overwrite or reveal another account", async () => {
  const beforeB = (await check(b, "GET", "/api/settings", 200, "isolation")).settings;
  const settings = await check(a, "PATCH", "/api/settings", 200, "happy-path", { timezone: "UTC" });
  assert.equal(settings.settings.timezone, "UTC");
  assert.equal((await check(a, "GET", "/api/settings", 200, "happy-path")).settings.timezone, "UTC");
  assert.deepEqual((await check(b, "GET", "/api/settings", 200, "isolation")).settings, beforeB);
  await check(b, "PATCH", "/api/settings", 200, "isolation", { timezone: "Europe/London" });
  assert.equal((await check(a, "GET", "/api/settings", 200, "happy-path")).settings.timezone, "UTC");
  await check(a, "PATCH", "/api/settings", 400, "invalid-input", [1, 2]);
  await check(a, "PATCH", "/api/settings", 400, "invalid-input", { timezone: false });
  await check(a, "PUT", "/api/settings/modules", 400, "invalid-input", { id: 12, on: "yes" });
  await check(a, "PUT", "/api/preferences/http-isolation", 200, "happy-path", { value: { text: "private" } });
  await check(b, "PUT", "/api/preferences/http-isolation", 200, "isolation", { value: { text: "other" } });
  const read = await check(a, "GET", "/api/preferences", 200, "happy-path");
  assert.equal(read.preferences.find((row: { key: string }) => row.key === "http-isolation").value.text, "private");
  const foreign = await check(b, "GET", "/api/preferences", 200, "isolation");
  assert.equal(foreign.preferences.find((row: { key: string }) => row.key === "http-isolation").value.text, "other");
  await check(a, "PUT", "/api/preferences/hub.settings", 400, "invalid-input", { value: {} });
});

test("documents enforce owner ids, private original bytes and owned manual tags", async () => {
  const body = { filename: "private.txt", dataBase64: Buffer.from("Private original").toString("base64"), summarize: false };
  const id = await created("/api/documents", "document", body);
  assert.ok((await check(a, "GET", "/api/documents", 200, "happy-path")).documents.some((row: { id: string }) => row.id === id));
  assert.ok(!(await check(b, "GET", "/api/documents", 200, "isolation")).documents.some((row: { id: string }) => row.id === id));
  for (const suffix of ["text", "original"]) {
    await hidden("GET", `/api/documents/${id}/${suffix}`);
    const result = await check(a, "GET", `/api/documents/${id}/${suffix}`, 200, "happy-path");
    assert.equal(suffix === "text" ? result.text : result, "Private original");
  }
  await hidden("PATCH", `/api/documents/${id}/tags`, { projectIds: [] });
  const ownProject = await created("/api/projects", "project", { name: "Document tags" });
  await check(a, "PATCH", `/api/documents/${id}/tags`, 200, "happy-path", { projectIds: [ownProject] });
  for (const [key, path, field, payload] of [
    ["projectIds", "/api/projects", "project", { name: "Foreign tags" }],
    ["personIds", "/api/people", "person", { name: "Foreign tags" }],
    ["repoIds", "/api/repos", "repo", { fullName: "fictional/foreign-tags" }],
    ["taskIds", "/api/tasks", "task", { title: "Foreign tags" }],
  ] as const) {
    const foreign = (await check(b, "POST", path, 201, "happy-path", payload))[field].id;
    await check(a, "POST", "/api/documents", 404, "relation-isolation", { ...body, tags: { [key]: [foreign] } });
    await check(a, "PATCH", `/api/documents/${id}/tags`, 404, "relation-isolation", { [key]: [foreign] });
  }
  assert.deepEqual((await harness.prisma.document.findUniqueOrThrow({ where: { id } })).projectIds, [ownProject]);
  await check(a, "POST", "/api/documents", 400, "invalid-input", { filename: false });
  await check(a, "PATCH", `/api/documents/${id}/tags`, 400, "invalid-input", { projectIds: false });
  await hidden("DELETE", `/api/documents/${id}`);
  await check(a, "DELETE", `/api/documents/${id}`, 204, "happy-path");
});

test("diagram revisions, SVG, duplicate and link relation writes are private", async () => {
  const id = await created("/api/diagrams", "diagram", { title: "Private diagram" });
  const current = (await check(a, "GET", `/api/diagrams/${id}`, 200, "happy-path")).diagram;
  assert.ok((await check(a, "GET", "/api/diagrams", 200, "happy-path")).diagrams.some((row: { id: string }) => row.id === id));
  assert.ok(!(await check(b, "GET", "/api/diagrams", 200, "isolation")).diagrams.some((row: { id: string }) => row.id === id));
  for (const suffix of ["", "/svg", "/revisions"]) {
    await hidden("GET", `/api/diagrams/${id}${suffix}`);
    const result = await check(a, "GET", `/api/diagrams/${id}${suffix}`, 200, "happy-path");
    if (suffix === "/svg") assert.match(result, /<svg/);
  }
  await hidden("PATCH", `/api/diagrams/${id}`, { version: 1, title: "stolen" });
  await check(a, "PATCH", `/api/diagrams/${id}`, 200, "happy-path", { version: 1, source: current.source, title: "Updated" });
  await hidden("POST", `/api/diagrams/${id}/restore`, { version: 1 });
  await check(a, "POST", `/api/diagrams/${id}/restore`, 200, "happy-path", { version: 1 });
  await hidden("POST", `/api/diagrams/${id}/duplicate`);
  await check(a, "POST", `/api/diagrams/${id}/duplicate`, 201, "happy-path");
  const task = await created("/api/tasks", "task", { title: "Linked diagram" });
  await check(a, "PUT", "/api/diagrams/links", 200, "happy-path", { targetKind: "task", targetId: task, diagramIds: [id] });
  assert.ok((await check(a, "GET", "/api/diagrams/links", 200, "happy-path")).links.some((row: { targetId: string }) => row.targetId === task));
  assert.deepEqual((await check(b, "GET", "/api/diagrams/links", 200, "isolation")).links, []);
  await check(b, "PUT", "/api/diagrams/links", 404, "relation-isolation", { targetKind: "task", targetId: task, diagramIds: [id] });
  const otherDiagram = (await check(b, "POST", "/api/diagrams", 201, "happy-path", {})).diagram.id;
  await check(a, "PUT", "/api/diagrams/links", 404, "relation-isolation", { targetKind: "task", targetId: task, diagramIds: [otherDiagram] });
  await check(a, "POST", "/api/diagrams", 400, "invalid-input", { title: false });
  await check(a, "PATCH", `/api/diagrams/${id}`, 400, "invalid-input", { version: false });
  await check(a, "POST", `/api/diagrams/${id}/restore`, 400, "invalid-input", { version: false });
  await check(a, "PUT", "/api/diagrams/links", 400, "invalid-input", { targetKind: "invalid" });
  await hidden("DELETE", `/api/diagrams/${id}`);
  await check(a, "DELETE", `/api/diagrams/${id}`, 204, "happy-path");
});

test("plots and text datasets have isolated CRUD and cannot link a foreign dataset", async () => {
  const datasetId = await created("/api/plots/datasets", "dataset", { name: "Private CSV", filename: "private.csv", text: "x,y\n1,2\n3,4" });
  const id = await created("/api/plots", "plot", { title: "Private plot", datasetId });
  for (const [path, key, rowId] of [["/api/plots", "plots", id], ["/api/plots/datasets", "datasets", datasetId]]) {
    assert.ok((await check(a, "GET", path!, 200, "happy-path"))[key!].some((row: { id: string }) => row.id === rowId));
    assert.ok(!(await check(b, "GET", path!, 200, "isolation"))[key!].some((row: { id: string }) => row.id === rowId));
    await hidden("GET", `${path}/${rowId}`);
    await check(a, "GET", `${path}/${rowId}`, 200, "happy-path");
  }
  const columns = [{ name: "x", type: "number" }, { name: "y", type: "number" }];
  await hidden("PATCH", `/api/plots/datasets/${datasetId}`, { columns });
  await check(a, "PATCH", `/api/plots/datasets/${datasetId}`, 200, "happy-path", { columns, name: "Updated CSV" });
  await hidden("PATCH", `/api/plots/${id}`, { title: "stolen" });
  await check(a, "PATCH", `/api/plots/${id}`, 200, "happy-path", { title: "Updated plot" });
  const foreign = (await check(b, "POST", "/api/plots/datasets", 201, "happy-path", { text: "x,y\n1,2" })).dataset.id;
  await check(a, "POST", "/api/plots", 404, "relation-isolation", { datasetId: foreign });
  await check(a, "PATCH", `/api/plots/${id}`, 404, "relation-isolation", { datasetId: foreign });
  await hidden("POST", `/api/plots/${id}/duplicate`);
  await check(a, "POST", `/api/plots/${id}/duplicate`, 201, "happy-path");
  await check(a, "POST", "/api/plots", 400, "invalid-input", { title: false });
  await check(a, "POST", "/api/plots/datasets", 400, "invalid-input", { text: false });
  await check(a, "PATCH", `/api/plots/${id}`, 400, "invalid-input", { title: false });
  await check(a, "PATCH", `/api/plots/datasets/${datasetId}`, 400, "invalid-input", { columns: [] });
  await hidden("DELETE", `/api/plots/${id}`);
  await check(a, "DELETE", `/api/plots/${id}`, 204, "happy-path");
  await hidden("DELETE", `/api/plots/datasets/${datasetId}`);
  await check(a, "DELETE", `/api/plots/datasets/${datasetId}`, 204, "happy-path");
});

test("assistant conversations and stop actions stay private without invoking a provider", async () => {
  const id = await created("/api/assistant/conversations", "conversation", { title: "Private conversation" });
  await harness.prisma.assistantMessage.create({ data: { userId: a.id, conversationId: id, role: "user", content: "Private message" } });
  assert.ok((await check(a, "GET", "/api/assistant/conversations", 200, "happy-path")).conversations.some((row: { id: string }) => row.id === id));
  assert.ok(!(await check(b, "GET", "/api/assistant/conversations", 200, "isolation")).conversations.some((row: { id: string }) => row.id === id));
  await hidden("GET", `/api/assistant/conversations/${id}/messages`);
  assert.equal((await check(a, "GET", `/api/assistant/conversations/${id}/messages`, 200, "happy-path")).messages[0].content, "Private message");
  await hidden("POST", `/api/assistant/conversations/${id}/stop`);
  await check(a, "POST", `/api/assistant/conversations/${id}/stop`, 204, "happy-path");
  await check(a, "POST", "/api/assistant/conversations", 400, "invalid-input", { title: false });
});

test("decisions, cancel and saved rules are scoped before long polling or writes", async () => {
  const ask = await check(a, "POST", "/api/decisions", 202, "happy-path", { source: "other", event: "permission", payload: { tool_name: "fixture" }, waitSeconds: 5 });
  assert.equal(typeof ask.id, "string");
  assert.ok((await check(a, "GET", "/api/decisions", 200, "happy-path")).decisions.some((row: { id: string }) => row.id === ask.id));
  assert.ok(!(await check(b, "GET", "/api/decisions", 200, "isolation")).decisions.some((row: { id: string }) => row.id === ask.id));
  await hidden("GET", `/api/decisions/${ask.id}/wait?timeout=1`);
  await hidden("POST", `/api/decisions/${ask.id}/decide`, { decision: "deny" });
  await hidden("POST", `/api/decisions/${ask.id}/cancel`);
  await check(a, "POST", `/api/decisions/${ask.id}/decide`, 200, "happy-path", { decision: "deny" });
  await check(a, "GET", `/api/decisions/${ask.id}/wait?timeout=1`, 200, "happy-path");
  await check(a, "POST", `/api/decisions/${ask.id}/cancel`, 204, "happy-path");
  await check(a, "POST", "/api/decisions", 400, "invalid-input", { source: false });
  await check(a, "GET", "/api/decisions?status=invalid", 400, "invalid-input");
  await check(a, "GET", `/api/decisions/${ask.id}/wait?timeout=bad`, 400, "invalid-input");
  await check(a, "POST", `/api/decisions/${ask.id}/decide`, 400, "invalid-input", { decision: false });
  const rule = await harness.prisma.decisionRule.create({ data: { userId: a.id, source: "other", toolName: "fixture", pattern: "*", decision: "deny" } });
  assert.ok((await check(a, "GET", "/api/decision-rules", 200, "happy-path")).rules.some((row: { id: string }) => row.id === rule.id));
  assert.deepEqual((await check(b, "GET", "/api/decision-rules", 200, "isolation")).rules, []);
  await hidden("DELETE", `/api/decision-rules/${rule.id}`);
  await check(a, "DELETE", `/api/decision-rules/${rule.id}`, 204, "happy-path");
});

test("deleted-record lists and bulk restore operate only on the current user's rows", async () => {
  const id = await created("/api/tasks", "task", { title: "Deleted private" });
  await check(a, "DELETE", `/api/tasks/${id}`, 200, "happy-path");
  assert.ok((await check(a, "GET", "/api/deleted", 200, "happy-path")).items.some((row: { id: string }) => row.id === id));
  assert.ok(!(await check(b, "GET", "/api/deleted", 200, "isolation")).items.some((row: { id: string }) => row.id === id));
  assert.equal((await check(b, "POST", "/api/deleted/restore", 200, "isolation", { kind: "task", id })).restored, 0);
  assert.equal((await check(a, "POST", "/api/deleted/restore", 200, "happy-path", { kind: "task", id })).restored, 1);
  await check(a, "POST", "/api/deleted/restore", 400, "invalid-input", { kind: "invalid" });
});

test("completed records, pin/reopen and approval decisions hide foreign ids", async () => {
  const taskId = await created("/api/tasks", "task", { title: "Completed private", status: "done" });
  const projectId = await created("/api/projects", "project", { name: "Completed private" });
  const deliverableId = await created("/api/deliverables", "deliverable", { title: "Completed private", projectId });
  await check(a, "PATCH", `/api/deliverables/${deliverableId}`, 200, "happy-path", { status: "completed" });
  const completed = await check(a, "GET", "/api/completed", 200, "happy-path");
  assert.ok(completed.items.some((row: { id: string }) => row.id === taskId));
  assert.ok(completed.items.some((row: { id: string }) => row.id === deliverableId));
  assert.ok(!(await check(b, "GET", "/api/completed", 200, "isolation")).items.some((row: { id: string }) => [taskId, deliverableId].includes(row.id)));
  for (const [path, id] of [["/api/tasks", taskId], ["/api/deliverables", deliverableId]]) {
    await hidden("POST", `${path}/${id}/pin`, { pinned: true });
    await hidden("POST", `${path}/${id}/reopen`);
    await check(a, "POST", `${path}/${id}/pin`, 200, "happy-path", { pinned: true });
    await check(a, "POST", `${path}/${id}/reopen`, 200, "happy-path");
    await check(a, "POST", `${path}/${id}/pin`, 400, "invalid-input", { pinned: false.toString() });
  }
  await check(a, "GET", "/api/completed?kind=invalid", 400, "invalid-input");
  const run = await harness.prisma.run.create({ data: { userId: a.id, taskId, worker: "fixture" } });
  const approval = await harness.prisma.approval.create({ data: { userId: a.id, runId: run.id, taskId, kind: "other", title: "Private approval", preview: {} } });
  assert.ok((await check(a, "GET", "/api/approvals", 200, "happy-path")).approvals.some((row: { id: string }) => row.id === approval.id));
  assert.ok(!(await check(b, "GET", "/api/approvals", 200, "isolation")).approvals.some((row: { id: string }) => row.id === approval.id));
  await hidden("POST", `/api/approvals/${approval.id}/decide`, { decision: "rejected" });
  await check(a, "POST", `/api/approvals/${approval.id}/decide`, 400, "invalid-input", { decision: false });
  await check(a, "POST", `/api/approvals/${approval.id}/decide`, 200, "happy-path", { decision: "rejected" });
});

test("notifications and meeting session writes remain scoped to the current account", async () => {
  const notification = await harness.prisma.notification.create({ data: { userId: a.id, kind: "fixture", title: "Private notification", body: "" } });
  assert.ok((await check(a, "GET", "/api/notifications", 200, "happy-path")).notifications.some((row: { id: string }) => row.id === notification.id));
  assert.ok(!(await check(b, "GET", "/api/notifications", 200, "isolation")).notifications.some((row: { id: string }) => row.id === notification.id));
  await hidden("POST", `/api/notifications/${notification.id}/read`);
  await check(b, "POST", "/api/notifications/read", 200, "isolation");
  assert.equal((await harness.prisma.notification.findUniqueOrThrow({ where: { id: notification.id } })).readAt, null);
  assert.equal((await check(a, "POST", `/api/notifications/${notification.id}/read`, 200, "happy-path")).updated, 1);
  await check(a, "POST", "/api/notifications/read", 200, "happy-path");
  const session = (await check(a, "POST", "/api/meetings/sessions", 201, "happy-path", { title: "Private meeting" })).session;
  assert.ok((await check(a, "GET", "/api/meetings/sessions", 200, "happy-path")).sessions.some((row: { id: string }) => row.id === session.id));
  assert.ok(!(await check(b, "GET", "/api/meetings/sessions", 200, "isolation")).sessions.some((row: { id: string }) => row.id === session.id));
  await hidden("GET", `/api/meetings/sessions/${session.id}`);
  await check(a, "GET", `/api/meetings/sessions/${session.id}`, 200, "happy-path");
  await hidden("PATCH", `/api/meetings/sessions/${session.id}`, { notes: "stolen" });
  assert.equal((await check(a, "PATCH", `/api/meetings/sessions/${session.id}`, 200, "happy-path", { notes: "Private notes" })).session.notes, "Private notes");
  for (const suffix of ["end", "decline", "recap"]) {
    await hidden("POST", `/api/meetings/sessions/${session.id}/${suffix}`);
    await check(a, "POST", `/api/meetings/sessions/${session.id}/${suffix}`, 200, "happy-path");
  }
  await check(a, "POST", "/api/meetings/sessions", 400, "invalid-input", { title: false });
  await check(a, "PATCH", `/api/meetings/sessions/${session.id}`, 400, "invalid-input", { notes: false });
  await check(a, "POST", "/api/meetings/sessions", 404, "relation-isolation", { artifactId: MISSING_ID });
  await hidden("DELETE", `/api/meetings/sessions/${session.id}`);
  await check(a, "DELETE", `/api/meetings/sessions/${session.id}`, 200, "happy-path");
});

test("layout saves and resets are per-user and reject foreign project configuration", async () => {
  const beforeB = await check(b, "GET", "/api/layouts/today", 200, "isolation");
  const document = { v: 1, placements: [{ type: "focus", size: "m" }] };
  await check(a, "PUT", "/api/layouts/today", 200, "happy-path", document);
  assert.deepEqual((await check(a, "GET", "/api/layouts/today", 200, "happy-path")).document, document);
  assert.deepEqual((await check(b, "GET", "/api/layouts/today", 200, "isolation")).document, beforeB.document);
  await check(b, "PUT", "/api/layouts/today", 200, "isolation", { v: 1, placements: [] });
  assert.deepEqual((await check(a, "GET", "/api/layouts/today", 200, "happy-path")).document, document);
  await check(b, "POST", "/api/layouts/today/reset", 200, "isolation");
  assert.deepEqual((await check(a, "GET", "/api/layouts/today", 200, "happy-path")).document, document);
  await check(a, "POST", "/api/layouts/today/reset", 200, "happy-path");
  const projectId = (await check(b, "POST", "/api/projects", 201, "happy-path", { name: "Foreign layout project" })).project.id;
  const ownProject = await created("/api/projects", "project", { name: "Owned layout project" });
  await check(a, "PUT", "/api/layouts/today", 200, "happy-path", { v: 1, placements: [{ type: "focus", size: "m", config: { projectId: ownProject } }] });
  const foreignSave = await check(a, "PUT", "/api/layouts/today", 400, "relation-isolation", { v: 1, placements: [{ type: "focus", size: "m", config: { projectId } }] });
  assert.equal(foreignSave.error, "That project is not yours.");
  await check(a, "GET", "/api/layouts/invalid", 400, "invalid-input");
  await check(a, "PUT", "/api/layouts/today", 400, "invalid-input", { v: false, placements: false });
});

test("real paired-device tokens reach only their own job handlers and can be revoked", async () => {
  const anonymous = { ...a, inject: (request: InjectOptions) => harness.app.inject(request) };
  const pair = await check(a, "POST", "/api/devices/pair", 201, "happy-path");
  const registerBody = { code: pair.code, name: "HTTP fixture", platform: "macos" };
  const registered = await check(anonymous, "POST", "/api/devices/register", 201, "happy-path", registerBody);
  await check(anonymous, "POST", "/api/devices/register", 400, "invalid-input", { code: false });
  const deviceUser = { ...a, inject: (request: InjectOptions) => harness.app.inject({ ...request, headers: { ...request.headers, authorization: `Bearer ${registered.token}` } }) };
  const foreignToken = await harness.asToken(b, "device");
  await harness.prisma.device.create({ data: { userId: b.id, tokenId: foreignToken.id, name: "Other fixture", platform: "macos" } });
  const foreignDevice = { ...b, inject: foreignToken.inject };
  assert.ok((await check(a, "GET", "/api/devices", 200, "happy-path")).devices.some((row: { id: string }) => row.id === registered.device.id));
  assert.ok(!(await check(b, "GET", "/api/devices", 200, "isolation")).devices.some((row: { id: string }) => row.id === registered.device.id));
  await check(deviceUser, "POST", "/api/devices/self/heartbeat", 200, "happy-path", {});
  await check(deviceUser, "POST", "/api/devices/self/heartbeat", 400, "invalid-input", { runningJobIds: false });
  await check(deviceUser, "POST", "/api/devices/self/claim", 204, "happy-path");
  const taskId = await created("/api/tasks", "task", { title: "Device fixture" });
  const job = await harness.prisma.workspaceJob.create({
    data: { userId: a.id, taskId, deviceId: registered.device.id, executionMode: "auto", model: "fixture", status: "running", leaseToken: "fixture-lease", leaseUntil: new Date(Date.now() + 60_000) },
  });
  const progress = { leaseToken: "fixture-lease", progress: "Private" };
  await check(foreignDevice, "POST", `/api/devices/self/jobs/${job.id}/progress`, 404, "isolation", progress);
  await check(deviceUser, "POST", `/api/devices/self/jobs/${MISSING_ID}/progress`, 404, "unknown-id", progress);
  await check(deviceUser, "POST", `/api/devices/self/jobs/${job.id}/progress`, 400, "invalid-input", { leaseToken: false });
  await check(deviceUser, "POST", `/api/devices/self/jobs/${job.id}/progress`, 200, "happy-path", progress);
  await hidden("DELETE", `/api/devices/${registered.device.id}`);
  await check(a, "DELETE", `/api/devices/${registered.device.id}`, 204, "happy-path");
  const denied = await deviceUser.inject({ method: "POST", url: "/api/devices/self/heartbeat", payload: {} });
  assert.equal(denied.statusCode, 401, denied.body);
});

test("assistant apply checks the conversation and task before running relation writes", async () => {
  const conversationId = await created("/api/assistant/conversations", "conversation", { title: "Apply fixture" });
  const create = { conversationId, name: "hub_create_tasks", input: { tasks: [{ title: "Applied private task" }] } };
  const beforeB = await harness.prisma.task.count({ where: { userId: b.id } });
  await check(b, "POST", "/api/assistant/apply", 404, "relation-isolation", create);
  await check(a, "POST", "/api/assistant/apply", 404, "relation-isolation", { ...create, conversationId: MISSING_ID });
  assert.equal(await harness.prisma.task.count({ where: { userId: b.id } }), beforeB);
  await check(a, "POST", "/api/assistant/apply", 200, "happy-path", create);
  const task = await harness.prisma.task.findFirstOrThrow({ where: { userId: a.id, title: create.input.tasks[0]!.title } });
  await check(b, "POST", "/api/assistant/apply", 404, "isolation", {
    name: "hub_update_task", input: { taskId: task.id, matchTitle: task.title, title: "Stolen" },
  });
  assert.equal((await harness.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).title, task.title);
  await check(a, "POST", "/api/assistant/apply", 400, "invalid-input", { name: false });
});

test("Ensemble replies and watcher cancel actions hide foreign identifiers", async () => {
  const row = await harness.prisma.ensembleReply.create({
    data: { userId: a.id, surface: "board", anchorKey: "private-fixture", prompt: "Fixture", content: "Private reply", toolCalls: [{ id: "fixture-call", state: "awaiting_approval" }] },
  });
  assert.equal((await check(a, "GET", "/api/ensemble/replies?surface=board&anchorKey=private-fixture", 200, "happy-path")).replies[0].id, row.id);
  assert.deepEqual((await check(b, "GET", "/api/ensemble/replies?surface=board&anchorKey=private-fixture", 200, "isolation")).replies, []);
  await hidden("POST", `/api/ensemble/replies/${row.id}/applied`, { callId: "fixture-call" });
  await check(a, "POST", `/api/ensemble/replies/${row.id}/applied`, 200, "happy-path", { callId: "fixture-call" });
  await check(a, "POST", `/api/ensemble/replies/${row.id}/applied`, 400, "invalid-input", { callId: false });
  await check(a, "GET", "/api/ensemble/replies", 400, "invalid-input");
  const watcher = await harness.prisma.watcher.create({ data: { userId: a.id, scopeKind: "task", scopeId: MISSING_ID, condition: "fixture" } });
  assert.ok((await check(a, "GET", "/api/watchers", 200, "happy-path")).watchers.some((row: { id: string }) => row.id === watcher.id));
  assert.deepEqual((await check(b, "GET", "/api/watchers", 200, "isolation")).watchers, []);
  await hidden("POST", `/api/watchers/${watcher.id}/cancel`);
  assert.equal((await check(a, "POST", `/api/watchers/${watcher.id}/cancel`, 200, "happy-path")).watcher.status, "cancelled");
});

test("OAuth-only sessions remain real shell accounts, and unverified hosted browser notes/context still work", async () => {
  const oauth = await harness.asUser();
  await harness.prisma.user.update({ where: { id: oauth.id }, data: { passwordHash: null, emailVerifiedAt: null } });
  await harness.prisma.authIdentity.create({ data: { userId: oauth.id, provider: "google", subject: `fixture-${oauth.id}`, email: oauth.email } });
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const shell = await check(oauth, "GET", "/api/shell", 200, "happy-path");
    assert.deepEqual(shell.user, { id: oauth.id, email: oauth.email, name: "HTTP test user", emailVerified: false, hasPassword: false });
    assert.equal(shell.verificationRequired, true);
    assert.equal(shell.via, "session");
    assert.equal((await check(b, "GET", "/api/shell", 200, "isolation")).user.id, b.id);
    const page = (await check(oauth, "POST", "/api/pages", 201, "happy-path")).page;
    await check(oauth, "PUT", `/api/pages/${page.id}`, 200, "happy-path", { revision: 1, content: { type: "doc", content: [{ type: "paragraph" }] } });
    await check(oauth, "GET", `/api/pages/${page.id}`, 200, "happy-path");
    const project = (await check(oauth, "POST", "/api/projects", 201, "happy-path", { name: "Unverified browser context" })).project;
    await check(oauth, "PATCH", `/api/projects/${project.id}`, 200, "happy-path", { summary: "Still editable" });
    await check(oauth, "GET", `/api/projects/${project.id}`, 200, "happy-path");
    const person = (await check(oauth, "POST", "/api/people", 201, "happy-path", { name: "Fictional colleague" })).person;
    assert.ok((await check(oauth, "GET", "/api/people", 200, "happy-path")).people.some((row: { id: string }) => row.id === person.id));
    await check(oauth, "PATCH", "/api/settings", 200, "happy-path", { timezone: "UTC" });
    const task = (await check(oauth, "POST", "/api/tasks", 201, "happy-path", { title: "Unverified browser page" })).task;
    await check(oauth, "POST", `/api/pages/task/${task.id}/comments`, 201, "happy-path", { body: { text: "Manual comments remain usable." } });
    await check(oauth, "GET", `/api/pages/task/${task.id}/comments`, 200, "happy-path");
    for (const [url, payload] of [
      ["/api/assistant/turn", { message: "Must verify before a stream opens." }],
      [`/api/pages/task/${task.id}/ensemble`, { prompt: "Must verify before a stream opens." }],
      ["/api/ensemble/invoke", { surface: "board", prompt: "Must verify before a stream opens." }],
    ] as const) {
      const denied = await oauth.inject({ method: "POST", url, payload });
      assert.equal(denied.statusCode, 403, denied.body);
      assert.match(String(denied.headers["content-type"]), /^application\/json/);
      assert.equal(denied.json().code, "EMAIL_UNVERIFIED");
      track("POST", url, "hosted-verification");
    }
    assert.equal(await harness.prisma.assistantConversation.count({ where: { userId: oauth.id } }), 0);
    assert.equal(await harness.prisma.assistantMessage.count({ where: { userId: oauth.id } }), 0);
    assert.equal(await harness.prisma.ensembleReply.count({ where: { userId: oauth.id } }), 0);
    assert.equal(await harness.prisma.pageDiscussion.count({ where: { userId: oauth.id, authorKind: "ensemble" } }), 0);
    const beforeParsing = await oauth.inject({
      method: "POST",
      url: "/api/assistant/turn",
      headers: { "content-type": "application/json" },
      payload: '{"broken":',
    });
    assert.equal(beforeParsing.statusCode, 403, beforeParsing.body);
    assert.equal(beforeParsing.json().code, "EMAIL_UNVERIFIED");
    const addCodeRoot = () => oauth.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { code: { roots: ["/tmp/ensemble-should-not-be-resolved"] } },
    });
    const unverifiedRoot = await addCodeRoot();
    assert.equal(unverifiedRoot.statusCode, 403, unverifiedRoot.body);
    assert.equal(unverifiedRoot.json().code, "EMAIL_UNVERIFIED");
    await harness.prisma.user.update({ where: { id: oauth.id }, data: { emailVerifiedAt: new Date() } });
    await check(oauth, "POST", "/api/assistant/turn", 400, "invalid-input", { message: null });
    const nonOperatorRoot = await addCodeRoot();
    assert.equal(nonOperatorRoot.statusCode, 403, nonOperatorRoot.body);
    assert.equal(nonOperatorRoot.json().code, "HOST_ACCESS_DENIED");
    await harness.prisma.user.update({ where: { id: oauth.id }, data: { emailVerifiedAt: null } });
    const { ensureDesktopUser } = await import("../lib/desktop-user.js");
    assert.equal(await ensureDesktopUser(oauth.id), oauth.id);
    const retained = await harness.prisma.user.findUniqueOrThrow({ where: { id: oauth.id } });
    assert.equal(retained.passwordHash, null);
    assert.equal(retained.email, oauth.email);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test("generic preferences cannot reset internal daily job usage, including after task deletion", async () => {
  const key = `hosted.agent-jobs.${new Date().toISOString().slice(0, 10)}`;
  await harness.prisma.preference.create({ data: { userId: a.id, key, value: { count: 50 }, source: "system" } });
  const reset = await a.inject({ method: "PUT", url: `/api/preferences/${key}`, payload: { value: { count: 0 } } });
  assert.equal(reset.statusCode, 403, reset.body);
  const remove = await a.inject({ method: "DELETE", url: `/api/preferences/${key}` });
  assert.equal(remove.statusCode, 403, remove.body);
  assert.deepEqual((await harness.prisma.preference.findUniqueOrThrow({ where: { userId_key: { userId: a.id, key } } })).value, { count: 50 });
  const taskId = await created("/api/tasks", "task", { title: "Delete must not reset daily usage" });
  await check(a, "DELETE", `/api/tasks/${taskId}`, 200, "happy-path");
  assert.deepEqual((await harness.prisma.preference.findUniqueOrThrow({ where: { userId_key: { userId: a.id, key } } })).value, { count: 50 });
  assert.ok(!(await check(a, "GET", "/api/preferences", 200, "happy-path")).preferences.some((row: { key: string }) => row.key === key));
  await check(a, "PUT", "/api/preferences/erasable-normal-preference", 200, "happy-path", { value: "mine" });
  await check(b, "DELETE", "/api/preferences/erasable-normal-preference", 204, "isolation");
  assert.equal((await harness.prisma.preference.findUniqueOrThrow({ where: { userId_key: { userId: a.id, key: "erasable-normal-preference" } } })).deletedAt, null);
  await check(a, "DELETE", "/api/preferences/erasable-normal-preference", 204, "happy-path");
});
