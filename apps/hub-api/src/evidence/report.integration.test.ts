/**
 * The worker's own result on this computer (evidence/run-tools.ts), end to end through the run's
 * `ensemble` MCP server: report_result is validated (shape, and that the commit it names is in the
 * folder's repository) and kept on the job; attach_evidence copies a checked file into the run's
 * evidence folder; a worker without the tools writes .ensemble/result.json, read when the run ends.
 * Against the real routes on an in-memory database, with the MCP server as the agent starts it.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";

const scratch = mkdtempSync(join(tmpdir(), "ensemble-report-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(scratch, "data");
process.env.ENSEMBLE_WORKSPACE_ROOT = join(scratch, "workspace");
const h = await createHttpHarness();
const { registerEngineRun, unregisterEngineRun } = await import("../workspace/engines/registry.js");
const { collectRunResult } = await import("./run-tools.js");
const { evidenceDir } = await import("./files.js");
// The work folder lives outside Ensemble's own checkout, as a person's project does.
const work = mkdtempSync(join(homedir(), ".ensemble-report-work-"));
after(async () => {
  await h.close();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ffff3f0005fe02fea7d6a4a40000000049454e44ae426082", "hex");

function git(...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: work, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function runFor(context: Record<string, unknown> = {}) {
  const user = await h.asUser();
  const task = await h.prisma.task.create({ data: { userId: user.id, title: "Check the export" } });
  const job = await h.prisma.workspaceJob.create({ data: { userId: user.id, taskId: task.id, executionMode: "native", model: "default", status: "running", repoPath: work, context: context as never } });
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const ctx = {
    prisma: h.prisma,
    job,
    userId: user.id,
    taskId: task.id,
    root: work,
    sandboxed: false,
    network: false,
    signal: new AbortController().signal,
    accessMode: "read-write",
    trusted: true,
    explicitTrust: false,
    silentWorkspace: true,
    blockedOutside: [],
    touched: new Set<string>(),
    event: async (kind: string, data: Record<string, unknown>) => void events.push({ kind, data }),
    progress: async () => undefined,
    waitForPerson: async <T>(work: () => Promise<T>) => work(),
    strength: "advisory",
  };
  return { user, job, ctx: ctx as never, events };
}

/** The run's MCP server as the agent starts it, answering one call. */
async function mcpCall(port: number, credential: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const script = fileURLToPath(new URL("../../../../scripts/ensemble-ask-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [script], { env: { ...process.env, ENSEMBLE_ENGINE_URL: `http://127.0.0.1:${port}`, ENSEMBLE_RUN: credential }, stdio: ["pipe", "pipe", "inherit"] });
  try {
    let out = "";
    const answered = new Promise<{ text: string; isError: boolean }>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const line = out.split("\n").find((row) => row.includes('"id":5'));
        if (!line) return;
        const reply = JSON.parse(line) as { result: { content: Array<{ text: string }>; isError?: boolean } };
        resolve({ text: reply.result.content[0]!.text, isError: reply.result.isError === true });
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name, arguments: args } })}\n`);
    return await answered;
  } finally {
    child.kill();
  }
}

test("report_result and attach_evidence through the run's MCP server: validated, kept on the job, copied into the evidence folder", async () => {
  git("init", "--quiet");
  writeFileSync(join(work, "app.js"), "console.log('export')\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "Export");
  const head = git("rev-parse", "HEAD");
  const { job, ctx } = await runFor();
  const credential = registerEngineRun(ctx);
  const desktop = process.env.ENSEMBLE_DESKTOP;
  // The engine routes answer only on the computer (the desktop sidecar), over loopback.
  process.env.ENSEMBLE_DESKTOP = "1";
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (h.app.server.address() as { port: number }).port;
  try {
    const bad = await mcpCall(port, credential, "report_result", { outcome: "great", summary: "" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Not recorded: outcome/);
    const missing = await mcpCall(port, credential, "report_result", { outcome: "pass", summary: "All export checks pass.", checks: [{ name: "CSV export", verdict: "pass" }], subject: { commit: "0123456789abcdef0123456789abcdef01234567" } });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /is not in this folder's repository/);
    assert.equal((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: job.id } })).report, null, "nothing kept from a refused report");

    writeFileSync(join(work, "export.png"), PNG);
    const attached = await mcpCall(port, credential, "attach_evidence", { path: "export.png", kind: "screenshot", caption: "The export dialog" });
    assert.equal(attached.isError, false, attached.text);
    const row = await h.prisma.jobEvidence.findFirstOrThrow({ where: { jobId: job.id } });
    assert.equal(row.mime, "image/png");
    assert.match(attached.text, new RegExp(`evidence id ${row.id}`));
    writeFileSync(join(work, ".env"), "TOKEN=abc\n");
    const refused = await mcpCall(port, credential, "attach_evidence", { path: ".env", kind: "file" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /never attached/);

    const good = await mcpCall(port, credential, "report_result", { outcome: "pass", summary: "All export checks pass.", checks: [{ id: "r1-a1", name: "CSV export", verdict: "pass", evidence: [row.id] }], subject: { commit: head } });
    assert.equal(good.isError, false, good.text);
    assert.match(good.text, /Recorded your result: pass, with 1 check/);
    const kept = (await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: job.id } })).report as { outcome: string; subject: { commit: string } };
    assert.equal(kept.outcome, "pass");
    assert.equal(kept.subject.commit, head);
  } finally {
    unregisterEngineRun(job.id);
    if (desktop === undefined) delete process.env.ENSEMBLE_DESKTOP;
    else process.env.ENSEMBLE_DESKTOP = desktop;
  }
  // The run has ended: its secret no longer works.
  const ended = await mcpCall(port, credential, "report_result", { outcome: "done", summary: "x" });
  assert.equal(ended.isError, true);
});

test("without the tools, .ensemble/result.json and its evidence are read when the run ends; an earlier run's file is not", async () => {
  const { job, ctx, events } = await runFor();
  const since = new Date();
  mkdirSync(join(work, ".ensemble"), { recursive: true });
  writeFileSync(join(work, "failure.log"), "1 failing: export keeps the header row\n");
  writeFileSync(join(work, ".ensemble", "result.json"), JSON.stringify({ outcome: "fail", summary: "The CSV export repeats its header.", checks: [{ name: "CSV export", verdict: "fail", detail: "Header written twice." }], evidence: [{ kind: "log", ref: "failure.log", caption: "Test output" }, { kind: "url", ref: "https://example.test/run/1" }] }));
  await collectRunResult(ctx, since);
  const report = (await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: job.id } })).report as { outcome: string; checks: Array<{ verdict: string }> };
  assert.equal(report.outcome, "fail");
  assert.equal(report.checks[0]!.verdict, "fail");
  const files = await h.prisma.jobEvidence.findMany({ where: { jobId: job.id } });
  assert.deepEqual(files.map((row) => [row.name, row.kind, row.caption]), [["failure.log", "log", "Test output"]]);
  assert.ok(events.some((row) => row.kind === "report" && row.data.via === "file"));

  // A file left in the evidence folder by the worker itself is attached too.
  writeFileSync(join(evidenceDir(job.id), "after.png"), PNG);
  await collectRunResult(ctx, since);
  assert.equal(await h.prisma.jobEvidence.count({ where: { jobId: job.id } }), 2);

  // A result file from before this run, or one that is not a report, is not taken.
  const second = await runFor();
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(join(work, ".ensemble", "result.json"), old, old);
  await collectRunResult(second.ctx, new Date());
  assert.equal((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: second.job.id } })).report, null);
  writeFileSync(join(work, ".ensemble", "result.json"), JSON.stringify({ outcome: "maybe" }));
  await collectRunResult(second.ctx, new Date(Date.now() - 5_000));
  assert.equal((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: second.job.id } })).report, null);
  assert.ok(second.events.some((row) => row.kind === "report_refused" && /not a valid report/.test(String(row.data.problem))));

  // Written by hand as the brief lists the fields: the commit at the top goes into subject, and must exist.
  const third = await runFor();
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(work, ".ensemble", "result.json"), JSON.stringify({ outcome: "done", summary: "Fixed the header.", commit: "ffffffffffffffffffffffffffffffffffffffff" }));
  await collectRunResult(third.ctx, new Date(Date.now() - 5_000));
  assert.equal((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: third.job.id } })).report, null);
  assert.ok(third.events.some((row) => row.kind === "report_refused" && /is not in this folder's repository/.test(String(row.data.problem))));
  writeFileSync(join(work, ".ensemble", "result.json"), JSON.stringify({ outcome: "done", summary: "Fixed the header.", commit: head }));
  await collectRunResult(third.ctx, new Date(Date.now() - 5_000));
  const byHand = (await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: third.job.id } })).report as { subject?: { commit?: string } };
  assert.equal(byHand.subject?.commit, head);
});

test("a report's content hash must be the last commit's tree or the working tree's; the staging area is left alone", async () => {
  const { candidateProblem } = await import("./run-tools.js");
  const { sandboxAvailable } = await import("../workspace/guard.js");
  const { ctx } = await runFor();
  // Under the OS sandbox where there is one, as on a person's computer.
  const run = { ...(ctx as Record<string, unknown>), sandboxed: sandboxAvailable() } as never;
  const headTree = git("rev-parse", "HEAD^{tree}");
  assert.equal(await candidateProblem(run, { contentHash: headTree }), null);
  writeFileSync(join(work, "app.js"), "console.log('export, fixed')\n");
  const staged = git("diff", "--cached", "--name-only");
  const problem = await candidateProblem(run, { contentHash: headTree.replace(/^./, (char) => (char === "0" ? "1" : "0")) });
  assert.match(String(problem), /does not match the working tree \(its git tree is ([0-9a-f]{40})\)/);
  const tree = /its git tree is ([0-9a-f]{40})/.exec(String(problem))![1]!;
  assert.notEqual(tree, headTree, "the uncommitted change is in the working tree's hash");
  assert.equal(await candidateProblem(run, { contentHash: tree }), null);
  assert.equal(git("diff", "--cached", "--name-only"), staged, "the real index is untouched");
  assert.match(git("status", "--porcelain"), /^ ?M app\.js$/m, "the change stays unstaged");
  assert.doesNotMatch(git("status", "--porcelain", "--ignored"), /ensemble-report-index/, "the throwaway index is gone");
});
