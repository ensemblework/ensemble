import assert from "node:assert/strict";
import test, { after } from "node:test";
import { z } from "zod";
import { createHttpHarness } from "../test/http.js";

const h = await createHttpHarness();
after(() => h.close());
const db = h.prisma;
const { registerAppToolSource, registerToolResolver } = await import("../assistant/apps.js");
const { defineTool, toolOk } = await import("../assistant/types.js");
const { BRIDGE_ACTIONS } = await import("./actions.js");
const { getTool } = await import("../assistant/registry.js");

type Key = Awaited<ReturnType<typeof h.asToken>>;

async function keyFor(grants: { canWrite?: boolean; canUseApps?: boolean } = {}) {
  const user = await h.asUser();
  const key = await h.asToken(user, "bridge");
  await db.apiToken.update({ where: { id: key.id }, data: { canWrite: Boolean(grants.canWrite), canUseApps: Boolean(grants.canUseApps) } });
  return { user, key };
}

const act = (key: Key, name: string, input: Record<string, unknown> = {}) => key.inject({ method: "POST", url: `/api/bridge/act/${name}`, payload: { input } });

test("every allowlisted action is a tool the assistant has; settings, skills and bulk deletes are not on the list", () => {
  for (const name of Object.keys(BRIDGE_ACTIONS)) assert.ok(getTool(name), name);
  for (const name of ["hub_update_settings", "hub_manage_skill", "hub_delete_tasks", "hub_delete_pages", "hub_assign_to_agent", "hub_create_routine", "hub_create_reminder", "hub_delete_board", "hub_edit_layout", "hub_run_workflow"]) {
    assert.equal(BRIDGE_ACTIONS[name], undefined, name);
  }
});

test("a read-only key lists and runs the reads, and is refused every change", async () => {
  const { key } = await keyFor();
  const listed = await key.inject({ method: "GET", url: "/api/bridge/actions?groups=pages" });
  assert.equal(listed.statusCode, 200, listed.body);
  const actions = listed.json<{ canWrite: boolean; actions: Array<{ name: string; allowed: boolean; write: boolean; inputSchema?: unknown }> }>();
  assert.equal(actions.canWrite, false);
  assert.ok(actions.actions.every((row) => row.allowed === !row.write));
  assert.ok(actions.actions.every((row) => !row.inputSchema), "schemas only when asked");
  const described = await key.inject({ method: "GET", url: "/api/bridge/actions?names=hub_create_page" });
  assert.ok(described.json<{ actions: Array<{ inputSchema?: unknown }> }>().actions[0]?.inputSchema);

  assert.equal((await act(key, "hub_list_tasks")).statusCode, 200);
  const refused = await act(key, "hub_create_page", { title: "Nope" });
  assert.equal(refused.statusCode, 403);
  assert.match(refused.json<{ error: string }>().error, /read-only/);
  assert.equal((await key.inject({ method: "POST", url: "/api/bridge/write/files", payload: { filename: "a.txt", dataBase64: Buffer.from("hi").toString("base64") } })).statusCode, 403);
});

