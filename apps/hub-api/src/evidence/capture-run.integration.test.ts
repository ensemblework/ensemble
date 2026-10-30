/**
 * A coding agent's browser and capture tools (evidence/capture-tools.ts), through the run's `ensemble`
 * MCP server as the agent starts it: listed for a task run (never Chat), run for the run's own operation
 * with a headless Chromium against a local server, and what they capture is the run's evidence at once
 * (held for the owner's preview on a preview-first site). A run with the internet off browses only this
 * computer's own addresses. When the run ends, its recording is finished and kept, and its tabs close.
 * Held files go to a server that knows them as held, without their bytes, and to an older one not at all.
 * Browser parts skip without a Chromium.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";

const scratch = mkdtempSync(join(homedir(), ".ensemble-capture-run-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(scratch, "data");
process.env.ENSEMBLE_WORKSPACE_ROOT = join(scratch, "workspace");
const h = await createHttpHarness();
const { registerEngineRun } = await import("../workspace/engines/registry.js");
const { configureBrowser, browserBroker, shutdownBrowser } = await import("../browser/index.js");
const { shutdownCapture } = await import("../capture/index.js");
const { finishRunCapture } = await import("./capture-tools.js");
const { sendEvidence } = await import("./upload.js");
const { findFfmpegs, chooseVideoEncoder } = await import("../capture/ffmpeg.js");

const privacy: { previewFirst: string[] } = { previewFirst: [] };
configureBrowser({ privacy: async () => ({ previewFirst: privacy.previewFirst }) });
const noBrowser = browserBroker().chromium(true) ? false : "no Chromium on this computer (`ensemble capture setup` installs one)";
const work = mkdtempSync(join(homedir(), ".ensemble-capture-run-work-"));

const site = createServer((request, response) => {
  response.setHeader("content-type", "text/html");
  if (request.url === "/blank") return void response.end(`<!doctype html><title>Loading</title><body style="background:#fff"></body>`);
  response.end(`<!doctype html><title>Export</title><body style="margin:0;font:24px sans-serif"><header style="background:#1d4ed8;color:#fff;padding:40px">Export ready</header><main style="display:grid;grid-template-columns:1fr 1fr;height:600px"><section style="background:#f59e0b">Download the CSV.</section><section style="background:#10b981">Rows: 1,204</section></main></body>`);
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

const desktop = process.env.ENSEMBLE_DESKTOP;
// The engine routes answer only on the computer, over loopback.
process.env.ENSEMBLE_DESKTOP = "1";
await h.app.listen({ port: 0, host: "127.0.0.1" });
const port = (h.app.server.address() as { port: number }).port;

after(async () => {
  process.env.ENSEMBLE_DESKTOP = desktop;
  await shutdownCapture().catch(() => undefined);
  await shutdownBrowser().catch(() => undefined);
  site.close();
  await h.close();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

async function runFor(options: { network?: boolean; chat?: boolean } = {}) {
  const user = await h.asUser();
  const task = await h.prisma.task.create({ data: { userId: user.id, title: "Check the export page" } });
  const job = await h.prisma.workspaceJob.create({ data: { userId: user.id, taskId: task.id, executionMode: "native", model: "default", status: "running", repoPath: work, context: (options.chat ? { chat: true } : {}) as never } });
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const ctx = {
    prisma: h.prisma,
    job,
    userId: user.id,
    taskId: task.id,
    root: work,
    sandboxed: false,
    network: options.network ?? true,
    signal: new AbortController().signal,
    accessMode: "read-write",
    trusted: true,
    explicitTrust: false,
    silentWorkspace: true,
    blockedOutside: [],
    touched: new Set<string>(),
    event: async (kind: string, data: Record<string, unknown>) => void events.push({ kind, data }),
    progress: async () => undefined,
    waitForPerson: async <T>(run: () => Promise<T>) => run(),
    strength: "advisory",
  };
  return { user, job, ctx: ctx as never, events, credential: registerEngineRun(ctx as never) };
}

/** The run's MCP server as the agent starts it: one request, its reply. */
async function mcp(credential: string, method: string, params: Record<string, unknown> = {}, env: Record<string, string> = {}): Promise<Record<string, any>> {
  const script = fileURLToPath(new URL("../../../../scripts/ensemble-ask-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [script], { env: { ...process.env, ENSEMBLE_ENGINE_URL: `http://127.0.0.1:${port}`, ENSEMBLE_RUN: credential, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  try {
    let out = "";
    const answered = new Promise<Record<string, any>>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const line = out.split("\n").find((row) => row.includes('"id":7'));
        if (line) resolve((JSON.parse(line) as { result: Record<string, any> }).result);
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method, params })}\n`);
    return await answered;
  } finally {
    child.kill();
  }
}

const call = async (credential: string, name: string, args: Record<string, unknown>) => {
  const result = await mcp(credential, "tools/call", { name, arguments: args });
  return { text: String(result.content[0].text), isError: result.isError === true };
};

test("a task run's MCP server lists the browser and capture tools; Chat gets none", async () => {
  const { credential } = await runFor();
  const tools = ((await mcp(credential, "tools/list")).tools as Array<{ name: string; inputSchema: Record<string, unknown> }>).map((tool) => tool.name);
  assert.ok(["ask_person", "report_result", "attach_evidence", "capture_status"].every((name) => tools.includes(name)));
  if (!noBrowser) assert.ok(["browser_open", "browser_snapshot", "browser_screenshot", "capture_screenshot", "capture_video", "capture_check", "capture_app_start"].every((name) => tools.includes(name)));
  const chat = await runFor({ chat: true });
  const chatTools = ((await mcp(chat.credential, "tools/list", {}, { ENSEMBLE_CHAT: "1" })).tools as Array<{ name: string }>).map((tool) => tool.name);
  assert.ok(!chatTools.some((name) => name.startsWith("browser_") || name.startsWith("capture_")));
  const refused = await fetch(`http://127.0.0.1:${port}/api/engine/tool`, { method: "POST", headers: { "content-type": "application/json", "x-ensemble-run": chat.credential }, body: JSON.stringify({ name: "browser_open", input: { url: base } }) });
  assert.equal(refused.status, 403);
});

