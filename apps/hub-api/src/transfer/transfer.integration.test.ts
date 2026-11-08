import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";

const h = await createHttpHarness();
after(() => h.close());
const db = h.prisma;
const { exportBatches, localDataCounts, sendLocalData } = await import("./export.js");
const { remapIds } = await import("./schema.js");
const { deleteAccountData } = await import("../lib/account-data.js");

type Key = Awaited<ReturnType<typeof h.asToken>>;

/** fetch for sendLocalData that lands on the test app with the transfer key. */
function fetchVia(key: Key): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const response = await key.inject({ method: (init?.method ?? "GET") as "POST", url: url.pathname, payload: init?.body as string, headers: { "content-type": "application/json" } });
    return new Response(response.body, { status: response.statusCode });
  }) as typeof fetch;
}

async function seedComputer(userId: string) {
  const project = await db.project.create({ data: { userId, name: "Alpha", summary: "Interpretability study" } });
  const person = await db.person.create({ data: { userId, name: "Mira Chen", email: "mira@fieldnote.dev", role: "Research lead" } });
  const skill = await db.skill.create({ data: { userId, slug: "write-notes", name: "Write notes", body: "Short notes, bullet points." } });
  const board = await db.pageBoard.create({ data: { userId, title: "Ensemble board", columns: [{ id: "todo", title: "To do" }] } });
  const task = await db.task.create({ data: { userId, title: "Draft the probe report", projectId: project.id, people: [person.id], skillIds: [skill.id] } });
  const bytes = Buffer.from("probe results\n");
  const file = await db.document.create({ data: { userId, filename: "results.txt", mediaType: "text/plain", byteSize: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), format: "text", original: bytes } });
  const page = await db.taskPage.create({ data: { userId, taskId: task.id, title: "Probe report", boardId: board.id, sourceFileId: file.id, content: { type: "doc", content: [{ type: "mention", attrs: { id: person.id, kind: "person" } }] } } });
  const child = await db.taskPage.create({ data: { userId, title: "Appendix", parentId: page.id } });
  await db.preference.create({ data: { userId, key: "settings", value: { appearance: { theme: "dark" }, assistant: { model: "local-model" } } } });
  return { project, person, skill, board, task, file, page, child };
}

