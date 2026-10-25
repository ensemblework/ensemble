import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS, PageDocument } from "@ensemble/shared-types";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import { advertisedTools, findPlaybook, routePlaybooks, playbooksFor, simpleTodoRequest } from "./skills/index.js";
import type { ToolContext } from "./types.js";

const h = await createHttpHarness();
const { getTool, TOOL_NAMES, APP_TOOL_LIST, toolAllowedFor } = await import("./registry.js");
const { saveFile } = await import("../files/store.js");
const { fileTextSettled } = await import("../files/extract.js");
const { undoLast } = await import("../lib/undo.js");
const { markdownToDocx } = await import("../lib/office/docx.js");
const { docxText } = await import("../lib/office/extract.js");
const { rowsToXlsx, xlsxToRows } = await import("../lib/office/xlsx.js");
const { replaceOfficeText } = await import("../files/office-edit.js");
const { resolveWorkflowRefs, workflowTools } = await import("./tools/workflows.js");
const { runInScope } = await import("../sharing/context.js");
after(() => h.close());
const context = (u: HttpUser, extra: Partial<ToolContext> = {}): ToolContext => ({ app: h.app, prisma: h.prisma, userId: u.id, actor: "agent", settings: { ...DEFAULT_SETTINGS, timezone: "Asia/Kolkata" }, requestHeaders: { cookie: u.cookie }, ...extra });
async function run(u: HttpUser, name: string, input: unknown, extra: Partial<ToolContext> = {}) { const tool = getTool(name)!; assert.ok(tool, name); return tool.run(context(u, extra), tool.input.parse(input)); }
async function apply(u: HttpUser, name: string, input: Record<string, unknown>, existing?: { conversationId: string; callId: string }) {
 const ids = existing ?? { conversationId: randomUUID(), callId: randomUUID() };
 if (!existing) { await h.prisma.assistantConversation.create({ data: { id: ids.conversationId, userId: u.id } }); await h.prisma.assistantMessage.create({ data: { userId: u.id, conversationId: ids.conversationId, role: "assistant", toolCalls: [{ id: ids.callId, name, input, state: "awaiting_approval", isWrite: true }] as never } }); }
 const response = await u.inject({ method: "POST", url: "/api/assistant/apply", payload: { ...ids, name, input } });
 return { ...ids, response, body: response.json() };
}

test("one Apply creates and links dependent People, project and tasks; repeated Apply never duplicates", async () => {
 const u = await h.asUser();
 const input = { title: "Set up Launch", steps: [
  { id: "person", tool: "hub_create_person", input: { name: "Mira Chen", email: "mira@fieldnote.example" } },
  { id: "project", tool: "hub_create_project", input: { name: "Launch" } },
  { id: "tasks", tool: "hub_create_tasks", input: { tasks: [{ title: "Review launch", status: "todo", projectId: { $ref: "project.project.id" }, people: [{ $ref: "person.person.id" }] }] } },
 ] };
 const result = await apply(u, "hub_run_workflow", input);
 assert.equal(result.response.statusCode, 200, result.response.body);
 assert.equal(result.body.partial, undefined, result.response.body);
 const task = await h.prisma.task.findFirstOrThrow({ where: { userId: u.id, title: "Review launch" } });
 const person = await h.prisma.person.findFirstOrThrow({ where: { userId: u.id, name: "Mira Chen" } });
 const project = await h.prisma.project.findFirstOrThrow({ where: { userId: u.id, name: "Launch" } });
 assert.deepEqual(task.people, [person.id]); assert.equal(task.projectId, project.id);
 const again = await apply(u, "hub_run_workflow", input, result);
 assert.equal(again.body.already, true);
 assert.equal(await h.prisma.person.count({ where: { userId: u.id } }), 1);
 assert.equal(await h.prisma.task.count({ where: { userId: u.id } }), 1);
});

