/**
 * A Code tab turn's harness against an in-memory database (docs/16 §9, docs/41 §2): the whole packet
 * for a new session and only what changed for a later turn in it (a renamed task, nothing else), the
 * packet's version on the run, the owner's linked skills in the agent's own skill folder, a handoff
 * record and a new session when the owner switches agent, a fork, the steer prompt, the checks Ensemble
 * ran again kept apart from the agent's claim, and what a paired computer sends the web about a turn.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";

const h = await createHttpHarness();
const db = h.prisma;
const { keepCodeTurn, keepCodeTurnContext, prepareCodeTurn, codeTurnResultOf, keepCodeTurnResult } = await import("./code-turn.js");
const { completionOf, markAccepted, parseCompletion, saveCompletion, verifyRun } = await import("./completion.js");
const { steerPrompt } = await import("./engine-watch.js");
const { HANDOFF_CHARS, renderHandoff, parseHandoff } = await import("./handoff-record.js");
const { withMentionedContent } = await import("./mentioned.js");
const { packetRecordOf } = await import("./turn-packet.js");
const { loadSettings, saveSettings } = await import("../lib/settings.js");
const { runLimits } = await import("@ensemble/shared-types");
const { Assign, createJob } = await import("./assign.js");
const { webContext } = await import("../remote/origin.js");
type Ctx = Parameters<typeof prepareCodeTurn>[0];
type JobContext = Parameters<typeof verifyRun>[0];

const scratch = mkdtempSync(join(tmpdir(), "ensemble-code-turn-"));
after(async () => {
  await h.close();
  rmSync(scratch, { recursive: true, force: true });
});

const RULES = ["- You're in the folder Code has open.", "- Commands ask first."];
const mention = (title: string, id: string) => `\n\n(Mentioned in Ensemble: @${title} [task] ensemble://task/${id})`;

async function setup(name: string) {
  const user = await h.asUser();
  const root = join(scratch, name);
  execFileSync("git", ["init", "-q", root]);
  const board = await db.task.create({ data: { userId: user.id, title: "Fix the CSV export", description: "Acceptance criteria:\n- The header row stays first", owner: "agent", status: "todo", createdBy: "me" } });
  const thread = await db.task.create({ data: { userId: user.id, title: "CSV export", owner: "agent", status: "todo", sourceKind: "other", sourceRef: "code:local:fieldnote", createdBy: "me" } });
  /** One turn of the thread, as the queue made it, with its run started. */
  const turn = async (over: { provider?: string; model?: string; continueFrom?: string | null; instructions?: string; context?: Record<string, unknown> } = {}) => {
    const run = await db.run.create({ data: { taskId: thread.id, userId: user.id, worker: "workspace" } });
    return db.workspaceJob.create({
      data: {
        userId: user.id,
        taskId: thread.id,
        kind: "code",
        status: "running",
        executionMode: "native",
        provider: over.provider ?? "claude-code",
        model: over.model ?? "",
        continueFromJobId: over.continueFrom ?? null,
        instructions: over.instructions ?? "Carry on.",
        context: { chat: true, surface: "code", ...over.context },
        runId: run.id,
        repoPath: root,
        startedAt: new Date(),
      },
      include: { task: true },
    });
  };
  const ctx = (job: Awaited<ReturnType<typeof turn>>): Ctx => ({ prisma: db, job, userId: user.id, root, secretEnv: {} }) as unknown as Ctx;
  /** The turn's provenance was kept before it went; its agent got its prompt and recorded its session; the turn ended. */
  const ran = async (job: Awaited<ReturnType<typeof turn>>, built: Awaited<ReturnType<typeof prepareCodeTurn>>, session: string) => {
    await keepCodeTurnContext(db, job.runId!, built);
    await keepCodeTurn(db, job.runId!, built);
    await db.workspaceEvent.create({ data: { jobId: job.id, kind: "engine", data: { session } } });
    await db.workspaceJob.update({ where: { id: job.id }, data: { status: "succeeded", finishedAt: new Date(), summary: "Changed the export to keep the column order." } });
  };
  const base = { owner: "Mira", rules: RULES, head: null, timezone: "Europe/London" };
  return { user, root, board, thread, turn, ctx, ran, base };
}

