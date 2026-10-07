import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { zipSync } from "fflate";
import type { InjectOptions } from "fastify";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { importRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

const originalEnv = { ...process.env };
process.env.NODE_ENV = "test";

const harness: HttpHarness = await createHttpHarness();
const covered = new Map<string, Set<RouteCheck>>();
const fixtures = fileURLToPath(new URL("../imports/fixtures/", import.meta.url));
const realFetch = globalThis.fetch;

after(async () => {
  globalThis.fetch = realFetch;
  try {
    for (const [route, checks] of Object.entries(importRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted import coverage claim: ${check} ${route}`);
    }
  } finally {
    await harness.close();
    process.env = originalEnv;
  }
});

function track(route: string, check: RouteCheck): void {
  const checks = covered.get(route) ?? new Set<RouteCheck>();
  checks.add(check);
  covered.set(route, checks);
}

async function call(user: HttpUser, route: string, check: RouteCheck, options: InjectOptions) {
  const response = await user.inject(options);
  track(route, check);
  return response;
}

async function uploadFile(user: HttpUser, source: string, name: string, data: Uint8Array, check: RouteCheck = "happy-path") {
  const form = new FormData();
  form.append("source", source);
  form.append("file", new Blob([data]), name);
  const encoded = new Response(form);
  const payload = Buffer.from(await encoded.arrayBuffer());
  return call(user, "POST /api/imports/preview", check, {
    method: "POST",
    url: "/api/imports/preview",
    headers: { "content-type": encoded.headers.get("content-type")! },
    payload,
  });
}

type Job = {
  id: string;
  status: string;
  counts: { tasks: { created: number; updated: number; unchanged: number }; pages: { created: number; updated: number; unchanged: number; keptEdits: number }; projects: { created: number; linked: number } };
  progress: { created: { tasks: number; pages: number; projects: number }; undone: unknown };
  links: { projects: Array<{ id: string; name: string }>; labels: string[]; pages: string[] };
  canUndo: boolean;
  error: string | null;
};

async function waitForJob(user: HttpUser, id: string): Promise<Job> {
  const until = Date.now() + 20_000;
  for (;;) {
    const response = await call(user, "GET /api/imports/:id", "happy-path", { method: "GET", url: `/api/imports/${id}` });
    assert.equal(response.statusCode, 200, response.body);
    const job = response.json<{ job: Job }>().job;
    if (!["queued", "running", "cancelling"].includes(job.status)) return job;
    if (Date.now() > until) throw new Error(`Import ${id} did not finish: ${JSON.stringify(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function startJob(user: HttpUser, body: Record<string, unknown>): Promise<Job> {
  const response = await call(user, "POST /api/imports", "happy-path", { method: "POST", url: "/api/imports", payload: body });
  assert.equal(response.statusCode, 202, response.body);
  return waitForJob(user, response.json<{ job: Job }>().job.id);
}

type TaskRow = { id: string; title: string; status: string; priority: string; due: string | null; labels: string[]; people: string[]; projectId: string | null; sourceKind: string; sourceUrl: string | null; description: string };

async function tasks(user: HttpUser): Promise<TaskRow[]> {
  const response = await user.inject({ method: "GET", url: "/api/tasks" });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<{ tasks: TaskRow[] }>().tasks;
}

function notionZip(): Uint8Array {
  const root = join(fixtures, "notion-export");
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[`Export-1b2c3d4e/${relative(root, path).split("\\").join("/")}`] = readFileSync(path);
    }
  };
  walk(root);
  // Notion wraps the export in a second zip.
  return zipSync({ "Export-1b2c3d4e-Part-1.zip": zipSync(files) });
}

test("sources list says what each app needs", async () => {
  const user = await harness.asUser();
  const response = await call(user, "GET /api/imports/sources", "happy-path", { method: "GET", url: "/api/imports/sources" });
  assert.equal(response.statusCode, 200, response.body);
  const sources = response.json<{ sources: Array<{ id: string; api: boolean; connected: boolean; files: string[]; tokenFields: string[] }> }>().sources;
  const byId = new Map(sources.map((source) => [source.id, source]));
  for (const id of ["notion", "linear", "jira", "trello", "asana", "todoist", "clickup", "monday", "github", "csv"]) assert.ok(byId.has(id), id);
  assert.equal(byId.get("csv")!.api, false);
  assert.deepEqual(byId.get("notion")!.files, ["zip", "csv"]);
  assert.deepEqual(byId.get("jira")!.tokenFields, ["site", "email"]);
  assert.equal(byId.get("linear")!.connected, false);
});

test("CSV: preview, import, re-import updates instead of duplicating, undo removes only what it created", async () => {
  const mira = await harness.asUser();
  const theo = await harness.asUser();
  const csv = readFileSync(join(fixtures, "tasks.csv"));
  const previewResponse = await uploadFile(mira, "csv", "Fieldnote tasks.csv", csv);
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  const preview = previewResponse.json<{
    previewId: string;
    via: string;
    containers: Array<{ id: string; count: number }>;
    mapping: { tables: Array<{ columns: Record<string, string[]>; preset: string }>; statuses: Array<{ value: string; proposed: string }> };
    samples: Array<{ title: string; labels: string[] }>;
  }>();
  assert.equal(preview.via, "file");
  assert.equal(preview.containers[0]!.count, 3);
  assert.equal(preview.mapping.tables[0]!.preset, "generic");
  assert.deepEqual(preview.mapping.tables[0]!.columns.title, ["Task"]);
  assert.deepEqual(preview.mapping.tables[0]!.columns.labels, ["Tags"]);
  assert.deepEqual(preview.mapping.tables[0]!.columns.assignee, ["Owner"]);
  const proposed = Object.fromEntries(preview.mapping.statuses.map((status) => [status.value, status.proposed]));
  assert.deepEqual(proposed, { "In progress": "in_progress", "Not started": "todo", Done: "done" });
  assert.deepEqual(preview.samples[0]!.labels, ["Research", "Survey"]);

  // Another person cannot use this preview.
  const stolen = await call(theo, "POST /api/imports", "isolation", { method: "POST", url: "/api/imports", payload: { previewId: preview.previewId, containers: [preview.containers[0]!.id] } });
  assert.equal(stolen.statusCode, 404, stolen.body);
  const stolenPreview = await call(theo, "POST /api/imports/preview", "isolation", { method: "POST", url: "/api/imports/preview", payload: { previewId: preview.previewId } });
  assert.equal(stolenPreview.statusCode, 404, stolenPreview.body);

  const first = await startJob(mira, { previewId: preview.previewId, containers: [preview.containers[0]!.id], statusMap: { "not started": "proposed" } });
  assert.equal(first.status, "done", first.error ?? "");
  assert.deepEqual(first.counts.tasks, { created: 3, updated: 0, unchanged: 0 });
  assert.equal(first.counts.projects.created, 2);
  assert.ok(first.links.labels.includes("Launch"));

  const rows = await tasks(mira);
  assert.equal(rows.length, 3);
  const survey = rows.find((row) => row.title === "Draft the grower survey")!;
  assert.equal(survey.status, "in_progress");
  assert.equal(survey.priority, "p0");
  assert.equal(survey.due, "2026-10-20T00:00:00.000Z");
  assert.deepEqual(survey.labels, ["Research", "Survey"]);
  assert.deepEqual(survey.people, ["Mira Chen"]);
  assert.equal(survey.description, "Ten questions max.");
  const print = rows.find((row) => row.title === "Book the print shop")!;
  assert.equal(print.status, "proposed", "the person's status choice wins");
  assert.equal(print.due, "2026-10-28T00:00:00.000Z");
  assert.deepEqual(print.labels, ["Launch", "Print"]);
  assert.equal(print.priority, "p2");
  const kit = rows.find((row) => row.title === "Send the press kit")!;
  assert.equal(kit.status, "done");
  assert.equal(kit.description, "Kit lives in the shared drive.");
  const kitPage = await mira.inject({ method: "GET", url: `/api/tasks/${kit.id}/page` });
  assert.match(JSON.stringify(kitPage.json()), /photo credits sheet/);
  assert.equal(new Set(rows.map((row) => row.projectId)).size, 2);
  assert.deepEqual(await tasks(theo), [], "imports stay with the person who ran them");

  // The same file again: nothing duplicates, nothing changes.
  const again = (await uploadFile(mira, "csv", "Fieldnote tasks.csv", csv)).json<{ previewId: string; containers: Array<{ id: string }> }>();
  const second = await startJob(mira, { previewId: again.previewId, containers: [again.containers[0]!.id], statusMap: { "not started": "proposed" } });
  assert.deepEqual(second.counts.tasks, { created: 0, updated: 0, unchanged: 3 });
  assert.equal(second.counts.projects.created, 0);
  assert.equal((await tasks(mira)).length, 3);

  // A changed row updates in place.
  const edited = new TextEncoder().encode(csv.toString("utf8").replace("Not started", "Blocked"));
  const third = (await uploadFile(mira, "csv", "Fieldnote tasks.csv", edited)).json<{ previewId: string; containers: Array<{ id: string }> }>();
  const updated = await startJob(mira, { previewId: third.previewId, containers: [third.containers[0]!.id] });
  assert.deepEqual(updated.counts.tasks, { created: 0, updated: 1, unchanged: 2 });
  assert.equal((await tasks(mira)).find((row) => row.title === "Book the print shop")!.status, "blocked");

  // Only the owner sees, cancels or undoes a job.
  for (const [route, method, url] of [
    ["GET /api/imports/:id", "GET", `/api/imports/${first.id}`],
    ["POST /api/imports/:id/cancel", "POST", `/api/imports/${first.id}/cancel`],
    ["POST /api/imports/:id/undo", "POST", `/api/imports/${first.id}/undo`],
  ] as const) {
    const denied = await call(theo, route, "isolation", { method, url, ...(method === "POST" ? { payload: {} } : {}) });
    assert.equal(denied.statusCode, 404, denied.body);
  }
  const theoJobs = await call(theo, "GET /api/imports", "isolation", { method: "GET", url: "/api/imports" });
  assert.deepEqual(theoJobs.json<{ jobs: unknown[] }>().jobs, []);
  const miraJobs = await call(mira, "GET /api/imports", "happy-path", { method: "GET", url: "/api/imports" });
  assert.equal(miraJobs.json<{ jobs: unknown[] }>().jobs.length, 3);

  // Cancelling a finished job leaves it as it was.
  const cancelled = await call(mira, "POST /api/imports/:id/cancel", "happy-path", { method: "POST", url: `/api/imports/${first.id}/cancel`, payload: {} });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json<{ job: Job }>().job.status, "done");

  // Undo the first import: its three tasks and two projects go; the update jobs created nothing.
  const undo = await call(mira, "POST /api/imports/:id/undo", "happy-path", { method: "POST", url: `/api/imports/${first.id}/undo`, payload: {} });
  assert.equal(undo.statusCode, 200, undo.body);
  assert.equal(undo.json<{ job: Job }>().job.status, "undone");
  assert.equal((await tasks(mira)).length, 0);
  assert.equal(await harness.prisma.project.count({ where: { userId: mira.id, deletedAt: null } }), 0);
  const twice = await call(mira, "POST /api/imports/:id/undo", "invalid-input", { method: "POST", url: `/api/imports/${first.id}/undo`, payload: {} });
  assert.equal(twice.statusCode, 409, twice.body);

  // Re-running after an undo brings them back once.
  const back = (await uploadFile(mira, "csv", "Fieldnote tasks.csv", csv)).json<{ previewId: string; containers: Array<{ id: string }> }>();
  const restored = await startJob(mira, { previewId: back.previewId, containers: [back.containers[0]!.id] });
  assert.equal(restored.counts.tasks.created, 3);
  assert.equal((await tasks(mira)).length, 3);
});

test("CSV: two sheets with their own 1..N ids stay separate; the same sheet downloaded again still updates", async () => {
  const mira = await harness.asUser();
  const sheet = (rows: string[]) => new TextEncoder().encode(`ID,Title,Status\n${rows.join("\n")}\n`);
  const importSheet = async (name: string, rows: string[]) => {
    const preview = (await uploadFile(mira, "csv", name, sheet(rows))).json<{ previewId: string; containers: Array<{ id: string }> }>();
    return startJob(mira, { previewId: preview.previewId, containers: [preview.containers[0]!.id] });
  };
  const hiring = await importSheet("Hiring.csv", ["1,Post the role,To do", "2,Screen applicants,To do", "3,Book interviews,To do"]);
  const roadmap = await importSheet("Q3 roadmap.csv", ["1,Plan launch,Doing", "2,Write field guide,To do", "3,Ship press kit,To do"]);
  assert.equal(hiring.counts.tasks.created, 3);
  assert.deepEqual(roadmap.counts.tasks, { created: 3, updated: 0, unchanged: 0 }, "the roadmap did not overwrite the hiring rows");
  const titles = (await tasks(mira)).map((row) => row.title).sort();
  assert.deepEqual(titles, ["Book interviews", "Plan launch", "Post the role", "Screen applicants", "Ship press kit", "Write field guide"]);

  const again = await importSheet("Q3 roadmap (1).csv", ["1,Plan launch,Done", "2,Write field guide,To do", "3,Ship press kit,To do"]);
  assert.deepEqual(again.counts.tasks, { created: 0, updated: 1, unchanged: 2 });
  const rows = await tasks(mira);
  assert.equal(rows.length, 6);
  assert.equal(rows.find((row) => row.title === "Plan launch")!.status, "done");
  assert.equal(rows.find((row) => row.title === "Post the role")!.status, "todo");

  // Undoing the roadmap import leaves the hiring sheet alone.
  const undo = await call(mira, "POST /api/imports/:id/undo", "happy-path", { method: "POST", url: `/api/imports/${roadmap.id}/undo`, payload: {} });
  assert.equal(undo.statusCode, 200, undo.body);
  assert.deepEqual((await tasks(mira)).map((row) => row.title).sort(), ["Book interviews", "Post the role", "Screen applicants"]);
});

test("Trello JSON export: lists become status, labels and checklists come across, re-import is idempotent", async () => {
  const mira = await harness.asUser();
  const board = readFileSync(join(fixtures, "trello-board.json"));
  const response = await uploadFile(mira, "trello", "fieldnote-launch.json", board);
  assert.equal(response.statusCode, 200, response.body);
  const preview = response.json<{ previewId: string; source: string; containers: Array<{ id: string; name: string; count: number }>; mapping: { statuses: Array<{ value: string; proposed: string }> } }>();
  assert.equal(preview.source, "trello");
  assert.deepEqual(preview.containers.map((container) => [container.name, container.count]), [["Fieldnote launch", 3]]);
  assert.deepEqual(Object.fromEntries(preview.mapping.statuses.map((status) => [status.value, status.proposed])), { Doing: "in_progress", "To Do": "todo", Done: "done" });
  const job = await startJob(mira, { previewId: preview.previewId, containers: [preview.containers[0]!.id] });
  assert.equal(job.status, "done", job.error ?? "");
  assert.equal(job.counts.tasks.created, 3);
  const rows = await tasks(mira);
  const post = rows.find((row) => row.title === "Write launch post")!;
  assert.equal(post.status, "in_progress");
  assert.equal(post.sourceKind, "trello");
  assert.equal(post.sourceUrl, "https://trello.com/c/Card0001");
  assert.deepEqual(post.labels, ["Writing", "red"]);
  assert.deepEqual(post.people, ["Mira Chen"]);
  assert.equal(post.due, "2026-10-15T17:00:00.000Z");
  const page = await mira.inject({ method: "GET", url: `/api/tasks/${post.id}/page` });
  const doc = JSON.stringify(page.json());
  assert.match(doc, /Before posting/);
  assert.match(doc, /"checked":true/);
  assert.equal(rows.find((row) => row.title === "Pick the cover photo")!.status, "done");
  assert.ok(!rows.some((row) => row.title === "Archived idea"));
  const project = await harness.prisma.project.findFirst({ where: { userId: mira.id, name: "Fieldnote launch" } });
  assert.equal(project?.externalSource, "trello");

  const again = (await uploadFile(mira, "trello", "fieldnote-launch.json", board)).json<{ previewId: string; containers: Array<{ id: string }> }>();
  const second = await startJob(mira, { previewId: again.previewId, containers: [again.containers[0]!.id] });
  assert.deepEqual(second.counts.tasks, { created: 0, updated: 0, unchanged: 3 });
  assert.equal(second.counts.projects.linked, 1);
  assert.equal((await tasks(mira)).length, 3);
});

test("Notion Markdown & CSV zip: databases become projects and tasks with page bodies, pages keep your edits on re-import", async () => {
  const mira = await harness.asUser();
  const zip = notionZip();
  const response = await uploadFile(mira, "notion", "Export-1b2c3d4e.zip", zip);
  assert.equal(response.statusCode, 200, response.body);
  const preview = response.json<{
    previewId: string;
    format: string;
    containers: Array<{ id: string; name: string; kind: string; count: number; importAs: string; parent: string | null }>;
    mapping: { tables: Array<{ containerId: string; columns: Record<string, string[]> }> };
  }>();
  assert.equal(preview.format, "notion-zip");
  const database = preview.containers.find((container) => container.kind === "database")!;
  assert.equal(database.name, "Tasks");
  assert.equal(database.count, 3, "the _all.csv wins over the view CSV");
  assert.equal(database.parent, "Fieldnote Home");
  const pages = preview.containers.find((container) => container.kind === "page")!;
  assert.equal(pages.count, 2);
  assert.deepEqual(preview.mapping.tables[0]!.columns.due, ["Due"]);
  assert.deepEqual(preview.mapping.tables[0]!.columns.labels, ["Tags"]);

  const job = await startJob(mira, { previewId: preview.previewId, containers: [database.id, pages.id] });
  assert.equal(job.status, "done", job.error ?? "");
  assert.deepEqual(job.counts.tasks, { created: 3, updated: 0, unchanged: 0 });
  assert.equal(job.counts.pages.created, 2);
  const rows = await tasks(mira);
  const draft = rows.find((row) => row.title === "Draft field guide")!;
  assert.equal(draft.status, "in_progress");
  assert.equal(draft.due, "2026-10-20T00:00:00.000Z");
  assert.deepEqual(draft.labels, ["Writing", "Field guide"]);
  assert.equal(draft.sourceKind, "notion");
  assert.equal(draft.sourceUrl, "https://www.notion.so/aaaabbbbccccddddeeeeffff00001111");
  const body = JSON.stringify((await mira.inject({ method: "GET", url: `/api/tasks/${draft.id}/page` })).json());
  assert.match(body, /Soil basics/);
  assert.match(body, /taskItem/);
  assert.doesNotMatch(body, /Assignee: Mira Chen/, "the property block is not repeated in the body");
  const interview = rows.find((row) => row.title === "Interview growers")!;
  assert.equal(interview.due, "2026-10-12T00:00:00.000Z");
  assert.match(JSON.stringify((await mira.inject({ method: "GET", url: `/api/tasks/${interview.id}/page` })).json()), /Budget/);
  assert.equal(rows.find((row) => row.title === "Ship press kit")!.status, "done");
  const project = await harness.prisma.project.findFirst({ where: { userId: mira.id, name: "Tasks" } });
  assert.equal(project?.externalId, "9a8b7c6d5e4f30211203f4e5d6c7b8a9");

  const stored = await harness.prisma.taskPage.findMany({ where: { userId: mira.id, taskId: null }, orderBy: { title: "asc" } });
  assert.deepEqual(stored.map((page) => page.title), ["Field guide outline", "Fieldnote Home"]);
  const outline = stored[0]!;
  assert.equal(outline.externalId, "11112222333344445555666677778888");
  assert.match(JSON.stringify(outline.content), /Imported from Notion/);
  assert.match(JSON.stringify(outline.content), /in Fieldnote Home/);
  assert.match(JSON.stringify(outline.content), /orderedList/);
  assert.match(outline.searchText ?? "", /Soil/);

  // Mira edits one page in Ensemble; the next import keeps her edit and still updates nothing else.
  const save = await mira.inject({
    method: "PUT",
    url: `/api/pages/${outline.id}`,
    payload: { revision: outline.revision, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Mira's own outline" }] }] } },
  });
  assert.equal(save.statusCode, 200, save.body);
  const again = (await uploadFile(mira, "notion", "Export-1b2c3d4e.zip", zip)).json<{ previewId: string; containers: Array<{ id: string }> }>();
  const second = await startJob(mira, { previewId: again.previewId, containers: again.containers.map((container) => container.id) });
  assert.deepEqual(second.counts.tasks, { created: 0, updated: 0, unchanged: 3 });
  assert.deepEqual(second.counts.pages, { created: 0, updated: 0, unchanged: 1, keptEdits: 1 });
  const kept = await harness.prisma.taskPage.findUniqueOrThrow({ where: { id: outline.id } });
  assert.match(JSON.stringify(kept.content), /Mira's own outline/);

  // Undo removes the pages and tasks this first import made.
  const undo = await call(mira, "POST /api/imports/:id/undo", "happy-path", { method: "POST", url: `/api/imports/${job.id}/undo`, payload: {} });
  assert.equal(undo.statusCode, 200, undo.body);
  assert.equal((await tasks(mira)).length, 0);
  assert.equal(await harness.prisma.taskPage.count({ where: { userId: mira.id, taskId: null } }), 0);
});

test("API import with a pasted token (Linear, mocked): token stays in memory, cancel stops between pages", async () => {
  const mira = await harness.asUser();
  let release: (() => void) | null = null;
  let calls = 0;
  const seenAuth = new Set<string>();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.linear.app/")) return realFetch(input, init);
    calls += 1;
    seenAuth.add(String((init?.headers as Record<string, string>)?.Authorization));
    const body = JSON.parse(String(init?.body)) as { query: string; variables: { after?: string | null } };
    const json = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
    if (body.query.includes("teams(first")) return json({ viewer: { name: "Mira Chen" }, teams: { nodes: [{ id: "team-1", name: "Field", key: "FLD" }], pageInfo: { hasNextPage: false, endCursor: null } } });
    if (body.variables.after === "page-2") {
      // Hold the second page until the test cancels.
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    return json({
      issues: {
        nodes: [
          {
            id: `uuid-${body.variables.after ?? "1"}`,
            identifier: body.variables.after ? "FLD-2" : "FLD-1",
            title: body.variables.after ? "Second issue" : "Map the plots",
            description: "Use the **new** survey.",
            url: "https://linear.app/fieldnote/issue/FLD-1",
            priorityLabel: "Urgent",
            dueDate: "2026-11-02",
            state: { name: "In Review", type: "started" },
            labels: { nodes: [{ name: "Field" }] },
            assignee: { name: "Mira Chen" },
            project: { id: "proj-1", name: "Field guide" },
          },
        ],
        pageInfo: { hasNextPage: !body.variables.after, endCursor: "page-2" },
      },
    });
  }) as typeof fetch;
  try {
    const preview = await call(mira, "POST /api/imports/preview", "happy-path", {
      method: "POST",
      url: "/api/imports/preview",
      payload: { source: "linear", credentials: { token: "lin_api_fictional_token_for_tests" } },
    });
    assert.equal(preview.statusCode, 200, preview.body);
    const body = preview.json<{ previewId: string; via: string; containers: Array<{ id: string }> }>();
    assert.equal(body.via, "token");
    assert.deepEqual(body.containers.map((container) => container.id), ["mine", "team-1"]);
    assert.ok(!preview.body.includes("lin_api_fictional"));

    const sampled = await call(mira, "POST /api/imports/preview", "happy-path", { method: "POST", url: "/api/imports/preview", payload: { previewId: body.previewId, containers: ["team-1"] } });
    const statuses = sampled.json<{ mapping: { statuses: Array<{ value: string; proposed: string }> } }>().mapping.statuses;
    assert.deepEqual(statuses, [{ value: "In Review", count: 1, proposed: "in_progress" }]);

    const started = await call(mira, "POST /api/imports", "happy-path", { method: "POST", url: "/api/imports", payload: { previewId: body.previewId, containers: ["team-1"] } });
    assert.equal(started.statusCode, 202, started.body);
    const jobId = started.json<{ job: Job }>().job.id;
    const busy = await call(mira, "POST /api/imports", "invalid-input", { method: "POST", url: "/api/imports", payload: { previewId: body.previewId, containers: ["team-1"] } });
    assert.equal(busy.statusCode, 409, busy.body);
    const until = Date.now() + 10_000;
    while (!release && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(release, "the second page was requested");
    const cancel = await call(mira, "POST /api/imports/:id/cancel", "happy-path", { method: "POST", url: `/api/imports/${jobId}/cancel`, payload: {} });
    assert.equal(cancel.statusCode, 200, cancel.body);
    const job = await waitForJob(mira, jobId);
    assert.equal(job.status, "cancelled");
    const rows = await tasks(mira);
    assert.deepEqual(rows.map((row) => row.title), ["Map the plots"]);
    assert.equal(rows[0]!.priority, "p0");
    assert.equal(rows[0]!.due, "2026-11-02T00:00:00.000Z");
    assert.deepEqual(rows[0]!.labels, ["Field"]);
    assert.equal(rows[0]!.status, "in_progress");
    assert.deepEqual([...seenAuth], ["lin_api_fictional_token_for_tests"]);
    const stored = await harness.prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.ok(!JSON.stringify(stored).includes("lin_api_fictional"), "the token is never stored");
    assert.ok(calls >= 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("bad input and unknown ids are refused", async () => {
  const mira = await harness.asUser();
  const noSource = await call(mira, "POST /api/imports/preview", "invalid-input", { method: "POST", url: "/api/imports/preview", payload: {} });
  assert.equal(noSource.statusCode, 400, noSource.body);
  const fileOnly = await call(mira, "POST /api/imports/preview", "invalid-input", { method: "POST", url: "/api/imports/preview", payload: { source: "csv" } });
  assert.equal(fileOnly.statusCode, 400, fileOnly.body);
  const notConnected = await call(mira, "POST /api/imports/preview", "invalid-input", { method: "POST", url: "/api/imports/preview", payload: { source: "notion" } });
  assert.equal(notConnected.statusCode, 409, notConnected.body);
  const broken = await uploadFile(mira, "trello", "board.json", new TextEncoder().encode('{"not":"a board"}'), "invalid-input");
  assert.equal(broken.statusCode, 400, broken.body);
  assert.match(broken.json<{ error: string }>().error, /Export as JSON/);
  const notZip = await uploadFile(mira, "notion", "export.zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]), "invalid-input");
  assert.equal(notZip.statusCode, 400, notZip.body);

  const csv = (await uploadFile(mira, "csv", "tasks.csv", readFileSync(join(fixtures, "tasks.csv")))).json<{ previewId: string }>();
  const unknownContainer = await call(mira, "POST /api/imports", "invalid-input", { method: "POST", url: "/api/imports", payload: { previewId: csv.previewId, containers: ["not-in-preview"] } });
  assert.equal(unknownContainer.statusCode, 400, unknownContainer.body);
  const badStatus = await call(mira, "POST /api/imports", "invalid-input", { method: "POST", url: "/api/imports", payload: { previewId: csv.previewId, containers: ["x"], statusMap: { open: "finished" } } });
  assert.equal(badStatus.statusCode, 400, badStatus.body);

  for (const [route, method, url] of [
    ["GET /api/imports/:id", "GET", "/api/imports/00000000-0000-4000-8000-000000000000"],
    ["POST /api/imports/:id/cancel", "POST", "/api/imports/00000000-0000-4000-8000-000000000000/cancel"],
    ["POST /api/imports/:id/undo", "POST", "/api/imports/00000000-0000-4000-8000-000000000000/undo"],
  ] as const) {
    const missing = await call(mira, route, "unknown-id", { method, url, ...(method === "POST" ? { payload: {} } : {}) });
    assert.equal(missing.statusCode, 404, missing.body);
  }
});

test("hosted: unverified accounts cannot preview or start imports", async () => {
  const unverified = await harness.asUser();
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const preview = await call(unverified, "POST /api/imports/preview", "hosted-verification", { method: "POST", url: "/api/imports/preview", payload: { source: "linear" } });
    assert.equal(preview.statusCode, 403, preview.body);
    assert.equal(preview.json<{ code: string }>().code, "EMAIL_UNVERIFIED");
    const start = await call(unverified, "POST /api/imports", "hosted-verification", { method: "POST", url: "/api/imports", payload: { source: "linear", containers: ["mine"] } });
    assert.equal(start.statusCode, 403, start.body);
  } finally {
    process.env.NODE_ENV = original;
  }
});

test("task labels: create and patch trim, de-duplicate and validate", async () => {
  const mira = await harness.asUser();
  const created = await mira.inject({ method: "POST", url: "/api/tasks", payload: { title: "Label me", labels: [" Field ", "field", "Launch", ""] } });
  assert.equal(created.statusCode, 201, created.body);
  const task = created.json<{ task: TaskRow }>().task;
  assert.deepEqual(task.labels, ["Field", "Launch"]);
  const patched = await mira.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: { labels: ["Print"] } });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.deepEqual(patched.json<{ task: TaskRow }>().task.labels, ["Print"]);
  const tooLong = await mira.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: { labels: ["x".repeat(41)] } });
  assert.equal(tooLong.statusCode, 400, tooLong.body);
  const tooMany = await mira.inject({ method: "POST", url: "/api/tasks", payload: { title: "Many", labels: Array.from({ length: 21 }, (_, index) => `l${index}`) } });
  assert.equal(tooMany.statusCode, 400, tooMany.body);
  const plain = await mira.inject({ method: "POST", url: "/api/tasks", payload: { title: "No labels" } });
  assert.deepEqual(plain.json<{ task: TaskRow }>().task.labels, []);
});
