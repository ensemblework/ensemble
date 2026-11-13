import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";
import { makeTestDirectory } from "../test/temporary.js";
import { checkoutSlug, reserveCheckoutFolder, titleCheckoutSlug } from "./checkout-folder.js";
import type { JobContext } from "./tools.js";

const scratch = makeTestDirectory("ensemble-checkout-names-");
const workspace = join(scratch, "workspace");
process.env.ENSEMBLE_WORKSPACE_ROOT = workspace;
process.env.ENSEMBLE_INPROCESS_RUNTIME = "0";
let reply = "dijkstra-weighted-graph";
let status = 200;
const requests: Array<{ model: string; provider: string; messages: Array<{ content: string }>; folderExisted: boolean }> = [];
const runtime = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push({ ...JSON.parse(Buffer.concat(chunks).toString()), folderExisted: existsSync(join(workspace, "runs", reply)) });
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(status === 200
    ? { text: reply, toolCalls: [], model: "run-selected-model", credits: null, tokensIn: 12, tokensOut: 4 }
    : { detail: "The naming model is unavailable." }));
});
await new Promise<void>((resolve) => runtime.listen(0, "127.0.0.1", resolve));
const address = runtime.address();
assert.ok(address && typeof address === "object");
process.env.AGENT_RUNTIME_URL = `http://127.0.0.1:${address.port}`;
const h = await createHttpHarness();
const { prepareFolder } = await import("./agent.js");
const { loadSettings } = await import("../lib/settings.js");
const { grantFolder } = await import("./tools.js");
const user = await h.asUser();
const settings = await loadSettings(h.prisma, user.id);
after(async () => {
  await new Promise<void>((resolve, reject) => runtime.close((error) => error ? reject(error) : resolve()));
  await h.close();
  await rm(scratch, { recursive: true, force: true });
});

async function context(title: string, options: { continueFromJobId?: string; externalRoot?: string } = {}): Promise<JobContext> {
  const task = await h.prisma.task.create({ data: { userId: user.id, title, createdBy: "me" } });
  const job = await h.prisma.workspaceJob.create({
    data: { userId: user.id, taskId: task.id, kind: "code", status: "running", provider: "openai", model: "run-selected-model", reasoningEffort: "low", instructions: "Implement and test the shortest-path algorithm.", executionMode: "native", ...options },
  });
  return {
    prisma: h.prisma, job, userId: user.id, taskId: task.id, taskTitle: title, runId: job.id,
    root: "", sandboxed: false, network: false, trusted: true, explicitTrust: false,
    silentWorkspace: true, accessMode: "read-write", strength: "advisory", outsideAccess: "none",
    blockedOutside: [], runBranch: "", touched: new Set(), wrotePage: false, finished: null,
    signal: new AbortController().signal,
    progress: async () => undefined,
    event: async (kind, data) => { await h.prisma.workspaceEvent.create({ data: { jobId: job.id, kind, data: JSON.parse(JSON.stringify(data)) } }); },
    waitForPerson: (work) => work(),
  };
}

test("checkout slugs accept safe names and reject paths, reserved names, malformed lengths and names without letters", () => {
  for (const slug of ["graph-shortest-path", "3d-graph", "a".repeat(40)]) assert.equal(checkoutSlug(slug), slug);
  for (const slug of ["../graph", "graph/path", "graph\\path", "graph path", "graph.dot", "Graph", "ab", "a".repeat(41), "123", "-graph", "graph-", "runs", "files", "projects", "worktrees", ".ensemble", "con", "com1", "lpt9"]) {
    assert.equal(checkoutSlug(slug), null, slug);
  }
  assert.equal(titleCheckoutSlug("Dijkstra on a weighted graph"), "dijkstra-on-a-weighted-graph");
  assert.equal(titleCheckoutSlug("Cr\u00e8me: shortest / path"), "creme-shortest-path");
  assert.equal(titleCheckoutSlug("Graph ".repeat(20)).length <= 40, true);
  assert.equal(titleCheckoutSlug("AI"), "task-ai");
  assert.equal(titleCheckoutSlug("123"), "task-123");
  assert.equal(titleCheckoutSlug("runs"), "task-runs");
  for (const title of ["", "\u56fe"]) {
    const name = titleCheckoutSlug(title);
    assert.match(name, /^task-[a-f0-9]{8}$/);
    assert.equal(checkoutSlug(name), name);
  }
});