test("dependent workflow failure resumes after successful steps, and refuses forward refs or nested workflows", async () => {
 const u = await h.asUser();
 const targetId = randomUUID();
 const input = { title: "Create and update", steps: [
  { id: "person", tool: "hub_create_person", input: { name: "Avery" } },
  { id: "change", tool: "hub_update_person", input: { personId: targetId, role: "Designer" } },
 ] };
 const first = await apply(u, "hub_run_workflow", input);
 assert.equal(first.response.statusCode, 200, first.response.body); assert.equal(first.body.partial, true);
 assert.match(first.body.failed[0].error, /Completed: person/);
 await h.prisma.person.create({ data: { id: targetId, userId: u.id, name: "Rowan" } });
 const storedMessage = await h.prisma.assistantMessage.findFirstOrThrow({ where: { conversationId: first.conversationId, role: "assistant" } });
 const storedInput = (storedMessage.toolCalls as any[])[0].input;
 const changed = await apply(u, "hub_run_workflow", { ...input, title: "Changed after proposal" }, first); assert.equal(changed.response.statusCode, 409);
 const retry = await apply(u, "hub_run_workflow", storedInput, first);
 assert.equal(retry.body.partial, undefined, retry.response.body);
 assert.equal(await h.prisma.person.count({ where: { userId: u.id, name: "Avery" } }), 1);
 assert.equal((await h.prisma.person.findUniqueOrThrow({ where: { id: targetId } })).role, "Designer");
 const tool = workflowTools[0]!;
 await assert.rejects(async () => tool.preview!(context(u), { title: "Bad", steps: [{ id: "a", tool: "hub_create_person", input: { name: { $ref: "b.id" } } }, { id: "b", tool: "hub_create_person", input: { name: "B" } }] }), /earlier/);
 assert.throws(() => resolveWorkflowRefs({ $ref: "a.constructor" }, new Map([["a", {}]])), /No result/);
});

test("workflow respects area and shared-space permissions", async () => {
 const u = await h.asUser(); const tool = workflowTools[0]!;
 const input = { title: "People", steps: [{ id: "a", tool: "hub_create_person", input: { name: "A" } }, { id: "b", tool: "hub_create_person", input: { name: "B" } }] };
 await assert.rejects(async () => tool.preview!({ ...context(u), settings: { ...DEFAULT_SETTINGS, assistant: { ...DEFAULT_SETTINGS.assistant, allowedWriteAreas: ["tasks"] } } }, input), /available/);
 const { toolsForTurn } = await import("./apps.js");
 await runInScope({ spaceId: u.id, accountId: "guest", access: { kind: "member", role: "viewer", ownerId: u.id } }, async () => {
  const offered = await toolsForTurn(context(u)); assert.equal(offered.some(tool => tool.isWrite), false);
 });
 await runInScope({ spaceId: u.id, accountId: "guest", access: { kind: "member", role: "editor", ownerId: u.id } }, async () => {
  const offered = await toolsForTurn(context(u)); for (const name of ["hub_edit_layout", "hub_manage_app_relationship", "hub_start_board_import"]) assert.equal(offered.some(tool => tool.name === name), false, name);
 });
 assert.equal(toolAllowedFor(getTool("hub_manage_skill")!, "tasks"), false);
});

test("Today, Board and Context layout edits retain unrelated tiles, reject stale versions and undo", async () => {
 const u = await h.asUser();
 for (const surface of ["today", "board", "context"] as const) {
  const read = (await run(u, "hub_read_layout", { surface })).data as any;
  const available = read.available.find((row: any) => !read.document.placements.some((tile: any) => tile.type === row.type) && row.type !== "orbit"); assert.ok(available);
  const before = read.document.placements;
  const result = await run(u, "hub_edit_layout", { surface, version: read.version, edits: [{ action: "add", type: available.type, size: available.size }] });
  const doc = (result.data as any).document; assert.deepEqual(doc.placements.slice(0, before.length), before);
  await assert.rejects(run(u, "hub_edit_layout", { surface, version: read.version, edits: [{ action: "remove", type: available.type }] }), /changed/);
  await undoLast(h.prisma, u.id);
  const restored = (await run(u, "hub_read_layout", { surface })).data as any; assert.deepEqual(restored.document, read.document);
 }
});