test("captures are the run's evidence at once: kept, checked, held on a preview-first site", { skip: noBrowser, timeout: 120_000 }, async () => {
  const { job, credential, events, ctx } = await runFor();
  const opened = await call(credential, "browser_open", { url: `${base}/export` });
  assert.equal(opened.isError, false, opened.text);
  const tab = /Opened (t\d+)/.exec(opened.text)![1]!;
  const shot = await call(credential, "browser_screenshot", { tab, name: "export" });
  assert.equal(shot.isError, false, shot.text);
  const row = await h.prisma.jobEvidence.findFirstOrThrow({ where: { jobId: job.id } });
  assert.deepEqual([row.kind, row.mime, row.held, row.storageKey], ["screenshot", "image/png", false, "export.png"]);
  assert.match(shot.text, new RegExp(`Kept as evidence: screenshot “export.png” \\[${row.id}\\]`));
  assert.ok(events.some((event) => event.kind === "evidence" && event.data.id === row.id));
  const path = /Saved (\S+\.png)/.exec(shot.text)![1]!;
  const check = await call(credential, "capture_check", { kind: "image", path, id: "a1" });
  assert.match(check.text, /^pass: /, "not blank");
  const text = await call(credential, "capture_check", { kind: "text", tab, expected: ["Export ready"] });
  assert.match(text.text, /^pass: /);
  // A page that has not drawn yet is a blank screenshot: a failed check for the report.
  await call(credential, "browser_open", { url: `${base}/blank`, tab });
  const blank = await call(credential, "browser_screenshot", { tab, name: "blank" });
  const blankPath = /Saved (\S+\.png)/.exec(blank.text)![1]!;
  assert.match((await call(credential, "capture_check", { kind: "image", path: blankPath })).text, /^fail: The screenshot is not blank \(The image is blank/);

  privacy.previewFirst = ["127.0.0.1"];
  try {
    const held = await call(credential, "capture_screenshot", { target: "web", url: `${base}/export`, name: "previewed" });
    assert.equal(held.isError, false, held.text);
    assert.match(held.text, /Held for your owner to preview first/);
    const kept = await h.prisma.jobEvidence.findFirstOrThrow({ where: { jobId: job.id, name: "previewed.png" } });
    assert.equal(kept.held, true);
  } finally {
    privacy.previewFirst = [];
  }
  await finishRunCapture(ctx);
  assert.deepEqual(await browserBroker().list(job.id).catch(() => []), [], "the run's tabs closed when it ended");
});

test("a run with the internet off browses only this computer's own addresses", { skip: noBrowser, timeout: 60_000 }, async () => {
  const { credential, ctx } = await runFor({ network: false });
  const away = await call(credential, "browser_open", { url: "https://example.com/" });
  assert.equal(away.isError, true);
  assert.match(away.text, /internet off/);
  const captured = await call(credential, "capture_screenshot", { target: "web", url: "https://example.com/" });
  assert.equal(captured.isError, true);
  const home = await call(credential, "browser_open", { url: `${base}/export` });
  assert.equal(home.isError, false, home.text);
  await finishRunCapture(ctx);
});

const encoder = chooseVideoEncoder(await findFfmpegs().catch(() => []));
test("a recording still going when the run ends is finished and kept as its evidence", { skip: noBrowser || (!encoder && "no video encoder here"), timeout: 120_000 }, async () => {
  const { job, credential, ctx } = await runFor();
  const opened = await call(credential, "browser_open", { url: `${base}/export` });
  const tab = /Opened (t\d+)/.exec(opened.text)![1]!;
  const started = await call(credential, "browser_record", { tab, kind: "video", action: "start" });
  assert.equal(started.isError, false, started.text);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await finishRunCapture(ctx);
  const video = await h.prisma.jobEvidence.findFirstOrThrow({ where: { jobId: job.id, kind: "video" } });
  assert.equal(video.held, false);
  const variants = await h.prisma.jobEvidence.findMany({ where: { variantOf: video.id } });
  assert.ok(variants.some((row) => row.variant === "poster"), "with its poster");
});

test("held files go to a server that knows them as held, without their bytes, and to an older one not at all", async () => {
  const { job, user } = await runFor();
  const { randomUUID } = await import("node:crypto");
  const row = await h.prisma.jobEvidence.create({ data: { id: randomUUID(), userId: user.id, jobId: job.id, kind: "screenshot", name: "secret.png", mime: "image/png", size: 10, sha256: "c".repeat(64), storageKey: "secret.png", held: true, holdReason: "It shows one of your saved secret values." } });
  const sent: Array<{ meta: Record<string, unknown>; bytes: number }> = [];
  const client = { uploadEvidence: async (_job: string, _lease: string, meta: Record<string, unknown>, bytes: Uint8Array) => (sent.push({ meta, bytes: bytes.byteLength }), { result: "stored" as const }) };
  const current = { hostedId: randomUUID(), leaseToken: "lease", protocol: 7, evidenceSent: [] as string[] };
  await sendEvidence({ prisma: h.prisma }, client as never, current as never, { id: job.id });
  assert.deepEqual(sent.map((item) => [item.meta.id, item.meta.held, item.meta.local, item.bytes]), [[row.id, true, true, 0]]);
  assert.equal(sent[0]!.meta.holdReason, "It shows one of your saved secret values.");
  sent.length = 0;
  const older = { hostedId: randomUUID(), leaseToken: "lease", protocol: 6, evidenceSent: [] as string[] };
  await sendEvidence({ prisma: h.prisma }, client as never, older as never, { id: job.id });
  assert.deepEqual(sent, [], "an older server never sees it");
});