test("the first turn gets the whole packet; the next turn in the session only the renamed task; the run keeps the packet's version", async () => {
  const { user, board, turn, ctx, ran, base } = await setup("delta");
  const first = await turn({ instructions: `Make the export keep the column order.${mention(board.title, board.id)}` });
  const one = await prepareCodeTurn(ctx(first), { ...base, resume: null });
  assert.equal(one.operation, "fresh");
  assert.equal(one.record.mode, "full");
  assert.match(one.prompt, /You're the coding agent in Mira's Ensemble Code tab/);
  assert.match(one.prompt, /From Mira's Ensemble, around this work[\s\S]*Fix the CSV export \(task/);
  assert.match(one.prompt, /- AC-1: The header row stays first/, "the task's own acceptance criteria");
  await ran(first, one, "session-1");
  const run = await db.run.findUniqueOrThrow({ where: { id: first.runId! } });
  assert.equal(run.promptVersion, one.record.version);
  assert.ok(run.contextPackId, "a Code tab turn keeps the context pack too");
  assert.ok(packetRecordOf(run.packet)?.sections.some((section) => section.name === "code/00-agent" && section.chars > 0), "section sizes are kept with the version");

  await db.task.update({ where: { id: board.id }, data: { title: "Fix the CSV and XLSX export" } });
  const second = await turn({ continueFrom: first.id, instructions: "Now the XLSX one too." });
  const two = await prepareCodeTurn(ctx(second), { ...base, resume: "session-1" });
  assert.equal(two.operation, "resume");
  assert.equal(two.record.mode, "delta");
  assert.match(two.prompt, /Since your last turn[\s\S]*- Changed: Fix the CSV and XLSX export \(task/);
  assert.doesNotMatch(two.prompt, /How this run works|You're the coding agent|Today is|AC-1/, "nothing that did not change");
  assert.ok(two.prompt.endsWith("The message from Mira:\n\nNow the XLSX one too."));
  await ran(second, two, "session-1");
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: second.runId! } })).promptVersion, two.record.version);

  // The steer prompt: a message that changes the work under way, in the same session, with what it mentions read for the agent.
  const words = `Use semicolons, as the task says.${mention(board.title, board.id)}`;
  const expanded = await withMentionedContent(db, user.id, words);
  assert.match(expanded, /\(Attached from Ensemble:[\s\S]*The header row stays first/);
  const steered = await turn({ continueFrom: second.id, instructions: expanded, context: { steer: { update: words } } });
  const three = await prepareCodeTurn(ctx(steered), { ...base, resume: "session-1" });
  assert.ok(three.prompt.endsWith(steerPrompt(expanded)), "the steer carries the mentioned records' content");
  // A new day is said again, after the steer note and before the message.
  const later = await prepareCodeTurn(ctx(steered), { ...base, resume: "session-1", now: new Date(Date.now() + 2 * 86_400_000) });
  assert.match(later.prompt, /Today is \d{4}-\d{2}-\d{2} \([\w/]+\)/);
  assert.ok(later.prompt.startsWith(steerPrompt("")), "the steer note leads");
  assert.ok(later.prompt.endsWith(`The message from Mira:\n\n${expanded}`));
});