test("precise page edits preserve unrelated blocks, links and formatting and reject stale revision", async () => {
 const u = await h.asUser();
 const created = await run(u, "hub_create_page", { title: "Launch plan", markdown: "## Plan\n\nKeep **this** intact.\n\nChange the old date.\n\nLast paragraph." });
 const pageId = (created.data as any).id;
 const read = (await run(u, "hub_read_page_blocks", { pageId })).data as any;
 const block = read.blocks.find((row: any) => row.markdown.includes("old date"));
 const before = await h.prisma.taskPage.findUniqueOrThrow({ where: { id: pageId } });
 await run(u, "hub_edit_page", { pageId, revision: read.revision, edits: [{ path: block.path, action: "replace_text", expected: block.markdown, find: "old date", replacement: "new date" }] });
 const after = await h.prisma.taskPage.findUniqueOrThrow({ where: { id: pageId } });
 const first = PageDocument.parse(before.content), next = PageDocument.parse(after.content);
 assert.deepEqual(next.content[1], first.content[1]); assert.match(JSON.stringify(next), /new date/); assert.deepEqual(next.content.at(-1), first.content.at(-1));
 await assert.rejects(run(u, "hub_edit_page", { pageId, revision: read.revision, edits: [{ path: block.path, action: "delete", expected: block.markdown }] }), /changed/);
 await undoLast(h.prisma, u.id); assert.deepEqual((await h.prisma.taskPage.findUniqueOrThrow({ where: { id: pageId } })).content, before.content);
 const outsider = await h.asUser(); await assert.rejects(run(outsider, "hub_read_page_blocks", { pageId }));
});

test("nested page moves refuse cycles and foreign parents", async () => {
 const u = await h.asUser(); const outsider = await h.asUser();
 const a = (await run(u, "hub_create_page", { title: "A" })).data as any;
 const b = (await run(u, "hub_create_page", { title: "B" })).data as any;
 const c = (await run(outsider, "hub_create_page", { title: "C" })).data as any;
 await run(u, "hub_move_page", { pageId: b.id, parentId: a.id });
 await assert.rejects(run(u, "hub_move_page", { pageId: a.id, parentId: b.id }), /descendant/);
 await assert.rejects(run(u, "hub_move_page", { pageId: a.id, parentId: c.id }), /not found/);
});

test("personal skills create with a body, version edits, disabled discovery and stale writes", async () => {
 const u = await h.asUser();
 const created = (await run(u, "hub_manage_skill", { action: "create", name: "Weekly updates", body: "Use three concise bullets." })).data as any;
 const read = (await run(u, "hub_read_skill", { skillId: created.id })).data as any;
 assert.equal(read.skill.body, "Use three concise bullets.");
 await run(u, "hub_manage_skill", { action: "update", skillId: created.id, expectedVersion: read.skill.version, body: "Use four bullets.", enabled: false });
 await assert.rejects(run(u, "hub_manage_skill", { action: "update", skillId: created.id, expectedVersion: read.skill.version, body: "Stale" }), /changed/);
 const skills = (await run(u, "hub_list_skills", { includeDisabled: true })).data as any; assert.ok(skills.skills.some((row: any) => row.id === created.id && !row.enabled));
 const outsider = await h.asUser(); await assert.rejects(run(outsider, "hub_manage_skill", { action: "update", skillId: created.id, expectedVersion: 2, body: "Foreign" }), /not found/i);
});

test("original text and Word edits preserve IDs, enforce content hashes and leave other formatting", async () => {
 const u = await h.asUser();
 const file = await saveFile(h.prisma, u.id, { filename: "plan.md", mediaType: "text/markdown", bytes: Buffer.from("A unique old date.\nKeep this.") }, { summarize: false });
 const info = (await run(u, "hub_file_edit_info", { fileId: file.id })).data as any;
 await run(u, "hub_edit_file", { fileId: file.id, expectedSha256: info.expectedSha256, action: "replace_text", find: "old date", replacement: "new date" });
 const saved = await h.prisma.document.findUniqueOrThrow({ where: { id: file.id } }); assert.equal(Buffer.from(saved.original!).toString(), "A unique new date.\nKeep this.");
 await assert.rejects(run(u, "hub_edit_file", { fileId: file.id, expectedSha256: info.expectedSha256, action: "replace_text", find: "new date", replacement: "other date" }), /changed/);
 const bytes = await markdownToDocx("# Agreement\n\nKeep **bold** formatting.\n\nReplace old clause.");
 const word = await saveFile(h.prisma, u.id, { filename: "agreement.docx", mediaType: "application/octet-stream", bytes }, { summarize: false });
 await fileTextSettled(word.id);
 const wordInfo = (await run(u, "hub_file_edit_info", { fileId: word.id })).data as any;
 await run(u, "hub_edit_file", { fileId: word.id, expectedSha256: wordInfo.expectedSha256, action: "replace_text", find: "old clause", replacement: "new clause" });
 const updated = await h.prisma.document.findUniqueOrThrow({ where: { id: word.id } }); assert.match(docxText(updated.original!), /new clause/);
 const { unzipSync, strFromU8 } = await import("fflate");
 const originalXml = strFromU8(unzipSync(bytes)["word/document.xml"]!); const nextXml = strFromU8(unzipSync(updated.original!)["word/document.xml"]!);
 assert.ok(originalXml.includes("w:b")); assert.ok(nextXml.includes("w:b"));
 assert.throws(() => replaceOfficeText(bytes, "docx", "absent", "x"), /matched 0/);
});

