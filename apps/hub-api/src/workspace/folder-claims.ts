/**
 * Folders the runs on this computer are changing, so two runs never change one at once without the
 * person knowing. A live run holds its own folder (`repoPath`, an in-place run's `externalRoot`) and
 * every folder outside it that it starts changing: the `grantFolder` unit (a top-level workspace
 * folder, another run's `runs/<id>`, else the repository or folder), kept on the job as a `dir:<path>`
 * resource key, so the queue holds a job assigned to that folder until the run ends
 * (`queueConflict`). A hold ends with the run; nothing else is stored.
 *
 * A change inside a folder another live run holds, to a folder holding one, or anywhere in a
 * folder (a project or repository) that is inside or around one, is a conflict, settled before the
 * change goes ahead: wait until that run finishes (the call is held), work in a separate copy (a git
 * worktree on its own branch), or work alongside it. Ask and Review only ask on Needs me, and the card
 * closes by itself when the other run lets go first; Run unattended takes the recommended choice.
 */
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { ENGINE_LABELS, isCodeEngine } from "@ensemble/shared-types";
import { expandHome, harmlessPath, inTemp, knownWorkspace, within } from "./guard.js";
import { runTrustedGit } from "./git-gate.js";
import { OCCUPIED } from "./queue-policy.js";
import { parseShell } from "./shell-parse.js";
import { askPerson, DANGEROUS_GIT_CONFIG, grantFolder, grantFolderToRun, outsideArgs, readsOnly, realOutside, type Held, type JobContext } from "./tools.js";

/** How often a waiting run looks again. */
let pollMs = 2_000;
export function setFolderPollForTests(ms: number | null): void {
  pollMs = ms ?? 2_000;
}

/** Agents that never see why a call was refused (Codex and Cursor get a bare decline): a copy could not be pointed out to them. */
const DEAF = new Set(["codex", "cursor-agent"]);

export type FolderHolder = { id: string; own: boolean; title: string; agent: string; since: Date; progress: string | null; folder: string };

/** `asked`: the person approved this very call (the card showed its command). `answered`: they answered a card about the folder. */
type Verdict = { held: Held | null; asked: boolean; answered?: boolean };
const FREE: Verdict = { held: null, asked: false };

/** A change: the folder it would take (`grantFolder`) and the path itself. */
type Want = { folder: string; real: string };

const overlaps = (a: string, b: string) => within(a, b) || within(b, a);

/** Every folder a run holds. */
function holdings(row: { repoPath: string; externalRoot: string | null; resourceKeys: string[] }): string[] {
  return [...new Set([row.repoPath, row.externalRoot ?? "", ...row.resourceKeys.filter((key) => key.startsWith("dir:")).map((key) => key.slice(4))].filter(Boolean))];
}

type LiveRow = { id: string; userId: string; provider: string | null; progress: string | null; startedAt: Date | null; createdAt: Date; repoPath: string; externalRoot: string | null; resourceKeys: string[]; task: { title: string } };

/** The other runs this server or computer is running that may change files. */
async function liveRuns(prisma: PrismaClient, selfId: string): Promise<LiveRow[]> {
  return (await prisma.workspaceJob.findMany({
    where: { status: { in: [...OCCUPIED] }, deviceId: null, kind: "code", accessMode: { not: "review" }, id: { not: selfId } },
    select: { id: true, userId: true, provider: true, progress: true, startedAt: true, createdAt: true, repoPath: true, externalRoot: true, resourceKeys: true, task: { select: { title: true } } },
  })) as LiveRow[];
}

/**
 * The live run (other than this one) whose folder the change meets: the path is in that folder or
 * holds it, or the change's whole folder is inside it. A folder that only holds another run's (a
 * parent folder) is no conflict for a change elsewhere in it; `wide` says so, and then the change
 * takes nothing, so the parent never blocks the runs inside it.
 */
export async function folderHolder(prisma: PrismaClient, self: { id: string; userId: string }, want: Want): Promise<{ holder: FolderHolder | null; wide: boolean }> {
  let wide = false;
  for (const row of await liveRuns(prisma, self.id)) {
    const held = holdings(row).find((path) => within(path, want.folder) || within(path, want.real) || within(want.real, path));
    if (!held) {
      wide ||= holdings(row).some((path) => within(want.folder, path));
      continue;
    }
    const own = row.userId === self.userId;
    return { holder: {
      id: row.id,
      own,
      title: own ? row.task.title : "a task in another account",
      agent: isCodeEngine(row.provider) ? ENGINE_LABELS[row.provider] : "Ensemble's agent",
      since: row.startedAt ?? row.createdAt,
      progress: own ? row.progress : null,
      folder: held,
    }, wide };
  }
  return { holder: null, wide };
}

