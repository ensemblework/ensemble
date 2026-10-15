/**
 * The assistant's page tools on the in-memory database: Markdown becomes real blocks and
 * `ensemble://` links become mentions (only for rows in this space), pages read back as Markdown
 * in parts, append and replace with the title guard, task pages, Trash and undo, and another
 * space of the same account can neither read nor write them.
 */
import type { Prisma } from "@prisma/client";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { DEFAULT_SETTINGS, type PageDocument, type PageNode } from "@ensemble/shared-types";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../../test/http.js";

const harness: HttpHarness = await createHttpHarness();
const db = harness.prisma;
const { getTool } = await import("../registry.js");
const { applyHeldCalls } = await import("../apply.js");
const { undoLast } = await import("../../lib/undo.js");
const { saveFile } = await import("../../files/store.js");
const { fileTextSettled } = await import("../../files/extract.js");
const { filesOnPage } = await import("../../files/attached.js");
const { newWriterState, writeBatch, finishPageImport } = await import("../../imports/apply.js");
const { emptyCounts } = await import("../../imports/types.js");
const { notionNodes } = await import("../../imports/notion-content.js");
const { pageAgentText } = await import("../../pages/agent-context.js");
const { loadOpenPage } = await import("../state.js");
const { commentPageText } = await import("../../routes/comments.js");
const { readItem: bridgeReadItem } = await import("../../bridge/service.js");
const { attachClaimedFiles } = await import("../../remote/accept.js");
const { makePdf } = await import("../../files/testing.js");
const { filesOnTask, fileOriginal, fileText } = await import("../../files/attached.js");
const { markdownToNodes, pageMarkdown } = await import("../../pages/markdown.js");
type ToolContext = import("../types.js").ToolContext;
type AnyHubTool = import("../types.js").AnyHubTool;

after(() => harness.close());

test("Notion children resolve across batches; bulk deletion and one Undo restore content, nesting and attachments", async () => {
  const mira = await harness.asUser();
  const state = newWriterState(mira.id, { externalSource: "notion", sourceKind: "notion", sourceLabel: "Notion", importAs: {}, statusMap: {} }, emptyCounts());
  const content: PageDocument = { type: "doc", content: notionNodes([
    { type: "toggle", toggle: { rich_text: [{ plain_text: "Details", annotations: { bold: true, italic: true, underline: true } }] }, children: [
      { type: "numbered_list_item", numbered_list_item: { rich_text: [{ plain_text: "Step one" }] }, children: [{ type: "code", code: { language: "python", rich_text: [{ plain_text: "print('inside')" }] } }] },
    ] },
    { type: "child_page", id: "child", child_page: { title: "Child" } },
  ]) };
  await writeBatch(db, state, [{ kind: "page", externalId: "child", title: "Child", parentRef: "root", pageMarkdown: "Nested text" }]);
  await writeBatch(db, state, [{ kind: "page", externalId: "root", title: "Root", pageContent: content }]);
  await db.$transaction((tx) => finishPageImport(tx, state));
  const root = await db.taskPage.findFirstOrThrow({ where: { userId: mira.id, externalId: "root" } });
  const child = await db.taskPage.findFirstOrThrow({ where: { userId: mira.id, externalId: "child" } });
  assert.equal(child.parentId, root.id);
  const nodes = (root.content as unknown as PageDocument).content;
  assert.equal(nodes.at(-1)!.attrs!.pageId, child.id);
  assert.deepEqual(nodes[1]!.content![0]!.content![0]!.marks!.map((mark) => mark.type), ["bold", "italic", "underline"]);
  const second = await db.taskPage.create({ data: { userId: mira.id, title: "Other selected page" } });
  const deleted = await apply(mira.id, "hub_delete_pages", { pageIds: [root.id, second.id, root.id] });
  assert.ok(deleted.undoEntryId);
  assert.equal(await db.undoEntry.count({ where: { userId: mira.id, undoneAt: null } }), 1);
  for (const id of [root.id, child.id, second.id]) assert.ok((await db.taskPage.findUniqueOrThrow({ where: { id } })).deletedAt);
  await undoLast(db, mira.id, deleted.undoEntryId!);
  const restored = await db.taskPage.findUniqueOrThrow({ where: { id: child.id } });
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.parentId, root.id);
  assert.deepEqual((await db.taskPage.findUniqueOrThrow({ where: { id: root.id } })).content, root.content);
  const outsider = await harness.asUser();
  await assert.rejects(apply(outsider.id, "hub_delete_pages", { pageIds: [root.id] }), /unavailable/);
  const foreign = await db.taskPage.create({ data: { userId: outsider.id, title: "Foreign" } });
  const response = await mira.inject({ method: "POST", url: "/api/pages/delete-many", payload: { pageIds: [second.id, foreign.id] } });
  assert.equal(response.statusCode, 404, response.body);
  assert.equal((await db.taskPage.findUniqueOrThrow({ where: { id: second.id } })).deletedAt, null);
  const converted = await mira.inject({ method: "POST", url: `/api/pages/page/${root.id}/convert`, payload: { revision: root.revision } });
  assert.equal(converted.statusCode, 200, converted.body);
  const nested = await mira.inject({ method: "GET", url: `/api/pages/${child.id}` });
  assert.equal(nested.json().parentId, root.id);
  assert.equal(nested.json().parentTaskId, converted.json().id, "children can navigate back after their parent becomes an agent task");
});

