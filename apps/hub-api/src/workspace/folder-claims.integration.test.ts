/**
 * Two runs on one computer changing the same folder: the second waits, works in a git worktree, or
 * goes alongside, as the person (or, unattended, the recommended choice) says; the queue holds a job
 * for a folder a running job is changing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { WorkspaceJob } from "@prisma/client";
import { createHttpHarness } from "../test/http.js";

const h = await createHttpHarness();
const ws = realpathSync(mkdtempSync(join(homedir(), ".ensemble-folder-claims-test-")));
after(async () => {
  rmSync(ws, { recursive: true, force: true });
  await h.close();
});
const { outsidePath } = await import("./tools.js");
const { noteChanges, setFolderPollForTests, writtenOutside } = await import("./folder-claims.js");
const { queueConflict } = await import("./queue-policy.js");
const { decisionBus } = await import("../lib/decisions.js");
type Ctx = import("./tools.js").JobContext;
setFolderPollForTests(50);

const user = await h.asUser();
let order = 0;

async function run(title: string, over: { unattended?: boolean; provider?: string; accessMode?: "auto" | "read-write" } = {}) {
  const task = await h.prisma.task.create({ data: { userId: user.id, title, boardOrder: (order += 1), createdBy: "me" } });
  const id = crypto.randomUUID();
  const root = join(ws, "runs", id);
  mkdirSync(root, { recursive: true });
  const job = (await h.prisma.workspaceJob.create({
    data: { id, userId: user.id, taskId: task.id, kind: "code", executionMode: "sandbox", status: "running", startedAt: new Date(), provider: over.provider ?? "claude-code", model: "default", repoPath: root, unattended: over.unattended ?? true },
  })) as WorkspaceJob;
  const control = new AbortController();
  const ctx = {
    prisma: h.prisma,
    job,
    userId: user.id,
    taskId: task.id,
    taskTitle: title,
    runId: id,
    root,
    workspace: ws,
    grants: [],
    sandboxed: false,
    network: false,
    trusted: true,
    explicitTrust: false,
    silentWorkspace: true,
    accessMode: over.accessMode ?? "auto",
    strength: "advisory",
    outsideAccess: "read",
    blockedOutside: [],
    decisions: [],
    runBranch: "",
    touched: new Set<string>(),
    wrotePage: false,
    finished: null,
    commitAuthor: "Mira Chen <mira@example.test>",
    signal: control.signal,
    progress: async () => undefined,
    event: async (kind: string, data: Record<string, unknown>) => void (await h.prisma.workspaceEvent.create({ data: { jobId: id, kind, data: data as never } })),
    waitForPerson: <T,>(work: () => Promise<T>) => work(),
    waitForRun: <T,>(work: () => Promise<T>) => work(),
  } as unknown as Ctx;
  return { ctx, job, finish: () => h.prisma.workspaceJob.update({ where: { id }, data: { status: "succeeded", finishedAt: new Date() } }) };
}

const folder = (name: string) => {
  mkdirSync(join(ws, name), { recursive: true });
  return join(ws, name);
};
const kinds = async (jobId: string) => (await h.prisma.workspaceEvent.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } })).map((row) => row.kind);
const keys = async (jobId: string) => (await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: jobId } })).resourceKeys;
const pending = async (jobId: string) => h.prisma.agentDecision.findFirst({ where: { sessionId: jobId, status: "pending" }, orderBy: { requestedAt: "desc" } });
async function until<T>(read: () => Promise<T | null | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function answer(id: string, choice: string | null, decision: "allow" | "deny" = "allow") {
  await h.prisma.agentDecision.update({ where: { id }, data: { status: "decided", decision, reason: choice, decidedAt: new Date() } });
  decisionBus.emit(id);
}
const settled = <T,>(promise: Promise<T>) => Promise.race([promise.then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), 150))]);

test("unattended: the second run waits for the first to finish with the folder, then takes it; the queue holds a job for it meanwhile", async () => {
  const api = folder("api");
  const a = await run("Fix the login");
  const b = await run("Rate-limit the login");
  assert.deepEqual(await outsidePath(a.ctx, join(api, "login.ts"), true), { held: null, asked: false });
  assert.ok((await keys(a.job.id)).includes(`dir:${api}`), "the folder is held on the job");
  assert.equal((await outsidePath(a.ctx, join(api, "other.ts"), true)).held, null, "later changes go straight on");

  // A job assigned to a folder inside it waits in the queue for the run changing it.
  const queued = { id: "c", deviceId: null, repoUrl: null, resourceKeys: [`dir:${join(api, "web")}`], continueFromJobId: null, task: { projectId: null, repoId: null } };
  assert.deepEqual(queueConflict(queued, [{ ...queued, id: a.job.id, resourceKeys: await keys(a.job.id) }]), { jobId: a.job.id, reason: "folder" });

  const waiting = outsidePath(b.ctx, join(api, "limit.ts"), true);
  assert.equal(await settled(waiting), false, "held while the other run changes the folder");
  assert.match(b.ctx.decisions![0]!.question, /“Fix the login” \(Claude Code, 1 min in\) is changing api\/ right now/);
  assert.equal(b.ctx.decisions![0]!.recommended, "Wait until “Fix the login” finishes, then work in api/");
  assert.equal(await pending(b.job.id), null, "nobody is asked in Run unattended");
  await a.finish();
  assert.deepEqual(await waiting, { held: null, asked: false });
  assert.ok((await keys(b.job.id)).includes(`dir:${api}`));
  assert.deepEqual((await kinds(b.job.id)).filter((kind) => kind.startsWith("folder") || kind === "decision"), ["decision", "folder_wait", "folder_held"]);
  await b.finish();
});

test("Review only: one question names the other task; the card closes by itself when that task lets go first, and then the folder is asked about as usual", async () => {
  const docs = folder("docs");
  const a = await run("Write the guide");
  const b = await run("Fix typos", { unattended: false });
  await outsidePath(a.ctx, join(docs, "guide.md"), true);
  const asking = outsidePath(b.ctx, join(docs, "typos.md"), true);
  const card = await until(() => pending(b.job.id), "the conflict card");
  assert.equal(card.event, "question");
  const detail = card.detail as { options: string[]; recommended: string };
  assert.deepEqual(detail.options, ["Wait until “Write the guide” finishes, then work in docs/", "Work in docs/ alongside it"], "not a repository: no copy offered");
  assert.equal(detail.recommended, detail.options[0]);
  await a.finish();
  const permission = await until(async () => {
    const row = await pending(b.job.id);
    return row && row.id !== card.id ? row : null;
  }, "the folder question");
  assert.equal((await h.prisma.agentDecision.findUniqueOrThrow({ where: { id: card.id } })).status, "expired");
  assert.match(permission.title, /work in .*docs/);
  await answer(permission.id, null);
  assert.equal((await asking).held, null);
  assert.ok((await keys(b.job.id)).includes(`dir:${docs}`));
  await b.finish();
});

test("Ask: working alongside holds the folder for both; a card that shows the command approves it, one about a file only the folder; saying no keeps this run out", async () => {
  const site = folder("site");
  const a = await run("Redesign the header");
  const b = await run("New footer", { unattended: false, accessMode: "read-write" });
  const c = await run("Change the colours", { unattended: false, accessMode: "read-write" });
  await outsidePath(a.ctx, join(site, "header.tsx"), true);
  const both = outsidePath(b.ctx, join(site, "footer.tsx"), true, { command: "npm run build:footer" });
  const card = await until(() => pending(b.job.id), "B's card");
  assert.match(card.title, /and this task wants to run npm run build:footer there\./);
  await answer(card.id, "Work in site/ alongside it");
  assert.deepEqual(await both, { held: null, asked: true }, "the person saw and approved the command");
  assert.ok((await keys(b.job.id)).includes(`dir:${site}`));
  assert.ok((await kinds(b.job.id)).includes("folder_shared"));

  const d = await run("Fix the logo", { unattended: false, accessMode: "read-write" });
  const file = outsidePath(d.ctx, join(site, "logo.svg"), true);
  await answer((await until(() => pending(d.job.id), "D's card")).id, "Work in site/ alongside it");
  assert.deepEqual(await file, { held: null, asked: false }, "no command was shown: the folder is settled, nothing else approved");
  assert.ok(d.ctx.grants!.includes(site), "and the answer lets the run into the folder");
  await d.finish();

  const no = outsidePath(c.ctx, join(site, "colours.css"), true);
  await answer((await until(() => pending(c.job.id), "C's card")).id, null, "deny");
  const refused = await no;
  assert.match(JSON.stringify(refused.held), /chose not to let this run change site\/ while “Redesign the header” is changing it/);
  assert.ok(!(await keys(c.job.id)).includes(`dir:${site}`));
  await Promise.all([a.finish(), b.finish(), c.finish()]);
});

test("a repository: a separate copy is a git worktree on its own branch, and every later change there is pointed at the copy", async () => {
  const repo = folder("app");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "app\n");
  git("add", ".");
  git("-c", "user.name=Mira", "-c", "user.email=mira@example.test", "commit", "-q", "-m", "first");
  const a = await run("Upgrade React");
  const b = await run("Add dark mode", { unattended: false });
  await outsidePath(a.ctx, join(repo, "package.json"), true);
  const asking = outsidePath(b.ctx, join(repo, "theme.css"), true);
  const card = await until(() => pending(b.job.id), "the card");
  const options = (card.detail as { options: string[] }).options;
  assert.deepEqual(options, ["Wait until “Upgrade React” finishes, then work in app/", "Work in a separate copy of app/ (a git worktree on its own branch)", "Work in app/ alongside it"]);
  await answer(card.id, options[1]!);
  const copied = await asking;
  const note = (copied.held?.result as { error: string; copy: string; branch: string }) ?? null;
  assert.ok(note, "the call is answered with where to work");
  assert.equal(note.copy, join(ws, `app-${b.job.id.slice(0, 8)}`));
  assert.equal(note.branch, `ensemble/add-dark-mode-${b.job.id.slice(0, 8)}`);
  assert.match(note.error, /Make this change, and every other change this task needs in app\/, in .* instead/);
  assert.match(git("worktree", "list"), new RegExp(note.branch.replace(/\//g, "\\/")));
  assert.match(note.error, /Leave them uncommitted there \(this run makes no commits\)/, "a Local only run is not told to commit");
  const again = await outsidePath(b.ctx, join(repo, "src", "theme.ts"), true);
  assert.equal((again.held?.result as { copy: string }).copy, note.copy, "the same answer, no second card");
  assert.equal(await pending(b.job.id), null);
  assert.deepEqual(await outsidePath(b.ctx, join(note.copy, "theme.css"), true), { held: null, asked: false }, "the copy is the run's own to change");
  await a.finish();
  const after = await outsidePath(b.ctx, join(repo, "theme.css"), true);
  assert.equal((after.held?.result as { copy: string }).copy, note.copy, "once in a copy, the task stays there, and nobody is asked");
  assert.equal(await pending(b.job.id), null);
  await b.finish();
});

test("two runs each waiting on the other's folder would wait forever: the second goes alongside instead", async () => {
  const left = folder("left");
  const right = folder("right");
  const a = await run("Left task");
  const b = await run("Right task");
  await outsidePath(a.ctx, join(left, "a"), true);
  await outsidePath(b.ctx, join(right, "b"), true);
  const aWaits = outsidePath(a.ctx, join(right, "a"), true);
  await until(async () => (await kinds(a.job.id)).includes("folder_wait"), "A to wait");
  assert.deepEqual(await outsidePath(b.ctx, join(left, "b"), true), { held: null, asked: false }, "B does not wait on A");
  assert.equal(b.ctx.decisions![0]!.recommended, "Work in left/ alongside it");
  await b.finish();
  assert.equal((await aWaits).held, null);
  await a.finish();
});

test("what a run takes: never Ensemble's own cache or the workspace whole; a parent folder of another run's is no conflict for a change elsewhere in it", async () => {
  const outside = realpathSync(mkdtempSync(join(homedir(), ".ensemble-folder-claims-outside-")));
  after(() => rmSync(outside, { recursive: true, force: true }));
  const app = join(outside, "app");
  mkdirSync(app);
  const a = await run("Work in app");
  await h.prisma.workspaceJob.update({ where: { id: a.job.id }, data: { externalRoot: app, resourceKeys: [`dir:${app}`] } });
  const b = await run("Tidy up");
  mkdirSync(join(ws, ".cache", "tmp"), { recursive: true });
  assert.deepEqual(await outsidePath(b.ctx, join(ws, ".cache", "tmp", "scratch"), true), { held: null, asked: false });
  assert.deepEqual(await outsidePath(b.ctx, ws, true), { held: null, asked: false });
  assert.deepEqual(await outsidePath(b.ctx, join(outside, "README.md"), true), { held: null, asked: false }, "beside app, not in it");
  assert.deepEqual(await keys(b.job.id), [], "none of these is taken");
  const into = outsidePath(b.ctx, join(app, "x.ts"), true);
  assert.equal(await settled(into), false, "in app: waits for the run working there");
  await a.finish();
  assert.equal((await into).held, null);
  assert.deepEqual(await keys(b.job.id), [`dir:${app}`]);
  await b.finish();
});

test("Codex's own changes outside its folder hold it from then on; one another run holds is a clash both runs and the person hear about", async () => {
  const lib = folder("lib");
  const a = await run("Refactor lib");
  const codex = await run("Bump versions", { provider: "codex" });
  await outsidePath(a.ctx, join(lib, "x.ts"), true);
  assert.deepEqual(writtenOutside(codex.ctx.root, `cd ${lib} && npm version patch`).map((path) => path.replace(ws, "<ws>")), ["<ws>/lib"]);
  assert.deepEqual(writtenOutside(codex.ctx.root, `ls ${lib} && cat ${lib}/x.ts`), [], "reading takes nothing");
  await noteChanges(codex.ctx, [join(lib, "package.json")], [lib]);
  assert.deepEqual(await keys(codex.job.id), [], "closed to its sandbox when it started: it changed nothing there");
  assert.ok(!(await kinds(codex.job.id)).includes("folder_clash"));
  await noteChanges(codex.ctx, [join(lib, "package.json")]);
  assert.ok((await keys(codex.job.id)).includes(`dir:${lib}`));
  assert.ok((await kinds(codex.job.id)).includes("folder_clash"));
  assert.ok((await kinds(a.job.id)).includes("folder_clash"));
  assert.ok(await h.prisma.notification.findFirst({ where: { userId: user.id, title: "Two tasks are changing lib/ at once" } }));
  await Promise.all([a.finish(), codex.finish()]);
});
