import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import type { PageBoardRecord } from "@ensemble/shared-types";
import { createHttpHarness, type HttpUser } from "../test/http.js";

const harness = await createHttpHarness();
after(() => harness.close());
const columns = () => [
  { id: randomUUID(), name: "To do", color: "gray" },
  { id: randomUUID(), name: "On-going experiments", color: "blue" },
  { id: randomUUID(), name: "Results", color: "violet" },
  { id: randomUUID(), name: "Done", color: "green" },
];
async function newBoard(user: HttpUser) {
  const response = await user.inject({ method: "POST", url: "/api/boards", payload: { title: "Research", columns: columns() } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<{ board: PageBoardRecord }>().board;
}
async function newPage(user: HttpUser) {
  const response = await user.inject({ method: "POST", url: "/api/pages" });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<{ page: { id: string } }>().page.id;
}
const assign = (user: HttpUser, id: string, board: PageBoardRecord, column = 0, extra = {}) => user.inject({
  method: "PUT", url: `/api/pages/page/${id}/board`,
  payload: { boardId: board.id, columnId: board.columns[column]!.id, ...extra },
});

test("boards organize existing pages without changing their writing, revisions or comments", async () => {
  const user = await harness.asUser(), board = await newBoard(user), id = await newPage(user);
  const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Experiment notes" }] }] };
  const saved = await user.inject({ method: "PUT", url: `/api/pages/${id}`, payload: { revision: 1, content } });
  assert.equal(saved.statusCode, 200, saved.body);
  const revision = saved.json().revision;
  const commented = await user.inject({ method: "POST", url: `/api/pages/page/${id}/comments`, payload: { quote: "", body: { text: "Keep the control group" } } });
  assert.equal(commented.statusCode, 201, commented.body);
  assert.equal((await assign(user, id, board, 1)).statusCode, 200);
  const opened = (await user.inject({ method: "GET", url: `/api/pages/${id}` })).json();
  assert.deepEqual(opened.content, content);
  assert.equal(opened.revision, revision);
  assert.equal((await user.inject({ method: "GET", url: `/api/pages/page/${id}/comments` })).json().comments[0].body.text, "Keep the control group");
  const detail = (await user.inject({ method: "GET", url: `/api/boards/${board.id}` })).json();
  assert.equal(detail.board.pageCount, 1);
  assert.deepEqual(detail.pages.map((page: { id: string; columnId: string }) => [page.id, page.columnId]), [[id, board.columns[1]!.id]]);
  const directory = (await user.inject({ method: "GET", url: "/api/pages?all=true&q=Experiment" })).json().pages;
  assert.deepEqual(directory.map((page: { id: string; board: { title: string } }) => [page.id, page.board.title]), [[id, "Research"]]);
  assert.equal((await assign(user, id, board, 2)).statusCode, 200);
  const unassigned = await user.inject({ method: "PUT", url: `/api/pages/page/${id}/board`, payload: { boardId: null, columnId: null } });
  assert.equal(unassigned.statusCode, 200);
  assert.equal((await user.inject({ method: "GET", url: "/api/pages?all=true" })).json().pages.find((page: { id: string }) => page.id === id).board, null);
});

test("new board cards are pages, ordering is persisted, and neighbours must belong to the target column", async () => {
  const user = await harness.asUser(), board = await newBoard(user);
  const create = () => user.inject({ method: "POST", url: `/api/boards/${board.id}/pages`, payload: { columnId: board.columns[0]!.id } });
  const first = await create(), second = await create(), third = await create();
  assert.equal(first.statusCode, 201, first.body);
  const ids = [first.json().page.id, second.json().page.id, third.json().page.id] as string[];
  assert.equal((await assign(user, ids[2]!, board, 0, { afterId: ids[0] })).statusCode, 200);
  const detail = (await user.inject({ method: "GET", url: `/api/boards/${board.id}` })).json();
  assert.deepEqual(detail.pages.map((page: { id: string }) => page.id), [ids[2], ids[0], ids[1]]);
  const invalid = await assign(user, ids[1]!, board, 1, { beforeId: ids[0] });
  assert.equal(invalid.statusCode, 409, invalid.body);
  assert.equal((await assign(user, ids[1]!, board, 1)).statusCode, 200);
  const wrongColumn = await user.inject({ method: "POST", url: `/api/boards/${board.id}/pages`, payload: { columnId: randomUUID() } });
  assert.equal(wrongColumn.statusCode, 400);
  assert.equal(await harness.prisma.taskPage.count({ where: { userId: user.id } }), 3, "invalid card creation rolls back the page too");
});

test("board settings reject stale saves, persist scoped tiles, and do not drop populated columns", async () => {
  const user = await harness.asUser(), board = await newBoard(user), id = await newPage(user);
  await assign(user, id, board);
  const patch = (payload: object) => user.inject({ method: "PATCH", url: `/api/boards/${board.id}`, payload });
  assert.equal((await patch({ revision: 1, columns: board.columns.slice(1) })).statusCode, 409);
  const changed = await patch({ revision: 1, title: "Learning", tiles: ["distribution", "flow"], columns: board.columns.map((column, index) => index ? column : { ...column, name: "Reading" }) });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual(changed.json().board.tiles, ["distribution", "flow"]);
  assert.equal(changed.json().board.columns[0].name, "Reading");
  assert.equal((await patch({ revision: 1, title: "Overwrite" })).statusCode, 409);
  assert.equal((await patch({ revision: 2, columns: [board.columns[0], board.columns[0]] })).statusCode, 400);
  assert.equal((await patch({ revision: 2, tiles: ["flow", "flow"] })).statusCode, 400);
  assert.equal((await user.inject({ method: "POST", url: "/api/boards", payload: { title: " ", columns: columns() } })).statusCode, 400);
  assert.equal((await user.inject({ method: "POST", url: "/api/boards", payload: { title: "Empty", columns: [] } })).statusCode, 400);
});

test("task pages move between custom and default boards without changing task status, and deleting a board preserves all pages", async () => {
  const user = await harness.asUser(), board = await newBoard(user), note = await newPage(user);
  const task = (await user.inject({ method: "POST", url: "/api/tasks", payload: { title: "Review results", status: "blocked", notes: "Keep these notes" } })).json().task;
  assert.equal((await user.inject({ method: "GET", url: "/api/pages?all=true" })).json().pages.find((row: { id: string }) => row.id === task.id).board.id, "ensemble");
  const moved = await user.inject({ method: "PUT", url: `/api/pages/task/${task.id}/board`, payload: { boardId: board.id, columnId: board.columns[1]!.id } });
  assert.equal(moved.statusCode, 200, moved.body);
  const stored = (await user.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json().task;
  assert.equal(stored.status, "blocked");
  assert.equal(stored.notes, "Keep these notes");
  assert.ok(!(await user.inject({ method: "GET", url: "/api/tasks?board=default" })).json().tasks.some((row: { id: string }) => row.id === task.id));
  assert.ok((await user.inject({ method: "GET", url: "/api/tasks" })).json().tasks.some((row: { id: string }) => row.id === task.id));
  await assign(user, note, board);
  assert.equal((await user.inject({ method: "DELETE", url: `/api/boards/${board.id}` })).statusCode, 204);
  assert.equal((await user.inject({ method: "GET", url: `/api/pages/${note}` })).statusCode, 200);
  const directory = (await user.inject({ method: "GET", url: "/api/pages?all=true" })).json().pages;
  assert.equal(directory.find((row: { id: string }) => row.id === note).board, null);
  assert.equal(directory.find((row: { id: string }) => row.id === task.id).board.id, "ensemble");
  assert.ok((await user.inject({ method: "GET", url: "/api/tasks?board=default" })).json().tasks.some((row: { id: string }) => row.id === task.id));
});

test("board reads, writes, membership and neighbour ids stay inside their space", async () => {
  const owner = await harness.asUser(), stranger = await harness.asUser(), board = await newBoard(owner), other = await newBoard(stranger), id = await newPage(owner), foreign = await newPage(stranger);
  assert.equal((await stranger.inject({ method: "GET", url: `/api/boards/${board.id}` })).statusCode, 404);
  assert.equal((await stranger.inject({ method: "PATCH", url: `/api/boards/${board.id}`, payload: { revision: 1, title: "Stolen" } })).statusCode, 404);
  assert.equal((await stranger.inject({ method: "DELETE", url: `/api/boards/${board.id}` })).statusCode, 404);
  assert.equal((await stranger.inject({ method: "POST", url: `/api/boards/${board.id}/pages`, payload: { columnId: board.columns[0]!.id } })).statusCode, 404);
  assert.equal((await assign(stranger, foreign, board)).statusCode, 404);
  assert.equal((await assign(stranger, id, other)).statusCode, 404);
  assert.equal((await assign(owner, id, board, 0, { beforeId: foreign })).statusCode, 409);
  assert.deepEqual((await stranger.inject({ method: "GET", url: "/api/boards" })).json().boards.map((row: { id: string }) => row.id), [other.id]);
  assert.ok(!(await stranger.inject({ method: "GET", url: "/api/pages?all=true" })).json().pages.some((page: { id: string }) => page.id === id));
});

test("deleting a board keeps pages in Trash recoverable with their original undo entry", async () => {
  const user = await harness.asUser(), board = await newBoard(user), id = await newPage(user);
  await assign(user, id, board);
  const removed = await user.inject({ method: "POST", url: "/api/pages/delete-many", payload: { pageIds: [id] } });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal((await user.inject({ method: "DELETE", url: `/api/boards/${board.id}` })).statusCode, 204);
  const restored = await user.inject({ method: "POST", url: "/api/undo", payload: { entryId: removed.json().undoEntryId } });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal((await user.inject({ method: "GET", url: `/api/pages/${id}` })).statusCode, 200);
  assert.equal((await user.inject({ method: "GET", url: "/api/pages?all=true" })).json().pages.find((page: { id: string }) => page.id === id).board, null);
});

test("space viewers read boards, editors manage them, and individual page shares cannot reach board metadata", async () => {
  const owner = await harness.asUser(), member = await harness.asUser(), recipient = await harness.asUser(), board = await newBoard(owner), id = await newPage(owner);
  const membership = await harness.prisma.spaceMember.create({ data: { spaceId: owner.id, accountId: member.id, role: "viewer", addedBy: owner.id } });
  const scoped = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => harness.app.inject({
    method, url, payload, headers: { cookie: `${member.cookie}; ensemble_space=${owner.id}` },
  });
  assert.equal((await scoped("GET", "/api/boards")).statusCode, 200);
  assert.equal((await scoped("GET", `/api/boards/${board.id}`)).statusCode, 200);
  assert.equal((await scoped("GET", "/api/pages?all=true")).statusCode, 200);
  assert.equal((await scoped("POST", "/api/boards", { title: "Denied", columns: columns() })).statusCode, 403);
  assert.equal((await scoped("PATCH", `/api/boards/${board.id}`, { revision: 1, title: "Denied" })).statusCode, 403);
  assert.equal((await scoped("DELETE", `/api/boards/${board.id}`)).statusCode, 403);
  assert.equal((await scoped("POST", `/api/boards/${board.id}/pages`, { columnId: board.columns[0]!.id })).statusCode, 403);
  assert.equal((await scoped("PUT", `/api/pages/page/${id}/board`, { boardId: board.id, columnId: board.columns[0]!.id })).statusCode, 403);
  await harness.prisma.spaceMember.update({ where: { id: membership.id }, data: { role: "editor" } });
  assert.equal((await scoped("PUT", `/api/pages/page/${id}/board`, { boardId: board.id, columnId: board.columns[0]!.id })).statusCode, 200);
  assert.equal((await scoped("PATCH", `/api/boards/${board.id}`, { revision: 1, title: "Shared research" })).statusCode, 200);
  const share = await harness.prisma.share.create({ data: { spaceId: owner.id, kind: "page", resourceId: id, recipientId: recipient.id, role: "edit", createdBy: owner.id } });
  assert.equal((await recipient.inject({ method: "GET", url: `/api/pages/${id}`, headers: { "x-ensemble-share": share.id } })).statusCode, 200);
  assert.equal((await recipient.inject({ method: "GET", url: "/api/boards", headers: { "x-ensemble-share": share.id } })).statusCode, 403);
  assert.equal((await recipient.inject({ method: "PUT", url: `/api/pages/page/${id}/board`, payload: { boardId: null, columnId: null }, headers: { "x-ensemble-share": share.id } })).statusCode, 403);
});