test("a computer's local data moves into an account: ids kept, account's own rows win and absorb matches", async () => {
  const computer = await h.asUser();
  const local = await seedComputer(computer.id);
  const counts = await localDataCounts(db, computer.id);
  assert.equal(counts.tasks, 1);
  assert.equal(counts.task_pages, 2);
  const batches = [];
  for await (const batch of exportBatches(db, computer.id)) batches.push(batch);
  assert.ok(batches.length >= 1);

  const account = await h.asUser();
  const existingProject = await db.project.create({ data: { userId: account.id, name: "alpha", summary: "" } });
  const existingPerson = await db.person.create({ data: { userId: account.id, name: "Mira C.", email: "MIRA@fieldnote.dev", role: null } });
  const existingSkill = await db.skill.create({ data: { userId: account.id, slug: "write-notes", name: "Write notes", body: "Long-form notes." } });
  await db.pageBoard.create({ data: { userId: account.id, title: "Ensemble board", columns: [] } });
  await db.preference.create({ data: { userId: account.id, key: "settings", value: { appearance: { theme: "light" } } } });
  const key = await h.asToken(account, "transfer");

  // On a real move the rows arrive in a different database; erase the computer's copy so ids are free.
  await deleteAccountData(db, computer.id);
  const ids = new Map<string, string>();
  const patches: unknown[] = [];
  for (const batch of batches) {
    const response = await key.inject({ method: "POST", url: "/api/transfer/rows", payload: { batch: batch.map((part) => ({ table: part.table, rows: part.rows.map((row) => remapIds(row, ids)) })) } });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<{ ids: Record<string, string>; patches: unknown[] }>();
    for (const [from, to] of Object.entries(body.ids)) ids.set(from.toLowerCase(), to);
    patches.push(...body.patches);
  }
  const finished = await key.inject({ method: "POST", url: "/api/transfer/finish", payload: { patches: patches.map((patch) => remapIds(patch, ids)), counts: {} } });
  assert.equal(finished.statusCode, 200, finished.body);

  const task = await db.task.findUniqueOrThrow({ where: { id: local.task.id } });
  assert.equal(task.userId, account.id, "the task keeps its id and belongs to the account");
  assert.equal(task.projectId, existingProject.id, "the same project by name is the account's project");
  assert.deepEqual(task.people, [existingPerson.id], "the same person by email is the account's person");
  const project = await db.project.findUniqueOrThrow({ where: { id: existingProject.id } });
  assert.equal(project.name, "alpha", "the account's values win");
  assert.equal(project.summary, "Interpretability study", "the computer's values fill what was empty");
  const person = await db.person.findUniqueOrThrow({ where: { id: existingPerson.id } });
  assert.equal(person.role, "Research lead");
  assert.equal(await db.project.count({ where: { userId: account.id } }), 1);
  const skills = await db.skill.findMany({ where: { userId: account.id }, orderBy: { slug: "asc" } });
  assert.deepEqual(skills.map((skill) => skill.slug), ["write-notes", "write-notes-from-computer"], "a different skill with the same slug is kept beside it");
  assert.equal(skills[0]!.id, existingSkill.id);
  assert.deepEqual(task.skillIds, [skills[1]!.id]);
  const boards = await db.pageBoard.findMany({ where: { userId: account.id }, orderBy: { title: "asc" } });
  assert.deepEqual(boards.map((board) => board.title), ["Ensemble board", "Ensemble board (from this computer)"]);
  const page = await db.taskPage.findUniqueOrThrow({ where: { id: local.page.id } });
  assert.equal(page.boardId, local.board.id);
  assert.equal(page.sourceFileId, local.file.id);
  assert.match(JSON.stringify(page.content), new RegExp(existingPerson.id), "a mention in a page follows the merged person");
  const child = await db.taskPage.findUniqueOrThrow({ where: { id: local.child.id } });
  assert.equal(child.parentId, local.page.id);
  const file = await db.document.findUniqueOrThrow({ where: { id: local.file.id } });
  assert.equal(Buffer.from(file.original!).toString(), "probe results\n");
  const settings = await db.preference.findFirstOrThrow({ where: { userId: account.id, key: "settings" } });
  assert.deepEqual(settings.value, { appearance: { theme: "light" }, assistant: { model: "local-model" } }, "the account's appearance stays; settings it lacked are added");
  assert.equal(await db.apiToken.count({ where: { id: key.id, revokedAt: null } }), 0, "the key stops working when the move finishes");

  const again = await key.inject({ method: "POST", url: "/api/transfer/rows", payload: { batch: [] } });
  assert.equal(again.statusCode, 401);
});

test("sendLocalData moves everything and follows ids the account had to change", async () => {
  const computer = await h.asUser();
  const local = await seedComputer(computer.id);
  const account = await h.asUser();
  const key = await h.asToken(account, "transfer");
  // Same database, so every id is already another account's: each row gets a new id and the references follow.
  const progress: number[] = [];
  const result = await sendLocalData({ db, userId: computer.id, apiBase: "http://api.test", token: key.token, fetchImpl: fetchVia(key), onProgress: (step) => progress.push(step.sent) });
  assert.ok(progress.length >= 1);
  assert.equal(result.counts.tasks?.added, 1);
  assert.equal(result.counts.task_pages?.added, 2);
  const task = await db.task.findFirstOrThrow({ where: { userId: account.id } });
  assert.notEqual(task.id, local.task.id);
  const project = await db.project.findFirstOrThrow({ where: { userId: account.id } });
  const person = await db.person.findFirstOrThrow({ where: { userId: account.id } });
  assert.equal(task.projectId, project.id);
  assert.deepEqual(task.people, [person.id]);
  const pages = await db.taskPage.findMany({ where: { userId: account.id } });
  const parent = pages.find((page) => page.taskId === task.id)!;
  const child = pages.find((page) => page.id !== parent.id)!;
  assert.equal(child.parentId, parent.id);
  assert.match(JSON.stringify(parent.content), new RegExp(person.id));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: local.task.id } })).userId, computer.id, "the source rows are untouched");
});