test("checkout allocation suffixes workspace, run, project, worktree and unfinished-job names, including concurrent reservations", async () => {
  const base = join(scratch, "collisions");
  for (const [dir, name] of [["", "graph-task"], ["projects", "graph-task-2"], ["worktrees", "graph-task-3"], ["runs", "graph-task-4"]] as const) {
    await mkdir(join(base, dir, name), { recursive: true });
  }
  assert.equal(await reserveCheckoutFolder(base, "graph-task", ["graph-task-5"]), join(base, "runs", "graph-task-6"));
  const roots = await Promise.all([reserveCheckoutFolder(base, "parallel-task"), reserveCheckoutFolder(base, "parallel-task")]);
  assert.deepEqual(roots.map((root) => basename(root)).sort(), ["parallel-task", "parallel-task-2"]);
  const long = "a".repeat(40);
  await mkdir(join(base, "runs", long));
  const suffixed = basename(await reserveCheckoutFolder(base, long));
  assert.equal(suffixed, `${"a".repeat(38)}-2`);
  assert.equal(checkoutSlug(suffixed), suffixed);
  const lastLetter = `${"1".repeat(39)}a`;
  await mkdir(join(base, "runs", lastLetter));
  const numericPrefix = basename(await reserveCheckoutFolder(base, lastLetter));
  assert.equal(checkoutSlug(numericPrefix), numericPrefix, "suffix truncation must keep at least one letter");
});

test("checkout allocation never follows a replaced runs directory or overwrites an existing entry", async () => {
  const base = join(scratch, "links");
  const outside = join(scratch, "outside");
  await mkdir(base);
  await mkdir(outside);
  await symlink(outside, join(base, "runs"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(reserveCheckoutFolder(base, "graph-task"), /runs folder is not a folder/);
  assert.deepEqual(await readdir(outside), []);
  const plain = join(scratch, "plain");
  await mkdir(join(plain, "runs"), { recursive: true });
  await writeFile(join(plain, "runs", "graph-task"), "keep me");
  assert.equal(basename(await reserveCheckoutFolder(plain, "graph-task")), "graph-task-2");
});

test("prepareFolder asks the run's selected model before creating a readable checkout, saves repoPath and keeps task labels and grants", async () => {
  const ctx = await context("Dijkstra on a weighted graph");
  const folder = await prepareFolder(h.app, ctx, settings);
  assert.equal(folder.root, join(workspace, "runs", "dijkstra-weighted-graph"));
  assert.equal(folder.git, true);
  assert.equal(existsSync(join(workspace, "runs", ctx.job.id)), false);
  const naming = requests.at(-1)!;
  assert.equal(naming.model, ctx.job.model);
  assert.equal(naming.provider, ctx.job.provider);
  assert.equal(naming.folderExisted, false);
  const prompt = JSON.parse(naming.messages[1]!.content);
  assert.equal(prompt.title, ctx.taskTitle);
  assert.equal(prompt.instructions, ctx.job.instructions);
  assert.equal((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: ctx.job.id } })).repoPath, folder.root);
  assert.equal(await grantFolder(join(folder.root, "src", "graph.ts"), workspace), folder.root);
  const detail = await user.inject({ method: "GET", url: `/api/agent/jobs/${ctx.job.id}` });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().job.title, ctx.taskTitle);
  assert.equal(detail.json().job.folder, folder.root);
  const run = await h.prisma.run.create({ data: { userId: user.id, taskId: ctx.taskId, worker: "workspace" } });
  await h.prisma.workspaceJob.update({ where: { id: ctx.job.id }, data: { runId: run.id } });
  const runDetail = await user.inject({ method: "GET", url: `/api/runs/${run.id}` });
  assert.equal(runDetail.statusCode, 200, runDetail.body);
  assert.equal(runDetail.json().job.folder, folder.root, "the run sheet receives the readable checkout path");
  await h.prisma.workspaceEvent.create({ data: { jobId: ctx.job.id, kind: "prepared", data: { root: folder.root } } });
  await h.prisma.workspaceJob.update({ where: { id: ctx.job.id }, data: { repoPath: "" } });
  const reported = await user.inject({ method: "GET", url: `/api/runs/${run.id}` });
  assert.equal(reported.json().job.folder, folder.root, "a paired run's prepared event supplies its path");
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const hosted = await user.inject({ method: "GET", url: `/api/runs/${run.id}` });
    assert.equal(hosted.statusCode, 200, hosted.body);
    assert.equal(hosted.json().job.folder, basename(folder.root), "a hosted run reveals the name, not the host's path");
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
  await h.prisma.workspaceJob.update({ where: { id: ctx.job.id }, data: { repoPath: folder.root } });
  const repos = await user.inject({ method: "GET", url: "/api/code/repos" });
  assert.equal(repos.statusCode, 200, repos.body);
  assert.equal(repos.json().details.find((row: { path: string }) => row.path === folder.root)?.taskTitle, ctx.taskTitle);
  const earlier = await user.inject({ method: "GET", url: "/api/workspace/checkouts" });
  assert.equal(earlier.statusCode, 200, earlier.body);
  assert.equal(earlier.json().checkouts.find((row: { jobId: string }) => row.jobId === ctx.job.id)?.title, ctx.taskTitle);
});