/** Folders other live runs hold, except any around or inside this run's own. */
export async function heldElsewhere(ctx: Pick<JobContext, "prisma" | "job" | "root" | "workspace">): Promise<string[]> {
  if (!usable(ctx)) return [];
  const rows = await liveRuns(ctx.prisma, ctx.job.id);
  return [...new Set(rows.flatMap(holdings))].filter((folder) => !overlaps(folder, ctx.root) && claimable(ctx, folder));
}

let queue: Promise<unknown> = Promise.resolve();
/** Looking for a holder and taking the folder happen together: one runtime runs all of a computer's jobs. */
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

/** Which run each waiting run waits for, to see a wait that would never end. */
const waits = new Map<string, string>();
function deadlocks(self: string, holder: string): boolean {
  let at: string | undefined = holder;
  for (let hops = 0; at && hops < 50; hops += 1) {
    if (at === self) return true;
    at = waits.get(at);
  }
  return false;
}

/**
 * Folders a run can take: not a temporary or device path, not Ensemble's own (`<workspace>/.cache`,
 * the scratch and caches every run shares), and never the workspace or the home folder whole.
 */
function claimable(ctx: Pick<JobContext, "workspace">, path: string, home = homedir()): boolean {
  const workspace = ctx.workspace ?? knownWorkspace();
  if (harmlessPath(path) || inTemp(path) || within(path, workspace) || within(path, home)) return false;
  return !(within(workspace, path, false) && relative(workspace, path).startsWith("."));
}

/** Folder claims need the job table; a unit test's bare context has none. */
function usable(ctx: Pick<JobContext, "prisma" | "job">): boolean {
  return typeof ctx.prisma?.workspaceJob?.findMany === "function" && ctx.job.accessMode !== "review";
}

async function take(ctx: JobContext, folder: string, how: "changes" | "alongside" | "seen" = "changes"): Promise<void> {
  ctx.claims = [...(ctx.claims ?? []), folder];
  const key = `dir:${folder}`;
  if (!(ctx.job.resourceKeys ?? []).includes(key)) {
    await ctx.prisma.workspaceJob.update({ where: { id: ctx.job.id }, data: { resourceKeys: { push: key } } });
    ctx.job.resourceKeys = [...(ctx.job.resourceKeys ?? []), key];
  }
  await ctx.event("folder_held", { folder, how });
}

/** Lets go of a folder the run took but will not change after all. */
export async function releaseFolder(ctx: JobContext, real: string): Promise<void> {
  const folder = (ctx.claims ?? []).find((row) => within(row, real));
  if (!folder || !usable(ctx)) return;
  ctx.claims = (ctx.claims ?? []).filter((row) => row !== folder);
  ctx.job.resourceKeys = (ctx.job.resourceKeys ?? []).filter((key) => key !== `dir:${folder}`);
  await ctx.prisma.workspaceJob.update({ where: { id: ctx.job.id }, data: { resourceKeys: ctx.job.resourceKeys } });
}

/** The holder, or the folder taken for this run (unless it only holds other runs' folders). */
const takeIfFree = (ctx: JobContext, want: Want, how?: "changes" | "seen") =>
  exclusive(async () => {
    const { holder, wide } = await folderHolder(ctx.prisma, { id: ctx.job.id, userId: ctx.userId }, want);
    if (!holder && !wide) await take(ctx, want.folder, how);
    return holder;
  });

/** How a folder reads in a question: under the workspace by its path there, else from the home folder. */
export function folderName(ctx: Pick<JobContext, "workspace">, folder: string, home = homedir()): string {
  const workspace = ctx.workspace ?? knownWorkspace();
  if (within(workspace, folder, false)) return `${relative(workspace, folder).replace(/\\/g, "/")}/`;
  return within(home, folder, false) ? `~/${relative(home, folder).replace(/\\/g, "/")}` : folder;
}

function copyNote(ctx: Pick<JobContext, "job">, copy: NonNullable<JobContext["copies"]>[number], name: string): Held {
  const keep = ctx.job.delivery === "local"
    ? `Leave them uncommitted there (this run makes no commits), and say in your summary that they are in ${copy.folder} on branch ${copy.branch}.`
    : `Commit them on ${copy.branch}, and say in your summary that ${copy.branch} needs merging.`;
  const error = `“${copy.holder}” is changing ${name} right now, so this run has its own copy: ${copy.folder} (a git worktree of ${copy.from} on branch ${copy.branch}, made from its last commit; changes not yet committed there are not in it). Make this change, and every other change this task needs in ${name}, in ${copy.folder} instead. ${keep}`;
  return { ok: false, result: { error, copy: copy.folder, branch: copy.branch }, summary: `Use the copy ${copy.folder}` };
}