test("page context includes owned diagram source and a converted document's original", async () => {
  const mira = await harness.asUser();
  const outsider = await harness.asUser();
  const own = await db.blockDiagram.create({ data: { userId: mira.id, title: "Transformer", source: "diagram Transformer\nblock attention: Multi-head attention", document: {} } });
  const foreign = await db.blockDiagram.create({ data: { userId: outsider.id, title: "Private", source: "SECRET", document: {} } });
  const content: PageDocument = { type: "doc", content: [{ type: "toggleBlock", attrs: { collapsed: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Architecture" }] }, { type: "paragraph", content: [own, foreign].map((diagram) => ({ type: "mention", attrs: { kind: "diagram", id: diagram.id, label: diagram.title } })) }] }] };
  const context = await pageAgentText(db, mira.id, content, "");
  assert.match(context, /Multi-head attention/);
  assert.doesNotMatch(context, /SECRET/);
  const file = await saveFile(db, mira.id, { filename: "brief.md", mediaType: "text/markdown", bytes: new TextEncoder().encode("Full document text") }, { summarize: false });
  const page = await db.taskPage.create({ data: { userId: mira.id, title: "From a file", sourceFileId: file.id, content: content as Prisma.InputJsonValue } });
  assert.equal((await filesOnPage(db, mira.id, page.id))[0]!.id, file.id);
  const open = await loadOpenPage(db, mira.id, { path: `/pages/${page.id}` }, "UTC", "2026-10-15", "Thursday");
  assert.match(open!.open!.diagrams!, /Multi-head attention/);
  assert.match(open!.open!.files!, /brief.md/);
  const inline = await commentPageText(db, mira.id, "page", page.id);
  assert.match(inline, /Multi-head attention/);
  assert.doesNotMatch(inline, /SECRET/);
  const bridge = await bridgeReadItem(db, mira.id, "page", page.id, 0, 20_000);
  assert.match(JSON.stringify(bridge), /Multi-head attention/);
  assert.doesNotMatch(JSON.stringify(bridge), /SECRET/);
  const token = await harness.asToken(mira, "device");
  const device = await db.device.create({ data: { userId: mira.id, tokenId: token.id, name: "Task computer", platform: "macos" } });
  const task = await db.task.create({ data: { userId: mira.id, title: "Read the source and original", owner: "agent", status: "todo" } });
  await db.taskPage.update({ where: { id: page.id }, data: { taskId: task.id } });
  const job = await db.workspaceJob.create({ data: { userId: mira.id, taskId: task.id, deviceId: device.id, executionMode: "auto", model: "fixture", status: "queued" } });
  const claim = await token.inject({ method: "POST", url: "/api/devices/self/claim", payload: {} });
  assert.equal(claim.statusCode, 200, claim.body);
  const spec = claim.json<{ id: string; leaseToken: string; task: { page: string }; attachments: Array<{ id: string }> }>();
  assert.equal(spec.id, job.id);
  assert.match(spec.task.page, /Multi-head attention/);
  assert.doesNotMatch(spec.task.page, /SECRET/);
  assert.ok(spec.attachments.some((attachment) => attachment.id === file.id));
  const download = (fileId: string, lease = spec.leaseToken) => token.inject({ method: "GET", url: `/api/devices/self/jobs/${job.id}/attachments/${fileId}`, headers: { "x-ensemble-job-lease": lease } });
  const original = await download(file.id);
  assert.equal(original.statusCode, 200, original.body);
  assert.equal(original.body, "Full document text");
  const sourceFile = await download(own.id);
  assert.equal(sourceFile.statusCode, 200, sourceFile.body);
  assert.equal(sourceFile.body, own.source);
  assert.equal((await download(file.id, "wrong-lease")).statusCode, 409);
  assert.equal((await download(randomUUID())).statusCode, 404);
  const foreignToken = await harness.asToken(outsider, "device");
  await db.device.create({ data: { userId: outsider.id, tokenId: foreignToken.id, name: "Other computer", platform: "macos" } });
  const otherDownload = await foreignToken.inject({ method: "GET", url: `/api/devices/self/jobs/${job.id}/attachments/${file.id}`, headers: { "x-ensemble-job-lease": spec.leaseToken } });
  assert.equal(otherDownload.statusCode, 404);
  await db.workspaceJob.update({ where: { id: job.id }, data: { leaseUntil: new Date(0) } });
  assert.equal((await download(file.id)).statusCode, 409);
});

test("Markdown preserves nested ordered items, code and collapsible blocks on round trips", () => {
  const source = "<details>\n<summary>Details</summary>\n\n3. First\n  - Nested\n  ```python\n  print('hi')\n  ```\n4. Second\n\n</details>";
  const doc: PageDocument = { type: "doc", content: markdownToNodes(source) };
  const toggle = doc.content[0]!;
  assert.equal(toggle.type, "toggleBlock");
  assert.equal(toggle.attrs!.collapsed, true);
  const ordered = toggle.content![1]!;
  assert.equal(ordered.type, "orderedList");
  assert.equal(ordered.attrs!.start, 3);
  assert.deepEqual(ordered.content![0]!.content!.map((node) => node.type), ["paragraph", "bulletList", "codeBlock"]);
  assert.deepEqual(markdownToNodes(pageMarkdown(doc, "")), doc.content);
});

test("a paired runner's PDF and full diagram source are readable by the local ids in its task page", async () => {
  const mira = await harness.asUser();
  const task = await db.task.create({ data: { userId: mira.id, title: "Use the PDF and diagram" } });
  const pdfId = randomUUID();
  const diagramId = randomUUID();
  const pdf = makePdf(["Read the complete Fieldnote brief"]);
  const source = new TextEncoder().encode("diagram Training\nblock attention: Multi-head attention");
  const notes = await attachClaimedFiles(db, mira.id, task.id, randomUUID(), [
    { attachment: { id: pdfId, filename: "brief.pdf", kind: "file", byteSize: pdf.byteLength }, bytes: pdf },
    { attachment: { id: diagramId, filename: "Training.ensemble-diagram.txt", kind: "diagram", byteSize: source.byteLength }, bytes: source },
  ], `[@Brief](ensemble://file/${pdfId})\n[@Training](ensemble://diagram/${diagramId})\nDiagram (diagram id ${diagramId})\n[Source truncated; read the diagram for the rest.]`);
  const files = await filesOnTask(db, mira.id, task.id);
  assert.equal(files.length, 2);
  const localPdf = files.find((file) => file.filename === "brief.pdf")!;
  const localSource = files.find((file) => file.filename === "Training.ensemble-diagram.txt")!;
  assert.match(notes, new RegExp(`ensemble://file/${localPdf.id}`));
  assert.match(notes, new RegExp(`diagram source file id ${localSource.id}`));
  assert.doesNotMatch(notes, new RegExp(`${pdfId}|${diagramId}`));
  assert.deepEqual(new Uint8Array((await fileOriginal(db, mira.id, localPdf.id))!.bytes), new Uint8Array(pdf));
  await fileTextSettled(localPdf.id);
  assert.match((await fileText(db, mira.id, localPdf.id))!.text, /complete Fieldnote brief/);
  assert.match((await fileText(db, mira.id, localSource.id))!.text, /Multi-head attention/);
});

function ctx(userId: string): ToolContext {
  return { app: harness.app, prisma: db, userId, actor: "agent", settings: { ...DEFAULT_SETTINGS, timezone: "UTC" } };
}

function tool(name: string): AnyHubTool {
  const found = getTool(name);
  assert.ok(found, `${name} is registered`);
  return found;
}

async function read(userId: string, name: string, input: Record<string, unknown>) {
  const t = tool(name);
  return t.run(ctx(userId), t.input.parse(input));
}

/** Runs a write the way Apply does: preview first, then in the batch transaction with one undo entry. */
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

function types(doc: PageDocument): string[] {
  return doc.content.map((node) => node.type);
}

function walk(nodes: PageNode[] | undefined, out: PageNode[] = []): PageNode[] {
  for (const node of nodes ?? []) {
    out.push(node);
    walk(node.content, out);
  }
  return out;
}

async function pageDoc(id: string): Promise<PageDocument> {
  const row = await db.taskPage.findUniqueOrThrow({ where: { id } });
  return row.content as unknown as PageDocument;
}

const BODY = [
  "# Field visit plan",
  "",
  "Bring the brief: [@Field brief.md](ensemble://file/FILE) and ask [@Arjun](ensemble://person/PERSON).",
  "Unknown: [@Ghost.pdf](ensemble://file/GHOST).",
  "",
  "- Calibrate the probe",
  "- Photograph each site",
  "",
  "- [ ] Book the van",
  "- [x] Print the map",
  "",
  "| Site | pH |",
  "| --- | --- |",
  "| North | 7.1 |",
  "",
  "```python",
  "print('ok')",
  "```",
].join("\n");

test("Markdown becomes blocks, ensemble links become mentions in this space only, and the page reads back as Markdown in parts", async () => {
  const mira = await harness.asUser();
  const brief = await saveFile(db, mira.id, { filename: "Field brief.md", mediaType: "text/markdown", bytes: new TextEncoder().encode("# Brief") }, { summarize: false });
  await fileTextSettled(brief.id);
  const arjun = await db.person.create({ data: { userId: mira.id, name: "Arjun Rao" } });
  const markdown = BODY.replace("FILE", brief.id).replace("PERSON", arjun.id).replace("GHOST", randomUUID());

  const created = await apply(mira.id, "hub_create_page", { title: "Visit plan", markdown });
  assert.match(String(created.preview), /^Create page “Visit plan” \(\d+ blocks\)$/);
  const id = (created.result.data as { id: string }).id;
  assert.equal(created.result.href, `/pages/${id}`);
  assert.match(created.result.summary, /1 link\(s\) did not match anything in this space and stay as text: Ghost\.pdf/);
  assert.ok(created.undoEntryId);

  const doc = await pageDoc(id);
  assert.deepEqual(types(doc), ["heading", "paragraph", "bulletList", "taskList", "table", "codeBlock"]);
  const mentions = walk(doc.content).filter((node) => node.type === "mention").map((node) => node.attrs);
  assert.deepEqual(mentions, [
    { kind: "file", id: brief.id, label: "Field brief.md" },
    { kind: "people", id: arjun.id, label: "Arjun" },
  ]);
  assert.ok(walk(doc.content).some((node) => node.type === "text" && node.text === "@Ghost.pdf"), "an unknown id stays text");
  const checked = doc.content[3]!.content!.map((item) => item.attrs?.checked);
  assert.deepEqual(checked, [false, true]);
  assert.deepEqual((await db.taskPageMention.findMany({ where: { pageId: id }, orderBy: { kind: "asc" } })).map((row) => [row.kind, row.entityId]), [["file", brief.id], ["people", arjun.id]]);
  assert.deepEqual((await filesOnPage(db, mira.id, id)).map((file) => file.id), [brief.id], "the file link attaches the file to the page");

  const back = await read(mira.id, "hub_read_page", { pageId: id });
  const text = (back.data as { text: string }).text;
  assert.match(text, /^# Field visit plan/);
  assert.ok(text.includes(`[@Field brief.md](ensemble://file/${brief.id})`));
  assert.ok(text.includes(`[@Arjun](ensemble://people/${arjun.id})`));
  assert.ok(text.includes("- [ ] Book the van\n- [x] Print the map"));
  assert.ok(text.includes("| Site | pH |\n| --- | --- |\n| North | 7.1 |"));
  assert.ok(text.includes("```python\nprint('ok')\n```"));
  assert.equal(back.href, `/pages/${id}`);

  const listed = await read(mira.id, "hub_list_pages", { query: "calibrate" });
  assert.deepEqual((listed.data as { pages: Array<{ id: string; title: string }> }).pages.map((row) => row.title), ["Visit plan"]);

  const long = Array.from({ length: 400 }, (_, index) => `- Reading ${index + 1}: north field pH 7.${index % 10}`).join("\n");
  const big = await apply(mira.id, "hub_create_page", { title: "Readings", markdown: long });
  const bigId = (big.result.data as { id: string }).id;
  const first = (await read(mira.id, "hub_read_page", { pageId: bigId })).data as { text: string; nextOffset?: number; total: number };
  assert.ok(first.nextOffset && first.nextOffset < first.total);
  const second = (await read(mira.id, "hub_read_page", { pageId: bigId, offset: first.nextOffset })).data as { text: string; offset: number };
  assert.equal(second.offset, first.nextOffset);
  assert.ok(!second.text.startsWith("- Reading 1:"));

  await undoLast(db, mira.id, created.undoEntryId!);
  assert.ok((await db.taskPage.findUniqueOrThrow({ where: { id } })).deletedAt, "undoing the create moves the page to Trash");
  await refused(read(mira.id, "hub_read_page", { pageId: id }), /No page with that id/, 404);
});

test("append keeps the page, replace rewrites it behind the title guard, task pages work by taskId, and undo and Trash bring things back", async () => {
  const mira = await harness.asUser();
  const created = await apply(mira.id, "hub_create_page", { title: "Launch notes", markdown: "Intro line." });
  const id = (created.result.data as { id: string }).id;

  const appended = await apply(mira.id, "hub_update_page", { pageId: id, matchTitle: "launch notes", mode: "append", markdown: "## Next\n\n- Ship it" });
  assert.equal(appended.preview, "Add to “Launch notes”: Next");
  assert.deepEqual(types(await pageDoc(id)), ["paragraph", "heading", "bulletList"]);

  const wrong = tool("hub_update_page");
  await refused(wrong.preview!(ctx(mira.id), wrong.input.parse({ pageId: id, matchTitle: "Other page", mode: "replace", markdown: "x" })), /That page is “Launch notes”, not “Other page”/, 409);
  await refused(applyHeldCalls(harness.app, ctx(mira.id), [{ tool: wrong, input: wrong.input.parse({ pageId: id, matchTitle: "Other page", mode: "replace", markdown: "x" }) }]), /not “Other page”/);
  assert.deepEqual(types(await pageDoc(id)), ["paragraph", "heading", "bulletList"], "a refused write changes nothing");

  const replaced = await apply(mira.id, "hub_update_page", { pageId: id, matchTitle: "Launch notes", mode: "replace", markdown: "Only this.", title: "Launch summary" });
  assert.match(String(replaced.preview), /Rewrite the whole of “Launch notes”, renamed “Launch summary”/);
  const row = await db.taskPage.findUniqueOrThrow({ where: { id } });
  assert.equal(row.title, "Launch summary");
  assert.deepEqual(types(row.content as unknown as PageDocument), ["paragraph"]);
  assert.match(row.searchText ?? "", /^Launch summary\nOnly this\./);
  await undoLast(db, mira.id, replaced.undoEntryId!);
  const restored = await db.taskPage.findUniqueOrThrow({ where: { id } });
  assert.equal(restored.title, "Launch notes");
  assert.deepEqual(types(restored.content as unknown as PageDocument), ["paragraph", "heading", "bulletList"]);

  const task = await db.task.create({ data: { userId: mira.id, title: "Write the report", notes: "Old notes from the board.", boardOrder: 0 } });
  const onTask = await apply(mira.id, "hub_update_page", { taskId: task.id, matchTitle: "Write the report", mode: "append", markdown: "- [ ] Draft section 1" });
  assert.equal(onTask.result.href, `/tasks/${task.id}`);
  const taskPage = await db.taskPage.findFirstOrThrow({ where: { taskId: task.id } });
  assert.deepEqual(types(taskPage.content as unknown as PageDocument), ["paragraph", "taskList"], "the task's notes come first, then the new list");
  const viaTask = (await read(mira.id, "hub_read_page", { taskId: task.id })).data as { text: string; pageId: string };
  assert.equal(viaTask.pageId, taskPage.id);
  assert.equal(viaTask.text, "Old notes from the board.\n\n- [ ] Draft section 1");
  await refused(tool("hub_update_page").preview!(ctx(mira.id), { taskId: task.id, matchTitle: "Write the report", mode: "append", markdown: "x", title: "New" }), /keeps its task's title/);
  await undoLast(db, mira.id, onTask.undoEntryId!);
  assert.equal((await db.taskPage.findUniqueOrThrow({ where: { id: taskPage.id } })).content, null, "undo returns the task page to no content");

  await refused(tool("hub_delete_page").preview!(ctx(mira.id), { pageId: taskPage.id }), /That is the page of task “Write the report”/);
  const deleted = await apply(mira.id, "hub_delete_page", { pageId: id });
  assert.equal(deleted.preview, "Move page “Launch notes” to Trash");
  assert.deepEqual(deleted.result.data, { id, restore: "Undo in the app bar, or Trash (/trash), brings it back." });
  assert.ok((await db.taskPage.findUniqueOrThrow({ where: { id } })).deletedAt);
  await undoLast(db, mira.id, deleted.undoEntryId!);
  assert.equal((await db.taskPage.findUniqueOrThrow({ where: { id } })).deletedAt, null);
});

test("another space of the same account can neither read nor write these pages, and its links to them stay text", async () => {
  const mira = await harness.asUser();
  const other = await space(mira, "Side project");
  const page = await apply(mira.id, "hub_create_page", { title: "Primary plan", markdown: "Secret steps." });
  const pageId = (page.result.data as { id: string }).id;
  const task = await db.task.create({ data: { userId: mira.id, title: "Primary task", boardOrder: 0 } });
  const file = await saveFile(db, mira.id, { filename: "primary.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("Primary only") }, { summarize: false });
  await fileTextSettled(file.id);

  const listed = (await read(other, "hub_list_pages", { query: "" })).data as { pages: Array<{ id: string }> };
  assert.ok(!listed.pages.some((row) => row.id === pageId));
  assert.equal(((await read(other, "hub_list_pages", { query: "Secret" })).data as { total: number }).total, 0);
  await refused(read(other, "hub_read_page", { pageId }), /No page with that id/, 404);
  await refused(read(other, "hub_read_page", { taskId: task.id }), /No task with that id/, 404);
  const update = tool("hub_update_page");
  await refused(update.preview!(ctx(other), update.input.parse({ pageId, matchTitle: "Primary plan", mode: "append", markdown: "x" })), /No page with that id/, 404);
  await refused(applyHeldCalls(harness.app, ctx(other), [{ tool: update, input: update.input.parse({ pageId, matchTitle: "Primary plan", mode: "replace", markdown: "x" }) }]), /No page with that id/);
  await refused(applyHeldCalls(harness.app, ctx(other), [{ tool: update, input: update.input.parse({ taskId: task.id, matchTitle: "Primary task", mode: "append", markdown: "x" }) }]), /No task with that id/);
  const remove = tool("hub_delete_page");
  await refused(applyHeldCalls(harness.app, ctx(other), [{ tool: remove, input: { pageId } }]), /No page with that id/);
  const kept = await db.taskPage.findUniqueOrThrow({ where: { id: pageId } });
  assert.equal(kept.deletedAt, null);
  assert.equal(kept.searchText, "Primary plan\nSecret steps.");
  assert.equal(await db.taskPage.count({ where: { taskId: task.id } }), 0, "no page was made for the other space's task");

  const linked = await apply(other, "hub_create_page", { title: "Links", markdown: `[@primary.txt](ensemble://file/${file.id}) and [@Primary plan](ensemble://task/${task.id})` });
  const linkedDoc = await pageDoc((linked.result.data as { id: string }).id);
  assert.equal(walk(linkedDoc.content).filter((node) => node.type === "mention").length, 0, "ids from another space never become cards");
  assert.match(linked.result.summary, /2 link\(s\) did not match anything in this space/);
});

test("what the assistant writes about a task goes on its page, never in the short description", async () => {
  const mira = await harness.asUser();
  const created = await apply(mira.id, "hub_create_tasks", {
    tasks: [{ title: "Plan the launch", page: "## Steps\n- [ ] Book the room", description: "Kick-off with the team." }],
  });
  assert.match(String(created.preview), /Plan the launch, with a page/);
  const id = (created.result.data as { tasks: Array<{ id: string }> }).tasks[0]!.id;
  const task = await db.task.findUniqueOrThrow({ where: { id } });
  assert.equal(task.description, "", "the short description stays the person's");
  assert.equal(task.notes, "");
  const page = (await read(mira.id, "hub_read_page", { taskId: id })).data as { text: string };
  assert.equal(page.text, "## Steps\n\n- [ ] Book the room\n\nKick-off with the team.");

  await apply(mira.id, "hub_update_task", { taskId: id, matchTitle: "Plan the launch", description: "Send the invite.", priority: "p0" });
  const after = await db.task.findUniqueOrThrow({ where: { id } });
  assert.equal(after.description, "");
  assert.equal(after.priority, "p0");
  assert.match(((await read(mira.id, "hub_read_page", { taskId: id })).data as { text: string }).text, /Kick-off with the team\.\n\nSend the invite\.$/);

  const onlyPage = await apply(mira.id, "hub_update_task", { taskId: id, matchTitle: "Plan the launch", page: "Done when the room is booked." });
  assert.equal(onlyPage.preview, "Add to the page of “Plan the launch”: Done when the room is booked.");
  await refused(apply(mira.id, "hub_update_task", { taskId: id, matchTitle: "Another task", page: "x" }), /not “Another task”/);
  await undoLast(db, mira.id, onlyPage.undoEntryId!);
  assert.doesNotMatch(((await read(mira.id, "hub_read_page", { taskId: id })).data as { text: string }).text, /room is booked/);
});

test("automatic task creation keeps context on the page and cannot replace a human description", async () => {
  const { createTask, updateTask } = await import("../../services/tasks.js");
  const person = await harness.asUser("human-description@fieldnote.example");
  const task = await db.$transaction((tx) => createTask(tx, person.id, { title: "Plan a review", description: "## Context\nRead the checklist." }, "agent"));
  assert.equal(task.description, "");
  const page = await db.taskPage.findUniqueOrThrow({ where: { taskId: task.id } });
  assert.match(pageMarkdown(page.content as unknown as PageDocument, ""), /Context.*Read the checklist/s);
  await db.$transaction((tx) => updateTask(tx, person.id, task.id, { description: "Written by a person." }, "me"));
  await assert.rejects(db.$transaction((tx) => updateTask(tx, person.id, task.id, { description: "Automated replacement" }, "agent")), /short description is for people/);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).description, "Written by a person.");
});