test("a transfer refuses rows that reach into another account", async () => {
  const victim = await h.asUser();
  const theirProject = await db.project.create({ data: { userId: victim.id, name: "Secret" } });
  const theirTask = await db.task.create({ data: { userId: victim.id, title: "Their task" } });
  const account = await h.asUser();
  const key = await h.asToken(account, "transfer");
  const response = await key.inject({
    method: "POST",
    url: "/api/transfer/rows",
    payload: {
      batch: [
        { table: "tasks", rows: [{ id: theirTask.id, user_id: victim.id, title: "Overwrite", project_id: theirProject.id, assignee_account_id: victim.id }] },
        { table: "task_page_mentions", rows: [{ id: "6f0d7c1e-1b2a-4c3d-8e9f-001122334455", page_id: "00000000-0000-4000-8000-000000000000", kind: "task", entity_id: theirTask.id, label: "x" }] },
      ],
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json<{ ids: Record<string, string>; counts: Record<string, { added: number; skipped: number }> }>();
  const moved = body.ids[theirTask.id];
  assert.ok(moved && moved !== theirTask.id, "an id that is another account's gets a new id");
  const mine = await db.task.findUniqueOrThrow({ where: { id: moved } });
  assert.equal(mine.userId, account.id);
  assert.equal(mine.projectId, null, "a reference to another account's row is dropped");
  assert.equal(mine.assigneeAccountId, account.id);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: theirTask.id } })).title, "Their task");
  assert.equal(body.counts.task_page_mentions?.skipped, 1, "a child row without a parent of this account is skipped");
  const unknown = await key.inject({ method: "POST", url: "/api/transfer/rows", payload: { batch: [{ table: "api_tokens", rows: [{}] }] } });
  assert.equal(unknown.statusCode, 400);
});