test("prepareFolder suffixes another job's reserved name and continuations reuse the saved path without another naming request", async () => {
  const busy = await context("Reserved graph work");
  await h.prisma.workspaceJob.update({ where: { id: busy.job.id }, data: { repoPath: join(workspace, "runs", "dijkstra-weighted-graph-2") } });
  const ctx = await context("Another graph task");
  const folder = await prepareFolder(h.app, ctx, settings);
  assert.equal(basename(folder.root), "dijkstra-weighted-graph-3");
  const before = requests.length;
  const continuation = await context("Continue graph task", { continueFromJobId: ctx.job.id });
  assert.deepEqual(await prepareFolder(h.app, continuation, settings), folder);
  assert.equal(requests.length, before);
});

test("stopping during naming does not fall back into creating a checkout", async () => {
  const ctx = await context("Stopped graph task");
  ctx.signal = AbortSignal.abort(new DOMException("Stopped", "AbortError"));
  await assert.rejects(prepareFolder(h.app, ctx, settings), { name: "AbortError" });
  assert.equal((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: ctx.job.id } })).repoPath, "");
  assert.equal(existsSync(join(workspace, "runs", "stopped-graph-task")), false);
});

test("prepareFolder uses a title fallback after an unsafe reply or model failure, and preserves UUID and user-picked folders", async () => {
  reply = "../outside";
  const rejected = await context("Graph rejected reply");
  assert.equal(basename((await prepareFolder(h.app, rejected, settings)).root), "graph-rejected-reply");
  status = 503;
  const unavailable = await context("Graph model unavailable");
  assert.equal(basename((await prepareFolder(h.app, unavailable, settings)).root), "graph-model-unavailable");
  const event = await h.prisma.workspaceEvent.findFirstOrThrow({ where: { jobId: unavailable.job.id, kind: "checkout_name" } });
  assert.deepEqual(event.data, { slug: "graph-model-unavailable", source: "title", reason: "The naming model could not answer." });
  const legacy = await context("Existing UUID checkout");
  const legacyRoot = join(workspace, "runs", legacy.job.id);
  await mkdir(legacyRoot);
  await h.prisma.workspaceJob.update({ where: { id: legacy.job.id }, data: { repoPath: legacyRoot } });
  const picked = join(workspace, "chosen-folder");
  await mkdir(picked);
  const own = await context("Keep my folder", { externalRoot: picked });
  const before = requests.length;
  assert.equal((await prepareFolder(h.app, await context("Continue UUID checkout", { continueFromJobId: legacy.job.id }), settings)).root, legacyRoot);
  assert.equal((await prepareFolder(h.app, own, settings)).root, picked);
  assert.equal(requests.length, before);
});