/** The copy this run works in instead of the folder `real` is in, as the call's answer. */
export function copyFor(ctx: JobContext, real: string): Held | null {
  const copy = (ctx.copies ?? []).find((row) => within(row.from, real));
  return copy ? copyNote(ctx, copy, folderName(ctx, copy.from)) : null;
}

/**
 * Before a run changes `real` (outside its own folder, already allowed by the mode): takes its
 * folder, or settles the conflict when another live run holds it. The first change per folder looks;
 * later ones in a folder the run holds go straight on.
 */
export async function holdFolder(ctx: JobContext, real: string, options: { withdrawn?: AbortSignal; command?: string } = {}): Promise<Verdict> {
  if (!usable(ctx) || within(ctx.root, real) || !claimable(ctx, real)) return FREE;
  const copied = copyFor(ctx, real);
  if (copied) return { held: copied, asked: false };
  if ((ctx.claims ?? []).some((folder) => within(folder, real))) return FREE;
  const want = await wanted(ctx, real);
  if (!want) return FREE;
  const holder = await takeIfFree(ctx, want);
  return holder ? settle(ctx, want, holder, options) : FREE;
}

/** The folder a change to `real` takes, or null for one no run can take. */
async function wanted(ctx: JobContext, real: string): Promise<Want | null> {
  const folder = await grantFolder(real, ctx.workspace ?? knownWorkspace());
  return claimable(ctx, folder) ? { folder, real } : null;
}

/** The live run holding the folder a change to `real` would take, if there is one. */
export async function busyWith(ctx: JobContext, real: string): Promise<FolderHolder | null> {
  if (!usable(ctx) || within(ctx.root, real) || !claimable(ctx, real)) return null;
  if ((ctx.claims ?? []).some((folder) => within(folder, real))) return null;
  const want = await wanted(ctx, real);
  return want ? (await folderHolder(ctx.prisma, { id: ctx.job.id, userId: ctx.userId }, want)).holder : null;
}

/** A copy can be made of a repository's own folder with a commit and a config that starts nothing, for an agent that reads why a call was refused. */
async function copyable(ctx: JobContext, folder: string): Promise<boolean> {
  if (DEAF.has(ctx.job.provider ?? "")) return false;
  if (!(await stat(join(folder, ".git")).then((info) => info.isDirectory(), () => false))) return false;
  const config = await readFile(join(folder, ".git", "config"), "utf8").catch(() => null);
  if (config === null || DANGEROUS_GIT_CONFIG.test(config) || /^\s*\[include/im.test(config)) return false;
  return (await runTrustedGit({ userId: ctx.userId, cwd: folder, args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], timeoutMs: 15_000 }).catch(() => null))?.exitCode === 0;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");

/** A git worktree of `folder` beside it in the workspace, on a branch of its own, for this run to work in. */
async function makeCopy(ctx: JobContext, folder: string, holder: FolderHolder): Promise<Held> {
  const workspace = ctx.workspace ?? knownWorkspace();
  const tag = ctx.job.id.slice(0, 8);
  const base = `${basename(folder)}-${tag}`;
  let target = join(workspace, base);
  for (let n = 2; await stat(target).then(() => true, () => false); n += 1) target = join(workspace, `${base}-${n}`);
  const stem = `ensemble/${slug(ctx.taskTitle) || slug(basename(folder)) || "task"}-${tag}`;
  let branch = stem;
  for (let n = 2; (await runTrustedGit({ userId: ctx.userId, cwd: folder, args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], timeoutMs: 15_000 })).exitCode === 0; n += 1) branch = `${stem}-${n}`;
  const made = await runTrustedGit({ userId: ctx.userId, cwd: folder, args: ["worktree", "add", "-b", branch, target, "HEAD"], timeoutMs: 120_000 });
  if (made.exitCode !== 0) throw new Error(made.output.trim().split("\n").pop() || "git worktree add failed");
  await grantFolderToRun(ctx, target, true);
  await take(ctx, target);
  const copy = { from: folder, folder: target, branch, holder: holder.title };
  ctx.copies = [...(ctx.copies ?? []), copy];
  await ctx.event("folder_copy", { from: folder, folder: target, branch, jobId: holder.id });
  return copyNote(ctx, copy, folderName(ctx, folder));
}