test("the owner's linked skills go into the agent's own skill folder, out of git, and on the run", async () => {
  const { user, root, board, turn, ctx, ran, base } = await setup("skills");
  const skill = await db.skill.create({ data: { userId: user.id, slug: "release-notes", name: "Release notes", description: "Use when writing release notes.", body: "Group by area." } });
  await db.task.update({ where: { id: board.id }, data: { skillIds: [skill.id] } });
  const job = await turn({ instructions: `Write the release notes.${mention(board.title, board.id)}` });
  const built = await prepareCodeTurn(ctx(job), { ...base, resume: null });
  assert.match(readFileSync(join(root, ".claude", "skills", "owner-release-notes", "SKILL.md"), "utf8"), /name: owner-release-notes[\s\S]*Group by area\./);
  assert.match(built.prompt, /Skills for this run are in \.claude\/skills[\s\S]*- owner-release-notes: Use when writing release notes\./);
  assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), "");
  await ran(job, built, "session-s");
  const run = await db.run.findUniqueOrThrow({ where: { id: job.runId! } });
  assert.deepEqual(run.skillIds, [skill.id]);
  const names = (run.skillSignatures as Array<{ name: string; source: string }>).map((row) => `${row.source}:${row.name}`);
  assert.equal(names.at(-1), "owner:owner-release-notes");
  assert.ok(names.slice(0, -1).length > 0 && names.slice(0, -1).every((name) => /^ensemble:ensemble-[a-z0-9-]+$/.test(name)), "Ensemble's bundled skills come first");

  // A read-only turn in the same session leaves the folder as it is, and says nothing new about the skills.
  const reading = await turn({ continueFrom: job.id, instructions: "Only read the release notes now." });
  const read = await prepareCodeTurn({ ...ctx(reading), accessMode: "review" } as Ctx, { ...base, resume: "session-s" });
  assert.equal(read.operation, "resume");
  assert.doesNotMatch(read.prompt, /no longer in your skill folder|Skills for this run/);
  assert.deepEqual(read.record.skills, built.record.skills);
  assert.ok(existsSync(join(root, ".claude", "skills", "owner-release-notes", "SKILL.md")));
  await ran(reading, read, "session-s");
  const readRun = await db.run.findUniqueOrThrow({ where: { id: reading.runId! } });
  assert.deepEqual(readRun.skillIds, run.skillIds);
  assert.deepEqual(readRun.skillSignatures, run.skillSignatures, "read-only resumed turns retain the skills already in their session");

  // A read-only turn writes nothing into the folder.
  const other = await setup("skills-read-only");
  const looking = await other.turn({ instructions: `Look at the release notes.${mention(other.board.title, other.board.id)}` });
  const looked = await prepareCodeTurn({ ...other.ctx(looking), accessMode: "review" } as Ctx, { ...other.base, resume: null });
  assert.equal(looked.skills, null);
  assert.ok(!existsSync(join(other.root, ".claude")));
  assert.doesNotMatch(looked.prompt, /Skills for this run are in/);
});

