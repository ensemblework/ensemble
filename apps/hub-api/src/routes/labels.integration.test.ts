/**
 * Board labels over HTTP: each board keeps its own list, names map to the board's label (created when
 * missing), and a label moves, renames and deletes with its board's items. In-memory PGlite unless
 * ENSEMBLE_TEST_DATABASE_URL names a test database.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { Settings, labelTone, type BoardLabelList, type BoardLabelRecord, type PageBoardRecord } from "@ensemble/shared-types";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { ToolContext } from "../assistant/types.js";

const harness = await createHttpHarness();
after(() => harness.close());

async function json<T>(user: HttpUser, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown, status = method === "POST" ? 201 : 200): Promise<T> {
  const response = await user.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  assert.equal(response.statusCode, status, `${method} ${url}: ${response.body}`);
  return response.json<T>();
}
const list = (user: HttpUser, query: string) => json<BoardLabelList>(user, "GET", `/api/labels?${query}`);
const names = (labels: BoardLabelRecord[]) => labels.map((label) => label.name);
const newTask = async (user: HttpUser, title: string, labels: string[]) => (await json<{ task: { id: string; labels: string[] } }>(user, "POST", "/api/tasks", { title, labels })).task;
const taskLabels = async (user: HttpUser, id: string) => (await json<{ task: { labels: string[] } }>(user, "GET", `/api/tasks/${id}`)).task.labels;
async function newBoard(user: HttpUser) {
  const columns = [{ id: randomUUID(), name: "Doing", color: "blue" }, { id: randomUUID(), name: "Done", color: "green" }];
  return (await json<{ board: PageBoardRecord }>(user, "POST", "/api/boards", { title: "Research", columns })).board;
}
const toBoard = (user: HttpUser, kind: "task" | "page", id: string, board: PageBoardRecord | null) =>
  json(user, "PUT", `/api/pages/${kind}/${id}/board`, { boardId: board?.id ?? null, columnId: board?.columns[0]!.id ?? null });

test("a name joins the board's list once, whatever its case, in a colour of its own", async () => {
  const user = await harness.asUser();
  const first = await newTask(user, "Plan launch", ["Launch", " field  work ", "launch"]);
  assert.deepEqual(first.labels, ["Launch", "field work"], "cleaned and de-duplicated");
  const second = await newTask(user, "Print posters", ["LAUNCH", "Print"]);
  assert.deepEqual(second.labels, ["Launch", "Print"], "an existing name takes the board's spelling");
  const ensemble = await list(user, "board=ensemble");
  assert.equal(ensemble.board.id, "ensemble");
  assert.deepEqual(names(ensemble.labels), ["Launch", "field work", "Print"]);
  assert.deepEqual(ensemble.labels.map((label) => label.count), [2, 1, 1]);
  assert.equal(new Set(ensemble.labels.map((label) => label.color)).size, 3, "new labels get different colours");
  // An old client patching names keeps working: an unknown one is created on the board.
  const patched = await json<{ task: { labels: string[] } }>(user, "PATCH", `/api/tasks/${first.id}`, { labels: ["print", "Docs"] });
  assert.deepEqual(patched.task.labels, ["Print", "Docs"]);
  assert.deepEqual(names((await list(user, `task=${first.id}`)).labels), ["Launch", "field work", "Print", "Docs"]);

  // The assistant's and the bridge's tools pass names too.
  const { getTool } = await import("../assistant/registry.js");
  const ctx: ToolContext = { app: { log: { warn() {}, error() {} } } as unknown as ToolContext["app"], prisma: harness.prisma, userId: user.id, actor: "agent", settings: Settings.parse({}) };
  const update = getTool("hub_update_task")!;
  await update.run(ctx, update.input.parse({ taskId: second.id, matchTitle: "Print posters", labels: ["docs", "Review"] }));
  assert.deepEqual(await taskLabels(user, second.id), ["Docs", "Review"]);
  const listTool = getTool("hub_list_tasks")!;
  const found = await listTool.run(ctx, listTool.input.parse({ label: "DOCS" }));
  assert.deepEqual((found.data as { tasks: Array<{ id: string }> }).tasks.map((row) => row.id).sort(), [first.id, second.id].sort(), "the label filter ignores case");
});

test("each board has its own labels; moving an item carries its labels over in their colours", async () => {
  const user = await harness.asUser();
  const board = await newBoard(user);
  const mine = await json<{ label: BoardLabelRecord }>(user, "POST", "/api/labels", { board: board.id, name: "Launch" });
  const again = await json<{ label: BoardLabelRecord }>(user, "POST", "/api/labels", { board: board.id, name: "launch" }, 200);
  assert.equal(again.label.id, mine.label.id, "one label per name on a board");
  await json(user, "POST", "/api/labels", { board: "ensemble", name: "Launch", color: "red" });
  const ensemble = await list(user, "board=ensemble");
  assert.notEqual(ensemble.labels[0]!.id, mine.label.id, "the same name on another board is another label");
  assert.equal(ensemble.labels[0]!.color, "red");

  const task = await newTask(user, "Ship", ["Launch", "Beta"]);
  await toBoard(user, "task", task.id, board);
  const custom = await list(user, `task=${task.id}`);
  assert.equal(custom.board.id, board.id, "the task now picks from its board");
  assert.deepEqual(names(custom.labels), ["Launch", "Beta"]);
  const beta = ensemble.labels.find((label) => label.name === "Beta") ?? (await list(user, "board=ensemble")).labels.find((label) => label.name === "Beta")!;
  assert.equal(custom.labels.find((label) => label.name === "Beta")!.color, beta.color, "a carried label keeps its colour");
  assert.equal(custom.labels.find((label) => label.name === "Launch")!.color, mine.label.color, "the board's own label wins");

  // A label written on the custom board's task lands on that board only.
  await json(user, "PATCH", `/api/tasks/${task.id}`, { labels: ["Launch", "Lab only"] });
  assert.equal(names((await list(user, "board=ensemble")).labels).includes("Lab only"), false);
  assert.equal(names((await list(user, `board=${board.id}`)).labels).includes("Lab only"), true);

  // Deleting the board returns its task to the Ensemble board with its labels; its own list goes.
  assert.equal((await user.inject({ method: "DELETE", url: `/api/boards/${board.id}` })).statusCode, 204);
  const after = await list(user, `task=${task.id}`);
  assert.equal(after.board.id, "ensemble");
  assert.deepEqual(names(after.labels).filter((name) => ["Launch", "Lab only"].includes(name)).sort(), ["Lab only", "Launch"]);
  assert.equal(await harness.prisma.boardLabel.count({ where: { userId: user.id, boardKey: board.id } }), 0);
});

test("renaming, recolouring and deleting a label reach every item of its board, and only its board", async () => {
  const user = await harness.asUser();
  const board = await newBoard(user);
  const here = await newTask(user, "Here", ["Launch"]);
  const there = await newTask(user, "There", ["Launch"]);
  await toBoard(user, "task", there.id, board);
  const project = (await json<{ project: { id: string } }>(user, "POST", "/api/projects", { name: "Atlas" })).project;
  const deliverable = (await json<{ deliverable: { id: string } }>(user, "POST", "/api/deliverables", { title: "Report", projectId: project.id })).deliverable;
  const saved = await json<{ deliverable: { labels: string[] } }>(user, "PATCH", `/api/deliverables/${deliverable.id}`, { labels: ["launch"] });
  assert.deepEqual(saved.deliverable.labels, ["Launch"], "deliverables pick from the Ensemble board");
  const note = (await json<{ page: { id: string } }>(user, "POST", "/api/pages")).page;
  const labelled = await json<{ labels: string[] }>(user, "PATCH", `/api/pages/${note.id}`, { labels: ["LAUNCH", "Notes"] });
  assert.deepEqual(labelled.labels, ["Launch", "Notes"], "a note on no board uses the Ensemble board's list");
  assert.deepEqual((await json<{ labels: string[] }>(user, "GET", `/api/pages/${note.id}`)).labels, ["Launch", "Notes"]);

  const launch = (await list(user, "board=ensemble")).labels.find((label) => label.name === "Launch")!;
  assert.equal(launch.count, 3, "a task, a deliverable and a note");
  const renamed = await json<{ label: BoardLabelRecord; changed: number }>(user, "PATCH", `/api/labels/${launch.id}`, { name: "Go live", color: "pink" });
  assert.equal(renamed.changed, 3);
  assert.equal(renamed.label.color, "pink");
  assert.deepEqual(await taskLabels(user, here.id), ["Go live"]);
  assert.deepEqual(await taskLabels(user, there.id), ["Launch"], "the custom board's label is its own");
  assert.deepEqual((await json<{ labels: string[] }>(user, "GET", `/api/pages/${note.id}`)).labels, ["Go live", "Notes"]);
  const clash = await user.inject({ method: "PATCH", url: `/api/labels/${launch.id}`, payload: { name: "notes" } });
  assert.equal(clash.statusCode, 409, "a board's names stay unique");

  await json(user, "DELETE", `/api/labels/${launch.id}`);
  assert.deepEqual(await taskLabels(user, here.id), []);
  assert.deepEqual((await json<{ deliverables: Array<{ id: string; labels: string[] }> }>(user, "GET", "/api/deliverables")).deliverables.find((row) => row.id === deliverable.id)!.labels, []);
  assert.deepEqual(names((await list(user, "board=ensemble")).labels), ["Notes"]);
  assert.deepEqual(await taskLabels(user, there.id), ["Launch"]);

  // Moving the note to the custom board brings its label along.
  await toBoard(user, "page", note.id, board);
  assert.deepEqual(names((await list(user, `page=${note.id}`)).labels).sort(), ["Launch", "Notes"]);
  // A copy of it lands on no board, with its labels on the Ensemble board's list.
  const copy = (await json<{ page: { id: string } }>(user, "POST", `/api/pages/${note.id}/duplicate`)).page;
  assert.deepEqual((await json<{ labels: string[] }>(user, "GET", `/api/pages/${copy.id}`)).labels, ["Notes"]);
  assert.equal((await list(user, `page=${copy.id}`)).board.id, "ensemble");
});

test("labels are the space's own: another account sees and changes none of them", async () => {
  const owner = await harness.asUser(), other = await harness.asUser();
  await newTask(owner, "Mine", ["Secret"]);
  const label = (await list(owner, "board=ensemble")).labels[0]!;
  assert.deepEqual((await list(other, "board=ensemble")).labels, []);
  assert.equal((await other.inject({ method: "PATCH", url: `/api/labels/${label.id}`, payload: { name: "Taken" } })).statusCode, 404);
  assert.equal((await other.inject({ method: "DELETE", url: `/api/labels/${label.id}` })).statusCode, 404);
  const board = await newBoard(owner);
  assert.equal((await other.inject({ method: "GET", url: `/api/labels?board=${board.id}` })).statusCode, 404);
  assert.equal((await other.inject({ method: "POST", url: "/api/labels", payload: { board: board.id, name: "X" } })).statusCode, 404);
});

test("bad input is refused", async () => {
  const user = await harness.asUser();
  assert.equal((await user.inject({ method: "POST", url: "/api/labels", payload: { board: "ensemble", name: "   " } })).statusCode, 400);
  assert.equal((await user.inject({ method: "POST", url: "/api/labels", payload: { board: "ensemble", name: "A", color: "teal" } })).statusCode, 400);
  assert.equal((await user.inject({ method: "GET", url: "/api/labels" })).statusCode, 400);
  assert.equal((await user.inject({ method: "GET", url: `/api/labels?board=ensemble&task=${randomUUID()}` })).statusCode, 400);
  assert.equal((await user.inject({ method: "PATCH", url: `/api/labels/${randomUUID()}`, payload: {} })).statusCode, 400);
  // A label no one picked a colour for has the one its name hashes to.
  await harness.prisma.boardLabel.create({ data: { userId: user.id, boardKey: "", name: "Legacy", nameKey: "legacy", color: null } });
  assert.equal((await list(user, "board=ensemble")).labels[0]!.color, labelTone("Legacy"));
});

test("renaming or deleting a label on thousands of items finishes, Trash included, keeping each item's order", async () => {
  const user = await harness.asUser();
  await newTask(user, "Seed", ["Wide"]);
  const label = (await list(user, "board=ensemble")).labels.find((row) => row.name === "Wide")!;
  const many = 3000;
  await harness.prisma.task.createMany({
    data: Array.from({ length: many }, (_, index) => ({ userId: user.id, title: `Bulk ${index}`, labels: index % 2 ? ["Other", "Wide"] : ["wide"], ...(index % 3 === 0 ? { deletedAt: new Date() } : {}) })),
  });
  const renamed = await json<{ changed: number }>(user, "PATCH", `/api/labels/${label.id}`, { name: "Broad" });
  assert.equal(renamed.changed, many + 1, "every spelling, live and in Trash");
  assert.equal(await harness.prisma.task.count({ where: { userId: user.id, labels: { has: "Broad" } } }), many + 1);
  assert.equal(await harness.prisma.task.count({ where: { userId: user.id, labels: { hasSome: ["Wide", "wide"] } } }), 0);
  assert.deepEqual((await harness.prisma.task.findFirstOrThrow({ where: { userId: user.id, title: "Bulk 1" } })).labels, ["Other", "Broad"]);
  const removed = await json<{ changed: number }>(user, "DELETE", `/api/labels/${label.id}`);
  assert.equal(removed.changed, many + 1);
  assert.deepEqual((await harness.prisma.task.findFirstOrThrow({ where: { userId: user.id, title: "Bulk 1" } })).labels, ["Other"]);
  assert.deepEqual((await harness.prisma.task.findFirstOrThrow({ where: { userId: user.id, title: "Bulk 0" } })).labels, []);
});

test("label edits leave items' versions alone, so a pending Undo still restores them", async () => {
  const user = await harness.asUser();
  const live = await newTask(user, "Live", ["Launch"]);
  const binned = await newTask(user, "Binned", ["Launch"]);
  const trashed = await json<{ undoEntryId: string }>(user, "DELETE", `/api/tasks/${binned.id}`);
  const version = async (id: string) => (await harness.prisma.task.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } })).updatedAt.getTime();
  const liveBefore = await version(live.id);
  const launch = (await list(user, "board=ensemble")).labels.find((row) => row.name === "Launch")!;
  await json(user, "PATCH", `/api/labels/${launch.id}`, { name: "Go live" });
  assert.equal(await version(live.id), liveBefore, "a rename is not an edit of the item");
  const restored = await user.inject({ method: "POST", url: "/api/undo", payload: { entryId: trashed.undoEntryId } });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.deepEqual(await taskLabels(user, binned.id), ["Go live"]);

  // Deleting a board carries a trashed note's labels (to the Ensemble board's spelling) without breaking its Trash undo.
  await newTask(user, "Lab work", ["lab"]);
  const board = await newBoard(user);
  const note = (await json<{ page: { id: string } }>(user, "POST", "/api/pages")).page;
  await toBoard(user, "page", note.id, board);
  await json(user, "PATCH", `/api/pages/${note.id}`, { labels: ["Lab"] });
  const binnedNote = await json<{ undoEntryId: string }>(user, "POST", "/api/pages/delete-many", { pageIds: [note.id] }, 200);
  assert.equal((await user.inject({ method: "DELETE", url: `/api/boards/${board.id}` })).statusCode, 204);
  const back = await user.inject({ method: "POST", url: "/api/undo", payload: { entryId: binnedNote.undoEntryId } });
  assert.equal(back.statusCode, 200, back.body);
  assert.deepEqual((await json<{ labels: string[] }>(user, "GET", `/api/pages/${note.id}`)).labels, ["lab"]);
});

test("someone a page, task or board is shared with sees labels but does not change the owner's list", async () => {
  const owner = await harness.asUser(), guest = await harness.asUser();
  const note = (await json<{ page: { id: string } }>(owner, "POST", "/api/pages")).page;
  await json(owner, "PATCH", `/api/pages/${note.id}`, { labels: ["Draft"] });
  const task = await newTask(owner, "Shared work", ["Draft"]);
  const share = async (kind: "page" | "task" | "board", resourceId: string) =>
    (await harness.prisma.share.create({ data: { spaceId: owner.id, kind, resourceId, recipientId: guest.id, role: "edit", createdBy: owner.id } })).id;
  const as = (shareId: string) => ({ "x-ensemble-share": shareId });
  const pageShare = await share("page", note.id);
  assert.deepEqual((await guest.inject({ method: "GET", url: `/api/pages/${note.id}`, headers: as(pageShare) })).json().labels, ["Draft"]);
  assert.equal((await guest.inject({ method: "PATCH", url: `/api/pages/${note.id}`, payload: { labels: ["Mine"] }, headers: as(pageShare) })).statusCode, 403);
  assert.equal((await guest.inject({ method: "PATCH", url: `/api/pages/${note.id}`, payload: { title: "Renamed by a guest" }, headers: as(pageShare) })).statusCode, 200, "other edits still work");
  assert.equal((await guest.inject({ method: "GET", url: `/api/labels?page=${note.id}`, headers: as(pageShare) })).statusCode, 403);
  const taskShare = await share("task", task.id);
  assert.equal((await guest.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: { labels: ["Mine"] }, headers: as(taskShare) })).statusCode, 403);
  assert.equal((await guest.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: { priority: "p0" }, headers: as(taskShare) })).statusCode, 200);
  const boardShare = await share("board", owner.id);
  assert.equal((await guest.inject({ method: "POST", url: "/api/tasks", payload: { title: "From a guest", labels: ["Mine"] }, headers: as(boardShare) })).statusCode, 403);
  assert.equal((await guest.inject({ method: "POST", url: "/api/tasks", payload: { title: "From a guest" }, headers: as(boardShare) })).statusCode, 201);
  assert.deepEqual(names((await list(owner, "board=ensemble")).labels), ["Draft"]);
});

test("names compare by the Hub's own key, and labels the migration keyed another way are repaired", async () => {
  const user = await harness.asUser();
  await newTask(user, "A", ["Über"]);
  assert.deepEqual((await newTask(user, "B", ["über"])).labels, ["Über"], "one label, whatever the case, beyond ASCII too");
  assert.equal((await json<{ label: BoardLabelRecord }>(user, "POST", "/api/labels", { board: "ensemble", name: "ÜBER" }, 200)).label.name, "Über");
  // As the migration leaves them on a C-locale database: SQL lower() did not fold Á or É.
  const other = await harness.asUser();
  await harness.prisma.boardLabel.createMany({ data: [
    { userId: other.id, boardKey: "", name: "Éclair", nameKey: "Éclair", position: 0 },
    { userId: other.id, boardKey: "", name: "éclair", nameKey: "éclair", position: 1 },
    { userId: other.id, boardKey: "", name: "Ärger", nameKey: "Ärger", position: 2 },
  ] });
  await harness.prisma.task.createMany({ data: [
    { userId: other.id, title: "E1", labels: ["Éclair", "Plain"] },
    { userId: other.id, title: "E2", labels: ["éclair"] },
    { userId: other.id, title: "E3", labels: ["Ärger"], deletedAt: new Date() },
  ] });
  const { repairLabelKeys } = await import("../labels/board-labels.js");
  assert.equal(await repairLabelKeys(harness.prisma), 2);
  assert.deepEqual(names((await list(other, "board=ensemble")).labels), ["éclair", "Ärger"]);
  const labelsOf = async (title: string) => (await harness.prisma.task.findFirstOrThrow({ where: { userId: other.id, title } })).labels;
  assert.deepEqual(await labelsOf("E1"), ["éclair", "Plain"], "items of the merged label take the kept spelling");
  assert.deepEqual(await labelsOf("E3"), ["Ärger"]);
  assert.deepEqual((await newTask(other, "E4", ["ärger"])).labels, ["Ärger"], "the fixed key is found");
  assert.equal(await repairLabelKeys(harness.prisma), 0, "a second run changes nothing");
});

test("meeting follow-ups take their labels from the board's list", async () => {
  const user = await harness.asUser();
  await json(user, "POST", "/api/labels", { board: "ensemble", name: "Waiting-On" });
  const { createProposals } = await import("../connectors/triage.js");
  await createProposals(user.id, [{ sourceRef: `test:${randomUUID()}`, sourceKind: "meeting", title: "Send the deck", description: "", priority: "p1", artifactId: randomUUID(), rationale: "Asked in the meeting.", labels: ["waiting-on", "Deck"], linkArtifact: false }], "heuristic");
  const task = await harness.prisma.task.findFirstOrThrow({ where: { userId: user.id, title: "Send the deck" } });
  assert.deepEqual(task.labels, ["Waiting-On", "Deck"]);
  assert.deepEqual(names((await list(user, "board=ensemble")).labels), ["Waiting-On", "Deck"]);
});