test("spreadsheet edits keep other cells and refuse stale hashes", async () => {
 const u = await h.asUser(); const bytes = await rowsToXlsx([{ name: "Budget", rows: [["Item", "Cost"], ["Paper", 10], ["Ink", 20]] }]);
 const file = await saveFile(h.prisma, u.id, { filename: "budget.xlsx", mediaType: "application/octet-stream", bytes }, { summarize: false });
 await fileTextSettled(file.id);
 const info = (await run(u, "hub_file_edit_info", { fileId: file.id })).data as any;
 await run(u, "hub_edit_file", { fileId: file.id, expectedSha256: info.expectedSha256, action: "edit_cells", sheets: [{ name: "Budget", set: [{ row: 2, col: 2, value: 15 }] }] });
 const updated = await h.prisma.document.findUniqueOrThrow({ where: { id: file.id } });
 const rows = await xlsxToRows(updated.original!); assert.equal(rows[0]!.rows[1]![1], 15); assert.equal(rows[0]!.rows[2]![1], 20);
});

test("profile-list updates retain IDs, validate status and can be undone", async () => {
 const u = await h.asUser(); const part = (await run(u, "hub_add_desk_item", { kind: "part", title: "Controller", qty: 2, status: "ordered" })).data as any;
 await run(u, "hub_update_desk_item", { kind: "part", id: part.id, status: "in", qty: 3 });
 assert.equal((await h.prisma.partRow.findUniqueOrThrow({ where: { id: part.id } })).qty, 3);
 await undoLast(h.prisma, u.id); assert.equal((await h.prisma.partRow.findUniqueOrThrow({ where: { id: part.id } })).status, "ordered");
 await assert.rejects(run(u, "hub_update_desk_item", { kind: "part", id: part.id, status: "pass" }));
 const outsider = await h.asUser(); await assert.rejects(run(outsider, "hub_update_desk_item", { kind: "part", id: part.id, qty: 1 }), /not found/);
});

test("intent routing wins over the open surface and simple todo requests keep a small tool budget", () => {
 const playbooks = playbooksFor();
 assert.ok(routePlaybooks({ message: "Add a part to my bench", path: "/today" }, playbooks).some(book => book.name === "context"));
 assert.ok(routePlaybooks({ message: "Resize the calendar tile on my board", path: "/board" }, playbooks).some(book => book.name === "layouts"));
 assert.ok(simpleTodoRequest("Create a todo to review the brief by Friday"));
 const offered = [...TOOL_NAMES.map(name => getTool(name)!), ...APP_TOOL_LIST];
 const tools = advertisedTools(offered, [findPlaybook("tasks")!], "Create a todo to review the brief by Friday");
 assert.ok(tools.length <= 10, `${tools.length} tools`); assert.ok(tools.some(tool => tool.name === "hub_create_tasks")); assert.equal(tools.some(tool => tool.area === "apps"), false);
});

test("tile edits target the actual profile desk, Context panel and Board preference used by the UI", async () => {
 const u = await h.asUser();
 await h.prisma.user.update({ where: { id: u.id }, data: { activeTemplateId: "mkt.branch-desk" } });
 const today = (await run(u, "hub_read_layout", { surface: "today" })).data as any;
 assert.equal(today.kind, "desk"); assert.ok(today.available.some((row: any) => row.type === "calendar"));
 await run(u, "hub_edit_layout", { surface: "today", version: today.version, edits: [{ action: "add", type: "calendar", c: 6, r: 5 }] });
 const pref = await h.prisma.preference.findUniqueOrThrow({ where: { userId_key: { userId: u.id, key: "desk.layout.branch" } } });
 const value = pref.value as any; assert.deepEqual(value.tiles.find((row: any) => row.key === "calendar"), { key: "calendar", c: 6, r: 5 });
 assert.equal(await h.prisma.widgetLayout.count({ where: { userId: u.id, surface: "today" } }), 0);
 const panel = (await run(u, "hub_read_layout", { surface: "context", tab: "overview" })).data as any;
 assert.equal(panel.kind, "context"); const first = panel.document.placements[0];
 await run(u, "hub_edit_layout", { surface: "context", tab: "overview", version: panel.version, edits: [{ action: "update", type: first.type, c: 6, r: 4 }] });
 assert.ok(await h.prisma.preference.findUnique({ where: { userId_key: { userId: u.id, key: "desk.context.branch.overview" } } }));
 const board = (await run(u, "hub_read_layout", { surface: "board" })).data as any;
 assert.equal(board.kind, "board");
 await run(u, "hub_edit_layout", { surface: "board", version: board.version, edits: [{ action: "add", type: "attention" }] });
 const strip = await h.prisma.preference.findUniqueOrThrow({ where: { userId_key: { userId: u.id, key: "desk.board.insights" } } });
 assert.ok((strip.value as any).tiles.includes("attention"));
 const after = (await run(u, "hub_read_layout", { surface: "board" })).data as any;
 await assert.rejects(run(u, "hub_edit_layout", { surface: "board", version: after.version, edits: [{ action: "add", type: "deadlines" }] }), /four/);
 await assert.rejects(run(u, "hub_edit_layout", { surface: "board", version: after.version, edits: [{ action: "update", type: "attention", c: 6 }] }), /fixed size/);
});