test("switching agent starts a new session with a handoff record of the earlier one, kept in the database and the folder", async () => {
  const { user, root, board, turn, ctx, ran, base } = await setup("handoff");
  const first = await turn({ instructions: `Make the export keep the column order.\nAC-1: the header row stays first${mention(board.title, board.id)}` });
  const one = await prepareCodeTurn(ctx(first), { ...base, resume: null });
  await ran(first, one, "claude-session");
  const report = { outcome: "pass" as const, summary: "Kept the order.", checks: [{ id: "AC-1", name: "export test", verdict: "pass" as const, rerun: { command: "npm test", expects: "exit_0" as const } }] };
  await db.workspaceJob.update({ where: { id: first.id }, data: { report, evidence: { files: [{ path: "src/export.ts", added: 12, removed: 3 }], model: "claude-sonnet-4-5" } } });
  const failed = { name: "export test", id: "AC-1", command: "npm test", cwd: null, expects: "exit_0" as const, claimed: "pass" as const, verdict: "fail" as const, reason: "It exited 1.", exitCode: 1, ms: 40, counts: null, output: "not ok 1 header order" };
  await db.run.update({ where: { id: first.runId! }, data: { completion: completionOf({ outcome: "success", files: [{ added: 12, removed: 3 }], report, runs: [failed], pr: { state: "none", url: null, source: null } }) as never } });
  await db.agentDecision.create({ data: { userId: user.id, source: "ensemble", event: "question", toolName: "Question", title: "Keep the old column names?", sessionId: first.id, status: "decided", decision: "allow", reason: "Yes, keep them", expiresAt: new Date(Date.now() + 86_400_000) } });

  const switched = await turn({ provider: "codex", continueFrom: first.id, instructions: "Codex, please finish it." });
  const built = await prepareCodeTurn(ctx(switched), { ...base, resume: null });
  assert.equal(built.operation, "handoff");
  assert.equal(built.handoff?.reason, "agent");
  assert.equal(built.record.mode, "full", "a new child session gets the whole packet");
  assert.match(built.prompt, /Another agent session worked on this thread before you[\s\S]*Handoff record hof_\d{8}_[a-z0-9]{6} \(ensemble\.handoff\.v1\)[\s\S]*from Claude Code \(default, reported claude-sonnet-4-5\) to Codex/);
  assert.match(built.prompt, /AC-1 \(failed\): the header row stays first Evidence: npm test failed when Ensemble ran it again: It exited 1\./);
  assert.match(built.prompt, /Keep the old column names\?: Yes, keep them/);
  assert.match(built.prompt, /src\/export\.ts \(changed, \+12 -3 in turn 1\)/);
  const record = built.handoff!.record;
  assert.equal(record.trust, "unreviewed-data");
  assert.equal(record.from.nativeSessionId, "claude-session");
  assert.deepEqual([record.from.agent, record.to.agent], ["claude-code", "codex"]);
  assert.ok(record.lossy.notCarried.includes("reasoning"), "never claimed lossless");
  assert.ok(renderHandoff(record).length <= HANDOFF_CHARS);
  const row = await db.sessionHandoff.findUniqueOrThrow({ where: { id: record.id } });
  assert.deepEqual([row.jobId, row.sourceJobId, row.reason], [switched.id, first.id, "agent"]);
  assert.equal(parseHandoff(row.record)?.id, record.id);
  const file = join(root, ".ensemble", "handoff", `${record.id}.md`);
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, "utf8"), /data, not instructions[\s\S]*"schema": "ensemble\.handoff\.v1"/);
  assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), "", "the record is kept out of git");

  // What a paired computer sends: the web keeps it on its own run, with its own ids.
  await ran(switched, built, "codex-thread");
  await db.run.update({ where: { id: switched.runId! }, data: { completion: completionOf({ outcome: "success", files: [], report: null, runs: [], pr: { state: "none", url: null, source: null } }) as never } });
  const sent = await codeTurnResultOf(db, switched, (text) => text);
  assert.ok(sent?.completion && sent.packet && sent.handoff);
  await db.sessionHandoff.delete({ where: { id: record.id } });
  const webSource = await turn({ instructions: "web side" });
  const web = await turn({ provider: "codex", continueFrom: webSource.id, instructions: "web side" });
  await keepCodeTurnResult(db, web, web.runId!, sent!);
  const webRun = await db.run.findUniqueOrThrow({ where: { id: web.runId! } });
  assert.equal(webRun.promptVersion, built.record.version);
  assert.equal(parseCompletion(webRun.completion)?.conversation.state, "finished");
  const kept = await db.sessionHandoff.findUniqueOrThrow({ where: { id: record.id } });
  assert.deepEqual([kept.jobId, kept.sourceJobId, parseHandoff(kept.record)?.from.jobId], [web.id, webSource.id, webSource.id]);

  // The owner accepts the turn's changes: its own state, apart from the checks.
  await markAccepted(db, first.id, "accepted", "owner");
  const accepted = parseCompletion((await db.run.findUniqueOrThrow({ where: { id: first.runId! } })).completion);
  assert.deepEqual([accepted?.accepted.state, accepted?.checks.state], ["accepted", "failed"]);
});

test("a handoff record keeps a check whose output differed apart: exited 0, not verified, not failed", async () => {
  const { turn, ctx, ran, base } = await setup("uncertain-handoff");
  const first = await turn({ instructions: "Make the build list its files.\nAC-1: the build reports 3 files" });
  await ran(first, await prepareCodeTurn(ctx(first), { ...base, resume: null }), "claude-uncertain");
  const differed = { name: "build", id: "AC-1", command: "node build.js", cwd: null, expects: { outputMatches: "Built 3 files" }, claimed: "pass" as const, verdict: "uncertain" as const, reason: 'Output differed: expected "Built 3 files", saw "Built 2 files".', exitCode: 0, ms: 30, counts: null, output: "Built 2 files" };
  await db.run.update({ where: { id: first.runId! }, data: { completion: completionOf({ outcome: "success", files: [], report: null, runs: [differed], pr: { state: "none", url: null, source: null } }) as never } });
  const switched = await turn({ provider: "codex", continueFrom: first.id, instructions: "Codex, take it from here." });
  const record = (await prepareCodeTurn(ctx(switched), { ...base, resume: null })).handoff!.record;
  assert.deepEqual([record.acceptance[0]?.id, record.acceptance[0]?.state], ["AC-1", "unverified"]);
  assert.match(record.acceptance[0]!.evidence, /^node build\.js exited 0 when Ensemble ran it again, but output differed: expected "Built 3 files", saw "Built 2 files"\.$/);
  assert.match(record.checks[0]!.result, /^build: exited 0 when Ensemble ran it again, but output differed/);
  assert.equal(record.state.failed.length, 0, "not a failure");
  assert.match(record.openWork.nextStep, /^Check AC-1 \(not verified yet\)/);
});

