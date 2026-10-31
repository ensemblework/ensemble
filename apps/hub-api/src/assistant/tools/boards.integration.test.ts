/**
 * Custom boards through the assistant's tools (assistant/tools/boards.ts), as the Hub assistant and,
 * through the space gateway, Ensemble Node use them: read a board by its pasted link, id or title;
 * make one and change its columns; put, place, move and take off tasks and notes; delete a board
 * (always held); and a node reading where its owner views and changing boards only where they edit.
 * The Board screen's routes see every change the same way (pages/boards.ts is shared).
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DEFAULT_SETTINGS, OPTIONAL_MODULES, serializeModules, type PageBoardRecord } from "@ensemble/shared-types";
import { createHttpHarness, type HttpUser } from "../../test/http.js";
import type { AnyHubTool, ToolContext } from "../types.js";

const h = await createHttpHarness();
const db = h.prisma;
const { getTool } = await import("../registry.js");
const { holdsAssistantWrite } = await import("../agent.js");
const { nodeSpaceGateway } = await import("../../node/spaces.js");
const { createSpaceUser } = await import("../../spaces/store.js");
after(() => h.close());

const MODULES = serializeModules(OPTIONAL_MODULES);
const context = (userId: string): ToolContext => ({ app: h.app, prisma: db, userId, actor: "agent", settings: { ...DEFAULT_SETTINGS }, modules: MODULES });
const tool = (name: string): AnyHubTool => {
  const found = getTool(name);
  assert.ok(found, `${name} exists`);
  return found;
};

/** The text a refusal gives the model: its message and its remedy (assistant/agent.ts `describe`). */
async function refused(work: Promise<unknown>, expected: RegExp) {
  await assert.rejects(work, (error: Error & { remedy?: string }) => {
    assert.match([error.message, error.remedy].filter(Boolean).join(" "), expected);
    return true;
  });
}

/** As a turn runs a call: parse, prepare (the exact records), then run. */
async function call(ctx: ToolContext, name: string, input: unknown, use: AnyHubTool = tool(name)) {
  let parsed = use.input.parse(input);
  if (use.spaceFor) ctx = { ...ctx, space: await use.spaceFor(ctx, parsed) };
  if (use.prepare) parsed = await use.prepare(ctx, parsed);
  return use.run(ctx, parsed);
}