test("the open Board surface honors live visible and selected IDs without leaking another space", async () => {
 const u = await h.asUser(); const other = await h.asUser();
 const a = await h.prisma.task.create({ data: { userId: u.id, title: "Visible task" } });
 const b = await h.prisma.task.create({ data: { userId: u.id, title: "Filtered out" } });
 const foreign = await h.prisma.task.create({ data: { userId: other.id, title: "Foreign task" } });
 const result = await run(u, "hub_read_surface", {}, { page: { path: "/board", surface: { kind: "board", filters: { search: "Visible", priority: "p0" }, visibleIds: [a.id, foreign.id], selectedIds: [a.id, foreign.id] } } });
 const encoded = JSON.stringify(result.data); assert.match(encoded, /Visible task/); assert.doesNotMatch(encoded, /Filtered out|Foreign task/); assert.ok(!encoded.includes(b.id)); assert.ok(!encoded.includes(foreign.id));
});

test("a CSV export already in Files can be previewed, imported as a whole board and checked from chat", async () => {
 const u = await h.asUser();
 const file = await saveFile(h.prisma, u.id, { filename: "launch.csv", mediaType: "text/csv", bytes: Buffer.from("Title,Status,Project\nReview launch,To do,Launch\nWrite notes,Done,Launch\n") }, { summarize: false });
 const preview = (await run(u, "hub_preview_board_import", { source: "csv", fileId: file.id })).data as any;
 assert.equal(preview.samples.length, 2);
 const started = await apply(u, "hub_start_board_import", { previewId: preview.previewId, containers: preview.containers.map((row: any) => row.id) });
 assert.equal(started.response.statusCode, 200, started.response.body);
 const { importsIdle } = await import("../imports/jobs.js"); await importsIdle();
 const jobs = (await run(u, "hub_read_import", {})).data as any; assert.equal(jobs.jobs[0].status, "done");
 assert.equal(await h.prisma.task.count({ where: { userId: u.id, title: { in: ["Review launch", "Write notes"] } } }), 2);
 const outsider = await h.asUser(); await assert.rejects(run(outsider, "hub_preview_board_import", { source: "csv", fileId: file.id }), /not found/i);
});

test("exporting a page creates a real Word or PDF file and respects a replacement's content hash", async () => {
 const u = await h.asUser(); const page = (await run(u, "hub_create_page", { title: "Status", markdown: "# Status\n\nLaunch is ready." })).data as any;
 const word = (await run(u, "hub_export_page_file", { pageId: page.id, format: "docx", filename: "status.docx" })).data as any;
 const original = await h.prisma.document.findUniqueOrThrow({ where: { id: word.id } }); assert.match(docxText(original.original!), /Launch is ready/);
 const pdf = (await run(u, "hub_export_page_file", { pageId: page.id, format: "pdf", filename: "status.pdf" })).data as any;
 const pdfRow = await h.prisma.document.findUniqueOrThrow({ where: { id: pdf.id } }); assert.ok(Buffer.from(pdfRow.original!).subarray(0, 4).toString() === "%PDF");
 await assert.rejects(run(u, "hub_export_page_file", { pageId: page.id, format: "docx", filename: "status.docx", replaceFileId: word.id, expectedSha256: "0".repeat(64) }), /changed/);
});

