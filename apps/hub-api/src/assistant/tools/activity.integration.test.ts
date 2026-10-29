/**
 * The assistant's running-work, runs and Code tools against PGlite: what is running, stopping
 * one, recent runs and one run, Code folders and agent changes. A second space of the same
 * account holds the same kinds of rows; nothing of it may be read or stopped from the first.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { OPTIONAL_MODULES, serializeModules, Settings } from "@ensemble/shared-types";
import type { PrismaClient } from "@prisma/client";
import { createHttpHarness } from "../../test/http.js";
import type { AnyHubTool, ToolContext } from "../types.js";

const harness = await createHttpHarness();
after(() => harness.close());
const { getTool } = await import("../registry.js");
const { beginActivity, isCancelled } = await import("../../lib/activity.js");
const { createSpaceUser } = await import("../../spaces/store.js");
const { runInScope } = await import("../../sharing/context.js");
const { saveSettings } = await import("../../lib/settings.js");
const db = harness.prisma as PrismaClient;

const ALL = serializeModules(OPTIONAL_MODULES);

let selfChat = "";

function ctx(userId: string, extra: Partial<ToolContext> = {}): ToolContext {
  return { app: harness.app, prisma: db, userId, actor: "agent", settings: Settings.parse({}), modules: ALL, conversationId: selfChat, ...extra };
}

/** A chat in this space with a reply running, as runAssistantTurn records it. */
async function replying(spaceId: string, detail: string): Promise<string> {
  const chat = await db.assistantConversation.create({ data: { userId: spaceId, title: detail } });
  await beginActivity(harness.app.redis, spaceId, { id: `assistant:${chat.id}`, kind: "assistant", label: "Assistant is thinking", detail, conversationId: chat.id });
  return `assistant:${chat.id}`;
}

function tool(name: string): AnyHubTool {
  const found = getTool(name);
  assert.ok(found, name);
  return found;
}

async function call(name: string, context: ToolContext, input: unknown = {}) {
  const found = tool(name);
  return found.run(context, found.input.parse(input));
}

async function preview(name: string, context: ToolContext, input: unknown): Promise<string> {
  const found = tool(name);
  assert.ok(found.preview, `${name} has a preview`);
  return found.preview(context, found.input.parse(input));
}

/** One space's worth of work: a running and a queued agent task, a finished run with a review, an import, a reply in another chat. */
async function seed(spaceId: string, tag: string) {
  const task = await db.task.create({ data: { userId: spaceId, title: `${tag} write the parser`, boardOrder: 0, createdBy: "me" } });
  const queuedTask = await db.task.create({ data: { userId: spaceId, title: `${tag} queued follow-up`, boardOrder: 1, createdBy: "me" } });
  const run = await db.run.create({
    data: { taskId: task.id, userId: spaceId, worker: "workspace", requestedModel: "anthropic::claude-haiku", outcome: "success", endedAt: new Date(), result: `${tag} parser done` },
  });
  await db.runStep.createMany({
    data: [
      { runId: run.id, index: 0, title: "Read the code", status: "done" },
      { runId: run.id, index: 1, title: "Write the parser", status: "done" },
    ],
  });
  const finished = await db.workspaceJob.create({
    data: { userId: spaceId, taskId: task.id, runId: run.id, kind: "code", status: "succeeded", executionMode: "sandbox", model: "claude-haiku", provider: "claude-code", repoPath: `/tmp/${tag}-repo`, branch: `ensemble/${tag}`, finishedAt: new Date() },
  });
  const review = await db.codeReview.create({
    data: { userId: spaceId, jobId: finished.id, repoPath: `/tmp/${tag}-repo`, initialHead: "a", startTree: "b", endTree: "c", agentPaths: ["src/parse.ts", "src/parse.test.ts"], expiresAt: new Date(Date.now() + 86_400_000) },
  });
  const running = await db.workspaceJob.create({
    data: { userId: spaceId, taskId: task.id, kind: "code", status: "running", executionMode: "sandbox", model: "claude-haiku", startedAt: new Date(), progress: "Editing parse.ts" },
  });
  const queued = await db.workspaceJob.create({ data: { userId: spaceId, taskId: queuedTask.id, kind: "research", status: "queued", executionMode: "sandbox", model: "gemini" } });
  const importJob = await db.importJob.create({ data: { userId: spaceId, source: "notion", status: "running", startedAt: new Date() } });
  const reply = await replying(spaceId, `${tag} summarise the week`);
  return { task, run, review, running, queued, importJob, reply };
}

const mira = await harness.asUser();
const sideId = await createSpaceUser(db, mira.id, { name: "Side", icon: null });
await db.user.update({ where: { id: sideId }, data: { moduleSet: ALL } });
const home = await seed(mira.id, "home");
const side = await seed(sideId, "side");
const selfReply = await replying(mira.id, "this chat");
selfChat = selfReply.slice("assistant:".length);