test("a transfer never trusts a row's storage: ids that are not plain get new ones, file sizes and keys come from the bytes", async () => {
  const victim = await h.asUser();
  const account = await h.asUser();
  const key = await h.asToken(account, "transfer");
  const hex = Buffer.from("hello").toString("hex");
  const response = await key.inject({
    method: "POST",
    url: "/api/transfer/rows",
    payload: {
      batch: [
        { table: "plot_datasets", rows: [{ id: `../${victim.id}/escape`, user_id: account.id, name: "d", format: "csv", columns: [], row_count: 1, byte_size: 0, content_hash: "x", sheet: "", sheets: [], $table: { columns: [{ name: "a", type: "number" }], rows: [[1]] } }] },
        {
          table: "context_documents",
          rows: [
            { id: "3f1e2d4c-5b6a-4789-8abc-def012345678", filename: "note.txt", media_type: "text/plain", byte_size: 0, sha256: "fake", format: "text", original: `\\x${hex}`, blob_key: `documents/${victim.id}/x/y` },
            { id: "4f1e2d4c-5b6a-4789-8abc-def012345678", filename: "theirs.txt", media_type: "text/plain", byte_size: 5, sha256: "x", format: "text", original: null, blob_key: `documents/${victim.id}/x/y` },
          ],
        },
        { table: "people", rows: [{ id: "5f1e2d4c-5b6a-4789-8abc-def012345678", name: "Fails later", email: "fails@fieldnote.dev" }] },
      ],
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json<{ ids: Record<string, string>; counts: Record<string, { added: number; skipped: number }> }>();
  const datasetId = body.ids[`../${victim.id}/escape`];
  assert.match(datasetId ?? "", /^[0-9a-f-]{36}$/, "a path-like id is replaced");
  const dataset = await db.plotDataset.findUniqueOrThrow({ where: { id: datasetId } });
  assert.equal(dataset.userId, account.id);
  assert.ok(dataset.byteSize > 0, "the dataset's size is measured here");
  const file = await db.document.findUniqueOrThrow({ where: { id: "3f1e2d4c-5b6a-4789-8abc-def012345678" } });
  assert.equal(file.blobKey, null, "a storage key from the computer is never kept");
  assert.equal(file.byteSize, 5);
  assert.equal(file.sha256, createHash("sha256").update("hello").digest("hex"));
  assert.equal(body.counts.context_documents?.skipped, 1, "a file without its bytes stays behind");
  assert.equal(body.counts.people?.added, 1, "the rest of the batch goes on");
});

test("a merge that cannot fill a value does not stop the batch", async () => {
  const account = await h.asUser();
  await db.person.create({ data: { userId: account.id, name: "Mira Chen", email: "mira@fieldnote.dev" } });
  await db.person.create({ data: { userId: account.id, name: "Someone else", upn: "mira@corp" } });
  const key = await h.asToken(account, "transfer");
  const response = await key.inject({
    method: "POST",
    url: "/api/transfer/rows",
    payload: { batch: [{ table: "people", rows: [{ id: "6f1e2d4c-5b6a-4789-8abc-def012345678", name: "Mira", email: "mira@fieldnote.dev", upn: "mira@corp", role: "Lead" }, { id: "7f1e2d4c-5b6a-4789-8abc-def012345678", name: "Rafa" }] }] },
  });
  assert.equal(response.statusCode, 200, response.body);
  const counts = response.json<{ counts: Record<string, { added: number; merged: number }> }>().counts.people;
  assert.deepEqual([counts?.merged, counts?.added], [1, 1]);
  const mira = await db.person.findFirstOrThrow({ where: { userId: account.id, email: "mira@fieldnote.dev" } });
  assert.equal(mira.upn, null, "a value another of the account's rows already holds is not copied");
  assert.equal(mira.role, "Lead");
});

test("retrying after an interrupted move keeps links to rows that arrive later", async () => {
  const account = await h.asUser();
  const key = await h.asToken(account, "transfer");
  const taskId = "8f1e2d4c-5b6a-4789-8abc-def012345678";
  const artifact = { id: "9f1e2d4c-5b6a-4789-8abc-def012345678", kind: "email", external_id: "m-1", ts: new Date().toISOString(), title: "Kickoff notes", text: "", task_id: taskId };
  const send = (batch: unknown) => key.inject({ method: "POST", url: "/api/transfer/rows", payload: { batch } });
  // The first attempt moved the artifact and stopped before its task.
  assert.equal((await send([{ table: "artifacts", rows: [artifact] }])).statusCode, 200);
  const retry = await send([{ table: "artifacts", rows: [artifact] }]);
  const patches = retry.json<{ patches: unknown[] }>().patches;
  assert.equal(patches.length, 1, "the already-moved row still reports its link");
  await send([{ table: "tasks", rows: [{ id: taskId, title: "Follow up on kickoff" }] }]);
  const finished = await key.inject({ method: "POST", url: "/api/transfer/finish", payload: { patches, counts: {} } });
  assert.equal(finished.statusCode, 200, finished.body);
  assert.equal((await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).taskId, taskId);
});

test("a transfer key reaches only the transfer routes, and nothing else reaches them", async () => {
  const account = await h.asUser();
  const key = await h.asToken(account, "transfer");
  assert.equal((await key.inject({ method: "GET", url: "/api/transfer" })).statusCode, 200);
  assert.equal((await key.inject({ method: "GET", url: "/api/tasks" })).statusCode, 403);
  const bridge = await h.asToken(account, "bridge");
  assert.equal((await bridge.inject({ method: "POST", url: "/api/transfer/rows", payload: { batch: [] } })).statusCode, 403);
  assert.equal((await account.inject({ method: "POST", url: "/api/transfer/rows", payload: { batch: [] } })).statusCode, 403);
  const listed = await account.inject({ method: "GET", url: "/api/tokens" });
  assert.ok(!listed.json<{ tokens: Array<{ id: string }> }>().tokens.some((row) => row.id === key.id), "a transfer key is not listed with personal keys");
});
