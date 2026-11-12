import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

/** What stays with the person in Ensemble: off the list, whatever a key's grants. */
const KEPT = ["hub_update_settings", "hub_choose_model", "hub_edit_layout", "hub_stop_activity", "hub_assign_to_agent", "hub_run_workflow", "hub_create_watcher", "hub_cancel_watcher", "hub_edit_file"];

test("every allowlisted action is a tool the assistant has; settings, layouts, runs, agents, workflows, watchers and file edits are not on the list", () => {
  for (const name of Object.keys(BRIDGE_ACTIONS)) assert.ok(getTool(name), name);
  for (const name of [...KEPT, "hub_view_file"]) assert.equal(BRIDGE_ACTIONS[name], undefined, name);
  for (const name of ["hub_manage_skill", "hub_delete_tasks", "hub_delete_pages", "hub_delete_board", "hub_create_routine", "hub_update_routine", "hub_create_reminder", "hub_get_settings", "hub_read_layout", "hub_list_runs", "hub_list_agent_sessions", "hub_save_file"]) {
    assert.ok(BRIDGE_ACTIONS[name], name);
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

  const related = await act(key, "hub_update_person", { personId: priya.id, relationship: "my manager" });
  assert.equal(related.statusCode, 200, related.body);
  assert.equal((await db.person.findUniqueOrThrow({ where: { id: priya.id } })).relationship, "my manager");

  const project2 = await act(key, "hub_update_project", { projectId: project.id, summary: "Search latency for the beta", personIds: [priya.id] });
  assert.equal(project2.statusCode, 200, project2.body);
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: project.id } })).summary, "Search latency for the beta");

  const ledger = await db.auditLedger.findMany({ where: { userId: user.id, action: { startsWith: "bridge." } }, select: { action: true } });
  for (const action of ["bridge.hub_update_task", "bridge.hub_create_page", "bridge.hub_create_board", "bridge.hub_create_diagram", "bridge.hub_update_project"]) {
    assert.ok(ledger.some((entry) => entry.action === action), action);
  }
  assert.ok((await db.undoEntry.count({ where: { userId: user.id } })) >= 2, "task and page changes are in Undo");

  // Bulk deletes are a key's too; settings stay with the person in Ensemble.
  const spare = await db.task.create({ data: { userId: user.id, title: "Old spike", status: "todo", createdBy: "me" } });
  const bulk = await act(key, "hub_delete_tasks", { taskIds: [spare.id] });
  assert.equal(bulk.statusCode, 200, bulk.body);
  assert.ok((await db.task.findUniqueOrThrow({ where: { id: spare.id } })).deletedAt, "moved to Trash");
  const settings = await act(key, "hub_update_settings", { changes: [] });
  assert.equal(settings.statusCode, 404);
  assert.match(settings.json<{ error: string }>().error, /stays with the person in Ensemble/);
  const wrong = await act(key, "hub_create_page", { heading: "No title" });
  assert.equal(wrong.statusCode, 400);
  assert.ok(wrong.json<{ inputSchema?: unknown }>().inputSchema, "a wrong input returns the schema");
});