/** Holds the call until no other run holds the folder, then takes it. */
async function waitUntilFree(ctx: JobContext, want: Want, first: FolderHolder, withdrawn?: AbortSignal): Promise<Verdict> {
  const folder = want.folder;
  const name = folderName(ctx, folder);
  let holder: FolderHolder | null = first;
  const wait = ctx.waitForRun ?? (<T>(work: () => Promise<T>) => work());
  try {
    return await wait(async () => {
      while (holder) {
        waits.set(ctx.job.id, holder.id);
        // Waiting on a run that waits on this one would never end: go on beside it instead.
        if (deadlocks(ctx.job.id, holder.id)) return alongside(ctx, want, holder);
        await ctx.progress(`Waiting for “${holder.title.slice(0, 80)}” to finish with ${name}`);
        await ctx.event("folder_wait", { folder, jobId: holder.id, title: holder.title });
        const seen = holder.id;
        while (holder?.id === seen) {
          await pause(pollMs, ctx.signal);
          if (withdrawn?.aborted) return { held: { ok: false, result: { error: `${name} is still being changed by “${holder.title}”. Try this change again in a while.` }, summary: "Still waiting" }, asked: false };
          holder = await takeIfFree(ctx, want);
        }
      }
      await ctx.progress(`Working in ${name}`);
      return FREE;
    });
  } finally {
    waits.delete(ctx.job.id);
  }
}