test("a fork starts a new session from a handoff record of the turn it forks, even with the same agent", async () => {
  const { board, turn, ctx, ran, base } = await setup("fork");
  const first = await turn({ instructions: `Try approach A.${mention(board.title, board.id)}` });
  await ran(first, await prepareCodeTurn(ctx(first), { ...base, resume: null }), "session-a");
  const fork = await turn({ continueFrom: first.id, instructions: "Try approach B instead.", context: { fork: { from: first.id } } });
  const built = await prepareCodeTurn(ctx(fork), { ...base, resume: null });
  assert.equal(built.operation, "fork");
  assert.equal(built.handoff?.reason, "fork");
  assert.match(built.prompt, /because the owner forked the thread from this point/);
  assert.match(built.prompt, /What the owner asked, oldest first:\n- Try approach A\./);
});

test("another model on the same plan stays in the session; another plan starts a new one with a handoff record", async () => {
  const { turn, ctx, ran, base } = await setup("subscription");
  const first = await turn({ provider: "opencode", model: "anthropic/claude-sonnet-4-5", instructions: "Start the export." });
  await ran(first, await prepareCodeTurn(ctx(first), { ...base, resume: null }), "oc-1");
  const sameVendor = await turn({ provider: "opencode", model: "anthropic/claude-opus-4-1", continueFrom: first.id, instructions: "Go on." });
  const same = await prepareCodeTurn(ctx(sameVendor), { ...base, resume: "oc-1" });
  assert.deepEqual([same.operation, same.handoff], ["resume", null]);
  await ran(sameVendor, same, "oc-1");
  const otherVendor = await turn({ provider: "opencode", model: "openai/gpt-5", continueFrom: sameVendor.id, instructions: "Finish it." });
  const other = await prepareCodeTurn(ctx(otherVendor), { ...base, resume: null });
  assert.deepEqual([other.operation, other.handoff?.reason, other.record.mode], ["handoff", "subscription", "full"]);
  assert.match(other.prompt, /because the owner switched to another subscription/);
});