test("an explicitly created calendar event is visible in Ensemble and can anchor meeting notes", async () => {
 const u = await h.asUser(); const originalFetch = globalThis.fetch;
 const { setAppTokenResolverForTests } = await import("./tools/apps-common.js");
 setAppTokenResolverForTests(async () => ({ token: "test-token", account: "mira@fieldnote.example", scopes: ["https://www.googleapis.com/auth/calendar.events"] }));
 globalThis.fetch = (async () => new Response(JSON.stringify({ id: "external-review", htmlLink: "https://calendar.google.com/review", summary: "Design review" }), { headers: { "content-type": "application/json" } })) as typeof fetch;
 try {
  const tool = APP_TOOL_LIST.find(item => item.name === "calendar_create_event")!;
  const event = await tool.run(context(u), tool.input.parse({ title: "Design review", start: "2026-10-19T10:00", end: "2026-10-19T10:30", attendees: ["rowan@fieldnote.example"] }));
  const data = event.data as any; assert.ok(data.hubEventId); assert.notEqual(data.hubEventId, data.id);
  const stored = await h.prisma.artifact.findUniqueOrThrow({ where: { id: data.hubEventId } }); assert.equal(stored.ts.toISOString(), "2026-10-19T04:30:00.000Z");
  const note = await run(u, "hub_create_meeting_note", { eventId: data.hubEventId, notes: "Agenda and next steps." }); assert.ok((note.data as any).id);
 } finally { globalThis.fetch = originalFetch; setAppTokenResolverForTests(null); }
});

test("relationship previews resolve real targets and reject unavailable apps before Apply", async () => {
 const u = await h.asUser(); const outsider = await h.asUser();
 const project = await h.prisma.project.create({ data: { userId: u.id, name: "Launch" } });
 const foreign = await h.prisma.task.create({ data: { userId: outsider.id, title: "Private task" } });
 const tool = getTool("hub_manage_app_relationship")!;
 await assert.rejects(async () => tool.preview!(context(u), tool.input.parse({ action: "attach", source: "notion", kind: "page", id: "source-page", taskId: foreign.id })), /Task not found/);
 await assert.rejects(async () => tool.preview!(context(u), tool.input.parse({ action: "import_people", source: "notion" })), /not ready/);
 const preview = await tool.preview!(context(u), tool.input.parse({ action: "link_project", source: "jira", containerId: "LAUNCH", containerName: "Launch tracker", projectId: project.id }));
 assert.match(preview, /project “Launch”/); assert.match(preview, /jira “Launch tracker”/);
 await assert.rejects(async () => tool.preview!(context(u), tool.input.parse({ action: "link_project", source: "atlassian", containerId: "LAUNCH", projectId: project.id })), /Project source links use.*jira/);
 const sources = (await run(u, "hub_list_app_relationships", { view: "project_containers" })).data as any; assert.ok(sources.linkSources.includes("jira"));
});

test("record previews and receipts name records by title, never by id", async () => {
 const u = await h.asUser();
 const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
 const project = await h.prisma.project.create({ data: { userId: u.id, name: "Launch", createdBy: "me" } });
 const mira = await h.prisma.person.create({ data: { userId: u.id, name: "Mira Chen" } });
 const a = (await run(u, "hub_create_page", { title: "Brief" })).data as any;
 const b = (await run(u, "hub_create_page", { title: "Plans" })).data as any;
 const preview = async (name: string, input: unknown) => { const tool = getTool(name)!; return tool.preview!(context(u), tool.input.parse(input)); };
 const update = await preview("hub_update_project", { projectId: project.id, status: "done", personIds: [mira.id, randomUUID()] });
 assert.equal(update, "Update project “Launch”: mark done; people: “Mira Chen” and 1 other");
 assert.equal(await preview("hub_move_page", { pageId: a.id, parentId: b.id }), "Move “Brief” under “Plans”.");
 const record = await preview("hub_manage_record", { action: "add_comment", kind: "project", id: project.id, text: "Ship it" });
 assert.equal(record, "Comment on project “Launch”: Ship it.");
 for (const text of [update, record]) assert.doesNotMatch(text, uuid);
 const moved = await run(u, "hub_move_page", { pageId: a.id, parentId: b.id });
 assert.equal(moved.summary, "Moved “Brief” under “Plans”.");
 await assert.rejects(preview("hub_update_project", { projectId: randomUUID() }), /not in this space/);
});
