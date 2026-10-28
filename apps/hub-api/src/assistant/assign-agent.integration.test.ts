/**
 * “@task:Clone a repo — do this on my machine”: the assistant assigns the task to an agent under
 * the person's default run profile (or the one they name), on their paired computer.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createHttpHarness } from "../test/http.js";

const h = await createHttpHarness();
after(() => h.close());
const { Settings, RunProfile } = await import("@ensemble/shared-types");
const { getTool, toolModule } = await import("./registry.js");
const { applyHeldCalls } = await import("./apply.js");
const { holdsAssistantWrite } = await import("./agent.js");
const { saveSettings, loadSettings } = await import("../lib/settings.js");
const { sha256 } = await import("../lib/auth.js");
type ToolContext = import("./types.js").ToolContext;

const app = { prisma: h.prisma, log: { error() {}, info() {}, warn() {} } } as unknown as FastifyInstance;

async function computer(userId: string, name: string, seen: Date | null, folders: string[] = []) {
  const token = await h.prisma.apiToken.create({
    data: { userId, name: `Device · ${name}`, tokenHash: sha256(`ens_${randomBytes(8).toString("hex")}`), prefix: "ens_test", scope: "device" },
  });
  return h.prisma.device.create({ data: { userId, name, platform: "macos", tokenId: token.id, capabilities: { folders }, lastSeenAt: seen } });
}

async function setup() {
  const user = await h.asUser();
  const laptop = await computer(user.id, "Chinmay's MacBook Pro", new Date(), ["Papers"]);
  const office = await computer(user.id, "Office Mac", null);
  const careful = RunProfile.parse({ id: "careful", name: "Careful", engine: "claude-code", mode: "ask", delivery: "local", deviceId: laptop.id });
  const away = RunProfile.parse({ id: "away", name: "Away", engine: "codex", mode: "unattended", delivery: "commit", deviceId: office.id });
  const third = RunProfile.parse({ id: "third", name: "Research", kind: "research", engine: "ensemble" });
  await saveSettings(h.prisma, user.id, { runProfiles: [careful, away, third], defaultRunProfileId: "careful" });
  const task = await h.prisma.task.create({ data: { userId: user.id, title: "Clone a repo", boardOrder: 0, createdBy: "me" } });
  const settings = await loadSettings(h.prisma, user.id);
  const ctx: ToolContext = { app, prisma: h.prisma, userId: user.id, actor: "agent", settings };
  return { user, laptop, office, task, ctx };
}

test("with no profile named, the default profile's agent and computer get the task, after Apply", async () => {
  const { laptop, task, ctx } = await setup();
  const tool = getTool("hub_assign_to_agent");
  assert.ok(tool?.prepare && tool.preview);
  assert.equal(toolModule(tool), "workspace");
  assert.equal(holdsAssistantWrite("immediate", tool.name, false, tool.area, tool.alwaysHold), true, "starting work on a computer always waits for Apply");

  const input = await tool.prepare(ctx, tool.input.parse({ taskId: task.id, computer: "any", repoUrl: "https://github.com/MCG-NJU/SportsMOT.git", instructions: "Clone it and summarise the README on the task page." }));
  assert.equal((input as { profile: string }).profile, "careful");
  assert.equal((input as { computer: string }).computer, laptop.id);
  const preview = await tool.preview(ctx, input);
  assert.match(preview, /^Assign “Clone a repo” to Claude Code on Chinmay's MacBook Pro, in a fresh clone of https:\/\/github.com\/MCG-NJU\/SportsMOT.git · profile Careful: Ask/);

  const batch = await applyHeldCalls(app, ctx, [{ tool, input }]);
  assert.ok(batch.outcomes[0]!.ok, JSON.stringify(batch.outcomes[0]));
  const job = await h.prisma.workspaceJob.findFirstOrThrow({ where: { taskId: task.id } });
  assert.equal(job.deviceId, laptop.id);
  assert.equal(job.provider, "claude-code");
  assert.equal((await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).owner, "agent");
});

test("a named profile wins, a named computer wins over the profile's, and unknown names are refused with the real ones", async () => {
  const { laptop, office, task, ctx } = await setup();
  const tool = getTool("hub_assign_to_agent")!;
  const away = await tool.prepare!(ctx, tool.input.parse({ taskId: task.id, profile: "away profile" }));
  assert.equal((away as { profile: string }).profile, "away");
  assert.equal((away as { computer: string }).computer, office.id);
  assert.match(await tool.preview!(ctx, away), /to Codex on Office Mac \(offline now: it starts when that computer is back\) · profile Away: Run unattended/);

  const moved = await tool.prepare!(ctx, tool.input.parse({ taskId: task.id, profile: "Away", computer: "macbook" }));
  assert.equal((moved as { computer: string }).computer, laptop.id);

  await assert.rejects(() => tool.prepare!(ctx, tool.input.parse({ taskId: task.id, profile: "Turbo" })), /no run profile called “Turbo”.*“Careful”, “Away”, “Research”/);
  await assert.rejects(() => tool.prepare!(ctx, tool.input.parse({ taskId: task.id, computer: "Studio" })), /No paired computer is called “Studio”/);
  await assert.rejects(() => tool.prepare!(ctx, tool.input.parse({ taskId: task.id, folder: "Secrets" })), /no shared folder called “Secrets”.*“Papers”/);
});

test("the options list marks the default profile and the computers", async () => {
  const { ctx } = await setup();
  const list = getTool("hub_list_agent_options")!;
  const result = (await list.run(ctx, {})).data as { profiles: Array<{ name: string; default: boolean; computer: string | null }>; computers: Array<{ name: string; online: boolean; folders: string[] }> };
  assert.deepEqual(result.profiles.map((row) => [row.name, row.default]), [["Careful", true], ["Away", false], ["Research", false]]);
  assert.equal(result.profiles[0]!.computer, "Chinmay's MacBook Pro");
  assert.deepEqual(result.computers.map((row) => [row.name, row.online]), [["Chinmay's MacBook Pro", true], ["Office Mac", false]]);
});

test("without a marked default the first saved profile is the default, everywhere", () => {
  const first = RunProfile.parse({ id: "a", name: "First" });
  const second = RunProfile.parse({ id: "b", name: "Second" });
  const settings = Settings.parse({ runProfiles: [first, second] });
  const ctx = { settings } as ToolContext;
  return import("./tools/agent-assign.js").then(({ chooseProfile }) => {
    assert.equal(chooseProfile(ctx).id, "a");
    assert.equal(chooseProfile({ settings: Settings.parse({ runProfiles: [first, second], defaultRunProfileId: "b" }) } as ToolContext).id, "b");
    assert.equal(chooseProfile({ settings: Settings.parse({}) } as ToolContext).id, "quick");
  });
});

test("agent sessions: one agent's chain of continued runs is one session; the assistant lists them and assigns a task into one", async () => {
  const { user, laptop, task, ctx } = await setup();
  const { listSessions, resolveSession, summaryLine } = await import("../workspace/sessions.js");
  const second = await h.prisma.task.create({ data: { userId: user.id, title: "Rate-limit the login", boardOrder: 1, createdBy: "me" } });
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 27, 9, minutes));
  const run = (data: Record<string, unknown>) =>
    h.prisma.workspaceJob.create({ data: { userId: user.id, kind: "code", executionMode: "sandbox", deviceId: laptop.id, status: "succeeded", startedAt: at(0), claimedAt: at(0), finishedAt: at(5), ...data } as never });
  const first = await run({ taskId: task.id, provider: "claude-code", model: "claude-sonnet-5-5", summary: "Fixed the login form. Added two tests. Left the CSS alone.", createdAt: at(0) });
  const next = await run({ taskId: second.id, provider: "claude-code", model: "claude-sonnet-5-5", reasoningEffort: "high", context: { contextTier: "long_context" }, continueFromJobId: first.id, summary: "Added rate limiting to the login route.", createdAt: at(10), finishedAt: at(15) });
  const codex = await run({ taskId: second.id, provider: "codex", model: "default", continueFromJobId: next.id, status: "running", finishedAt: null, progress: "Running the tests", createdAt: at(20) });
  await run({ taskId: task.id, provider: "openai", model: "gpt-6-luna", summary: "Ensemble's own agent is not a session.", createdAt: at(30) });
  await h.prisma.workspaceEvent.createMany({ data: [first, next].map((job) => ({ jobId: job.id, kind: "engine", data: { engine: "claude-code", session: "claude-session-1" } })) });

  const scope = { space: user.id, runner: null };
  const sessions = await listSessions(h.prisma, scope);
  assert.deepEqual(sessions.map((row) => [row.id, row.agent, row.status, row.runs]), [[codex.id, "codex", "working", 1], [first.id, "claude-code", "idle", 2]], "a new agent starts a new session in the same folder");
  const claude = sessions[1]!;
  assert.deepEqual([claude.lastJobId, claude.title, claude.latestTask.title, claude.tasks, claude.resumable, claude.computer], [next.id, "Clone a repo", "Rate-limit the login", 2, true, "Chinmay's MacBook Pro"]);
  assert.equal(claude.summary, "Added rate limiting to the login route.");
  assert.equal(sessions[0]!.summary, "Running the tests");
  assert.equal(summaryLine("Fixed the login form. Added two tests. Left the CSS alone."), "Fixed the login form. Added two tests.");
  assert.deepEqual((await listSessions(h.prisma, scope, { query: "rate limiting" })).map((row) => row.id), [first.id]);
  assert.equal((await resolveSession(h.prisma, scope, next.id))?.id, first.id, "any run in it finds its session");
  assert.equal(await resolveSession(h.prisma, { space: user.id, runner: "someone-else" }, first.id), null);

  const listed = (await getTool("hub_list_agent_sessions")!.run(ctx, { limit: 5 })).data as { sessions: Array<{ id: string; agent: string; summary: string; status: string }> };
  assert.deepEqual(listed.sessions.map((row) => [row.agent, row.status]), [["Codex", "working"], ["Claude Code", "idle"]]);

  // Into the Claude session: its agent, computer and model, continuing its latest run, whatever the profile says.
  const third = await h.prisma.task.create({ data: { userId: user.id, title: "Add a lockout email", boardOrder: 2, createdBy: "me" } });
  const tool = getTool("hub_assign_to_agent")!;
  const input = await tool.prepare!(ctx, tool.input.parse({ taskId: third.id, profile: "away", session: first.id }));
  assert.match(await tool.preview!(ctx, input), /to Claude Code on Chinmay's MacBook Pro, in its session “Clone a repo” \(its own checkout\)/);
  const batch = await applyHeldCalls(app, ctx, [{ tool, input }]);
  assert.ok(batch.outcomes[0]!.ok, JSON.stringify(batch.outcomes[0]));
  const job = await h.prisma.workspaceJob.findFirstOrThrow({ where: { taskId: third.id } });
  assert.deepEqual([job.provider, job.model, job.continueFromJobId, job.deviceId, job.kind], ["claude-code", "claude-sonnet-5-5", next.id, laptop.id, "code"]);
  assert.equal((await resolveSession(h.prisma, scope, job.id))?.lastJobId, job.id, "the new task is the session's latest run");
  await assert.rejects(() => tool.prepare!(ctx, tool.input.parse({ taskId: third.id, session: "00000000-0000-4000-8000-000000000000" })), /not one of theirs/);

  // The same agent's profile keeps its model to itself; a model the person names wins.
  const opus = { ...ctx, settings: { ...ctx.settings, runProfiles: ctx.settings.runProfiles.map((row) => (row.id === "careful" ? { ...row, model: "claude-opus-5-5", effort: "high" as const } : row)) } };
  const assignInto = async (context: ToolContext, title: string, extra: Record<string, unknown> = {}) => {
    const into = await h.prisma.task.create({ data: { userId: user.id, title, boardOrder: 3, createdBy: "me" } });
    const held = await tool.prepare!(context, tool.input.parse({ taskId: into.id, session: first.id, ...extra }));
    const outcome = (await applyHeldCalls(app, context, [{ tool, input: held }])).outcomes[0]!;
    assert.ok(outcome.ok, JSON.stringify(outcome));
    return { held, job: await h.prisma.workspaceJob.findFirstOrThrow({ where: { taskId: into.id } }) };
  };
  const kept = (await assignInto(opus, "Keep the model")).job;
  assert.deepEqual([kept.model, kept.reasoningEffort, (kept.context as { contextTier?: string }).contextTier], ["claude-sonnet-5-5", "high", "long_context"], "the session's model and tuning stay, not the profile's");
  assert.equal((await assignInto(opus, "Name a model", { model: "claude-haiku-4-5" })).job.model, "claude-haiku-4-5");

  // A computer paired again: the session moves to its current pairing.
  await h.prisma.device.update({ where: { id: laptop.id }, data: { revokedAt: new Date() } });
  const repaired = await computer(user.id, "Chinmay's MacBook Pro", new Date(), ["Papers"]);
  const moved = (await listSessions(h.prisma, scope, { deviceIds: [repaired.id] })).map((row) => [row.id, row.deviceId]);
  assert.deepEqual(moved, [[first.id, repaired.id], [codex.id, repaired.id]]);
  const again = await assignInto(ctx, "After pairing again");
  assert.match(await tool.preview!(ctx, again.held), /to Claude Code on Chinmay's MacBook Pro, in its session/);
  assert.equal(again.job.deviceId, repaired.id);

  // A chain whose first run never started (cancelled while queued, then run again) is still found by its id.
  const never = await run({ taskId: third.id, provider: "gemini-cli", model: "default", status: "cancelled", startedAt: null, claimedAt: null, finishedAt: at(40), createdAt: at(40) });
  const retried = await run({ taskId: third.id, provider: "gemini-cli", model: "default", continueFromJobId: never.id, deviceId: repaired.id, createdAt: at(41), finishedAt: at(45) });
  const gemini = (await listSessions(h.prisma, scope)).find((row) => row.agent === "gemini-cli");
  assert.equal(gemini?.id, never.id);
  assert.equal((await resolveSession(h.prisma, scope, never.id))?.lastJobId, retried.id);
});
