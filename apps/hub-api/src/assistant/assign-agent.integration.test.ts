/**
 * “@task:Clone a repo — do this on my machine”: the assistant assigns the task to an agent under
 * the person's default run profile (or the one they name), on their paired computer.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("the assistant applies a profile's saved place and exposes it in agent options; explicit assignments still win", async () => {
  const { task, ctx, laptop } = await setup();
  const profile = { ...ctx.settings.runProfiles[0]!, place: { kind: "folder" as const, label: "Papers" } };
  ctx.settings = { ...ctx.settings, runProfiles: [profile], defaultRunProfileId: profile.id };
  const tool = getTool("hub_assign_to_agent")!;
  const input = await tool.prepare!(ctx, tool.input.parse({ taskId: task.id }));
  assert.match(await tool.preview!(ctx, input), /in its “Papers” folder/);
  const result = await tool.run(ctx, input);
  const job = await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: (result.data as { jobId: string }).jobId } });
  assert.deepEqual([job.folderLabel, job.deviceId, job.externalRoot], ["Papers", laptop.id, null]);
  assert.equal((job.context as { folderInPlace?: boolean }).folderInPlace, true);
  const listed = (await getTool("hub_list_agent_options")!.run(ctx, {})).data as { profiles: Array<{ place: unknown; placeSummary: string }> };
  assert.deepEqual(listed.profiles[0]?.place, { kind: "folder", label: "Papers" });
  assert.match(listed.profiles[0]!.placeSummary, /^Papers on /);
  const { plan } = await import("./tools/agent-assign.js");
  assert.equal((await plan(ctx, { taskId: task.id, repoUrl: "fieldnote/app" })).body.place, undefined);
  assert.equal((await plan(ctx, { taskId: task.id, folder: "Papers" })).body.place, undefined);
  assert.deepEqual((await plan(ctx, { taskId: task.id, place: "checkout" })).body.place, { kind: "checkout" });
});

test("offline, unpaired and no-longer-shared profile places fail at preview and the assignment API without a fallback", async () => {
  const { task, ctx, laptop, user } = await setup();
  const place = { kind: "folder" as const, label: "Papers" };
  const profile = { ...ctx.settings.runProfiles[0]!, place };
  ctx.settings = { ...ctx.settings, runProfiles: [profile] };
  const tool = getTool("hub_assign_to_agent")!;
  const assign = () => user.inject({ method: "POST", url: "/api/agent/assign", payload: { taskId: task.id, deviceId: laptop.id, engine: "claude-code", place } });
  for (const [data, message] of [
    [{ lastSeenAt: null }, /is offline/],
    [{ lastSeenAt: new Date(), capabilities: { folders: [] } }, /no longer shares “Papers”/],
    [{ revokedAt: new Date() }, /no longer paired/],
  ] as const) {
    await h.prisma.device.update({ where: { id: laptop.id }, data });
    await assert.rejects(() => tool.prepare!(ctx, tool.input.parse({ taskId: task.id })), message);
    const response = await assign();
    assert.ok(response.statusCode >= 400, response.body);
    assert.match(response.body, message);
  }
  assert.equal(await h.prisma.workspaceJob.count({ where: { taskId: task.id } }), 0);
});

test("the picker trusts and shares a new folder once, keeps label collisions apart and preserves an existing read-only grant", async () => {
  const { user } = await setup();
  const root = await mkdtemp(join(tmpdir(), "ensemble-run-place-"));
  const before = process.env.ENSEMBLE_REMOTE_STATE_DIR;
  process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "remote");
  try {
    const { trustFolder } = await import("../lib/code-browse.js");
    const { loadSettings: remote, updateSettings: updateRemote } = await import("../remote/store.js");
    const first = join(root, "one", "notes");
    const second = join(root, "two", "notes");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const one = await trustFolder(h.prisma, user.id, first, false, true);
    const again = await trustFolder(h.prisma, user.id, first, false, true);
    const two = await trustFolder(h.prisma, user.id, second, false, true);
    assert.deepEqual([one.label, again.label, two.label], ["notes", "notes", "notes-2"]);
    assert.equal(remote().folders.length, 2);
    assert.ok((await loadSettings(h.prisma, user.id)).code.roots.includes(first));
    updateRemote({ folders: [{ label: "read-only", path: first, kind: "folder", access: "review" }] });
    const limited = await trustFolder(h.prisma, user.id, first, false, true);
    assert.equal(limited.label, "read-only");
    assert.deepEqual(remote().folders, [{ label: "read-only", path: first, kind: "folder", access: "review" }]);
  } finally {
    if (before === undefined) delete process.env.ENSEMBLE_REMOTE_STATE_DIR;
    else process.env.ENSEMBLE_REMOTE_STATE_DIR = before;
    await rm(root, { recursive: true, force: true });
  }
});

test("a folder shared through the Code relay is available for assignment immediately, without waiting for a heartbeat", async () => {
  const { user, laptop, task } = await setup();
  await h.prisma.device.update({ where: { id: laptop.id }, data: { capabilities: { code: true, codeApi: 7, folders: [] } } });
  const { sseHub } = await import("../lib/sse.js");
  const { storeAnswer } = await import("../devices/file-relay.js");
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${laptop.id}` || frame.event !== "code.request") return;
    const request = frame.data as { id: string };
    void storeAnswer(h.app.redis, laptop.id, request.id, { status: 200, body: { path: "/work/live-test", added: true, label: "live-test", folders: [{ label: "live-test", kind: "folder", access: "read-write" }] } });
  });
  try {
    const response = await user.inject({ method: "POST", url: `/api/devices/${laptop.id}/code`, headers: { origin: process.env.HUB_WEB_ORIGIN ?? "http://localhost:3000" }, payload: { method: "POST", path: "/api/code/folders/trust", body: { path: "/work/live-test", share: true } } });
    assert.equal(response.statusCode, 200, response.body);
    const assigned = await user.inject({ method: "POST", url: "/api/agent/assign", payload: { taskId: task.id, engine: "claude-code", deviceId: laptop.id, place: { kind: "folder", label: "live-test" } } });
    assert.equal(assigned.statusCode, 201, assigned.body);
    assert.equal((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: assigned.json().jobId } })).folderLabel, "live-test");
  } finally { stop(); }
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
  // A run in its project's folder (agent-projects.ts) shows that folder, as its computer reported it; one in Ensemble's own checkout says so.
  assert.equal(claude.folder, "its own checkout");
  await h.prisma.workspaceEvent.create({ data: { jobId: codex.id, kind: "prepared", data: { root: "~/ensemble-workspace/projects/atlas-search", git: true } } });
  assert.equal((await listSessions(h.prisma, scope))[0]!.folder, "projects/atlas-search");
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

test("the sandbox is in beta and off by default: Antigravity from the assistant gets a job its computer runs without one", async () => {
  const { planLocalJob, isRefusal } = await import("../remote/policy.js");
  const { sandboxFor } = await import("../workspace/assign.js");
  const user = await h.asUser();
  const key = await h.asToken(user, "device");
  const agent = { id: "antigravity", via: "cli", version: "1", signedIn: true, models: [], checkedAt: new Date().toISOString() };
  const box = await h.prisma.device.create({ data: { userId: user.id, tokenId: key.id, name: "Home server", platform: "linux", lastSeenAt: new Date(), capabilities: { folders: [], engines: ["antigravity"], agents: [agent] } } });
  const task = await h.prisma.task.create({ data: { userId: user.id, title: "Antigravity note", boardOrder: 0, createdBy: "me" } });
  // Nothing saved: the new defaults, and the built-in Quick profile with them.
  const settings = await loadSettings(h.prisma, user.id);
  assert.equal(settings.orchestration.defaultExecution, "native");
  const ctx: ToolContext = { app, prisma: h.prisma, userId: user.id, actor: "agent", settings };
  const tool = getTool("hub_assign_to_agent")!;
  const input = await tool.prepare!(ctx, tool.input.parse({ taskId: task.id, agent: "antigravity", computer: "Home server", instructions: "Write the note." }));
  assert.match(await tool.preview!(ctx, input), /on Home server · profile Quick: Review only, may commit and push, sandbox off/);
  const batch = await applyHeldCalls(app, ctx, [{ tool, input }]);
  assert.ok(batch.outcomes[0]!.ok, JSON.stringify(batch.outcomes[0]));
  const job = await h.prisma.workspaceJob.findFirstOrThrow({ where: { taskId: task.id } });
  assert.deepEqual([job.provider, job.deviceId, job.executionMode], ["antigravity", box.id, "native"]);

  // The computer takes it with the sandbox off, so it makes a run without one (the ACP runner stops a sandboxed one at once).
  const claim = await key.inject({ method: "POST", url: "/api/devices/self/claim", payload: {} });
  assert.equal(claim.statusCode, 200, claim.body);
  const spec = claim.json() as import("../remote/contract.js").JobSpec;
  assert.deepEqual([spec.id, spec.provider, spec.sandbox], [job.id, "antigravity", false]);
  const web: import("../remote/store.js").RemoteSettings = { version: 1, enabled: true, acceptWebApprovals: true, browseFiles: true, webEdit: true, webTerminal: true, evidenceUpload: true, captureSites: { never: [], preview: [] }, askBeforeBrowsing: false, apiBase: null, deviceId: box.id, deviceName: "Home server", pairedAt: null, folders: [], disconnected: null, unreachable: null, installId: "", secretsMode: "all" };
  const local = planLocalJob(spec, web, () => null);
  assert.ok(!isRefusal(local), JSON.stringify(local));
  if (!isRefusal(local)) {
    assert.deepEqual([local.assign.engine, local.assign.sandbox], ["antigravity", false]);
    assert.equal(sandboxFor(local.assign, Settings.parse({}).orchestration, false), false, "the run on the computer is made without the sandbox");
  }
});

test("a request that leaves the sandbox out follows Sandbox by default; a server whose own runner runs code keeps it on", async () => {
  const { sandboxFor } = await import("../workspace/assign.js");
  const user = await h.asUser();
  const key = await h.asToken(user, "device");
  const laptop = await h.prisma.device.create({ data: { userId: user.id, tokenId: key.id, name: "Laptop", platform: "macos", lastSeenAt: new Date(), capabilities: { folders: [] } } });
  const assign = async (title: string, extra: Record<string, unknown> = {}) => {
    const task = await h.prisma.task.create({ data: { userId: user.id, title, boardOrder: 0, createdBy: "me" } });
    const response = await user.inject({ method: "POST", url: "/api/agent/assign", payload: { taskId: task.id, engine: "claude-code", deviceId: laptop.id, instructions: "Tidy the README.", ...extra } });
    assert.equal(response.statusCode, 201, response.body);
    return (await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: (response.json() as { jobId: string }).jobId } })).executionMode;
  };
  assert.equal(await assign("Nothing said"), "native", "every caller that leaves it out: off");
  assert.equal(await assign("Asked for it", { sandbox: true }), "sandbox");
  // The person turns the beta on in Settings: requests that leave it out follow.
  await saveSettings(h.prisma, user.id, { orchestration: { defaultExecution: "sandbox" } });
  assert.equal(await assign("Beta on"), "sandbox");
  assert.equal(await assign("Turned off for this run", { sandbox: false }), "native");

  const off = { defaultExecution: "native" };
  assert.equal(sandboxFor({}, off, true), true, "a run on a server's own runner keeps its isolation");
  assert.equal(sandboxFor({ sandbox: false }, off, true), false, "unless the request turns it off");
  assert.equal(sandboxFor({ deviceId: laptop.id }, off, true), false, "a run for a paired computer follows Sandbox by default");
  assert.equal(sandboxFor({}, off, false), false, "the person's own runtime: off");
  assert.equal(sandboxFor({}, { defaultExecution: "sandbox" }, false), true);
});