test("a key with changes allowed edits tasks, pages, boards, diagrams and projects, each in Undo and the ledger", async () => {
  const { user, key } = await keyFor({ canWrite: true });
  const project = await db.project.create({ data: { userId: user.id, name: "Atlas", createdBy: "me" } });
  const priya = await db.person.create({ data: { userId: user.id, name: "Priya Shah" } });
  const task = await db.task.create({ data: { userId: user.id, title: "Write the latency report", status: "todo", createdBy: "me" } });

  const updated = await act(key, "hub_update_task", { taskId: task.id, matchTitle: task.title, owner: "agent", labels: ["perf"], due: "2026-12-01", projectId: project.id, people: [priya.id] });
  assert.equal(updated.statusCode, 200, updated.body);
  const row = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(row.owner, "agent");
  assert.deepEqual(row.labels, ["perf"]);
  assert.equal(row.projectId, project.id);
  assert.ok(row.people.includes(priya.id));
  assert.equal(updated.json<{ undoable?: boolean }>().undoable, true);

  const page = await act(key, "hub_create_page", { title: "Latency notes", markdown: `Owner: [@Priya Shah](ensemble://person/${priya.id})` });
  assert.equal(page.statusCode, 200, page.body);
  const pageId = (page.json<{ data: { id: string } }>().data).id;
  assert.ok(page.json<{ url?: string }>().url?.includes(pageId));

  const board = await act(key, "hub_create_board", { title: "Perf sprint", columns: ["Now", "Next"] });
  assert.equal(board.statusCode, 200, board.body);
  const moved = await act(key, "hub_move_to_board", { board: "Perf sprint", column: "Now", pageId });
  assert.equal(moved.statusCode, 200, moved.body);

  const diagram = await act(key, "hub_create_diagram", { title: "Request path", text: ["title Request path", "", 'node app "Web app"', 'node api "API"', "", "edge app > api", ""].join("\n") });
  assert.equal(diagram.statusCode, 200, diagram.body);

  const project2 = await act(key, "hub_update_project", { projectId: project.id, summary: "Search latency for the beta", personIds: [priya.id] });
  assert.equal(project2.statusCode, 200, project2.body);
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: project.id } })).summary, "Search latency for the beta");

  const ledger = await db.auditLedger.findMany({ where: { userId: user.id, action: { startsWith: "bridge." } }, select: { action: true } });
  for (const action of ["bridge.hub_update_task", "bridge.hub_create_page", "bridge.hub_create_board", "bridge.hub_create_diagram", "bridge.hub_update_project"]) {
    assert.ok(ledger.some((entry) => entry.action === action), action);
  }
  assert.ok((await db.undoEntry.count({ where: { userId: user.id } })) >= 2, "task and page changes are in Undo");

  // What stays with the assistant and Ensemble Node.
  const settings = await act(key, "hub_update_settings", { changes: [] });
  assert.equal(settings.statusCode, 404);
  assert.match(settings.json<{ error: string }>().error, /assistant and Ensemble Node/);
  assert.equal((await act(key, "hub_delete_tasks", { taskIds: [task.id] })).statusCode, 404);
  const guarded = await act(key, "hub_manage_record", { action: "delete_dataset", id: task.id });
  assert.equal(guarded.statusCode, 403);
  const wrong = await act(key, "hub_create_page", { heading: "No title" });
  assert.equal(wrong.statusCode, 400);
  assert.ok(wrong.json<{ inputSchema?: unknown }>().inputSchema, "a wrong input returns the schema");
});

test("route-backed actions work from a key: a dataset and a plot, a page to a task, a page to a file, tasks and meeting notes", async () => {
  const { user, key } = await keyFor({ canWrite: true });
  const dataset = await act(key, "hub_import_dataset", { name: "Latency", text: "week,p95\n1,240\n2,220\n3,195" });
  assert.equal(dataset.statusCode, 200, dataset.body);
  const datasetId = (dataset.json<{ data: { id?: string; datasetId?: string } }>().data);
  const id = datasetId.datasetId ?? datasetId.id;
  assert.ok(id, dataset.body);
  const plot = await act(key, "hub_create_plot", { title: "p95 by week", datasetId: id });
  assert.equal(plot.statusCode, 200, plot.body);

  const page = (await act(key, "hub_create_page", { title: "Beta checklist", markdown: "- warm the cache" })).json<{ data: { id: string } }>().data;
  const exported = await act(key, "hub_export_page_file", { pageId: page.id, format: "md", filename: "beta-checklist.md" });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(await db.document.count({ where: { userId: user.id, filename: "beta-checklist.md" } }), 1);
  const blocks = await act(key, "hub_read_page_blocks", { pageId: page.id });
  const revision = blocks.json<{ data: { revision: number } }>().data.revision;
  const converted = await act(key, "hub_manage_record", { action: "convert_page", kind: "page", id: page.id, revision });
  assert.equal(converted.statusCode, 200, converted.body);
  assert.equal(await db.task.count({ where: { userId: user.id, title: "Beta checklist" } }), 1, "the page is now a task");

  const tasks = await act(key, "hub_create_tasks", { tasks: [{ title: "Send the latency budget", due: "2026-12-04", labels: ["perf"] }] });
  assert.equal(tasks.statusCode, 200, tasks.body);
  const note = await act(key, "hub_create_meeting_note", { title: "Perf sync", notes: "Agreed to warm the cache before the beta." });
  assert.equal(note.statusCode, 200, note.body);
});