async function hubBoard(user: HttpUser, title: string, names = ["To do", "In progress", "Done"]): Promise<PageBoardRecord> {
  const columns = names.map((name) => ({ id: crypto.randomUUID(), name, color: "gray" }));
  const response = await user.inject({ method: "POST", url: "/api/boards", payload: { title, columns } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<{ board: PageBoardRecord }>().board;
}

async function hubTask(user: HttpUser, title: string, status = "todo"): Promise<string> {
  const response = await user.inject({ method: "POST", url: "/api/tasks", payload: { title, status, owner: "me" } });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { task: { id: string } }).task.id;
}

async function note(userId: string, title: string): Promise<string> {
  return ((await call(context(userId), "hub_create_page", { title, markdown: `${title} body.` })).data as { id: string }).id;
}

/** The Board screen's own view of a board: card ids per column, in order. */
async function screen(user: HttpUser, boardId: string): Promise<Record<string, string[]>> {
  const response = await user.inject({ method: "GET", url: `/api/boards/${boardId}` });
  assert.equal(response.statusCode, 200, response.body);
  const { board, pages } = response.json() as { board: PageBoardRecord; pages: Array<{ id: string; columnId: string }> };
  return Object.fromEntries(board.columns.map((column) => [column.name, pages.filter((page) => page.columnId === column.id).map((page) => page.id)]));
}

type Read = { board: { id: string; title: string; url: string }; columns: Array<{ id: string; name: string; count: number; cards: Array<{ kind: string; id: string; title: string; status?: string }>; more?: number }> };

test("a board is read by its pasted link, id or title: its columns in order and the tasks and notes in each, top first", async () => {
  const mira = await h.asUser();
  const ctx = context(mira.id);
  const board = await hubBoard(mira, "EnsembleWork");
  const [todo, doing] = board.columns;
  const spec = await hubTask(mira, "Write the spec");
  const ship = await hubTask(mira, "Ship the beta", "in_progress");
  const notes = await note(mira.id, "Launch notes");
  for (const [kind, id, column] of [["task", spec, todo!], ["page", notes, todo!], ["task", ship, doing!]] as const) {
    const placed = await mira.inject({ method: "PUT", url: `/api/pages/${kind}/${id}/board`, payload: { boardId: board.id, columnId: column.id } });
    assert.equal(placed.statusCode, 200, placed.body);
  }

  const listed = (await call(ctx, "hub_list_boards", {})).data as { boards: Array<{ id: string; title: string; columns: string[]; cards: number; url: string }> };
  assert.deepEqual(listed.boards.map((row) => [row.title, row.columns, row.cards]), [["EnsembleWork", ["To do", "In progress", "Done"], 3]]);
  assert.match(listed.boards[0]!.url, new RegExp(`/board\\?board=${board.id}$`));
  assert.equal(((await call(ctx, "hub_list_boards", { query: "ensemble work" })).data as { boards: unknown[] }).boards.length, 1, "a title as said, spaced");

  for (const ref of [`https://app.ensemblework.com/board?board=${board.id}`, `/board?board=${board.id}&peek=x`, board.id, "EnsembleWork", "ensemblework board"]) {
    const read = await call(ctx, "hub_read_board", { board: ref });
    const data = read.data as Read;
    assert.equal(data.board.id, board.id, ref);
    assert.equal(read.summary, "Read board “EnsembleWork”: 3 columns, 3 cards.");
    assert.deepEqual(data.columns.map((lane) => [lane.name, lane.cards.map((card) => [card.kind, card.title, card.status ?? null])]), [
      ["To do", [["task", "Write the spec", "todo"], ["page", "Launch notes", null]]],
      ["In progress", [["task", "Ship the beta", "in_progress"]]],
      ["Done", []],
    ]);
    assert.deepEqual(data.columns[0]!.cards.map((card) => card.id), [spec, notes], "ids other tools take: the task's id, the note's page id");
  }
  await refused(call(ctx, "hub_read_board", { board: "Roadmap" }), /No board called “Roadmap” in this space\. Its boards: “EnsembleWork”\./);
  await refused(call(ctx, "hub_read_board", { board: crypto.randomUUID() }), /That board is not in this space/);
  const one = (await call(ctx, "hub_read_board", { board: board.id, column: "in progress" })).data as Read & { otherColumns: string[] };
  assert.deepEqual([one.columns.map((lane) => lane.name), one.otherColumns], [["In progress"], ["To do", "Done"]]);
  const surface = (await call(ctx, "hub_read_surface", { path: `/board?board=${board.id}` })).data as { data: Read };
  assert.equal(surface.data.board.title, "EnsembleWork", "the open custom board reads as a board");

  // A long board still comes back whole: fewer cards per column, each column saying how many are left.
  const rows = Array.from({ length: 70 }, (_, index) => ({ userId: mira.id, title: `A long backlog item about the onboarding flow, number ${index + 1}`, status: "todo" as const, createdBy: "me" as const }));
  for (const [index, row] of rows.entries()) {
    const task = await db.task.create({ data: row });
    await db.taskPage.create({ data: { userId: mira.id, taskId: task.id, revision: 0, title: row.title, boardId: board.id, boardColumnId: board.columns[index % 3]!.id, boardOrder: 100 + index } });
  }
  const long = await call(ctx, "hub_read_board", { board: board.id });
  assert.ok(JSON.stringify(long.data).length <= 5_600, "one tool result");
  assert.match(long.summary, /73 cards\. Some columns show their top cards only/);
  const lanes = (long.data as Read).columns;
  assert.ok(lanes.every((lane) => lane.cards.length > 0 && lane.count === lane.cards.length + (lane.more ?? 0)));
  const offset = Number(/offset (\d+) for the next/.exec(long.summary)![1]);
  const next = (await call(ctx, "hub_read_board", { board: board.id, column: "Done", offset })).data as Read;
  assert.deepEqual(next.columns[0]!.cards.map((card) => card.id).slice(0, 1), [(await screen(mira, board.id)).Done![offset]], "the next part of a long column");
});

test("a board is made, and its columns added, renamed, moved, recoloured and removed in order; a column with cards stays", async () => {
  const mira = await h.asUser();
  const ctx = context(mira.id);
  const made = await call(ctx, "hub_create_board", { title: "Hiring", columns: ["Sourcing", "Interviewing", "Done"] });
  assert.equal(made.summary, "Made board “Hiring” with 3 columns.");
  const id = (made.data as { board: { id: string } }).board.id;
  assert.deepEqual((await db.pageBoard.findUniqueOrThrow({ where: { id } })).columns as unknown as Array<{ color: string }>, [
    { id: (made.data as { board: { columns: Array<{ id: string }> } }).board.columns[0]!.id, name: "Sourcing", color: "gray" },
    { id: (made.data as { board: { columns: Array<{ id: string }> } }).board.columns[1]!.id, name: "Interviewing", color: "gray" },
    { id: (made.data as { board: { columns: Array<{ id: string }> } }).board.columns[2]!.id, name: "Done", color: "green" },
  ]);
  const plain = ((await call(ctx, "hub_create_board", { title: "Plain" })).data as { board: { columns: Array<{ name: string }> } }).board.columns.map((column) => column.name);
  assert.deepEqual(plain, ["To do", "In progress", "Done"], "the Board screen's own default columns");

  const edits = { board: "Hiring", columns: [{ action: "add", name: "Offer", position: 3 }, { action: "rename", column: "interviewing", name: "Interviews" }, { action: "move", column: "Sourcing", position: 4 }, { action: "color", column: "Offer", color: "amber" }] };
  const update = tool("hub_update_board");
  const prepared = await update.prepare!(ctx, update.input.parse(edits));
  assert.equal((prepared as { board: string }).board, id, "Apply changes the board that was previewed, by id");
  assert.equal(await update.preview!(ctx, prepared), "Change board “Hiring”: add column “Offer”; rename “Interviewing” to “Interviews”; move “Sourcing” to place 4; colour “Offer” amber");
  const changed = await update.run(ctx, prepared);
  assert.match(changed.summary, /^Changed board “Hiring”: added column “Offer”; renamed “Interviewing” to “Interviews”; moved “Sourcing” to place 4; coloured “Offer” amber\.$/);
  const after = await db.pageBoard.findUniqueOrThrow({ where: { id } });
  assert.deepEqual((after.columns as Array<{ name: string; color: string }>).map((column) => [column.name, column.color]), [["Interviews", "gray"], ["Offer", "amber"], ["Done", "green"], ["Sourcing", "gray"]]);
  assert.equal(after.revision, 2);

  const task = await hubTask(mira, "Call the candidate");
  await call(ctx, "hub_move_to_board", { board: id, column: "Offer", taskId: task });
  await refused(call(ctx, "hub_update_board", { board: id, columns: [{ action: "remove", column: "Offer" }] }), /That column still has cards.*hub_move_to_board/);
  await call(ctx, "hub_update_board", { board: id, title: "Hiring 2027", columns: [{ action: "remove", column: "Sourcing" }], tiles: ["count", "flow"] });
  assert.deepEqual((await db.pageBoard.findUniqueOrThrow({ where: { id } })).tiles, ["count", "flow"]);
  assert.deepEqual(Object.keys(await screen(mira, id)), ["Interviews", "Offer", "Done"], "the Board screen shows the same columns");
  await refused(call(ctx, "hub_update_board", { board: id, columns: [{ action: "add", name: "offer" }] }), /already has a column “offer”/);
  await refused(call(ctx, "hub_update_board", { board: id }), /Say what to change/);
  assert.equal(update.input.safeParse({ board: id, columns: [{ action: "rename", column: "Done" }] }).success, false, "rename needs the new name");
});

test("a task or note is put on a column, placed, moved across columns and boards, and taken off; a task keeps its status", async () => {
  const mira = await h.asUser();
  const ctx = context(mira.id);
  const board = await hubBoard(mira, "EnsembleWork");
  const ideas = await hubBoard(mira, "Ideas", ["Later"]);
  const [first, second, third] = [await hubTask(mira, "First"), await hubTask(mira, "Second"), await hubTask(mira, "Third")];
  const page = await note(mira.id, "Meeting notes");

  assert.equal((await call(ctx, "hub_move_to_board", { board: "EnsembleWork", column: "to do", taskId: first })).summary, "Put “First” on “EnsembleWork” in “To do”.");
  await call(ctx, "hub_move_to_board", { board: board.id, column: "To do", taskId: second });
  await call(ctx, "hub_move_to_board", { board: board.id, column: "To do", taskId: third, position: "top" });
  await call(ctx, "hub_move_to_board", { board: board.id, column: "To do", pageId: page, after: first });
  assert.deepEqual((await screen(mira, board.id))["To do"], [third, first, page, second]);
  assert.equal((await call(ctx, "hub_move_to_board", { board: board.id, column: "To do", taskId: second, before: third })).summary, "Moved “Second” within “To do” on “EnsembleWork”.");
  assert.deepEqual((await screen(mira, board.id))["To do"], [second, third, first, page]);

  const moved = await call(ctx, "hub_move_to_board", { board: board.id, column: "Done", taskId: first });
  assert.equal(moved.summary, "Moved “First” from “To do” to “Done” on “EnsembleWork”.");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: first } })).status, "todo", "the board's column is its own");
  assert.equal((await call(ctx, "hub_move_to_board", { board: "Ideas", column: "Later", taskId: second })).summary, "Put “Second” on “Ideas” in “Later” (off “EnsembleWork”).");
  assert.deepEqual(await screen(mira, ideas.id), { Later: [second] });

  assert.equal((await call(ctx, "hub_remove_from_board", { pageId: page })).summary, "Took “Meeting notes” off “EnsembleWork”: the note stays in Pages.");
  assert.equal((await call(ctx, "hub_remove_from_board", { pageId: page })).summary, "“Meeting notes” is on no custom board.");
  assert.equal((await call(ctx, "hub_remove_from_board", { taskId: first })).summary, "Took “First” off “EnsembleWork”: the task is back on the Ensemble board.");
  assert.deepEqual(await screen(mira, board.id), { "To do": [third], "In progress": [], Done: [] });
  assert.equal((await db.taskPage.findUniqueOrThrow({ where: { id: page } })).deletedAt, null, "nothing is deleted");

  await refused(call(ctx, "hub_move_to_board", { board: board.id, column: "Review", taskId: third }), /“EnsembleWork” has no column “Review”\. Its columns: “To do”, “In progress”, “Done”\./);
  await refused(call(ctx, "hub_move_to_board", { board: board.id, column: "Done", taskId: third, after: third }), /next to another card, not itself/);
  await refused(call(ctx, "hub_move_to_board", { board: board.id, column: "Done", taskId: crypto.randomUUID() }), /That task is not in this space/);
  assert.equal(tool("hub_move_to_board").input.safeParse({ board: board.id, column: "Done", taskId: third, pageId: page }).success, false, "one card at a time");
});

