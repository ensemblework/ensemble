/**
 * Agent projects, linked sessions and session clean-up (docs/30, Agent projects, Linked sessions and Cleaning up sessions) against an in-memory database:
 * a project's folder found by its marker and its brief kept current by hash; a task that depends on
 * or mentions another continues that task's session with the same agent, never across projects and
 * not when a new session is asked for; and the sweep deleting only sessions whose tasks are all retired.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";

const h = await createHttpHarness();
const db = h.prisma;
const { projectBrief, projectFolder, syncProjectFiles, PROJECT_MARKER } = await import("./agent-projects.js");
const { sweepAgentSessions } = await import("./session-cleanup.js");
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
async function ranOn(userId: string, taskId: string, deviceId: string, options: { continueFrom?: string; at?: Date; provider?: string } = {}) {
  const at = options.at ?? new Date();
  const job = await db.workspaceJob.create({
    data: { userId, taskId, kind: "code", status: "succeeded", executionMode: "sandbox", provider: options.provider ?? "claude-code", model: "default", deviceId, continueFromJobId: options.continueFrom ?? null, startedAt: at, claimedAt: at, finishedAt: at, createdAt: at, summary: "Done." },
  });
  await db.workspaceEvent.create({ data: { jobId: job.id, kind: "engine", data: { session: randomUUID() } } });
  return job;
}

test("a project's folder is found by its marker and its brief is rewritten only when the project changed", async () => {
  const user = await h.asUser();
  const project = await db.project.create({ data: { userId: user.id, name: "Atlas Search", summary: "Ranking for the new search.", createdBy: "me" } });
  const person = await db.person.create({ data: { userId: user.id, name: "Mira Chen" } });
  await db.projectPerson.create({ data: { projectId: project.id, personId: person.id, role: "Lead" } });
  const brief = (await projectBrief(db, user.id, project.id))!;
  assert.match(brief.brief, /# Atlas Search[\s\S]*Ranking for the new search[\s\S]*Mira Chen — Lead/);

  const workspace = join(scratch, "ws1");
  const folder = await projectFolder(workspace, brief);
  assert.equal(folder, join(workspace, "projects", "atlas-search"));
  await mkdir(join(folder, ".git", "info"), { recursive: true });
  await writeFile(join(folder, "AGENTS.md"), "# House rules\nUse tabs.\n");
  assert.deepEqual(await syncProjectFiles(folder, brief), { changed: false }, "the first brief is not a change");
  const agents = await readFile(join(folder, "AGENTS.md"), "utf8");
  assert.match(agents, /Ranking for the new search[\s\S]*# House rules\nUse tabs/, "the folder's own text stays under Ensemble's block");
  assert.equal((await readFile(join(folder, "CLAUDE.md"), "utf8")).trim(), "@AGENTS.md");
  const exclude = await readFile(join(folder, ".git", "info", "exclude"), "utf8");
  for (const name of ["/.ensemble-project.json", "/AGENTS.md", "/CLAUDE.md", "/GEMINI.md"]) assert.ok(exclude.split("\n").includes(name), `${name} is kept out of git`);

  await db.project.update({ where: { id: project.id }, data: { name: "Atlas", summary: "Ranking and recall for search." } });
  const renamed = (await projectBrief(db, user.id, project.id))!;
  assert.notEqual(renamed.hash, brief.hash);
  assert.equal(await projectFolder(workspace, renamed), folder, "a renamed project keeps its folder (and its agents' sessions)");
  assert.deepEqual(await syncProjectFiles(folder, renamed), { changed: true });
  const updated = await readFile(join(folder, "AGENTS.md"), "utf8");
  assert.match(updated, /Ranking and recall/);
  assert.doesNotMatch(updated, /Ranking for the new search/);
  assert.equal(updated.match(/ensemble:project —/g)?.length, 1, "one block, replaced in place");
  assert.equal(JSON.parse(await readFile(join(folder, PROJECT_MARKER), "utf8")).hash, renamed.hash);
  assert.deepEqual(await syncProjectFiles(folder, renamed), { changed: false });

  const other = await db.project.create({ data: { userId: user.id, name: "Atlas Search", createdBy: "me" } });
  assert.equal(await projectFolder(workspace, (await projectBrief(db, user.id, other.id))!), join(workspace, "projects", `atlas-search-${other.id.slice(0, 8)}`), "another project with the name gets its own folder");
});

test("a task that depends on or mentions another continues its session with the same agent, within one project", async () => {
  const user = await h.asUser();
  const laptop = await laptopFor(user);
  const atlas = await db.project.create({ data: { userId: user.id, name: "Atlas", createdBy: "me" } });
  const other = await db.project.create({ data: { userId: user.id, name: "Other", createdBy: "me" } });
  const b = await db.task.create({ data: { userId: user.id, title: "Build the ranking API", status: "done", completedAt: new Date(), createdBy: "me", projectId: atlas.id } });
  const first = await ranOn(user.id, b.id, laptop.id, { at: new Date(Date.now() - 2 * DAY) });

  const a = await db.task.create({ data: { userId: user.id, title: "Add paging to the ranking API", createdBy: "me", projectId: atlas.id, dependsOn: [b.id] } });
  const preview = await user.inject({ method: "GET", url: `/api/agent/linked-session?taskId=${a.id}&engine=claude-code&deviceId=${laptop.id}` });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().linked.sessionId, first.id);
  assert.equal(preview.json().linked.why, "This task depends on “Build the ranking API”");

  const assigned = await user.inject({ method: "POST", url: "/api/agent/assign", payload: { taskId: a.id, engine: "claude-code", deviceId: laptop.id, mode: "unattended" } });
  assert.equal(assigned.statusCode, 201, assigned.body);
  const job = await db.workspaceJob.findUniqueOrThrow({ where: { id: assigned.json().jobId } });
  assert.equal(job.continueFromJobId, first.id, "the run continues the linked session");
  assert.equal((job.context as { linkedSession?: { taskId?: string; reason?: string } }).linkedSession?.taskId, b.id);
  await db.workspaceJob.update({ where: { id: job.id }, data: { status: "cancelled", finishedAt: new Date() } });

  const fresh = await user.inject({ method: "POST", url: "/api/agent/assign", payload: { taskId: a.id, engine: "claude-code", deviceId: laptop.id, mode: "unattended", newSession: true } });
  assert.equal(fresh.statusCode, 201, fresh.body);
  assert.equal((await db.workspaceJob.findUniqueOrThrow({ where: { id: fresh.json().jobId } })).continueFromJobId, null, "a new session when asked");
  await db.workspaceJob.update({ where: { id: fresh.json().jobId }, data: { status: "cancelled", finishedAt: new Date() } });

  const codex = await user.inject({ method: "POST", url: "/api/agent/assign", payload: { taskId: a.id, engine: "codex", deviceId: laptop.id, mode: "unattended" } });
  assert.equal((await db.workspaceJob.findUniqueOrThrow({ where: { id: codex.json().jobId } })).continueFromJobId, null, "another agent starts its own session");
  await db.workspaceJob.update({ where: { id: codex.json().jobId }, data: { status: "cancelled", finishedAt: new Date() } });

  // A task in another project that links to B does not reuse B's session.
  const c = await db.task.create({ data: { userId: user.id, title: "Reuse the ranking client", description: `See ensemble://task/${b.id}`, createdBy: "me", projectId: other.id } });
  const crossed = await user.inject({ method: "GET", url: `/api/agent/linked-session?taskId=${c.id}&engine=claude-code&deviceId=${laptop.id}` });
  assert.equal(crossed.json().linked, null, "never across projects");
  const d = await db.task.create({ data: { userId: user.id, title: "Document the ranking API", description: `Follows /tasks/${b.id}`, createdBy: "me", projectId: atlas.id } });
  const same = await user.inject({ method: "GET", url: `/api/agent/linked-session?taskId=${d.id}&engine=claude-code&deviceId=${laptop.id}` });
  assert.equal(same.json().linked?.reason, "link");

  assert.equal((await user.inject({ method: "PATCH", url: "/api/settings", payload: { orchestration: { linkedSessions: false } } })).statusCode, 200);
  const off = await user.inject({ method: "POST", url: "/api/agent/assign", payload: { taskId: a.id, engine: "claude-code", deviceId: laptop.id, mode: "unattended" } });
  assert.equal((await db.workspaceJob.findUniqueOrThrow({ where: { id: off.json().jobId } })).continueFromJobId, null, "off in Settings");
  await db.workspaceJob.update({ where: { id: off.json().jobId }, data: { status: "cancelled", finishedAt: new Date() } });
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

  await db.device.update({ where: { id: laptop.id }, data: { lastSeenAt: new Date(Date.now() - DAY) } });
  const offline: string[] = [];
  const waiting = await sweepAgentSessions(app, user.id, { completedDays: 60, remove: async (id) => offline.push(id) });
  assert.equal(offline.length, 0, "an offline computer's sessions wait, untouched");
  assert.ok(waiting.waiting >= 2);
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