async function alongside(ctx: JobContext, want: Want, holder: FolderHolder): Promise<Verdict> {
  await exclusive(() => take(ctx, want.folder, "alongside"));
  await ctx.event("folder_shared", { folder: want.folder, jobId: holder.id, title: holder.title });
  return FREE;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    if (signal.aborted) return fail(new DOMException("Stopped", "AbortError"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      done();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      fail(new DOMException("Stopped", "AbortError"));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Another run holds the folder: wait, a copy, or alongside it, as the person (or the recommended
 * choice) says. A card that shows the command approves it too (`asked`); one about a file change
 * only settles the folder (`answered`).
 */
async function settle(ctx: JobContext, want: Want, holder: FolderHolder, options: { withdrawn?: AbortSignal; command?: string }, rounds = 0): Promise<Verdict> {
  const folder = want.folder;
  const name = folderName(ctx, folder);
  const other = `“${holder.title.slice(0, 80)}”`;
  const stuck = deadlocks(ctx.job.id, holder.id);
  const canCopy = await copyable(ctx, folder);
  const choices = {
    wait: `Wait until ${other} finishes, then work in ${name}`,
    copy: `Work in a separate copy of ${name} (a git worktree on its own branch)`,
    together: `Work in ${name} alongside it`,
  };
  const options_ = [...(stuck ? [] : [choices.wait]), ...(canCopy ? [choices.copy] : []), choices.together];
  const minutes = Math.max(1, Math.round((Date.now() - holder.since.getTime()) / 60_000));
  const now = holder.progress?.trim() ? `, now: ${holder.progress.trim().slice(0, 60)}` : "";
  const wants = options.command ? `this task wants to run ${options.command.slice(0, 120)} there` : "this task needs to change it too";
  const title = `${other} (${holder.agent}, ${minutes} min in${now}) is changing ${name} right now, and ${wants}.${stuck ? " Waiting is not offered: that task is waiting for a folder this one holds." : ""}`;
  let choice: string;
  if (ctx.job.unattended) {
    choice = options_[0]!;
    ctx.decisions?.push({ question: title, options: options_, recommended: choice });
    await ctx.event("decision", { question: title, options: options_, recommended: choice, by: "unattended" });
  } else {
    // The card closes by itself if the other run lets go of the folder first.
    const freed = new AbortController();
    const answered = new AbortController();
    const looking = AbortSignal.any([ctx.signal, answered.signal]);
    const watch = (async () => {
      while (!looking.aborted) {
        if (!(await pause(pollMs, looking).then(() => true, () => false))) return;
        const still = await folderHolder(ctx.prisma, { id: ctx.job.id, userId: ctx.userId }, want).catch(() => null);
        if (still && !still.holder) return freed.abort();
      }
    })().catch(() => undefined);
    const withdrawn = options.withdrawn ? AbortSignal.any([freed.signal, options.withdrawn]) : freed.signal;
    await ctx.progress(`Waiting for your answer: ${name} is being changed by ${other}`);
    let answer: Awaited<ReturnType<typeof askPerson>>;
    try {
      answer = await askPerson(ctx, { event: "question", toolName: "folder in use", title, options: options_, allowCustom: false, recommended: options_[0]!, command: options.command ?? folder }, withdrawn);
    } finally {
      answered.abort();
      await watch;
    }
    if (freed.signal.aborted && !options.withdrawn?.aborted && answer.decision === "expired") {
      const next = await takeIfFree(ctx, want);
      // Nobody answered: a caller that still needs the person's yes for this folder asks it now.
      if (!next) return FREE;
      return rounds < 3 ? settle(ctx, want, next, options, rounds + 1) : waitUntilFree(ctx, want, next, options.withdrawn);
    }
    if (answer.decision !== "allow" || !answer.answer || !options_.includes(answer.answer)) {
      return { held: { ok: false, result: { error: `The person chose not to let this run change ${name} while ${other} is changing it. Carry on without it and say so in your summary.`, refused: true }, summary: "Not allowed (folder in use)" }, asked: true, answered: true };
    }
    choice = answer.answer;
  }
  const answered = !ctx.job.unattended;
  const said = { asked: answered && Boolean(options.command), answered };
  if (choice === choices.copy) {
    try {
      return { held: await makeCopy(ctx, folder, holder), ...said };
    } catch (error) {
      await ctx.event("folder_copy_failed", { folder, error: (error as Error).message });
      return { ...(await (stuck ? alongside(ctx, want, holder) : waitUntilFree(ctx, want, holder, options.withdrawn))), ...said };
    }
  }
  if (choice === choices.together) return { ...(await alongside(ctx, want, holder)), ...said };
  return { ...(await waitUntilFree(ctx, want, holder, options.withdrawn)), ...said };
}

/** Paths a shell command writes outside `root`: what each writing program names, the folder it runs in, and redirects. */
export function writtenOutside(root: string, command: string, cwd = root): string[] {
  const paths = new Set<string>();
  for (const segment of parseShell(command, cwd)) {
    const writes = segment.argv.length > 0 && !readsOnly(segment.argv);
    if (writes) {
      for (const path of outsideArgs(root, segment.argv, segment.cwd)) paths.add(resolve(segment.cwd, expandHome(path)));
      if (!within(root, segment.cwd)) paths.add(segment.cwd);
    }
    for (const redirect of segment.redirects) {
      const full = resolve(segment.cwd, expandHome(redirect.path));
      if (redirect.write && !within(root, full)) paths.add(full);
    }
  }
  return [...paths];
}

/**
 * Changes an agent made outside its folder without asking (Codex in Run unattended writes the
 * workspace's folders on its own): the run takes each folder from then on, so other runs wait for it.
 * One another run took after the agent started is a clash, told on both runs' logs and to the person.
 * `closed`: folders the agent's sandbox could not write.
 */
export async function noteChanges(ctx: JobContext, paths: string[], closed: string[] = []): Promise<void> {
  if (!usable(ctx)) return;
  for (const path of paths) {
    const full = resolve(ctx.root, expandHome(path));
    const real = await realOutside(full).catch(() => full);
    if (within(ctx.root, real) || !claimable(ctx, real)) continue;
    // Closed to the agent's sandbox: it changed nothing there (a change there comes through an approval and `holdFolder`).
    if (closed.some((folder) => within(folder, real))) continue;
    if ((ctx.claims ?? []).some((folder) => within(folder, real))) continue;
    const want = await wanted(ctx, real);
    if (!want) continue;
    const holder = await takeIfFree(ctx, want, "seen");
    if (!holder) continue;
    await exclusive(() => take(ctx, want.folder, "alongside"));
    const name = folderName(ctx, want.folder);
    await ctx.event("folder_clash", { folder: want.folder, jobId: holder.id, title: holder.title });
    // The other run's log names this task only when both are the same account's.
    await ctx.prisma.workspaceEvent.create({ data: { jobId: holder.id, kind: "folder_clash", data: holder.own ? { folder: want.folder, jobId: ctx.job.id, title: ctx.taskTitle } : { folder: want.folder } } }).catch(() => undefined);
    await ctx.prisma.notification
      .create({ data: { userId: ctx.userId, kind: "agent", title: `Two tasks are changing ${name} at once`.slice(0, 200), body: `“${ctx.taskTitle}” changed ${name} while “${holder.title}” is changing it.`, url: `/tasks/${ctx.taskId}` } })
      .catch(() => undefined);
  }
}