test("a key reads the rest of Ensemble and changes skills, routines, reminders and desk lists; what changes how Ensemble behaves stays with the person", async () => {
  const { user, key } = await keyFor({ canWrite: true });
  const listed = await key.inject({ method: "GET", url: "/api/bridge/actions" });
  assert.equal(listed.statusCode, 200, listed.body);
  const listing = listed.json<{ groups: string[]; notOffered: string; actions: Array<{ name: string; allowed: boolean; limit?: string }> }>();
  for (const group of ["context", "skills", "routines", "reminders", "desk", "calendar", "runs", "agents", "code", "settings", "layouts", "imports", "relationships"]) assert.ok(listing.groups.includes(group), group);
  const names = listing.actions.map((row) => row.name);
  for (const name of KEPT) assert.ok(!names.includes(name), name);
  assert.match(listing.actions.find((row) => row.name === "hub_update_routine")?.limit ?? "", /delete is refused/);
  assert.match(listing.actions.find((row) => row.name === "hub_delete_entity")?.limit ?? "", /files stay/);
  assert.match(listing.notOffered, /settings, model choice or layouts/);

  const reads: Array<[string, Record<string, unknown>]> = [
    ["hub_get_settings", {}],
    ["hub_find_setting", { query: "theme" }],
    ["hub_read_layout", { surface: "today" }],
    ["hub_read_surface", { path: "/today" }],
    ["hub_list_runs", {}],
    ["hub_list_activity", {}],
    ["hub_list_agent_options", {}],
    ["hub_list_skills", {}],
    ["hub_list_routines", {}],
    ["hub_list_reminders", {}],
    ["hub_list_watchers", {}],
    ["hub_list_desk_items", {}],
    ["hub_list_events", {}],
    ["hub_search_work", { query: "latency" }],
  ];
  for (const [name, input] of reads) {
    const read = await act(key, name, input);
    assert.equal(read.statusCode, 200, `${name}: ${read.body}`);
  }

  const skill = await act(key, "hub_manage_skill", { action: "create", name: "PR notes", body: "Lead with the user-visible change." });
  assert.equal(skill.statusCode, 200, skill.body);
  assert.equal(await db.skill.count({ where: { userId: user.id, name: "PR notes", deletedAt: null } }), 1);

  const routine = await act(key, "hub_create_routine", { title: "Monday plan", instruction: "List what is due this week.", every: "week", days: ["mon"], time: "09:00" });
  assert.equal(routine.statusCode, 200, routine.body);
  const routineId = (await db.assistantRoutine.findFirstOrThrow({ where: { userId: user.id, title: "Monday plan" } })).id;
  const paused = await act(key, "hub_update_routine", { routineId, action: "pause" });
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal((await db.assistantRoutine.findUniqueOrThrow({ where: { id: routineId } })).status, "paused");
  const dropRoutine = await act(key, "hub_update_routine", { routineId, action: "delete" });
  assert.equal(dropRoutine.statusCode, 403);
  assert.match(dropRoutine.json<{ error: string }>().error, /Routines are deleted by the person/);
  assert.ok(await db.assistantRoutine.findUnique({ where: { id: routineId } }), "the routine stays");

  const reminder = await act(key, "hub_create_reminder", { title: "Call Priya", dueDate: "2026-12-01" });
  assert.equal(reminder.statusCode, 200, reminder.body);
  const reminderId = (await db.reminder.findFirstOrThrow({ where: { userId: user.id, title: "Call Priya" } })).id;
  assert.equal((await act(key, "hub_delete_reminder", { reminderId })).statusCode, 200);
  const objective = await act(key, "hub_add_desk_item", { kind: "objective", title: "Ship the beta", progress: 10 });
  assert.equal(objective.statusCode, 200, objective.body);

  // Trash: a project, and back with any restore; a file never.
  const project = await db.project.create({ data: { userId: user.id, name: "Spike", createdBy: "me" } });
  assert.equal((await act(key, "hub_delete_entity", { kind: "project", id: project.id })).statusCode, 200);
  const restored = await act(key, "hub_manage_record", { action: "restore", kind: "project", id: project.id });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: project.id } })).deletedAt, null);
  const uploaded = await key.inject({ method: "POST", url: "/api/bridge/write/files", payload: { filename: "plan.md", dataBase64: Buffer.from("# Plan").toString("base64") } });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const fileId = uploaded.json<{ file: { id: string } }>().file.id;
  const fileKept = await act(key, "hub_delete_entity", { kind: "document", id: fileId });
  assert.equal(fileKept.statusCode, 403);
  assert.match(fileKept.json<{ error: string }>().error, /Files cannot be deleted from editors and agents/);
  assert.equal((await db.document.findUniqueOrThrow({ where: { id: fileId } })).deletedAt, null);

  for (const name of KEPT) {
    const kept = await act(key, name, {});
    assert.equal(kept.statusCode, 404, name);
    assert.match(kept.json<{ error: string }>().error, /stays with the person in Ensemble/, name);
  }
  assert.match((await act(key, "hub_view_file", { id: fileId })).json<{ error: string }>().error, /ensemble_get_file/);
});

test("an agent run keeps the everyday list", async () => {
  const user = await h.asUser();
  const { runActionCaller } = await import("../workspace/context-tools.js");
  const { listActions, runAction } = await import("./actions.js");
  const run = runActionCaller(user.id, (await db.user.findUniqueOrThrow({ where: { id: user.id } })).moduleSet);
  const names = listActions(run).map((row) => row.name);
  assert.ok(names.includes("hub_update_task"));
  for (const name of ["hub_manage_skill", "hub_create_routine", "hub_delete_tasks", "hub_get_settings", "hub_save_file"]) assert.ok(!names.includes(name), name);
  await assert.rejects(runAction(h.app, run, "hub_create_routine", { title: "Daily", instruction: "Sum up." }), /Agent runs cannot use hub_create_routine/);
  await assert.rejects(runAction(h.app, run, "hub_manage_record", { action: "delete_dataset", id: randomUUID() }), /ask the person to do it in Ensemble/);
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
  // An untitled standalone page takes the file as well.
  const untitled = await db.taskPage.create({ data: { userId: user.id, title: "", notesSnapshot: "", searchText: "", content: { type: "doc", content: [] } } });
  const onPage = await key.inject({ method: "POST", url: "/api/bridge/write/files", payload: { filename: "chart.txt", dataBase64: Buffer.from("p95").toString("base64"), attachTo: `ensemble://page/${untitled.id}` } });
  assert.equal(onPage.statusCode, 201, onPage.body);
  assert.ok(onPage.json<{ attached: unknown }>().attached);
  assert.match(JSON.stringify((await db.taskPage.findUniqueOrThrow({ where: { id: untitled.id } })).content), new RegExp(onPage.json<{ file: { id: string } }>().file.id));
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
    // The person's switch for changes in connected apps holds for keys too.
    const { saveSettings } = await import("../lib/settings.js");
    await saveSettings(db, user.id, { assistant: { connectedAppWrites: false } });
    const off = await act(both, "demo_post", { text: "again" });
    assert.equal(off.statusCode, 403, off.body);
    assert.equal((await act(both, "demo_echo", { text: "reads still run" })).statusCode, 200);
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
