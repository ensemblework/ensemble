/**
 * Agent projects, choosing a session and session clean-up (docs/30) against an in-memory database: a
 * project's folder kept by the projects index and its brief kept current by hash, never through a link;
 * choosing a session on the computer (a link or shared files continue one; never across projects, not when
 * too full or when a new one is asked for); the claim carrying what the computer chooses with and its report
 * linking the run on the web; and the sweep deleting only sessions whose tasks are all retired.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";

const h = await createHttpHarness();
const db = h.prisma;
const { projectBrief, projectFolder, syncProjectFiles } = await import("./agent-projects.js");
const { sweepAgentSessions } = await import("./session-cleanup.js");
const { chooseSession } = await import("./session-choice/choose.js");
const { factsOf } = await import("./session-choice/related.js");
const { DEFAULT_SESSION_CHOICE } = await import("./session-choice/config.js");
const scratch = await mkdtemp(join(tmpdir(), "ensemble-agent-projects-"));
after(async () => {
  await h.close();
  await rm(scratch, { recursive: true, force: true });
});
const DAY = 86_400_000;

async function laptopFor(user: HttpUser, online = true) {
  const key = await h.asToken(user, "device");
  return db.device.create({
    data: { userId: user.id, name: "Laptop", platform: "linux", appVersion: "cli-0.7.3", tokenId: key.id, capabilities: { engines: ["claude-code", "codex"], sessions: 1, sessionDelete: 1 } as never, lastSeenAt: online ? new Date() : new Date(Date.now() - DAY) },
  });
}

/** A finished Claude Code run of the task on the laptop, with the agent's session id recorded. */
async function ranOn(userId: string, taskId: string, deviceId: string | null, options: { continueFrom?: string; at?: Date; provider?: string } = {}) {
  const at = options.at ?? new Date();
  const job = await db.workspaceJob.create({
    data: { userId, taskId, kind: "code", status: "succeeded", executionMode: "sandbox", provider: options.provider ?? "claude-code", model: "default", deviceId, continueFromJobId: options.continueFrom ?? null, startedAt: at, claimedAt: at, finishedAt: at, createdAt: at, summary: "Done." },
  });
  await db.workspaceEvent.create({ data: { jobId: job.id, kind: "engine", data: { session: randomUUID() } } });
  return job;
}