test("a file from the editor goes into Files and onto the task's page", async () => {
  const { user, key } = await keyFor({ canWrite: true });
  const task = await db.task.create({ data: { userId: user.id, title: "Ship the deck", status: "todo", createdBy: "me" } });
  const uploaded = await key.inject({
    method: "POST",
    url: "/api/bridge/write/files",
    payload: { filename: "deck-notes.md", dataBase64: Buffer.from("# Deck\nSlides for the beta.").toString("base64"), attachTo: `ensemble://task/${task.id}` },
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const body = uploaded.json<{ file: { id: string; ref: string }; attached: { title: string } }>();
  assert.equal(body.attached.title, "Ship the deck");
  const file = await db.document.findUniqueOrThrow({ where: { id: body.file.id } });
  assert.deepEqual(file.taskIds, [task.id]);
  const page = await db.taskPage.findFirstOrThrow({ where: { taskId: task.id } });
  assert.match(JSON.stringify(page.content), new RegExp(body.file.id));
  const missing = await key.inject({ method: "POST", url: "/api/bridge/write/files", payload: { filename: "a.txt", dataBase64: Buffer.from("hi").toString("base64"), attachTo: "ensemble://task/00000000-0000-4000-8000-000000000000" } });
  assert.equal(missing.statusCode, 404);
});

test("connected apps need their own grant; reads run, changes also need the write grant", async () => {
  const echo = defineTool({ name: "demo_echo", area: "apps", description: "Echo.", input: z.object({ text: z.string() }), isWrite: false, risk: "low", run: async (_ctx, input) => toolOk("Echoed.", { text: input.text }) });
  const post = defineTool({ name: "demo_post", area: "apps", description: "Post.", input: z.object({ text: z.string() }), isWrite: true, risk: "medium", run: async (_ctx, input) => toolOk("Posted.", { id: input.text }) });
  const offSource = registerAppToolSource(async () => [echo, post]);
  const offResolver = registerToolResolver(async (_ctx, name) => [echo, post].find((tool) => tool.name === name));
  try {
    const { key: noApps } = await keyFor({ canWrite: true });
    const closed = await noApps.inject({ method: "GET", url: "/api/bridge/apps" });
    assert.equal(closed.json<{ allowed: boolean; tools: unknown[] }>().allowed, false);
    assert.deepEqual(closed.json<{ tools: unknown[] }>().tools, []);
    assert.equal((await act(noApps, "demo_echo", { text: "hi" })).statusCode, 403);

    const { key: readsApps } = await keyFor({ canUseApps: true });
    const apps = await readsApps.inject({ method: "GET", url: "/api/bridge/apps" });
    assert.equal(apps.statusCode, 200, apps.body);
    assert.ok(apps.json<{ tools: Array<{ name: string }> }>().tools.some((tool) => tool.name === "demo_echo"));
    const echoed = await act(readsApps, "demo_echo", { text: "hi" });
    assert.equal(echoed.statusCode, 200, echoed.body);
    assert.deepEqual(echoed.json<{ data: unknown }>().data, { text: "hi" });
    assert.equal((await act(readsApps, "demo_post", { text: "x" })).statusCode, 403);

    const { user, key: both } = await keyFor({ canWrite: true, canUseApps: true });
    const posted = await act(both, "demo_post", { text: "launch" });
    assert.equal(posted.statusCode, 200, posted.body);
    assert.equal(await db.auditLedger.count({ where: { userId: user.id, action: "apps.demo_post" } }), 1);
  } finally {
    offSource();
    offResolver();
  }
});

test("the hosted MCP endpoint offers the actions and runs one", async () => {
  const { user, key } = await keyFor({ canWrite: true });
  const rpc = (body: unknown) => key.inject({ method: "POST", url: "/mcp", headers: { accept: "application/json, text/event-stream", "content-type": "application/json" }, payload: JSON.stringify(body) });
  const listed = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(listed.statusCode, 200, listed.body);
  const names = listed.json<{ result: { tools: Array<{ name: string }> } }>().result.tools.map((tool) => tool.name);
  for (const name of ["ensemble_actions", "ensemble_act", "ensemble_upload_file"]) assert.ok(names.includes(name), name);
  assert.ok(!names.includes("ensemble_apps"), "no apps without the apps grant");
  const called = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ensemble_act", arguments: { action: "hub_create_page", input: { title: "From MCP" } } } });
  assert.equal(called.statusCode, 200, called.body);
  assert.notEqual(called.json<{ result: { isError?: boolean } }>().result.isError, true, called.body);
  assert.equal(await db.taskPage.count({ where: { userId: user.id, title: "From MCP" } }), 1);
});