test("hub_list_activity shows this space's running work only, and marks this chat's own reply", async () => {
  const result = await call("hub_list_activity", ctx(mira.id));
  const rows = (result.data as { activity: Array<{ id: string; kind: string; label: string; canStop: boolean; task?: { id: string } }> }).activity;
  const ids = rows.map((row) => row.id);
  for (const id of [`job:${home.running.id}`, `job:${home.queued.id}`, `import:${home.importJob.id}`, home.reply, selfReply]) assert.ok(ids.includes(id), id);
  for (const id of [`job:${side.running.id}`, `job:${side.queued.id}`, `import:${side.importJob.id}`, side.reply]) assert.ok(!ids.includes(id), `${id} is another space's`);
  assert.equal(rows.find((row) => row.id === selfReply)?.canStop, false);
  assert.equal(rows.find((row) => row.id === `job:${home.running.id}`)?.task?.id, home.task.id);
  assert.doesNotMatch(JSON.stringify(rows), /side /);

  const fromSide = await call("hub_list_activity", ctx(sideId));
  const sideIds = (fromSide.data as { activity: Array<{ id: string }> }).activity.map((row) => row.id);
  assert.ok(sideIds.includes(`job:${side.running.id}`));
  assert.ok(!sideIds.includes(`job:${home.running.id}`));
});