test("a project's folder is kept by the index and its brief is rewritten only when the project changed, never through a link", async () => {
  const user = await h.asUser();
  const project = await db.project.create({ data: { userId: user.id, name: "Atlas Search", summary: "Ranking for the new search.", createdBy: "me" } });
  const person = await db.person.create({ data: { userId: user.id, name: "Mira Chen" } });
  await db.projectPerson.create({ data: { projectId: project.id, personId: person.id, role: "Lead" } });
  const brief = (await projectBrief(db, user.id, project.id))!;
  assert.match(brief.brief, /# Atlas Search[\s\S]*Ranking for the new search[\s\S]*Mira Chen: Lead/);

  const workspace = join(scratch, "ws1");
  const folder = await projectFolder(workspace, brief);
  assert.equal(folder, join(workspace, "projects", "atlas-search"));
  await mkdir(join(folder, ".git", "info"), { recursive: true });
  await writeFile(join(folder, "AGENTS.md"), "# House rules\nUse tabs.\n");
  assert.deepEqual(await syncProjectFiles(workspace, folder, brief), { changed: false }, "the first brief is not a change");
  const agents = await readFile(join(folder, "AGENTS.md"), "utf8");
  assert.match(agents, /Ranking for the new search[\s\S]*# House rules\nUse tabs/, "the folder's own text stays under Ensemble's block");
  assert.equal((await readFile(join(folder, "CLAUDE.md"), "utf8")).trim(), "@AGENTS.md");
  const exclude = await readFile(join(folder, ".git", "info", "exclude"), "utf8");
  for (const name of ["/AGENTS.md", "/CLAUDE.md", "/GEMINI.md"]) assert.ok(exclude.split("\n").includes(name), `${name} is kept out of git`);

  await db.project.update({ where: { id: project.id }, data: { name: "Atlas", summary: "Ranking and recall for search." } });
  const renamed = (await projectBrief(db, user.id, project.id))!;
  assert.notEqual(renamed.hash, brief.hash);
  assert.equal(await projectFolder(workspace, renamed), folder, "a renamed project keeps its folder (and its agents' sessions)");
  assert.deepEqual(await syncProjectFiles(workspace, folder, renamed), { changed: true });
  const updated = await readFile(join(folder, "AGENTS.md"), "utf8");
  assert.match(updated, /Ranking and recall/);
  assert.doesNotMatch(updated, /Ranking for the new search/);
  assert.equal(updated.match(/ensemble:project —/g)?.length, 1, "one block, replaced in place");
  assert.equal(JSON.parse(await readFile(join(workspace, "projects", ".ensemble-projects.json"), "utf8"))[project.id].hash, renamed.hash);
  assert.deepEqual(await syncProjectFiles(workspace, folder, renamed), { changed: false });

  // A run in the folder links the project files to files outside it: Ensemble replaces the links, never writes through them.
  const outside = join(scratch, "dotfile");
  await writeFile(outside, "export SAFE=1\n");
  await rm(join(folder, "AGENTS.md"));
  await symlink(outside, join(folder, "AGENTS.md"));
  await rm(join(folder, "CLAUDE.md"));
  await symlink(outside, join(folder, "CLAUDE.md"));
  await db.project.update({ where: { id: project.id }, data: { summary: "Changed again." } });
  await syncProjectFiles(workspace, folder, (await projectBrief(db, user.id, project.id))!);
  assert.equal(await readFile(outside, "utf8"), "export SAFE=1\n", "the file outside is untouched");
  assert.ok(!(await lstat(join(folder, "AGENTS.md"))).isSymbolicLink() && !(await lstat(join(folder, "CLAUDE.md"))).isSymbolicLink());
  assert.match(await readFile(join(folder, "AGENTS.md"), "utf8"), /Changed again\./);
  await assert.rejects(syncProjectFiles(workspace, join(workspace, "projects"), renamed), "only the project's own folder");

  const other = await db.project.create({ data: { userId: user.id, name: "Atlas Search", createdBy: "me" } });
  assert.equal(await projectFolder(workspace, (await projectBrief(db, user.id, other.id))!), join(workspace, "projects", `atlas-search-${other.id.slice(0, 8)}`), "another project with the name gets its own folder");
});

test("on the computer, a new run continues the session that fits it: a link, shared files; never across projects or when too full", async () => {
  const user = await h.asUser();
  const scope = { space: user.id, runner: null };
  const config = DEFAULT_SESSION_CHOICE;
  const atlas = await db.project.create({ data: { userId: user.id, name: "Atlas", createdBy: "me" } });
  const other = await db.project.create({ data: { userId: user.id, name: "Other", createdBy: "me" } });
  const b = await db.task.create({ data: { userId: user.id, title: "Build the ranking API", description: "BM25 scoring for search results.", status: "done", completedAt: new Date(), createdBy: "me", projectId: atlas.id } });
  const first = await ranOn(user.id, b.id, null, { at: new Date(Date.now() - 2 * DAY) });
  await db.workspaceJob.update({ where: { id: first.id }, data: { summary: "Built the ranking API with BM25: rankResults in src/ranking/api.ts.", evidence: { files: [{ path: "src/ranking/api.ts" }, { path: "package.json" }] } } });
  const choose = async (taskId: string, extra: { newSession?: boolean } = {}) => {
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    return chooseSession(db, scope, { task: { facts: (await factsOf(db, user.id, taskId, "", { space: "local", runner: null }))!, title: task.title, description: task.description, notes: task.notes, instructions: "" }, engine: "claude-code", config, ...extra });
  };

  const a = await db.task.create({ data: { userId: user.id, title: "Add paging", description: `Page the results of ensemble://task/${b.id}.`, createdBy: "me", projectId: atlas.id } });
  const linked = await choose(a.id);
  assert.equal(linked.decision, "continue");
  assert.equal(linked.band, "confident");
  assert.equal(linked.session?.id, first.id);
  assert.equal(linked.why, "it links to “Build the ranking API”");
  const candidate = (linked.record.candidates as Array<{ sessionId: string; parts: Record<string, number>; signals: { link: string } }>)[0]!;
  assert.equal(candidate.sessionId, first.id);
  assert.equal(candidate.signals.link, "link");
  assert.equal(candidate.parts.link, 10, "every candidate's signals and parts are kept for calibration");
  assert.match(linked.record.configHash as string, /^[a-f0-9]{12}$/);

  const c = await db.task.create({ data: { userId: user.id, title: "Fix the page size of rankResults in src/ranking/api.ts", createdBy: "me", projectId: atlas.id } });
  const anchored = await choose(c.id);
  assert.equal(anchored.decision, "continue", "a task naming the file and code the session changed continues it");
  assert.equal(anchored.why, "like “Build the ranking API”: both name src/ranking/api.ts and rankResults");
  const one = await db.task.create({ data: { userId: user.id, title: "Tidy up src/ranking/api.ts", createdBy: "me", projectId: atlas.id } });
  const unsure = await choose(one.id);
  assert.equal(unsure.decision, "new", "one shared file alone is not enough");
  assert.equal(unsure.band, "unsure", "but it is recorded as a near miss");

  const elsewhere = await db.task.create({ data: { userId: user.id, title: "Fix the page size in src/ranking/api.ts", description: `See ensemble://task/${b.id}`, createdBy: "me", projectId: other.id } });
  const crossed = await choose(elsewhere.id);
  assert.equal(crossed.decision, "new");
  assert.equal(crossed.record.candidates && (crossed.record.candidates as unknown[]).length, 0, "a session of another project is not even a candidate");

  const unrelated = await db.task.create({ data: { userId: user.id, title: "Write the quarterly budget memo", createdBy: "me", projectId: atlas.id } });
  const none = await choose(unrelated.id);
  assert.equal(none.decision, "new");
  assert.equal(none.band, "none");

  const fresh = await choose(a.id, { newSession: true });
  assert.equal(fresh.decision, "new");
  assert.equal(fresh.note, "new-session");
  assert.equal(fresh.band, "confident", "what it would have chosen is still recorded");

  // Runs claimed from one web space never match a task of another space, or this computer's own tasks.
  const claimedTask = await db.task.create({ data: { userId: user.id, title: "Ship the invoice export", createdBy: "me" } });
  const claimedRun = await ranOn(user.id, claimedTask.id, null);
  await db.workspaceJob.update({ where: { id: claimedRun.id }, data: { context: { origin: "web", hostedJobId: randomUUID(), taskFacts: { key: "web-task-1", space: "space-a", runner: null, projectId: null } } } });
  const fromSpace = (space: string) =>
    chooseSession(db, scope, { task: { facts: { key: "web-task-2", space, runner: null, projectId: null, deliverableId: null, meetingId: null, parentPageId: null, labels: [], named: [{ id: "web-task-1", reason: "mention" }] }, title: "Add CSV to the invoice export", description: "", notes: "", instructions: "" }, engine: "claude-code", config });
  assert.equal((await fromSpace("space-a")).session?.id, claimedRun.id, "the same space continues it");
  const otherSpace = await fromSpace("space-b");
  assert.equal(otherSpace.decision, "new", "another space never does");
  assert.equal((otherSpace.record.candidates as unknown[]).length, 0);
  const local = await db.task.create({ data: { userId: user.id, title: "Add CSV to the invoice export", description: "Mentions ensemble://task/web-task-1", createdBy: "me" } });
  assert.notEqual((await choose(local.id)).session?.id, claimedRun.id, "nor this computer's own tasks");
  await db.workspaceJob.update({ where: { id: claimedRun.id }, data: { status: "cancelled" } });

  await db.workspaceEvent.create({ data: { jobId: first.id, kind: "engine_context", data: { size: 200_000, used: 170_000 } } });
  const full = await choose(a.id);
  assert.equal(full.decision, "new");
  assert.equal(full.note, "too-full");
  assert.equal(full.handover?.title, "Build the ranking API");
});

test("a claim carries what the computer chooses with, and its report links the run to the session it continued", async () => {
  const user = await h.asUser();
  const key = await h.asToken(user, "device");
  const laptop = await db.device.create({ data: { userId: user.id, name: "Desk", platform: "linux", appVersion: "cli-0.7.4", tokenId: key.id, capabilities: { engines: ["claude-code"], sessions: 1 } as never, lastSeenAt: new Date() } });
  const project = await db.project.create({ data: { userId: user.id, name: "Atlas", createdBy: "me" } });
  const b = await db.task.create({ data: { userId: user.id, title: "Build the ranking API", status: "done", completedAt: new Date(), createdBy: "me", projectId: project.id } });
  const earlier = await ranOn(user.id, b.id, laptop.id);
  const a = await db.task.create({ data: { userId: user.id, title: "Add paging", description: `Follows ensemble://task/${b.id}`, createdBy: "me", projectId: project.id } });
  const claim = async (payload: Record<string, unknown> = {}) => {
    const assigned = await user.inject({ method: "POST", url: "/api/agent/assign", payload: { taskId: a.id, engine: "claude-code", deviceId: laptop.id, mode: "unattended", ...payload } });
    assert.equal(assigned.statusCode, 201, assigned.body);
    const claimed = await key.inject({ method: "POST", url: "/api/devices/self/claim" });
    assert.equal(claimed.statusCode, 200, claimed.body);
    return claimed.json() as { id: string; leaseToken: string; continueFromJobId: string | null; related?: { key: string; projectId: string; named: Array<{ id: string; reason: string }> }; sessionChoice?: { enabled: boolean; version: string }; newSession?: boolean };
  };
  const spec = await claim();
  assert.equal(spec.continueFromJobId, null, "the web leaves the session to the computer");
  assert.deepEqual(spec.related?.named, [{ id: b.id, reason: "link" }]);
  assert.equal(spec.related?.projectId, project.id);
  assert.equal((spec.related as { space?: string } | undefined)?.space, user.id, "the claim says whose records the task is");
  assert.equal(spec.sessionChoice?.enabled, true);
  assert.equal(spec.newSession, undefined);

  const report = (id: string, lease: string, continues: string) =>
    key.inject({
      method: "POST",
      url: `/api/devices/self/jobs/${id}/session-choice`,
      headers: { "x-ensemble-job-lease": lease },
      payload: { decision: "continue", band: "confident", continues, sessionId: continues, score: 11, title: "Build the ranking API", why: "it links to “Build the ranking API”", note: null, configVersion: "2026-11-09.1", configHash: "abcdef123456", candidates: [{ sessionId: continues, score: 11, parts: { link: 10, warm: 1 } }], elapsedMs: 40 },
    });
  const reported = await report(spec.id, spec.leaseToken, earlier.id);
  assert.equal(reported.statusCode, 200, reported.body);
  assert.equal(reported.json().continues, earlier.id);
  assert.equal((await db.workspaceJob.findUniqueOrThrow({ where: { id: spec.id } })).continueFromJobId, earlier.id, "the web's session has the run too");
  const row = await db.sessionChoice.findUniqueOrThrow({ where: { jobId: spec.id } });
  assert.equal(row.decision, "continue");
  assert.equal(row.deviceId, laptop.id);
  assert.equal(row.projectId, project.id);
  const detail = await user.inject({ method: "GET", url: `/api/agent/jobs/${spec.id}` });
  assert.equal(detail.json().job.sessionChoice.why, "it links to “Build the ranking API”");
  await db.workspaceJob.update({ where: { id: spec.id }, data: { status: "succeeded", finishedAt: new Date() } });

  // A run another account made is never linked, whatever the computer says.
  const stranger = await h.asUser();
  const theirs = await ranOn(stranger.id, (await db.task.create({ data: { userId: stranger.id, title: "Theirs", createdBy: "me" } })).id, null);
  const second = await claim();
  const refused = await report(second.id, second.leaseToken, theirs.id);
  assert.equal(refused.json().continues, null);
  assert.equal((await db.workspaceJob.findUniqueOrThrow({ where: { id: second.id } })).continueFromJobId, null);
  assert.equal((await db.sessionChoice.findUniqueOrThrow({ where: { jobId: second.id } })).note, "not-linked");
  await db.workspaceJob.update({ where: { id: second.id }, data: { status: "succeeded", finishedAt: new Date() } });

  const asked = await claim({ newSession: true });
  assert.equal(asked.newSession, true, "the person's new session goes with the claim");
  await db.workspaceJob.update({ where: { id: asked.id }, data: { status: "succeeded", finishedAt: new Date() } });
  assert.equal((await user.inject({ method: "PATCH", url: "/api/settings", payload: { orchestration: { linkedSessions: false } } })).statusCode, 200);
  const off = await claim();
  assert.equal(off.sessionChoice?.enabled, false, "the setting goes with the claim");
  await db.workspaceJob.update({ where: { id: off.id }, data: { status: "succeeded", finishedAt: new Date() } });
});

test("the sweep deletes a session only when every task in it is retired and its computer can delete it", async () => {
  const user = await h.asUser();
  const laptop = await laptopFor(user);
  const app = { prisma: db, log: { info: () => undefined } } as unknown as FastifyInstance;
  const old = new Date(Date.now() - 61 * DAY);
  const done = (title: string, extra: Record<string, unknown> = {}) => db.task.create({ data: { userId: user.id, title, status: "done", completedAt: old, createdBy: "me", ...extra } });

  const retired = await ranOn(user.id, (await done("Retired work")).id, laptop.id, { at: old });
  const shared = await ranOn(user.id, (await done("Finished part")).id, laptop.id, { at: old });
  await ranOn(user.id, (await db.task.create({ data: { userId: user.id, title: "Still open", createdBy: "me" } })).id, laptop.id, { continueFrom: shared.id });
  const pinned = await ranOn(user.id, (await done("Pinned work", { pinned: true })).id, laptop.id, { at: old });
  const justDeleted = await ranOn(user.id, (await db.task.create({ data: { userId: user.id, title: "Deleted a moment ago", createdBy: "me", deletedAt: new Date(Date.now() - 60_000) } })).id, laptop.id);
  const deleted = await ranOn(user.id, (await db.task.create({ data: { userId: user.id, title: "Deleted earlier", createdBy: "me", deletedAt: new Date(Date.now() - 30 * 60_000) } })).id, laptop.id);
  const recent = await ranOn(user.id, (await db.task.create({ data: { userId: user.id, title: "Done yesterday", status: "done", completedAt: new Date(Date.now() - DAY), createdBy: "me" } })).id, laptop.id);

  const removed: string[] = [];
  const result = await sweepAgentSessions(app, user.id, { completedDays: 60, remove: async (id) => removed.push(id) });
  assert.deepEqual(removed.sort(), [retired.id, deleted.id].sort());
  assert.ok(!removed.includes(shared.id), "a session with a task still open stays");
  assert.ok(!removed.includes(pinned.id) && !removed.includes(justDeleted.id) && !removed.includes(recent.id));
  assert.equal(result.deleted.length, 2);

  const later = (await db.workspaceJob.findUniqueOrThrow({ where: { id: shared.id } })).context as { sessionCleanup?: { nextAt?: number } };
  assert.ok((later.sessionCleanup?.nextAt ?? 0) > Date.now(), "a session still in use is not looked at again for a while");

  // A run that joins the session after the sweep looked is seen under the session's lock: nothing is deleted or cancelled.
  const joined = await ranOn(user.id, (await done("Retired, then picked up")).id, laptop.id, { at: old });
  const { deleteAgentSession } = await import("./delete-session.js");
  const raced = await sweepAgentSessions(h.app, user.id, {
    completedDays: 60,
    remove: async (id, guard) => {
      if (id !== joined.id) return;
      await db.workspaceJob.update({ where: { id: joined.id }, data: { status: "running" } });
      return deleteAgentSession(h.app, user.id, id, { actor: "system", reason: "retired", guard });
    },
  });
  assert.ok(!raced.deleted.includes(joined.id) && raced.waiting >= 1);
  const kept = await db.workspaceJob.findUniqueOrThrow({ where: { id: joined.id } });
  assert.equal(kept.status, "running", "the run that joined goes on");
  assert.equal((kept.context as { sessionDeletion?: unknown } | null)?.sessionDeletion, undefined);
  await db.workspaceJob.update({ where: { id: joined.id }, data: { status: "succeeded" } });

  await db.device.update({ where: { id: laptop.id }, data: { lastSeenAt: new Date(Date.now() - DAY) } });
  const offline: string[] = [];
  const waiting = await sweepAgentSessions(app, user.id, { completedDays: 60, remove: async (id) => offline.push(id) });
  assert.equal(offline.length, 0, "an offline computer's sessions wait, untouched");
  assert.ok(waiting.waiting >= 2);
  assert.equal(offline.length, 0);
});

test("a claim of a project's task by the person's own agent carries the project's brief for its folder", async () => {
  const user = await h.asUser();
  const key = await h.asToken(user, "device");
  const laptop = await db.device.create({ data: { userId: user.id, name: "Desk", platform: "linux", appVersion: "cli-0.7.3", tokenId: key.id, capabilities: { engines: ["claude-code"] } as never, lastSeenAt: new Date() } });
  const project = await db.project.create({ data: { userId: user.id, name: "Atlas", summary: "Search ranking.", createdBy: "me" } });
  const task = await db.task.create({ data: { userId: user.id, title: "Tune the ranking", createdBy: "me", projectId: project.id } });
  const assigned = await user.inject({ method: "POST", url: "/api/agent/assign", payload: { taskId: task.id, engine: "claude-code", deviceId: laptop.id, mode: "unattended" } });
  assert.equal(assigned.statusCode, 201, assigned.body);
  const claimed = await key.inject({ method: "POST", url: "/api/devices/self/claim" });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const spec = claimed.json() as { project?: { id: string; name: string; brief: string; hash: string } };
  assert.equal(spec.project?.id, project.id);
  assert.match(spec.project!.brief, /# Atlas\n\nSearch ranking\./);
  assert.match(spec.project!.hash, /^[a-f0-9]{16}$/);
  await db.workspaceJob.updateMany({ where: { userId: user.id }, data: { status: "cancelled", finishedAt: new Date() } });
});

test("a node's own session unused for a week is deleted though its task stays open; a recent one and a person's open task stay", async () => {
  const user = await h.asUser();
  const laptop = await laptopFor(user);
  const app = { prisma: db, log: { info: () => undefined } } as unknown as FastifyInstance;
  const { NODE_SESSION_IDLE_DAYS } = await import("./session-cleanup.js");
  const idle = new Date(Date.now() - (NODE_SESSION_IDLE_DAYS + 1) * DAY);
  const nodeTask = (title: string) => db.task.create({ data: { userId: user.id, title, createdBy: "agent", sourceRef: `node:${randomUUID()}` } });

  const stale = await ranOn(user.id, (await nodeTask("Node work last week")).id, laptop.id, { at: idle });
  const fresh = await ranOn(user.id, (await nodeTask("Node work this week")).id, laptop.id, { at: new Date(Date.now() - 2 * DAY) });
  const persons = await ranOn(user.id, (await db.task.create({ data: { userId: user.id, title: "My open work", createdBy: "me" } })).id, laptop.id, { at: idle });

  const removed: string[] = [];
  await sweepAgentSessions(app, user.id, { completedDays: 60, remove: async (id) => removed.push(id) });
  assert.ok(removed.includes(stale.id), "the node's idle session goes");
  assert.ok(!removed.includes(fresh.id), "used two days ago: kept");
  assert.ok(!removed.includes(persons.id), "the person's own open task keeps its session");
});

test("a run continuing a deleted session starts its own; a continued run whose session was gone is told apart", async () => {
  const user = await h.asUser();
  const scope = { space: user.id, runner: null };
  const { listSessions, resolveSession, runsOfSession } = await import("./sessions.js");
  const { sessionRestartOf, sessionToResume } = await import("./session-continuity.js");
  const task = (title: string) => db.task.create({ data: { userId: user.id, title, createdBy: "me" } });
  const engineOf = async (jobId: string) => ((await db.workspaceEvent.findFirstOrThrow({ where: { jobId, kind: "engine" } })).data as { session: string }).session;

  // Ensemble deleted the session (a person, or its clean-up): every run of it is marked so.
  const first = await ranOn(user.id, (await task("Build it")).id, null);
  const second = await ranOn(user.id, (await task("Fix it")).id, null, { continueFrom: first.id });
  for (const id of [first.id, second.id]) await db.workspaceJob.update({ where: { id }, data: { context: { sessionDeletion: { state: "deleted", at: new Date().toISOString() } } } });
  // Continue an earlier task (its folder) after that: a session of its own, never resuming the deleted one.
  const later = await db.workspaceJob.create({ data: { userId: user.id, taskId: (await task("Polish it")).id, kind: "code", status: "queued", executionMode: "sandbox", provider: "claude-code", model: "default", continueFromJobId: second.id } });
  assert.equal(await sessionToResume(db, later), null, "a deleted session is not tried");
  await db.workspaceJob.update({ where: { id: later.id }, data: { status: "succeeded", startedAt: new Date(), finishedAt: new Date() } });
  await db.workspaceEvent.create({ data: { jobId: later.id, kind: "engine", data: { session: randomUUID() } } });
  const own = await resolveSession(db, scope, later.id);
  assert.equal(own?.id, later.id, "it is the root of its own session");
  assert.ok((await listSessions(db, scope)).some((row) => row.id === later.id), "listed, so it can be chosen and cleaned up");
  assert.deepEqual((await runsOfSession(db, scope, first.id, true)).map((run) => run.id).sort(), [first.id, second.id].sort(), "the deleted session keeps only its own runs");
  assert.equal(await sessionRestartOf(db, later), "deleted");

  // The agent no longer had the session (deleted in its own app): the run started a new one under another id.
  const before = await ranOn(user.id, (await task("Draft the report")).id, null);
  const resumed = await ranOn(user.id, (await task("Add the charts")).id, null, { continueFrom: before.id });
  await db.workspaceEvent.updateMany({ where: { jobId: resumed.id, kind: "engine" }, data: { data: { session: await engineOf(before.id) } } });
  assert.equal(await sessionRestartOf(db, resumed), null, "the same session id: it was resumed");
  const restarted = await ranOn(user.id, (await task("Add the tables")).id, null, { continueFrom: resumed.id });
  assert.equal(await sessionRestartOf(db, restarted), "gone", "another session id: the agent had lost it");
  const response = await user.inject({ method: "GET", url: `/api/agent/jobs/${restarted.id}` });
  assert.equal(response.json().job.sessionRestart, "gone", "the task page says so");
  const other = await ranOn(user.id, (await task("Review it")).id, null, { continueFrom: before.id, provider: "codex" });
  assert.equal(await sessionRestartOf(db, other), null, "another agent never resumes it");
});

test("Copilot's saved sessions are looked up in its own home", async () => {
  const { copilotHasSession } = await import("../subscriptions/copilot.js");
  const home = await mkdtemp(join(tmpdir(), "copilot-home-"));
  const saved = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  try {
    assert.equal(await copilotHasSession("abc-1"), null, "a Copilot that keeps sessions elsewhere: unknown");
    await mkdir(join(home, "session-state", "abc-1"), { recursive: true });
    assert.equal(await copilotHasSession("abc-1"), true);
    assert.equal(await copilotHasSession("abc-2"), false);
    assert.equal(await copilotHasSession("../escape"), false);
  } finally {
    if (saved === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = saved;
    await rm(home, { recursive: true, force: true });
  }
});
