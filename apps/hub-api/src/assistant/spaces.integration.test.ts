/**
 * The assistant never crosses Ensemble spaces. A second space of the same account is filled
 * using the assistant's own tools; then every Hub tool is called from the first space with the
 * second space's ids and words. Nothing of the second space may come back, and no write may
 * touch it. The same reads run inside the second space as a control, so the test cannot pass
 * by finding nothing anywhere.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DEFAULT_SETTINGS, OPTIONAL_MODULES, serializeModules } from "@ensemble/shared-types";
import { z } from "zod";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import type { AnyHubTool, ToolContext } from "./types.js";

const harness: HttpHarness = await createHttpHarness();
const db = harness.prisma;
// After the harness: the registry's modules load the database client.
const { TOOLS, getTool } = await import("./registry.js");
after(() => harness.close());

const MARK = "Zephyrine";
const MODULES = serializeModules(OPTIONAL_MODULES);

function context(userId: string): ToolContext {
  return { app: harness.app, prisma: db, userId, actor: "agent", settings: { ...DEFAULT_SETTINGS, timezone: "Asia/Kolkata" }, modules: MODULES };
}

async function run(ctx: ToolContext, name: string, input: unknown) {
  const tool = getTool(name);
  assert.ok(tool, `${name} exists`);
  return tool.run(ctx, tool.input.parse(input));
}

async function createSpace(user: HttpUser, name: string): Promise<string> {
  const res = await user.inject({ method: "POST", url: "/api/spaces", payload: { name, templateId: "semester-desk", settings: { mode: "fresh" } } });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { space: { id: string } }).space.id;
}

/** Tools that reach outside the database (the web, a git checkout) are not part of this check. */
const SKIP = new Set(["hub_web_search", "hub_fetch_now", "hub_repo_overview", "hub_repo_read_file", "hub_how_to", "hub_validate_diagram"]);

type Ids = Record<string, string>;

/**
 * Fills a tool's input from its schema: ids from the other space, the marker for searches, a wide
 * date range. `full` also fills optional ids (filters like taskId); the lean one fills only required ids.
 */
function inputFor(tool: AnyHubTool, ids: Ids, full: boolean): Record<string, unknown> | null {
  const outer = tool.input as z.ZodTypeAny;
  const schema = outer instanceof z.ZodEffects ? (outer.innerType() as z.ZodTypeAny) : outer;
  const shape = schema instanceof z.ZodObject ? (schema.shape as Record<string, z.ZodTypeAny>) : null;
  if (!shape) return null;
  const input: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    if (!full && (key === "id" || /Id$/.test(key)) && shape[key]!.isOptional()) continue;
    if (key === "query" || key === "q") input[key] = MARK;
    else if (key === "from") input[key] = "2020-01-01";
    else if (key === "to") input[key] = "2030-12-31";
    else if (key === "matchTitle") input[key] = `${MARK} task`;
    else if (key === "id") input[key] = ids[tool.name.includes("context") ? "artifact" : tool.name.includes("file") ? "file" : "task"];
    else if (/Id$/.test(key)) {
      const kind = key.slice(0, -2);
      if (ids[kind]) input[key] = ids[kind];
    }
  }
  return input;
}