test("hub_stop_activity refuses another space's work, unknown ids and this chat's own reply", async () => {
  const stop = tool("hub_stop_activity");
  assert.equal(stop.isWrite, true);
  assert.equal(stop.area, "runs");
  for (const id of [`job:${side.running.id}`, `import:${side.importJob.id}`, side.reply, "job:00000000-0000-0000-0000-000000000000"]) {
    await assert.rejects(() => preview("hub_stop_activity", ctx(mira.id), { id }), /no longer running in this space/, id);
    await assert.rejects(() => call("hub_stop_activity", ctx(mira.id), { id }), /no longer running in this space/, id);
  }
  await assert.rejects(() => call("hub_stop_activity", ctx(mira.id), { id: selfReply }), /this chat's own reply/);
  assert.equal((await db.workspaceJob.findUniqueOrThrow({ where: { id: side.running.id } })).status, "running");
  assert.equal((await db.importJob.findUniqueOrThrow({ where: { id: side.importJob.id } })).status, "running");
  assert.equal(await isCancelled(harness.app.redis, sideId, side.reply), false);
});

test("hub_stop_activity names what stops, then stops an agent task, an import and another chat's reply", async () => {
  assert.match(await preview("hub_stop_activity", ctx(mira.id), { id: `job:${home.running.id}` }), /Stop the agent task “home write the parser”/);
  assert.match(await preview("hub_stop_activity", ctx(mira.id), { id: `job:${home.queued.id}` }), /Remove the agent task “home queued follow-up” from the queue/);
  assert.match(await preview("hub_stop_activity", ctx(mira.id), { id: `import:${home.importJob.id}` }), /Cancel the import from Notion/);

  const stopped = await call("hub_stop_activity", ctx(mira.id), { id: `job:${home.running.id}` });
  assert.match(stopped.summary, /Stopping “home write the parser”/);
  assert.equal((await db.workspaceJob.findUniqueOrThrow({ where: { id: home.running.id } })).status, "cancelled");
  await call("hub_stop_activity", ctx(mira.id), { id: `job:${home.queued.id}` });
  assert.equal((await db.workspaceJob.findUniqueOrThrow({ where: { id: home.queued.id } })).status, "cancelled");
  await call("hub_stop_activity", ctx(mira.id), { id: `import:${home.importJob.id}` });
  assert.equal((await db.importJob.findUniqueOrThrow({ where: { id: home.importJob.id } })).status, "cancelled");
  await call("hub_stop_activity", ctx(mira.id), { id: home.reply });
  assert.equal(await isCancelled(harness.app.redis, mira.id, home.reply), true);
  const ledger = await db.auditLedger.findMany({ where: { userId: mira.id, action: "activity.stop" } });
  assert.ok(ledger.length >= 4 && ledger.every((row) => row.actor === "agent"));

  // The other space's work is untouched.
  assert.equal((await db.workspaceJob.findUniqueOrThrow({ where: { id: side.running.id } })).status, "running");
  assert.equal((await db.workspaceJob.findUniqueOrThrow({ where: { id: side.queued.id } })).status, "queued");
  assert.equal((await db.importJob.findUniqueOrThrow({ where: { id: side.importJob.id } })).status, "running");
});

test("hub_list_runs and hub_get_run read this space's runs, compactly, and never another space's", async () => {
  const listed = await call("hub_list_runs", ctx(mira.id), { limit: 10 });
  const runs = (listed.data as { runs: Array<{ id: string; status: string; engine: string; link: string; task: { title: string } }> }).runs;
  const mine = runs.find((row) => row.id === home.run.id);
  assert.ok(mine);
  assert.equal(mine.status, "success");
  assert.equal(mine.engine, "Claude Code");
  assert.equal(mine.link, `/runs?run=${home.run.id}`);
  assert.ok(!runs.some((row) => row.id === side.run.id));
  assert.ok(!runs.some((row) => row.task.title.startsWith("side")));

  const read = await call("hub_get_run", ctx(mira.id), { runId: home.run.id });
  const data = read.data as { status: string; steps: Array<{ n: number; title: string }>; result: string; filesChanged: { count: number; files: string[] }; review: { link: string }; branch: string };
  assert.equal(data.status, "success");
  assert.deepEqual(data.steps.map((step) => step.n), [1, 2]);
  assert.equal(data.result, "home parser done");
  assert.deepEqual(data.filesChanged, { count: 2, files: ["src/parse.ts", "src/parse.test.ts"] });
  assert.equal(data.review.link, `/code/review?review=${home.review.id}`);
  assert.equal(data.branch, "ensemble/home");
  assert.ok(JSON.stringify(read.data).length < 2000, "compact");

  await assert.rejects(() => call("hub_get_run", ctx(mira.id), { runId: side.run.id }), /No run with that id in this space/);
});

test("Code tools list this space's folders and agent changes only, and follow the Code module", async () => {
  await saveSettings(db, sideId, { code: { roots: ["/tmp/side-only-folder"] } });
  const folders = await call("hub_list_code_folders", ctx(mira.id));
  const listed = JSON.stringify(folders.data);
  assert.match(listed, /\/tmp\/home-repo/);
  assert.doesNotMatch(listed, /side-only-folder|side-repo/);
  assert.match(tool("hub_list_code_folders").description, /MCP/);

  const changes = await call("hub_list_agent_changes", ctx(mira.id));
  const rows = (changes.data as { changes: Array<{ id: string; files: number; link: string; status: string }> }).changes;
  assert.deepEqual(rows.map((row) => row.id), [home.review.id]);
  assert.equal(rows[0]!.files, 2);
  assert.equal(rows[0]!.status, "waiting");
  assert.equal(rows[0]!.link, `/code/review?review=${home.review.id}`);
  const reviewed = await call("hub_list_agent_changes", ctx(mira.id), { status: "reviewed" });
  assert.equal((reviewed.data as { total: number }).total, 0);

  const noCode = ctx(mira.id, { modules: serializeModules(OPTIONAL_MODULES.filter((id) => id !== "code")) });
  await assert.rejects(() => call("hub_list_code_folders", noCode), /Code feature is off/);
  await assert.rejects(() => call("hub_list_agent_changes", noCode), /Code feature is off/);
});

test("every new read tool takes no id of another space as an answer", async () => {
  for (const name of ["hub_list_activity", "hub_list_runs", "hub_list_agent_changes", "hub_list_code_folders"]) {
    const result = await call(name, ctx(mira.id));
    const text = JSON.stringify(result);
    for (const id of [side.run.id, side.review.id, side.running.id, side.queued.id, side.importJob.id, side.task.id]) assert.ok(!text.includes(id), `${name} leaked ${id}`);
  }
});

test("someone a space is shared with sees only this space's replies and runs, never their own other spaces' or the owner's imports", async () => {
  const guest = await harness.asUser();
  const theirs = await replying(guest.id, "guest's own space question");
  const ownersRun = await db.workspaceJob.create({ data: { userId: mira.id, taskId: home.task.id, kind: "code", status: "running", executionMode: "sandbox", model: "m", startedAt: new Date() } });
  const ownersImport = await db.importJob.create({ data: { userId: mira.id, source: "trello", status: "running", startedAt: new Date() } });
  const forOwner = ((await call("hub_list_activity", ctx(mira.id))).data as { activity: Array<{ id: string }> }).activity.map((row) => row.id);
  assert.ok(forOwner.includes(`import:${ownersImport.id}`));
  assert.ok(!forOwner.includes(theirs), "the guest's reply is not the owner's");
  const scope = { spaceId: mira.id, accountId: guest.id, access: { kind: "member" as const, role: "editor" as const, ownerId: mira.id } };
  await runInScope(scope, async () => {
    const inShared = await replying(mira.id, "guest asks in the shared space");
    const rows = ((await call("hub_list_activity", ctx(mira.id, { conversationId: undefined }))).data as { activity: Array<{ id: string; kind: string; canStop: boolean; note?: string }> }).activity;
    const ids = rows.map((row) => row.id);
    assert.ok(ids.includes(inShared));
    assert.ok(!ids.includes(theirs), "a reply in the guest's own space is another space's");
    assert.ok(!rows.some((row) => row.kind === "import"), "imports are the owner's");
    assert.equal(rows.find((row) => row.id === `job:${ownersRun.id}`)?.canStop, false, "a run on the owner's computer is theirs to stop");
    await assert.rejects(() => call("hub_stop_activity", ctx(mira.id), { id: `job:${ownersRun.id}` }), /someone else's computer/);
    await assert.rejects(() => call("hub_stop_activity", ctx(mira.id), { id: `import:${ownersImport.id}` }), /no longer running in this space/);
  });
  assert.equal((await db.importJob.findUniqueOrThrow({ where: { id: ownersImport.id } })).status, "running");
  assert.equal((await db.workspaceJob.findUniqueOrThrow({ where: { id: ownersRun.id } })).status, "running");
});
