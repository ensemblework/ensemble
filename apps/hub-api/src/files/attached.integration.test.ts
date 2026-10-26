/**
 * Files attached to work, as agents see them: which files a task or page has (mentions on the
 * page and the project page, files tagged with the task, never another person's), their text in
 * parts, the prompt section, how a page reads with a file on it, and Ensemble's own agent tools
 * read_attachment and save_attachment. Runs on the in-memory database.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { WorkspaceJob } from "@prisma/client";
import type { PageDocument, PageNode } from "@ensemble/shared-types";
import { createHttpHarness, type HttpHarness } from "../test/http.js";

const workspace = await realpath(await mkdtemp(join(tmpdir(), "ensemble-workspace-")));
process.env.ENSEMBLE_WORKSPACE_ROOT = workspace;
const harness: HttpHarness = await createHttpHarness();
const db = harness.prisma;
const { saveFile } = await import("./store.js");
const { fileTextSettled } = await import("./extract.js");
const { filesOnPage, filesOnTask, fileText, filesSection, mentionedFileIds } = await import("./attached.js");
const { markdownToNodes, pageMarkdown, pageSearchText, pageText } = await import("../pages/markdown.js");
const { pageAgentText } = await import("../pages/agent-context.js");
const { runTool } = await import("../workspace/tools.js");
type JobContext = import("../workspace/tools.js").JobContext;

const folders: string[] = [];
/** Work folders are real paths (workspaceRoot resolves links), so the jail sees no link to follow. */
async function workFolder(): Promise<string> {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "ensemble-files-")));
  folders.push(folder);
  return folder;
}
after(async () => {
  for (const folder of [...folders, workspace]) await rm(folder, { recursive: true, force: true });
  await harness.close();
});

const mention = (id: string, label: string): PageNode => ({ type: "mention", attrs: { kind: "file", id, label } });
const doc = (...content: PageNode[]): PageDocument => ({ type: "doc", content });
const para = (...content: PageNode[]): PageNode => ({ type: "paragraph", content });
const text = (value: string): PageNode => ({ type: "text", text: value });

