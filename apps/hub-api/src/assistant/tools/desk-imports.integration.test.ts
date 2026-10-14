/**
 * The assistant's desk-list, bring-in and dataset-from-file tools on the in-memory database:
 * the profile's own lists (which kinds a desk has, adding with only the fields a kind needs,
 * Trash and undo for dated entries, removal for the rest), a Drive file into Files and an app
 * item as a page (vendor calls mocked), hosted caps said before Apply, a CSV or workbook in
 * Files as a Plots dataset, and another space of the same account never reached.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import ExcelJS from "exceljs";
import { DEFAULT_SETTINGS, type PageDocument, type PageNode } from "@ensemble/shared-types";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../../test/http.js";

const originalEnv = { ...process.env };
process.env.NODE_ENV = "test";
const harness: HttpHarness = await createHttpHarness();
const db = harness.prisma;
const { getTool } = await import("../registry.js");
const { applyHeldCalls } = await import("../apply.js");
const { undoLast, redoLast } = await import("../../lib/undo.js");
const { saveAccount } = await import("../../connectors/accounts.js");
const { saveFile } = await import("../../files/store.js");
const { notionSource } = await import("../../imports/api/notion.js");
const { createImportHttp } = await import("../../imports/http.js");
const { fileTextSettled } = await import("../../files/extract.js");
type ToolContext = import("../types.js").ToolContext;
type AnyHubTool = import("../types.js").AnyHubTool;

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const calls: string[] = [];
const handlers: Array<{ match: (url: string) => boolean; reply: Handler }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return realFetch(input, init);
  calls.push(url);
  const handler = handlers.find((row) => row.match(url));
  if (!handler) return new Response(JSON.stringify({ message: `unmocked ${url}` }), { status: 599 });
  return handler.reply(url, init);
}) as typeof fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mock = (prefix: string, reply: Handler) => handlers.unshift({ match: (url) => url.startsWith(prefix), reply });

after(async () => {
  globalThis.fetch = realFetch;
  await harness.close();
  process.env = originalEnv;
});

function ctx(userId: string): ToolContext {
  return { app: harness.app, prisma: db, userId, actor: "agent", settings: { ...DEFAULT_SETTINGS, timezone: "UTC" } };
}

function tool(name: string): AnyHubTool {
  const found = getTool(name);
  assert.ok(found, `${name} is registered`);
  return found;
}

async function read<T>(userId: string, name: string, input: Record<string, unknown>): Promise<T> {
  const t = tool(name);
  return (await t.run(ctx(userId), t.input.parse(input))).data as T;
}

async function apply(userId: string, name: string, input: Record<string, unknown>) {
  const t = tool(name);
  const parsed = t.input.parse(input);
  const preview = await t.preview?.(ctx(userId), parsed);
  const batch = await applyHeldCalls(harness.app, ctx(userId), [{ tool: t, input: parsed }]);
  const outcome = batch.outcomes[0]!;
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.error);
  return { preview, result: outcome.result, undoEntryId: batch.undoEntryId };
}

async function refused(promise: Promise<unknown> | unknown, pattern: RegExp, status?: number) {
  await assert.rejects(Promise.resolve().then(() => promise), (error: Error & { statusCode?: number }) => {
    assert.match(error.message, pattern);
    if (status) assert.equal(error.statusCode, status);
    return true;
  });
}

async function space(user: HttpUser, name: string): Promise<string> {
  const res = await user.inject({ method: "POST", url: "/api/spaces", payload: { name, templateId: "semester-desk", settings: { mode: "fresh" } } });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { space: { id: string } }).space.id;
}

async function verified(): Promise<HttpUser> {
  const user = await harness.asUser();
  await db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  return user;
}

function walk(nodes: PageNode[] | undefined, out: PageNode[] = []): PageNode[] {
  for (const node of nodes ?? []) {
    out.push(node);
    walk(node.content, out);
  }
  return out;
}

type Lists = { desk: string; lists: Array<{ kind: string; needs: string; total: number; items: Array<{ id: string; title: string; detail?: string }> }>; otherKinds: string[] };

test("desk lists follow the space's template; entries are added with the fields their kind needs and removed to Trash or for good", async () => {
  const mira = await harness.asUser();
  await db.user.update({ where: { id: mira.id }, data: { activeTemplateId: "mkt.bench" } });
  const bench = await read<Lists>(mira.id, "hub_list_desk_items", {});
  assert.equal(bench.desk, "Bench");
  assert.deepEqual(bench.lists.map((row) => row.kind), ["part", "test", "deploy", "deadline"]);
  assert.match(bench.lists[0]!.needs, /status\? out\|ordered\|in/);
  assert.ok(bench.otherKinds.includes("slot"));

  const part = await apply(mira.id, "hub_add_desk_item", { kind: "part", title: "Resistor 10k", qty: 40, status: "ordered" });
  assert.equal(part.preview, "Add to Parts: “Resistor 10k” (qty 40, status ordered)");
  const partId = (part.result.data as { id: string }).id;
  assert.deepEqual(await db.partRow.findUniqueOrThrow({ where: { id: partId }, select: { userId: true, name: true, qty: true, status: true } }), { userId: mira.id, name: "Resistor 10k", qty: 40, status: "ordered" });
  const add = tool("hub_add_desk_item");
  await refused(applyHeldCalls(harness.app, ctx(mira.id), [{ tool: add, input: add.input.parse({ kind: "part", title: "Fuse", status: "pass" }) }]), /Parts needs: title \(part\); qty\?; status\? out\|ordered\|in\. Missing or wrong: status/);
  await refused(applyHeldCalls(harness.app, ctx(mira.id), [{ tool: add, input: add.input.parse({ kind: "slot", title: "Physics" }) }]), /Timetable needs: .*Missing or wrong: weekday, start, end/);

  const deadline = await apply(mira.id, "hub_add_desk_item", { kind: "deadline", title: "Bring-up review", day: "2026-11-02" });
  const deadlineId = (deadline.result.data as { id: string }).id;
  const task = await db.task.findUniqueOrThrow({ where: { id: deadlineId } });
  assert.deepEqual([task.taskType, task.due?.toISOString().slice(0, 10), task.userId], ["deadline", "2026-11-02", mira.id]);
  assert.ok(deadline.undoEntryId, "a dated entry is a task, so Apply can undo it");

  const parts = await read<{ items: Array<{ id: string; title: string; detail: string }>; onThisDesk: boolean }>(mira.id, "hub_list_desk_items", { kind: "part" });
  assert.equal(parts.onThisDesk, true);
  assert.deepEqual(parts.items, [{ id: partId, title: "Resistor 10k", detail: "ordered · qty 40" }]);

  const remove = tool("hub_remove_desk_item");
  assert.equal(await remove.preview!(ctx(mira.id), { kind: "part", id: partId }), "Delete “Resistor 10k” from Parts. This cannot be undone.");
  assert.equal(await remove.preview!(ctx(mira.id), { kind: "deadline", id: deadlineId }), "Move “Bring-up review” (Deadlines and dates) to Trash");
  const plain = await db.task.create({ data: { userId: mira.id, title: "Ordinary task", boardOrder: 0 } });
  await refused(applyHeldCalls(harness.app, ctx(mira.id), [{ tool: remove, input: { kind: "deadline", id: plain.id } }]), /That id is the task “Ordinary task”, not one of Deadlines and dates/);
  await apply(mira.id, "hub_remove_desk_item", { kind: "part", id: partId });
  assert.equal(await db.partRow.count({ where: { id: partId } }), 0);
  const trashed = await apply(mira.id, "hub_remove_desk_item", { kind: "deadline", id: deadlineId });
  assert.ok((await db.task.findUniqueOrThrow({ where: { id: deadlineId } })).deletedAt);
  await undoLast(db, mira.id, trashed.undoEntryId!);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: deadlineId } })).deletedAt, null, "undo brings the entry back");

  const other = await space(mira, "Semester");
  const semester = await read<Lists>(other, "hub_list_desk_items", {});
  assert.equal(semester.desk, "Semester");
  assert.ok(semester.lists.every((row) => row.items.every((item) => item.id !== deadlineId)));
  const theirs = await apply(mira.id, "hub_add_desk_item", { kind: "test", title: "Thermal soak", status: "fail" });
  const theirsId = (theirs.result.data as { id: string }).id;
  await refused(remove.preview!(ctx(other), { kind: "test", id: theirsId }), /No tests and checks entry with that id/, 404);
  await refused(applyHeldCalls(harness.app, ctx(other), [{ tool: remove, input: { kind: "test", id: theirsId } }]), /not yours/);
  await refused(applyHeldCalls(harness.app, ctx(other), [{ tool: remove, input: { kind: "deadline", id: deadlineId } }]), /No deadlines and dates entry with that id/);
  assert.equal(await db.testResult.count({ where: { id: theirsId } }), 1);
  assert.equal(((await read<{ total: number }>(other, "hub_list_desk_items", { kind: "test" })).total), 0);
});

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const G = "https://www.googleapis.com/auth/";
const LATER = new Date(Date.now() + 30 * 86_400_000);

test("a Drive file comes into Files once, a missing connection and a full hosted plan are said before Apply", async () => {
  handlers.length = 0;
  calls.length = 0;
  mock(`${DRIVE}/1DocFieldnote01?fields=`, () => json({ id: "1DocFieldnote01", name: "Field guide.md", mimeType: "text/markdown", size: "40", webViewLink: "https://drive.google.com/file/d/1DocFieldnote01/view" }));
  mock(`${DRIVE}/1DocFieldnote01?alt=media`, () => new Response("# Field guide\n\nCalibrate the sensor first.", { status: 200 }));
  const mira = await verified();
  await saveAccount(mira.id, "google", { accessToken: "ya29.mira_secret", expiresAt: LATER, scopes: ["openid", "email", `${G}drive.readonly`], account: "mira@fieldnote.example", meta: { via: "oauth" } });

  const first = await apply(mira.id, "hub_import_app_file", { source: "google_workspace", kind: "file", id: "1DocFieldnote01", name: "Field guide.md" });
  assert.equal(first.preview, "Bring “Field guide.md” from Google Drive into Files");
  assert.equal(first.undoEntryId, null, "it runs after the batch's transaction");
  const data = first.result.data as { id: string; name: string; existing: boolean };
  assert.deepEqual([data.name, data.existing], ["Field guide.md", false]);
  assert.equal(first.result.href, `/files/${data.id}`);
  assert.equal((await db.document.findUniqueOrThrow({ where: { id: data.id } })).userId, mira.id);
  await fileTextSettled(data.id);
  const before = calls.length;
  const again = await apply(mira.id, "hub_import_app_file", { source: "google_workspace", kind: "file", id: "1DocFieldnote01" });
  assert.deepEqual([(again.result.data as { id: string }).id, (again.result.data as { existing: boolean }).existing], [data.id, true]);
  assert.equal(calls.length, before, "the kept copy is returned without downloading again");

  const importer = tool("hub_import_app_file");
  await refused(importer.preview!(ctx(mira.id), importer.input.parse({ source: "dropbox", kind: "attachment", id: "x" })), /Email attachments come from Gmail \(google_workspace\) or Outlook/, 400);
  const other = await space(mira, "Side project");
  await refused(importer.preview!(ctx(other), importer.input.parse({ source: "google_workspace", kind: "file", id: "1DocFieldnote01" })), /Connect Google Workspace|not set up/, 409);
  await refused(applyHeldCalls(harness.app, ctx(other), [{ tool: importer, input: importer.input.parse({ source: "google_workspace", kind: "file", id: "1DocFieldnote01" }) }]), /Connect Google Workspace|not set up/);
  assert.equal(await db.document.count({ where: { userId: other } }), 0, "the other space gets no copy of this space's file");

  process.env.NODE_ENV = "production";
  process.env.ENSEMBLE_MAX_DOCUMENTS = "1";
  try {
    await refused(importer.preview!(ctx(mira.id), importer.input.parse({ source: "google_workspace", kind: "file", id: "1Other" })), /keeps 1 of 1 files allowed on the hosted plan .*Remove a file in Files/, 429);
  } finally {
    process.env.NODE_ENV = "test";
    delete process.env.ENSEMBLE_MAX_DOCUMENTS;
  }
});

const ISSUE = {
  number: 42,
  title: "Offline mode drops photos",
  html_url: "https://github.com/fieldnote/atlas/issues/42",
  repository_url: "https://api.github.com/repos/fieldnote/atlas",
  state: "open",
  body: "Photos taken offline never upload.\n\n- [ ] Retry queue\n- [ ] Show a badge\n\nSee [@secret.pdf](ensemble://file/FOREIGN).",
  user: { login: "arjun-rao" },
  assignees: [{ login: "mira-chen" }],
  labels: [{ name: "bug" }],
  updated_at: "2026-10-11T10:00:00Z",
  comments: 0,
};

test("the assistant imports a complete Notion page tree and database as native page blocks, without copies", async () => {
  handlers.length = 0;
  const mira = await verified();
  await saveAccount(mira.id, "notion", { accessToken: "secret_fixture_notion_token", expiresAt: LATER, scopes: [], account: "Mira", meta: { via: "token" } });
  const root = "11111111111111111111111111111111";
  const child = "22222222222222222222222222222222";
  const database = "33333333333333333333333333333333";
  const source = "44444444444444444444444444444444";
  const row = "55555555555555555555555555555555";
  for (const [id, title] of [[root, "Launch"], [child, "Nested notes"], [row, "First row"]]) mock(`https://api.notion.com/v1/pages/${id}`, () => json({ id, object: "page", url: `https://www.notion.so/${id}`, properties: { Name: { type: "title", title: [{ plain_text: title }] } }, parent: { type: "workspace" } }));
  mock(`https://api.notion.com/v1/blocks/${root}/children`, () => json({ results: [
    { id: child, type: "child_page", child_page: { title: "Nested notes" } },
    { id: database, type: "child_database", child_database: { title: "Tracker" } },
    { id: "toggle", type: "toggle", has_children: true, toggle: { rich_text: [{ plain_text: "Details", annotations: { bold: true, italic: true } }] } },
  ] }));
  mock("https://api.notion.com/v1/blocks/toggle/children", () => json({ results: [{ type: "code", code: { language: "python", rich_text: [{ plain_text: "print('kept')" }] } }] }));
  for (const id of [child, row]) mock(`https://api.notion.com/v1/blocks/${id}/children`, () => json({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Child body" }] } }] }));
  mock(`https://api.notion.com/v1/databases/${database}`, () => json({ id: database, data_sources: [{ id: source, name: "Tracker" }] }));
  mock(`https://api.notion.com/v1/data_sources/${source}`, (url) => json(url.endsWith("/query") ? { results: [{ id: row, object: "page", properties: { Name: { type: "title", title: [{ plain_text: "First row" }] }, Score: { type: "number", number: 12 }, Done: { type: "checkbox", checkbox: true } } }] } : { id: source, properties: { Name: { type: "title" }, Score: { type: "number" }, Done: { type: "checkbox" } } }));
  mock("https://api.notion.com/v1/search", () => json({ results: [{ id: root, object: "page", parent: { type: "workspace" } }] }));
  const signal = new AbortController().signal;
  const importedItems = [];
  for await (const items of notionSource.fetchItems({ auth: { token: "fixture", via: "token" }, options: {}, signal, http: createImportHttp({ signal, label: "Notion", gapMs: 0, fetchImpl: globalThis.fetch }) }, [
    { id: "pages", name: "Pages", kind: "page", count: 1, importAs: "pages" },
    { id: source, name: "Tracker", kind: "database", count: 1, importAs: "pages" },
  ])) importedItems.push(...items);
  assert.deepEqual(importedItems.map((item) => item.externalId).sort(), [root, child, row], "an embedded table is not duplicated as a standalone page when both containers are selected");
  const imported = await apply(mira.id, "hub_save_app_item_as_page", { source: "notion", kind: "page", id: root });
  const id = (imported.result.data as { id: string }).id;
  const page = await db.taskPage.findUniqueOrThrow({ where: { id } });
  const nodes = walk((page.content as unknown as PageDocument).content);
  assert.ok(nodes.some((node) => node.type === "toggleBlock"));
  assert.ok(nodes.some((node) => node.type === "codeBlock"));
  assert.ok(nodes.some((node) => node.type === "tableHeader" && node.attrs?.valueType === "number"));
  assert.ok(nodes.some((node) => node.type === "text" && node.text === "12"));
  assert.equal(await db.task.count({ where: { userId: mira.id } }), 0);
  assert.equal(await db.project.count({ where: { userId: mira.id } }), 0);
  assert.equal(await db.taskPage.count({ where: { userId: mira.id, parentId: id } }), 2);
  const again = await apply(mira.id, "hub_save_app_item_as_page", { source: "notion", kind: "page", id: root });
  assert.equal((again.result.data as { id: string }).id, id);
  assert.equal(await db.taskPage.count({ where: { userId: mira.id } }), 3);
  assert.equal((await db.taskPage.findUniqueOrThrow({ where: { id } })).revision, page.revision);
  await undoLast(db, mira.id, imported.result.undoEntryId!);
  assert.equal(await db.taskPage.count({ where: { userId: mira.id, deletedAt: null } }), 0);
  await refused(apply(mira.id, "hub_save_app_item_as_page", { source: "notion", kind: "page", id: root }), /in Trash/);
  await redoLast(db, mira.id, imported.result.undoEntryId!);
  const converted = await mira.inject({ method: "POST", url: `/api/pages/page/${id}/convert`, payload: { revision: page.revision } });
  assert.equal(converted.statusCode, 200, converted.body);
  const updated = await apply(mira.id, "hub_save_app_item_as_page", { source: "notion", kind: "page", id: root });
  assert.equal(updated.result.href, `/tasks/${converted.json().id}`, "a re-import links to the task the page became");
  assert.equal(await db.task.count({ where: { userId: mira.id, deletedAt: null } }), 1);
});

test("an app item becomes a page with where it came from, once; links inside it never reach another space's rows", async () => {
  handlers.length = 0;
  calls.length = 0;
  const mira = await verified();
  const other = await space(mira, "Side project");
  const foreign = await saveFile(db, other, { filename: "secret.pdf", mediaType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.7") }, { summarize: false });
  mock("https://api.github.com/repos/fieldnote/atlas/issues/42", () => json({ ...ISSUE, body: ISSUE.body.replace("FOREIGN", foreign.id) }));
  await saveAccount(mira.id, "github", { accessToken: "gho_mira_secret_token_0123456789", expiresAt: LATER, scopes: ["repo", "read:user"], account: "mira-chen", meta: { via: "oauth" } });

  const saved = await apply(mira.id, "hub_save_app_item_as_page", { source: "github", kind: "issue", id: "fieldnote/atlas#42" });
  assert.equal(saved.preview, "Save the GitHub issue fieldnote/atlas#42 as a page");
  const id = (saved.result.data as { id: string }).id;
  assert.equal(saved.result.href, `/pages/${id}`);
  const page = await db.taskPage.findUniqueOrThrow({ where: { id } });
  assert.deepEqual([page.userId, page.title, page.taskId, page.externalSource], [mira.id, "Offline mode drops photos", null, "app-item"]);
  const doc = page.content as unknown as PageDocument;
  const nodes = walk(doc.content);
  assert.equal(doc.content[0]!.type, "paragraph");
  assert.ok(nodes.some((node) => node.type === "text" && node.text === "From GitHub"), "the first line says where it came from");
  assert.ok(nodes.some((node) => node.marks?.some((mark) => mark.type === "link" && mark.attrs?.href === ISSUE.html_url)), "and links back");
  assert.ok(doc.content.some((node) => node.type === "taskList"), "the item's checklist is a real checklist");
  assert.equal(nodes.filter((node) => node.type === "mention").length, 0, "a link to another space's file stays text");
  assert.match(page.searchText ?? "", /Photos taken offline never upload/);

  const before = calls.length;
  const again = await apply(mira.id, "hub_save_app_item_as_page", { source: "github", kind: "issue", id: "fieldnote/atlas#42" });
  assert.deepEqual([(again.result.data as { id: string }).id, (again.result.data as { existing: boolean }).existing], [id, true]);
  assert.equal(calls.length, before);
  await apply(mira.id, "hub_delete_page", { pageId: id });
  const fresh = await apply(mira.id, "hub_save_app_item_as_page", { source: "github", kind: "issue", id: "fieldnote/atlas#42", title: "Photos bug" });
  const freshId = (fresh.result.data as { id: string }).id;
  assert.notEqual(freshId, id, "a copy in Trash does not block saving again");
  assert.equal((await db.taskPage.findUniqueOrThrow({ where: { id: freshId } })).title, "Photos bug");

  const saver = tool("hub_save_app_item_as_page");
  await refused(saver.preview!(ctx(mira.id), saver.input.parse({ source: "github", kind: "page", id: "x" })), /GitHub has no page items/, 400);
  await refused(saver.preview!(ctx(mira.id), saver.input.parse({ source: "nowhere", kind: "page", id: "x" })), /Ensemble cannot read nowhere/, 400);
  await refused(applyHeldCalls(harness.app, ctx(other), [{ tool: saver, input: saver.input.parse({ source: "github", kind: "issue", id: "fieldnote/atlas#42" }) }]), /not connected/);
  assert.equal(await db.taskPage.count({ where: { userId: other, externalSource: "app-item" } }), 0);
});

async function workbook(): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  const summary = book.addWorksheet("Summary");
  summary.addRow(["Note"]);
  summary.addRow(["See the Sales tab"]);
  const sales = book.addWorksheet("Sales");
  sales.addRow(["Region", "Revenue"]);
  sales.addRow(["North", 120]);
  sales.addRow(["South", 80]);
  return new Uint8Array(await book.xlsx.writeBuffer());
}

test("a CSV or a workbook sheet in Files becomes a Plots dataset; pasted CSV still works; another space's file is not found", async () => {
  const mira = await verified();
  const csv = await saveFile(db, mira.id, { filename: "readings.csv", mediaType: "text/csv", bytes: new TextEncoder().encode("site,ph\nNorth,7.1\nSouth,6.8\n") }, { summarize: false });
  const book = await saveFile(db, mira.id, { filename: "sales.xlsx", mediaType: "application/octet-stream", bytes: await workbook() }, { summarize: false });
  await fileTextSettled(csv.id);
  await fileTextSettled(book.id);

  const fromCsv = await apply(mira.id, "hub_import_dataset", { fileId: csv.id });
  assert.equal(fromCsv.preview, "Import dataset “readings” from readings.csv");
  const csvData = fromCsv.result.data as { id: string; name: string; rowCount: number; columns: Array<{ name: string }> };
  assert.deepEqual([csvData.name, csvData.rowCount, csvData.columns.map((column) => column.name)], ["readings", 2, ["site", "ph"]]);
  assert.equal((await db.plotDataset.findUniqueOrThrow({ where: { id: csvData.id } })).userId, mira.id);

  const fromSheet = await apply(mira.id, "hub_import_dataset", { fileId: book.id, sheet: "sales" });
  assert.equal(fromSheet.preview, "Import dataset “sales – Sales” from sales.xlsx (sheet Sales)");
  const sheetData = fromSheet.result.data as { rowCount: number; columns: Array<{ name: string; type: string }>; sheets: string[] };
  assert.equal(sheetData.rowCount, 2);
  assert.deepEqual(sheetData.columns.map((column) => [column.name, column.type]), [["Region", "category"], ["Revenue", "number"]]);
  assert.deepEqual(sheetData.sheets, ["Summary", "Sales"]);
  const importer = tool("hub_import_dataset");
  await refused(importer.preview!(ctx(mira.id), importer.input.parse({ fileId: book.id, sheet: "Costs" })), /sales\.xlsx has no sheet “Costs”\. Its sheets: Summary, Sales\./, 400);
  await refused(importer.preview!(ctx(mira.id), importer.input.parse({ fileId: csv.id, text: "a,b\n1,2" })), /Send either fileId/, 400);
  await refused(importer.preview!(ctx(mira.id), importer.input.parse({ name: "Nothing" })), /Send either fileId/, 400);

  const pasted = await apply(mira.id, "hub_import_dataset", { name: "Pasted", text: "x,y\n1,2\n3,4" });
  assert.equal((pasted.result.data as { rowCount: number }).rowCount, 2);

  const other = await space(mira, "Side project");
  await refused(importer.preview!(ctx(other), importer.input.parse({ fileId: csv.id })), /No file with that id in Files/, 404);
  await refused(applyHeldCalls(harness.app, ctx(other), [{ tool: importer, input: importer.input.parse({ fileId: csv.id }) }]), /No file with that id in Files/);
  assert.equal(await db.plotDataset.count({ where: { userId: other } }), 0);
});