test("deleting a board always waits for Apply, and keeps its cards: notes in Pages, tasks back on the Ensemble board", async () => {
  const mira = await h.asUser();
  const ctx = context(mira.id);
  const board = await hubBoard(mira, "Old plan");
  const task = await hubTask(mira, "Keep me");
  const page = await note(mira.id, "Keep this note");
  await call(ctx, "hub_move_to_board", { board: board.id, column: "To do", taskId: task });
  await call(ctx, "hub_move_to_board", { board: board.id, column: "Done", pageId: page });
  const remove = tool("hub_delete_board");
  assert.equal(holdsAssistantWrite("immediate", remove.name, false, remove.area, remove.alwaysHold), true, "held even when writes run at once");
  assert.equal(holdsAssistantWrite("immediate", "hub_move_to_board", false, "tasks", tool("hub_move_to_board").alwaysHold), false, "other board writes follow the write policy");
  assert.equal(await remove.preview!(ctx, await remove.prepare!(ctx, { board: "Old plan" })), "Delete board “Old plan” (2 cards: notes stay in Pages, tasks go back to the Ensemble board)");
  await call(ctx, "hub_delete_board", { board: "Old plan" });
  assert.equal(await db.pageBoard.count({ where: { id: board.id } }), 0);
  const pages = await db.taskPage.findMany({ where: { OR: [{ id: page }, { taskId: task }] }, select: { boardId: true, deletedAt: true } });
  assert.deepEqual(pages.map((row) => [row.boardId, row.deletedAt]), [[null, null], [null, null]]);
});