async function file(userId: string, filename: string, body: string | Uint8Array) {
  const saved = await saveFile(db, userId, { filename, mediaType: "application/octet-stream", bytes: typeof body === "string" ? new TextEncoder().encode(body) : body }, { summarize: false });
  await fileTextSettled(saved.id);
  return saved;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const LONG = Array.from({ length: 400 }, (_, index) => `Reading ${index + 1}: north field pH 7.${index % 10}`).join("\n");

async function setup() {
  const mira = await harness.asUser(`mira.${Date.now()}.${Math.random().toString(36).slice(2)}@fieldnote.example`);
  const arjun = await harness.asUser(`arjun.${Date.now()}.${Math.random().toString(36).slice(2)}@fieldnote.example`);
  const brief = await file(mira.id, "Field brief.md", "# Field brief\n\nCalibrate the sensor before each visit.");
  const readings = await file(mira.id, "readings.txt", LONG);
  const photo = await file(mira.id, "site.png", PNG);
  const tagged = await file(mira.id, "Contract notes.txt", "Payment on delivery.");
  const gone = await file(mira.id, "Old plan.txt", "Superseded.");
  await db.document.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
  const foreign = await file(arjun.id, "Arjun private.txt", "Not for Mira.");
  const project = await db.project.create({ data: { userId: mira.id, name: "Soil survey", content: doc(para(text("Photos: "), mention(photo.id, "site.png"))) as never } });
  const task = await db.task.create({ data: { userId: mira.id, title: "Write the visit report", projectId: project.id } });
  await db.taskPage.create({
    data: {
      userId: mira.id,
      taskId: task.id,
      content: doc(para(text("Use "), mention(brief.id, "Field brief.md"), text(" and "), mention(readings.id, "readings.txt")), para(mention(foreign.id, "Arjun private.txt"), mention(gone.id, "Old plan.txt"))) as never,
    },
  });
  await db.document.update({ where: { id: tagged.id }, data: { taskIds: [task.id] } });
  return { mira, arjun, brief, readings, photo, tagged, gone, foreign, project, task };
}

test("a page names a file's id for agents and only its name for search", () => {
  const page = doc(para(text("See "), mention("6f1c2d3e-0000-4000-8000-000000000001", "Q3 report.pdf"), text(" first.")));
  assert.equal(pageText(page, ""), "See [file: Q3 report.pdf (id 6f1c2d3e-0000-4000-8000-000000000001)] first.");
  assert.equal(pageSearchText("Plan", page, ""), "Plan\nSee @Q3 report.pdf first.");
  const person = doc(para({ type: "mention", attrs: { kind: "people", id: "p1", label: "Arjun Rao" } }));
  assert.equal(pageText(person, ""), "@Arjun Rao");
  assert.deepEqual(mentionedFileIds(doc(para(mention("a", "A")), { type: "fileBlock", attrs: { fileId: "b" } }, para(mention("a", "A")))), ["a", "b"]);
  assert.deepEqual(mentionedFileIds("not a page"), []);
});

test("a task's files: its page, its project's page and files tagged with it, never another person's or a removed one", async () => {
  const { mira, arjun, brief, readings, photo, tagged, task } = await setup();
  const files = await filesOnTask(db, mira.id, task.id);
  assert.deepEqual(files.map((row) => row.filename), ["Field brief.md", "readings.txt", "site.png", "Contract notes.txt"]);
  assert.deepEqual(files.map((row) => row.id), [brief.id, readings.id, photo.id, tagged.id]);
  const image = files.find((row) => row.id === photo.id)!;
  assert.equal(image.kind, "image");
  assert.equal(image.textStatus, "none");
  assert.deepEqual(await filesOnTask(db, arjun.id, task.id), [], "another person sees none of them");

  const page = await db.taskPage.create({ data: { userId: mira.id, title: "Notes", content: doc(para(mention(readings.id, "readings.txt"))) as never } });
  assert.deepEqual((await filesOnPage(db, mira.id, page.id)).map((row) => row.id), [readings.id]);
  const taskPage = await db.taskPage.findFirstOrThrow({ where: { taskId: task.id } });
  assert.equal((await filesOnPage(db, mira.id, taskPage.id)).length, 4, "a task's page counts as its task");
});

test("an image in a task's page is one of its files, and agents read and rewrite it without losing it", async () => {
  const { mira } = await setup();
  const photo = await file(mira.id, "north field.png", PNG);
  const task = await db.task.create({ data: { userId: mira.id, title: "Describe the site" } });
  const image: PageNode = { type: "image", attrs: { src: null, alt: "North field [after rain]", fileId: photo.id, width: 60, align: "left", naturalWidth: 1200, naturalHeight: 800 } };
  const web: PageNode = { type: "image", attrs: { src: "https://example.com/map.png", alt: "Map", width: 40 } };
  const page = doc(para(text("Before")), image, web);
  await db.taskPage.create({ data: { userId: mira.id, taskId: task.id, content: page as never } });

  assert.deepEqual((await filesOnTask(db, mira.id, task.id)).map((row) => row.id), [photo.id]);
  const agentText = await pageAgentText(db, mira.id, page, "");
  assert.ok(agentText.includes(`![North field \\[after rain\\]](ensemble://file/${photo.id}){width=60% align=left natural=1200x800}`), agentText);
  assert.match(agentText, /!\[Map\]\(https:\/\/example\.com\/map\.png\)\{width=40%\}/);
  assert.match(pageText(page, ""), new RegExp(`\\[image: North field \\[after rain\\] \\(file id ${photo.id}\\)\\]`));
  // A rewrite through Markdown keeps both images, their files, sizes and alignment.
  assert.deepEqual(markdownToNodes(pageMarkdown(page, "")), page.content);
});

test("file text comes in parts, and files without text say what they are", async () => {
  const { mira, arjun, readings, photo } = await setup();
  const first = (await fileText(db, mira.id, readings.id, 0, 1000))!;
  assert.equal(first.total, LONG.length);
  assert.ok(first.text.startsWith("Reading 1:"));
  assert.ok(first.nextOffset && first.nextOffset <= 1000);
  const next = (await fileText(db, mira.id, readings.id, first.nextOffset, 1000))!;
  assert.equal(next.offset, first.nextOffset);
  assert.ok(LONG.slice(next.offset).startsWith(next.text));
  const image = (await fileText(db, mira.id, photo.id))!;
  assert.equal(image.text, "");
  assert.match(image.note ?? "", /site\.png is an image with no text to read \(PNG image · 12 B\)/);
  assert.equal(await fileText(db, arjun.id, readings.id), null);
});

test("the prompt section lists each file by name, kind, size and id, and never Ensemble's text of it", async () => {
  const { mira, task } = await setup();
  const files = await filesOnTask(db, mira.id, task.id);
  const section = await filesSection(db, mira.id, files, { perFile: 300, total: 400, more: (row) => `More: read_attachment ${row.id}` });
  assert.match(section, /### Field brief\.md \(Markdown · \d+ B, id [0-9a-f-]{36}\)\nMore: read_attachment [0-9a-f-]{36}/);
  assert.match(section, /### readings\.txt \(Text · [\d.]+ KB, id [0-9a-f-]{36}\)/);
  assert.match(section, /### site\.png /);
  assert.doesNotMatch(section, /Calibrate the sensor|Reading 1:/, "extracted text stays out of prompts (files/extracted-text-policy.ts)");
});

function jobContext(userId: string, taskId: string, root: string, kind = "code", jobId = "job-files-test"): JobContext {
  return {
    prisma: db,
    job: { id: jobId, kind, unattended: false, delivery: "local", askBeforePublish: false, accessMode: "auto" } as WorkspaceJob,
    userId,
    taskId,
    taskTitle: "Write the visit report",
    runId: "run-files-test",
    root,
    sandboxed: true,
    outsideAccess: "none",
    network: false,
    signal: new AbortController().signal,
    commitAuthor: "",
    touched: new Set(),
    wrotePage: false,
    finished: null,
    progress: async () => {},
    event: async () => {},
    waitForPerson: (work) => work(),
    trusted: true,
    explicitTrust: true,
    silentWorkspace: true,
    accessMode: "auto",
    runBranch: "",
    blockedOutside: [],
    strength: "strong",
  };
}

test("view_attachment gives the attached file itself, by name or id; read_attachment (extracted text) is off", async () => {
  const { mira, readings, photo, task } = await setup();
  const ctx = { ...jobContext(mira.id, task.id, await workFolder()), viewFiles: true };
  const byName = await runTool(ctx, "view_attachment", { file: "READINGS.txt" });
  assert.equal(byName.ok, true, JSON.stringify(byName.result));
  assert.equal((byName.result as { file: { id: string } }).file.id, readings.id);
  const [label, part] = byName.pictures ?? [];
  assert.deepEqual(label, { type: "text", text: "File: readings.txt" });
  assert.equal(part?.type, "file");
  assert.match((part as { file: { file_data: string } }).file.file_data, /^data:text\/plain;base64,/);
  const picture = await runTool(ctx, "view_attachment", { file: photo.id });
  assert.equal(picture.ok, true, JSON.stringify(picture.result));
  const missing = await runTool(ctx, "view_attachment", { file: "budget.xlsx" });
  assert.equal(missing.ok, false);
  assert.deepEqual((missing.result as { attached: Array<{ name: string }> }).attached.map((row) => row.name), ["Field brief.md", "readings.txt", "site.png", "Contract notes.txt"]);
  const text = await runTool(ctx, "read_attachment", { file: "READINGS.txt" });
  assert.equal(text.ok, false, "read_attachment is not offered (files/extracted-text-policy.ts)");
});

test("save_attachment copies the original into the folder, never over a file unless asked, never outside", async () => {
  const { mira, arjun, photo, task, foreign } = await setup();
  const ctx = jobContext(mira.id, task.id, await workFolder());
  const saved = await runTool(ctx, "save_attachment", { file: "site.png" });
  assert.equal(saved.ok, true, JSON.stringify(saved.result));
  assert.equal((saved.result as { saved: string }).saved, "attachments/site.png");
  assert.deepEqual(new Uint8Array(await readFile(join(ctx.root, "attachments", "site.png"))), PNG);
  assert.ok(ctx.touched.has("attachments/site.png"));

  const again = await runTool(ctx, "save_attachment", { file: photo.id });
  assert.equal(again.ok, false);
  assert.match((again.result as { error: string }).error, /already exists/);
  await writeFile(join(ctx.root, "attachments", "site.png"), "changed");
  const replaced = await runTool(ctx, "save_attachment", { file: photo.id, overwrite: true });
  assert.equal(replaced.ok, true);
  assert.deepEqual(new Uint8Array(await readFile(join(ctx.root, "attachments", "site.png"))), PNG);

  const named = await runTool(ctx, "save_attachment", { file: "Field brief.md", path: "docs/" });
  assert.equal((named.result as { saved: string }).saved, "docs/Field brief.md");

  const outside = await runTool(ctx, "save_attachment", { file: "site.png", path: "../escaped.png" });
  assert.equal(outside.ok, false);
  assert.equal((outside.result as { refused?: boolean }).refused, true);
  const git = await runTool(ctx, "save_attachment", { file: "site.png", path: ".git/hooks/pre-commit" });
  assert.equal(git.ok, false);

  const theirs = await runTool(ctx, "save_attachment", { file: foreign.id });
  assert.equal(theirs.ok, false, "another person's file is not attached and not found");
  const research = await runTool(jobContext(arjun.id, task.id, ctx.root, "research"), "save_attachment", { file: "site.png" });
  assert.match((research.result as { error: string }).error, /No file .* is attached to this task/);
});

test("the Hub assistant and editors over MCP find a task's files; the assistant opens the file itself, and neither is given its extracted text", async () => {
  const { mira, arjun, readings, task } = await setup();
  const { fileTools } = await import("../assistant/tools/files.js");
  const list = fileTools.find((tool) => tool.name === "hub_list_files")!;
  const view = fileTools.find((tool) => tool.name === "hub_view_file")!;
  assert.equal(fileTools.find((tool) => tool.name === "hub_read_file"), undefined, "hub_read_file is off (files/extracted-text-policy.ts)");
  const as = (userId: string) => ({ prisma: db, userId }) as unknown as Parameters<typeof list.run>[0];

  const onTask = await list.run(as(mira.id), list.input.parse({ taskId: task.id }));
  assert.deepEqual((onTask.data as { files: Array<{ name: string }> }).files.map((row) => row.name), ["Field brief.md", "readings.txt", "site.png", "Contract notes.txt"]);
  const byText = await list.run(as(mira.id), list.input.parse({ query: "north field" }));
  assert.deepEqual((byText.data as { files: Array<{ id: string }> }).files.map((row) => row.id), [readings.id]);
  const opened = await view.run(as(mira.id), view.input.parse({ id: readings.id }));
  assert.equal(opened.pictures?.[1]?.type, "file");
  assert.deepEqual((await view.run(as(arjun.id), view.input.parse({ id: readings.id }))).data, { found: false });

  const bridge = await import("../bridge/service.js");
  const found = await bridge.searchHub(db, mira.id, "north field", 5);
  const hit = found.results.find((row) => row.kind === "document");
  assert.equal(hit?.id, readings.id);
  assert.equal(hit?.label, "readings.txt");
  assert.ok(!found.results.some((row) => row.kind === "artifact"), "the file is cited once, as a document");
  assert.doesNotMatch(JSON.stringify(found.results), /Reading 1:/, "search excerpts carry no file text");
  assert.equal((await bridge.searchHub(db, arjun.id, "north field", 5)).results.length, 0);
  const document = await bridge.readItem(db, mira.id, "document", readings.id, 0, 500);
  assert.ok(document.found);
  const item = document.item as { filename: string; format: string; originalBytesOmitted: boolean; note: string };
  assert.equal(item.filename, "readings.txt");
  assert.equal(item.format, "txt");
  assert.equal(item.originalBytesOmitted, true);
  assert.doesNotMatch(JSON.stringify(item), /Reading 1:/);
  assert.match(item.note, /does not send a file's extracted text/);
  const taskRead = await bridge.readItem(db, mira.id, "task", task.id, 0, 4000);
  assert.ok(taskRead.found);
  assert.deepEqual((taskRead.item as { files: Array<{ id: string; kind: string }> }).files.map((row) => row.kind), ["document", "document", "document", "document"]);
});

test("an engine gets copies of the originals where this run may read them, removed afterwards", async () => {
  const { mira, task, brief, photo } = await setup();
  const { copyForEngine, removeCopies } = await import("../workspace/agent.js");
  const { judgeEngineCall } = await import("../workspace/engines/judge.js");
  const { mkdir, readdir, stat } = await import("node:fs/promises");
  const files = await filesOnTask(db, mira.id, task.id);

  // Sandboxed with "Outside the work folder: read only" (the default): a job folder outside the work folder.
  const readRoot = join(workspace, "runs", "job-read");
  await mkdir(readRoot, { recursive: true });
  const reading = { ...jobContext(mira.id, task.id, readRoot, "code", "job-read"), outsideAccess: "read" as const };
  const outside = (await copyForEngine(reading, files))!;
  assert.equal(outside.dir, join(workspace, "files", "job-read"));
  assert.equal(outside.inFolder, false);
  const briefCopy = outside.paths.get(brief.id)!;
  assert.equal(await readFile(briefCopy, "utf8"), "# Field brief\n\nCalibrate the sensor before each visit.");
  assert.deepEqual(new Uint8Array(await readFile(outside.paths.get(photo.id)!)), PNG);
  assert.equal((await judgeEngineCall(reading, { tool: "Read", input: { file_path: briefCopy } })).decision, "allow");
  assert.equal((await judgeEngineCall(reading, { tool: "Write", input: { file_path: briefCopy } })).decision, "deny", "the copies are read-only to the engine");
  await removeCopies(reading, outside);
  await assert.rejects(stat(outside.dir));

  // No access outside the folder: the copies go inside it, hidden from git, and the folder is left as it was.
  const closedRoot = join(workspace, "runs", "job-closed");
  await mkdir(closedRoot, { recursive: true });
  const closed = { ...jobContext(mira.id, task.id, closedRoot, "code", "job-closed"), outsideAccess: "none" as const };
  const inside = (await copyForEngine(closed, files))!;
  assert.equal(inside.dir, join(closedRoot, ".ensemble", "attachments", "job-closed"));
  assert.equal(inside.inFolder, true);
  assert.equal(await readFile(join(inside.dir, ".gitignore"), "utf8"), "*\n");
  assert.equal((await judgeEngineCall(closed, { tool: "Read", input: { file_path: inside.paths.get(brief.id)! } })).decision, "allow");
  await removeCopies(closed, inside);
  assert.deepEqual(await readdir(closedRoot), []);
  assert.equal(await copyForEngine(closed, []), null, "no files, no folder");
});