test("every assistant tool stays inside the open space", async () => {
  const mira = await harness.asUser();
  await db.user.update({ where: { id: mira.id }, data: { name: "Mira Chen", onboardingRole: "student", onboardingCompletedAt: new Date(), moduleSet: MODULES } });
  const other = await createSpace(mira, `${MARK} space`);
  await db.user.update({ where: { id: other }, data: { moduleSet: MODULES } });
  const here = context(mira.id);
  const there = context(other);

  // Fill the other space with the assistant's own tools (run directly, as Apply would).
  await run(there, "hub_create_project", { name: `${MARK} project` });
  const project = (await run(there, "hub_list_projects", {})).data as { projects: Array<{ id: string; name: string }> };
  const projectId = project.projects.find((row) => row.name === `${MARK} project`)!.id;
  await run(there, "hub_create_tasks", { tasks: [{ title: `${MARK} task`, description: `${MARK} detail`, projectId }] });
  await run(there, "hub_create_person", { name: `${MARK} Bee`, email: "zephyrine@example.test" });
  await run(there, "hub_create_deliverable", { title: `${MARK} deliverable`, projectId, due: "2026-11-01" });
  await run(there, "hub_create_reminder", { title: `${MARK} reminder`, dueDate: "2026-11-02" });
  const page = (await run(there, "hub_create_page", { title: `${MARK} page`, markdown: `# ${MARK}\n\nSecret ${MARK} plan.` })).data as { id: string };
  const meeting = (await run(there, "hub_create_meeting_note", { title: `${MARK} sync`, date: "2026-10-12", time: "10:00", notes: `${MARK} decided the launch.` })).data as { id: string };
  const dataset = (await run(there, "hub_import_dataset", { name: `${MARK} data`, text: `region,revenue\n${MARK},10\nNorth,20\n` })).data as { dataset?: { id: string }; id?: string };
  const upload = await harness.app.inject({
    method: "POST",
    url: "/api/documents",
    headers: { cookie: `${mira.cookie}; ensemble_space=${other}` },
    payload: { filename: `${MARK}.txt`, mediaType: "text/plain", dataBase64: Buffer.from(`${MARK} contract text`).toString("base64"), summarize: false },
  });
  assert.equal(upload.statusCode, 201, upload.body);
  const fileId = (upload.json() as { file: { id: string } }).file.id;
  const diagram = (await run(there, "hub_create_diagram", { title: `${MARK} flow`, text: `title ${MARK} flow\nnode a "${MARK} step" shape rectangle\nnode b "Done" shape circle\nedge a > b` })).data as { diagram?: { id: string }; id?: string };
  const datasetId = (dataset.dataset?.id ?? dataset.id)!;
  const plot = (await run(there, "hub_create_plot", { title: `${MARK} chart`, datasetId, config: { chart: "bar", x: "region", series: [{ y: "revenue" }] } })).data as { plot?: { id: string }; id?: string };
  const artifact = await db.artifact.create({ data: { userId: other, kind: "email", externalId: `${MARK}-mail`, ts: new Date("2026-10-10T09:00:00Z"), title: `${MARK} mail`, text: `${MARK} wants the budget.` } });
  const task = await db.task.findFirstOrThrow({ where: { userId: other, title: `${MARK} task` } });
  const person = await db.person.findFirstOrThrow({ where: { userId: other, name: `${MARK} Bee` } });
  const deliverable = await db.deliverable.findFirstOrThrow({ where: { userId: other, title: `${MARK} deliverable` } });
  const reminder = await db.reminder.findFirstOrThrow({ where: { userId: other, title: `${MARK} reminder` } });
  const ids: Ids = {
    task: task.id,
    project: projectId,
    person: person.id,
    deliverable: deliverable.id,
    reminder: reminder.id,
    page: page.id,
    meeting: meeting.id,
    dataset: datasetId,
    diagram: (diagram.diagram?.id ?? diagram.id)!,
    plot: (plot.plot?.id ?? plot.id)!,
    file: fileId,
    artifact: artifact.id,
  };
  // The other space's records: their ids and the words stored in them (a tool echoing the search word is not a leak).
  const stored = `${MARK} (task|project|Bee|detail|deliverable|reminder|page|sync|data|mail|space|contract|decided|wants|flow|step|chart)|${MARK}\\.txt|Secret ${MARK}|${MARK},10`;
  const secret = new RegExp([stored, ...Object.values(ids)].join("|"), "i");

  const checked: string[] = [];
  const seenThere: string[] = [];
  for (const tool of TOOLS.values()) {
    if (SKIP.has(tool.name)) continue;
    const extra: Record<string, Array<Record<string, unknown>>> = {
      hub_read_page: [{ pageId: ids.page }],
      hub_update_page: [{ pageId: ids.page, matchTitle: `${MARK} page`, mode: "append", markdown: "Added from another space" }],
      hub_delete_page: [{ pageId: ids.page }],
      hub_delete_pages: [{ pageIds: [ids.page] }],
      hub_delete_entity: [{ kind: "project", id: ids.project }, { kind: "document", id: ids.file }],
      hub_restore_entity: [{ kind: "task", id: ids.task }],
      hub_diagram_context: [{ taskId: ids.task }, { projectId: ids.project }, { deliverableId: ids.deliverable }],
      hub_update_diagram: [{ diagramId: ids.diagram, find: "Done", replace: "Changed" }],
      hub_edit_diagram: [{ diagramId: ids.diagram, ops: [{ op: "rename_node", id: "b", label: "Changed" }] }],
      hub_create_plot: [{ title: "Copy", datasetId: ids.dataset }],
      hub_update_plot: [{ plotId: ids.plot, title: "Changed" }],
      hub_unlink_repo: [{ projectId: ids.project, repoId: ids.task }],
      // Creating in the open space must not attach to the other space's records.
      hub_create_deliverable: [{ title: "Linked across", projectId: ids.project }],
      hub_create_tasks: [{ tasks: [{ title: "Linked across", projectId: ids.project, people: [ids.person] }] }],
      hub_link_repo: [{ fullName: "fieldnote/linked-across", projectId: ids.project }],
      hub_create_watcher: [{ scopeKind: "task", scopeId: ids.task, condition: "all_tasks_done", message: "Across" }],
      hub_create_meeting_note: [{ title: "Linked across", date: "2026-10-12", time: "11:00", notes: "x", attendeeIds: [ids.person] }],
    };
    const variants = [inputFor(tool, ids, false), inputFor(tool, ids, true), ...(extra[tool.name] ?? [])].filter((input): input is Record<string, unknown> => input !== null);
    const tried = new Set<string>();
    for (const input of variants) {
      if (tried.has(JSON.stringify(input))) continue;
      tried.add(JSON.stringify(input));
      const parsed = tool.input.safeParse(input);
      if (!parsed.success) continue;
      if (!tool.isWrite) {
        const control = await tool.run(there, parsed.data).then((result) => JSON.stringify(result), () => "");
        if (secret.test(control) && !seenThere.includes(tool.name)) seenThere.push(tool.name);
      }
      const result = await tool.run(here, parsed.data).then(
        (value) => ({ ok: true as const, text: JSON.stringify(value) }),
        (error: unknown) => ({ ok: false as const, text: error instanceof Error ? error.message : String(error) }),
      );
      if (!checked.includes(tool.name)) checked.push(tool.name);
      if (result.ok) assert.doesNotMatch(result.text, secret, `${tool.name} returned something from the other space`);
      if (tool.isWrite && JSON.stringify(input).match(new RegExp(Object.values(ids).join("|")))) {
        // Refused, or done without touching the other space (checked below by what it holds).
        if (result.ok) assert.doesNotMatch(result.text, secret, `${tool.name} linked to the other space`);
      }
    }
  }

  // The control: the same reads do find the other space's records when run inside it.
  for (const name of ["hub_list_tasks", "hub_list_projects", "hub_list_people", "hub_list_pages", "hub_read_page", "hub_list_files", "hub_read_file", "hub_search_context", "hub_list_meeting_notes", "hub_read_meeting_note", "hub_list_datasets", "hub_get_diagram", "hub_get_plot", "hub_diagram_context"]) {
    assert.ok(seenThere.includes(name), `${name} finds the records inside their own space (saw: ${seenThere.join(", ")})`);
  }
  const unchecked = [...TOOLS.values()].filter((tool) => !SKIP.has(tool.name) && !checked.includes(tool.name)).map((tool) => `${tool.name}${tool.isWrite ? "(w)" : ""}`);
  // Left out: tools that only create something new from words (no ids), and reads with nothing of their kind seeded.
  assert.deepEqual(unchecked.filter((name) => !/^hub_create_(project|reminder|person|diagram|page)\(w\)$|^hub_(read_skill|get_run|add_desk_item\(w\)|remove_desk_item\(w\)|import_app_file\(w\)|save_app_item_as_page\(w\)|update_settings\(w\))$/.test(name)), []);
  assert.ok(checked.length >= 45, `checked ${checked.length} tools`);

  // Nothing in the other space was changed or trashed.
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).deletedAt, null);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).title, `${MARK} task`);
  assert.equal((await db.person.findUniqueOrThrow({ where: { id: person.id } })).deletedAt, null);
  assert.equal((await db.taskPage.findUniqueOrThrow({ where: { id: page.id } })).deletedAt, null);
  assert.equal((await db.document.findUniqueOrThrow({ where: { id: fileId } })).deletedAt, null);
  assert.equal((await db.project.findUniqueOrThrow({ where: { id: projectId } })).deletedAt, null);
  // Nothing in the open space points at the other space's records.
  assert.equal(await db.deliverable.count({ where: { userId: mira.id, projectId } }), 0, "no deliverable under the other space's project");
  assert.equal(await db.task.count({ where: { userId: mira.id, OR: [{ projectId }, { people: { has: ids.person } }] } }), 0, "no task linked across");
  assert.equal(await db.deliverable.count({ where: { userId: other, title: "Linked across" } }), 0);
  assert.equal(await db.task.count({ where: { userId: other, title: "Linked across" } }), 0);
  assert.equal(await db.watcher.count({ where: { userId: mira.id, scopeId: ids.task } }), 0, "no watcher on the other space's task");
  assert.match((await db.blockDiagram.findUniqueOrThrow({ where: { id: ids.diagram } })).source, /"Done"/);
  assert.equal((await db.plot.findUniqueOrThrow({ where: { id: ids.plot } })).title, `${MARK} chart`);
});

test("trashing a file through the assistant hides its text, and restoring brings it back", async () => {
  const mira = await harness.asUser();
  await db.user.update({ where: { id: mira.id }, data: { moduleSet: MODULES } });
  const ctx = context(mira.id);
  const upload = await mira.inject({
    method: "POST",
    url: "/api/documents",
    payload: { filename: "terms.txt", mediaType: "text/plain", dataBase64: Buffer.from("Quillfeather indemnity clause").toString("base64"), summarize: false },
  });
  assert.equal(upload.statusCode, 201, upload.body);
  const fileId = (upload.json() as { file: { id: string } }).file.id;
  const found = async () => JSON.stringify((await run(ctx, "hub_search_context", { query: "Quillfeather" })).data).includes("Quillfeather");
  assert.equal(await found(), true);
  await run(ctx, "hub_delete_entity", { kind: "document", id: fileId });
  assert.equal(await found(), false, "a trashed file's text leaves search");
  await run(ctx, "hub_restore_entity", { kind: "document", id: fileId });
  assert.equal(await found(), true, "restoring the file brings its text back");
});