test("a node reads a board where its owner can only view, changes boards only where they edit, and is told to look in another space", async () => {
  const akash = await h.asUser();
  const ben = await h.asUser();
  await db.user.update({ where: { id: akash.id }, data: { name: "Akash" } });
  await db.user.update({ where: { id: ben.id }, data: { name: "Ben Ito" } });
  const space = async (name: string, role: "viewer" | "editor") => {
    const id = await createSpaceUser(db, ben.id, { name, icon: null });
    await db.user.update({ where: { id }, data: { moduleSet: MODULES } });
    const shared = await ben.inject({ method: "POST", url: `/api/sharing/spaces/${id}/members`, payload: { personId: akash.id, role } });
    assert.equal(shared.statusCode, 201, shared.body);
    return id;
  };
  const fieldnote = await space("Fieldnote", "viewer");
  const studio = await space("Studio", "editor");
  const board = (await call(context(fieldnote), "hub_create_board", { title: "EnsembleWork" })).data as { board: { id: string; columns: Array<{ id: string }> } };
  const task = (await db.task.create({ data: { userId: fieldnote, title: "Review the copy", status: "todo", createdBy: "me" } })).id;
  const created = await akash.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  assert.equal(created.statusCode, 201, created.body);
  const node = (created.json() as { node: { id: string } }).node;
  const tools = new Map(nodeSpaceGateway(h.app, { id: node.id, userId: akash.id, spaceId: null }).wrap([...["hub_read_board", "hub_list_boards", "hub_move_to_board", "hub_create_board"].map(tool)]).map((row) => [row.name, row]));
  const owner = context(akash.id);
  const link = `https://app.ensemblework.com/board?board=${board.board.id}`;

  await refused(call(owner, "hub_read_board", { board: link }, tools.get("hub_read_board")), /That board is not in “[^”]+”\. Boards belong to one space: call hub_list_boards with another space your owner can open\./);
  const read = await call(owner, "hub_read_board", { board: link, space: "Fieldnote" }, tools.get("hub_read_board"));
  assert.match(read.summary, /^In “Fieldnote”: Read board “EnsembleWork”: 3 columns, 0 cards\.$/);
  await refused(call(owner, "hub_move_to_board", { board: link, column: "To do", taskId: task, space: "Fieldnote" }, tools.get("hub_move_to_board")), /can only view “Fieldnote”, so nothing there can be changed/);
  assert.equal(await db.taskPage.count({ where: { taskId: task } }), 0, "nothing moved");

  const made = await call(owner, "hub_create_board", { title: "Shared plan", space: "Studio" }, tools.get("hub_create_board"));
  assert.match(made.summary, /^In “Studio”: Made board “Shared plan”/);
  assert.equal((await db.pageBoard.findFirstOrThrow({ where: { title: "Shared plan" } })).userId, studio, "made in the space it named");
  const listed = await call(owner, "hub_list_boards", { space: "Studio" }, tools.get("hub_list_boards"));
  assert.deepEqual((listed.data as { boards: Array<{ title: string }> }).boards.map((row) => row.title), ["Shared plan"]);
});