test("a handoff record from a turn whose failing check has a long command is kept, its fields clipped", async () => {
  const { turn, ctx, ran, base } = await setup("long-check");
  const first = await turn({ instructions: "Make the build pass." });
  await ran(first, await prepareCodeTurn(ctx(first), { ...base, resume: null }), "claude-long");
  const command = `npm test -- ${"--grep 'keeps the header row in the CSV export' ".repeat(40)}`.slice(0, 1990);
  const failed = { name: "export test", id: null, command, cwd: null, expects: "exit_0" as const, claimed: "pass" as const, verdict: "fail" as const, reason: "It exited 1.", exitCode: 1, ms: 40, counts: null, output: "not ok 1" };
  await db.run.update({ where: { id: first.runId! }, data: { completion: completionOf({ outcome: "success", files: [], report: null, runs: [failed], pr: { state: "none", url: null, source: null } }) as never } });
  const warned: string[] = [];
  const switched = await turn({ provider: "codex", continueFrom: first.id, instructions: "Codex, fix the build." });
  const built = await prepareCodeTurn(ctx(switched), { ...base, resume: null, warn: (_error, message) => warned.push(message) });
  assert.ok(built.handoff, "the record is not dropped");
  assert.ok(built.handoff.record.openWork.nextStep.length <= 800);
  assert.match(built.handoff.record.openWork.nextStep, /^Fix what makes the check export test fail \(npm test -- --grep/);
  assert.deepEqual(warned, []);
});

test("an accept or discard while Ensemble runs the checks again stays on the run, and a discard stops the checks", async () => {
  const { user, root, turn } = await setup("discard");
  const job = await turn({ instructions: "Fix the export." });
  const report = {
    outcome: "pass" as const,
    summary: "Done.",
    checks: [
      { name: "unit", verdict: "pass" as const, rerun: { command: "npm test", expects: "exit_0" as const } },
      { name: "e2e", verdict: "pass" as const, rerun: { command: "npm run e2e", expects: "exit_0" as const } },
    ],
  };
  await db.workspaceJob.update({ where: { id: job.id }, data: { report } });
  const jobCtx = (over: Record<string, unknown> = {}) =>
    ({ prisma: db, job, userId: user.id, root, runId: job.runId, signal: new AbortController().signal, secretEnv: {}, accessMode: "read-write", sandboxed: false, network: false, progress: async () => undefined, event: async () => undefined, ...over }) as unknown as JobContext;
  const ran: string[] = [];
  const completion = await verifyRun(jobCtx(), { outcome: "success", files: [{ added: 2, removed: 1 }] }, {
    judge: async () => ({ decision: "allow" }),
    run: async (options) => {
      ran.push(options.argv.at(-1)!);
      // The owner discards the turn's changes while its first check runs.
      await markAccepted(db, job.id, "rejected", "owner");
      return { exitCode: 0, output: "ok", truncated: false, timedOut: false, killed: false, ms: 5 };
    },
  });
  assert.deepEqual(ran, ["npm test"], "no check runs after the discard");
  assert.deepEqual(completion.checks.runs.map((row) => row.verdict), ["pass", "not_run"]);
  assert.match(completion.checks.runs[1]!.reason ?? "", /discarded/);
  await saveCompletion(db, job.runId!, completion);
  const stored = parseCompletion((await db.run.findUniqueOrThrow({ where: { id: job.runId! } })).completion);
  assert.deepEqual([stored?.accepted.state, stored?.accepted.by, stored?.checks.passed, stored?.files.count], ["rejected", "owner", 1, 1], "the run's end keeps the discard and records the checks");

  // An accept that came first stays the same way, on this computer's run and on the web's from a computer's end.
  const accepted = await turn({ instructions: "Again." });
  await markAccepted(db, accepted.id, "accepted", "owner");
  await saveCompletion(db, accepted.runId!, completionOf({ outcome: "success", files: [], report: null, runs: [], pr: { state: "none", url: null, source: null } }));
  assert.equal(parseCompletion((await db.run.findUniqueOrThrow({ where: { id: accepted.runId! } })).completion)?.accepted.state, "accepted");
  await keepCodeTurnResult(db, accepted, accepted.runId!, { completion: completionOf({ outcome: "success", files: [{ added: 1, removed: 0 }], report: null, runs: [], pr: { state: "none", url: null, source: null } }) });
  const web = parseCompletion((await db.run.findUniqueOrThrow({ where: { id: accepted.runId! } })).completion);
  assert.deepEqual([web?.accepted.state, web?.files.count], ["accepted", 1]);
});

test("a turn from the web keeps what the web read for its @mentions on the computer, and its steer carries the same", async () => {
  // The web: its account's task, mentioned and read there.
  const web = await setup("from-web-records");
  const words = `Use semicolons, as the task says.${mention(web.board.title, web.board.id)}`;
  const fromWeb = await withMentionedContent(db, web.user.id, words);
  assert.match(fromWeb, /\(Attached from Ensemble:[\s\S]*The header row stays first/);
  // The computer: its own account and records, with none of the web's.
  const here = await setup("from-web-computer");
  const first = await here.turn({ model: "default", instructions: "Start the export." });
  await here.ran(first, await prepareCodeTurn(here.ctx(first), { ...here.base, resume: null }), "session-c");
  const turnHere = (instructions: string, context: Record<string, string | Record<string, string>>) => {
    const desktop = process.env.ENSEMBLE_DESKTOP;
    process.env.ENSEMBLE_DESKTOP = "1";
    return createJob(db, here.user.id, Assign.parse({ taskId: here.thread.id, kind: "code", engine: "claude-code", chat: true, surface: "code", continueFromJobId: first.id, instructions, markDone: false }), { context, actor: "system" }).finally(() => {
      if (desktop === undefined) delete process.env.ENSEMBLE_DESKTOP;
      else process.env.ENSEMBLE_DESKTOP = desktop;
    });
  };
  const claimed = await turnHere(fromWeb, { ...webContext(randomUUID()), steer: { update: words } });
  const job = await db.workspaceJob.findUniqueOrThrow({ where: { id: claimed!.jobId }, include: { task: true } });
  assert.equal(job.instructions, fromWeb, "kept as the web read it: this computer has no copy of those records");
  const steered = await prepareCodeTurn(here.ctx(job), { ...here.base, resume: "session-c" });
  assert.equal(steered.operation, "resume");
  assert.ok(steered.prompt.endsWith(steerPrompt(fromWeb)), "the steer carries the mentioned content, as on the web");
  // Run again here, without the web's mark: what was read there still goes, as nothing of it can be read here.
  assert.equal(await withMentionedContent(db, here.user.id, fromWeb), fromWeb);

  // A message made on this computer gets what it mentions read here.
  const local = await turnHere(`Check the task again.${mention(here.board.title, here.board.id)}`, {});
  const localJob = await db.workspaceJob.findUniqueOrThrow({ where: { id: local!.jobId } });
  assert.match(localJob.instructions, /\(Attached from Ensemble:[\s\S]*The header row stays first/);
});

test("the harness's migration applies again where it ran before, as on a database that ran its earlier name", async () => {
  const { applyMigration, appliedMigrationNames, listMigrationFiles, migrationsDir, openPglite } = await import("../lib/pglite-engine.js");
  const files = listMigrationFiles(migrationsDir());
  const harness = files.find((file) => file.name === "20261203130000_code_turn_harness");
  assert.ok(harness);
  const fresh = await openPglite();
  try {
    await appliedMigrationNames(fresh);
    for (const file of files) await applyMigration(fresh, file);
    await fresh.exec(harness.sql);
    const columns = await fresh.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'runs' AND column_name IN ('packet', 'completion') ORDER BY column_name`);
    assert.deepEqual(columns.rows.map((row) => row.column_name), ["completion", "packet"]);
  } finally {
    await fresh.close();
  }
});

test("a run's minutes and turns have no limit of Ensemble's own: the old saved defaults count as none, a limit the owner sets stays", async () => {
  const user = await h.asUser();
  assert.deepEqual(runLimits((await loadSettings(db, user.id)).orchestration), { maxMinutes: null, maxTurns: null });
  // Settings saved before carry Ensemble's old defaults (60 minutes, 40 turns) whether or not the owner chose them.
  await saveSettings(db, user.id, { orchestration: { maxMinutes: 60, maxTurns: 40, maxConcurrentJobs: 2 } });
  const saved = await loadSettings(db, user.id);
  assert.deepEqual([saved.orchestration.maxMinutes, saved.orchestration.maxTurns], [60, 40], "kept as saved, so an older API still reads them");
  assert.deepEqual(runLimits(saved.orchestration), { maxMinutes: null, maxTurns: null });
  // The owner sets 60 minutes themselves, then clears it.
  await saveSettings(db, user.id, { orchestration: { maxMinutes: 60, ownLimits: ["maxMinutes"] } });
  assert.deepEqual(runLimits((await loadSettings(db, user.id)).orchestration), { maxMinutes: 60, maxTurns: null });
  await saveSettings(db, user.id, { orchestration: { maxMinutes: null } });
  assert.deepEqual(runLimits((await loadSettings(db, user.id)).orchestration), { maxMinutes: null, maxTurns: null });
  // Saving anything else writes no null in their place.
  const other = await h.asUser();
  await saveSettings(db, other.id, { orchestration: { maxConcurrentJobs: 2 } });
  const row = await db.preference.findFirstOrThrow({ where: { userId: other.id, key: "hub.settings" } });
  const orchestration = (row.value as { orchestration: { maxMinutes: unknown; maxTurns: unknown } }).orchestration;
  assert.deepEqual([orchestration.maxMinutes, orchestration.maxTurns], [60, 40]);
});
