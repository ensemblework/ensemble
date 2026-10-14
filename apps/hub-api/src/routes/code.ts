/**
 * The Code tab (docs/06 §review).
 *
 * Two sources share one review surface:
 *   review=<id>  an agent run — base is the tree the run started from. Accept
 *                keeps the change; reject puts the old lines back on disk.
 *   repo=<path>  a local checkout — base is HEAD. Accept stages the hunk;
 *                reject discards it, like stage/revert hunk in an editor.
 */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../config.js";
import { requireHostAccess } from "../lib/hosted-access.js";
import {
  allowedRepo,
  changedFiles,
  discoverRepos,
  fileDiff,
  git,
  GitError,
  INDEX,
  githubActions,
  insideRepo,
  listRepoFolder,
  readRepoBytes,
  readRepoFile,
  removeRepoFile,
  revertHunk,
  stageHunk,
  status,
  writeRepoBytes,
} from "../lib/git.js";
import { decode, encode, gitBlob, hashOf, reviewCounts, writeBlob } from "../lib/code-versions.js";
import { commitPaths, defaultBranch, githubRepoOf, openPullRequest, pullRequestTemplate } from "../lib/code-commit.js";
import { GITHUB_AUTH_HINT, githubApiToken } from "../lib/git-auth.js";
import { refusedPath } from "../workspace/folder-read.js";
import { appendLedger } from "../lib/ledger.js";
import { declareModule } from "../lib/module-gate.js";
import { dropWhere, readLru, remember } from "../lib/bounded.js";
import { loadSettings } from "../lib/settings.js";
import { resolveCodeFolder, usableCodeRoots } from "../lib/code-folders.js";
import { expandHome, gitHardening, within } from "../workspace/guard.js";
import { isOwnRunBranch, isRunBranch, runTrustedGit } from "../workspace/git-gate.js";
import { pushRunBranch } from "../workspace/publish.js";
import { flagPlanted, type PlantedHit } from "../workspace/planted.js";

const REVIEW_TTL_DAYS = 14;
/** The decision row that keeps a file's accepted changes: `blob:<sha>` of the text they add up to. */
const BASELINE = "baseline";
const progressCache = new Map<string, { at: number; counts: { total: number; pending: number; yours: number } }>();
const fileStatCache = new Map<string, { at: number; files: Awaited<ReturnType<typeof changedFiles>> }>();
const FILE_STAT_TTL_MS = 8_000;
const FILE_STAT_MAX = 200;

async function cachedChangedFiles(repo: string, tree: string) {
  const key = `${repo}\0${tree}`;
  const now = Date.now();
  dropWhere(fileStatCache, (value) => now - value.at >= FILE_STAT_TTL_MS);
  const hit = readLru(fileStatCache, key);
  if (hit && now - hit.at < FILE_STAT_TTL_MS) return hit.files;
  const files = await changedFiles(repo, tree);
  remember(fileStatCache, key, { at: now, files }, FILE_STAT_MAX);
  return files;
}
async function plantedFlags(repo: string, paths: string[]): Promise<PlantedHit[]> {
  const interesting = paths.filter((path) => /\.vscode\/tasks\.json$|\.envrc$|(^|\/)\.husky(\/|$)|package\.json$|([/]|^)(Makefile|makefile|GNUmakefile)$/.test(path));
  const files = await Promise.all(
    interesting.map(async (path) => ({ path, text: await readFile(join(repo, path), "utf8").catch(() => undefined) })),
  );
  return flagPlanted(files);
}

const Source = z.object({ review: z.string().uuid().optional(), repo: z.string().optional() });
/** Query strings carry "false" as text; z.coerce.boolean would read it as true. */
const QueryFlag = z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean());

export async function codeRoutes(app: FastifyInstance): Promise<void> {
  declareModule(app, "code");
  app.addHook("preHandler", async (request) => requireHostAccess(request.userId, "Code filesystem"));
  const { prisma } = app;

  /** The workspace, the folders Code can use (settings.code.roots, never the terminal's), and agent run checkouts. */
  async function roots(userId: string): Promise<string[]> {
    const settings = await loadSettings(prisma, userId);
    const jobs = await prisma.workspaceJob.findMany({ where: { userId }, select: { repoPath: true }, distinct: ["repoPath"] });
    return [expandHome(env.ENSEMBLE_WORKSPACE_ROOT), ...(await usableCodeRoots(settings, userId)), ...jobs.map((job) => job.repoPath)];
  }

  async function resolveSource(request: FastifyRequest, input: unknown) {
    const source = Source.parse(input);
    if (source.review) {
      const review = await prisma.codeReview.findFirst({
        where: { id: source.review, userId: request.userId },
        include: { job: { include: { task: { select: { id: true, title: true } } } }, decisions: true },
      });
      if (!review) throw new GitError("Review not found.", 404);
      const repo = await allowedRepo(review.repoPath, await roots(request.userId));
      return { kind: "review" as const, repo, base: review.startTree, review };
    }
    if (source.repo) {
      const repo = await allowedRepo(source.repo, await roots(request.userId));
      // Like an editor's Changes list: what is not staged yet. Staged hunks leave it.
      return { kind: "repo" as const, repo, base: INDEX, review: null };
    }
    throw new GitError("Pass review or repo.");
  }

  app.get("/api/code/repos", async (request) => {
    const all = await roots(request.userId);
    const repos = await discoverRepos(all);
    return { repos, roots: all.filter(Boolean) };
  });

  /**
   * Check a folder someone wants Code to use and return its real path. Settings
   * then saves it with PATCH /api/settings, which runs the same check again.
   */
  app.post("/api/code/folders/resolve", async (request) => {
    const { path } = z.object({ path: z.string().min(1).max(4096) }).parse(request.body);
    return { path: await resolveCodeFolder(path, request.userId) };
  });

  app.get("/api/code/reviews", async (request) => {
    const { filter, expired } = z
      .object({ filter: z.enum(["needs", "reviewed", "all"]).default("needs"), expired: QueryFlag.default(false) })
      .parse(request.query);
    const reviews = await prisma.codeReview.findMany({
      where: {
        userId: request.userId,
        ...(expired ? {} : { expiredAt: null }),
        ...(filter === "needs" ? { completedAt: null } : filter === "reviewed" ? { completedAt: { not: null } } : {}),
      },
      orderBy: { createdAt: "desc" },
      include: {
        job: { include: { task: { select: { id: true, title: true } } } },
        _count: { select: { decisions: true } },
      },
    });
    const rootList = await roots(request.userId);
    const withStats = await Promise.all(
      reviews.map(async (review) => {
        let files = 0;
        let added = 0;
        let removed = 0;
        let reachable = true;
        try {
          const repo = await allowedRepo(review.repoPath, rootList);
          const changed = await cachedChangedFiles(repo, review.startTree);
          const scoped = review.agentPaths.length ? changed.filter((file) => review.agentPaths.includes(file.path)) : changed;
          files = scoped.length;
          added = scoped.reduce((sum, file) => sum + file.added, 0);
          removed = scoped.reduce((sum, file) => sum + file.removed, 0);
        } catch {
          reachable = false;
        }
        return {
          id: review.id,
          title: review.job.task.title,
          taskId: review.job.task.id,
          repoPath: review.repoPath,
          branch: review.job.branch,
          delivery: review.job.delivery,
          model: review.job.model,
          createdAt: review.createdAt.toISOString(),
          completedAt: review.completedAt?.toISOString() ?? null,
          expiresAt: review.expiresAt.toISOString(),
          decisions: review._count.decisions,
          files,
          added,
          removed,
          reachable,
        };
      }),
    );
    return { reviews: withStats, ttlDays: REVIEW_TTL_DAYS };
  });

  app.get("/api/code/source", async (request) => {
    const source = await resolveSource(request, request.query);
    const changed = await changedFiles(source.repo, source.base);
    const scoped =
      source.review && source.review.agentPaths.length
        ? changed.filter((file) => source.review!.agentPaths.includes(file.path))
        : changed;
    const branch = (await git(source.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD")).trim();
    const planted = await plantedFlags(source.repo, scoped.map((file) => file.path));
    let review = null;
    if (source.review) {
      const job = source.review.job;
      const head = (await git(source.repo, ["rev-parse", "HEAD"]).catch(() => "")).trim();
      const onRunBranch = isOwnRunBranch(branch, job.id) || (Boolean(job.continueFromJobId) && isRunBranch(branch));
      review = {
        id: source.review.id,
        completedAt: source.review.completedAt?.toISOString() ?? null,
        outside: Boolean(job.externalRoot),
        runBranch: onRunBranch,
        canPush: onRunBranch && !job.externalRoot && Boolean(job.repoUrl || job.continueFromJobId) && Boolean(head) && head !== source.review.initialHead,
      };
    }
    return {
      review,
      kind: source.kind,
      repo: source.repo,
      branch,
      title: source.review?.job.task.title ?? source.repo.split("/").pop(),
      taskId: source.review?.job.task.id ?? null,
      model: source.review?.job.model ?? null,
      createdAt: source.review?.createdAt.toISOString() ?? null,
      files: scoped.filter((file) => !file.binary),
      unreviewable: scoped.filter((file) => file.binary),
      planted,
      decisions: source.review?.decisions ?? [],
    };
  });

  app.get("/api/code/diff", async (request) => {
    const { path, untracked } = z
      .object({ path: z.string().min(1), untracked: QueryFlag.default(false) })
      .parse(request.query);
    const source = await resolveSource(request, request.query);
    const diff = await fileDiff(source.repo, source.base, path, untracked);
    const decisions = source.review?.decisions.filter((row) => row.path === path) ?? [];
    return { diff, decisions };
  });

  app.post("/api/code/decide", async (request) => {
    const body = z
      .object({
        review: z.string().uuid().optional(),
        repo: z.string().optional(),
        path: z.string().min(1),
        key: z.string().min(1),
        untracked: z.boolean().default(false),
        decision: z.enum(["accepted", "rejected"]),
      })
      .parse(request.body);
    const source = await resolveSource(request, body);
    const diff = await fileDiff(source.repo, source.base, body.path, body.untracked);
    const hunk = diff.hunks.find((row) => row.key === body.key);
    if (!hunk) throw new GitError("That change is no longer on disk. Refresh and try again.", 409);
    if (body.decision === "rejected") await revertHunk(source.repo, diff, hunk);
    else if (source.kind === "repo") await stageHunk(source.repo, diff, hunk);
    if (source.review) {
      await prisma.codeReviewDecision.upsert({
        where: { reviewId_path_chunkKey: { reviewId: source.review.id, path: body.path, chunkKey: body.key } },
        create: { reviewId: source.review.id, path: body.path, chunkKey: body.key, decision: body.decision },
        update: { decision: body.decision, at: new Date() },
      });
    }
    await appendLedger({
      userId: request.userId,
      actor: "me",
      action: `code.${body.decision}`,
      payload: { repo: source.repo, path: body.path, key: body.key, review: source.review?.id ?? null },
    });
    return { ok: true };
  });

  app.post("/api/code/reviews/:id/complete", async (request) => {
    const { id } = request.params as { id: string };
    await prisma.codeReview.updateMany({ where: { id, userId: request.userId }, data: { completedAt: new Date() } });
    return { ok: true };
  });

  async function agentReview(userId: string, id: string) {
    const review = await prisma.codeReview.findFirst({ where: { id, userId }, include: { job: { include: { task: true } } } });
    if (!review) throw new GitError("Review not found.", 404);
    const repo = await allowedRepo(review.repoPath, await roots(userId));
    const trusted = async (args: string[]) => {
      const result = await runTrustedGit({ userId, cwd: repo, args });
      if (result.exitCode !== 0) throw new GitError(`git ${args[0]} failed: ${result.output.trim().slice(-400)}`, 409);
      return result.output.trim();
    };
    const branch = await trusted(["rev-parse", "--abbrev-ref", "HEAD"]);
    const runBranch = isOwnRunBranch(branch, review.job.id) || (Boolean(review.job.continueFromJobId) && isRunBranch(branch));
    const paths = review.agentPaths.filter((path) => within(repo, join(repo, path)) && !path.split("/").includes(".git"));
    return { review, repo, trusted, branch, runBranch, paths };
  }

  /**
   * Keep what is on disk now (after any per-hunk rejects). In the run's own
   * checkout the change is committed on the run branch, by the app, with
   * hooks off. A folder outside the workspace is left uncommitted.
   */
  app.post("/api/code/reviews/:id/accept", async (request) => {
    const { id } = request.params as { id: string };
    const { review, repo, trusted, branch, runBranch, paths } = await agentReview(request.userId, id);
    let commit: string | null = null;
    if (runBranch && !review.job.externalRoot && paths.length) {
      await trusted(["add", "-A", "--", ...paths]);
      const staged = await runTrustedGit({ userId: request.userId, cwd: repo, args: ["diff", "--cached", "--quiet"] });
      if (staged.exitCode === 1) {
        const settings = await loadSettings(prisma, request.userId);
        const identity = settings.terminal.commitAuthor.match(/^(.+?)\s*<(.+)>$/) ?? [null, "Ensemble Agent", "agent@ensemble.local"];
        await trusted(["-c", `user.name=${identity[1]}`, "-c", `user.email=${identity[2]}`, "commit", "--quiet", "--no-verify", "-m", `${review.job.task.title}\n\nAccepted in Ensemble review (job ${review.job.id}).`]);
      }
      commit = await trusted(["rev-parse", "HEAD"]);
    }
    const head = await trusted(["rev-parse", "HEAD"]).catch(() => "");
    await prisma.codeReview.update({ where: { id: review.id }, data: { completedAt: new Date() } });
    if (review.job.task.status === "waiting_approval" && review.job.markDone) {
      await prisma.task.update({ where: { id: review.job.taskId }, data: { status: "done", completedAt: new Date() } });
    }
    await appendLedger({ userId: request.userId, actor: "me", action: "code.review.accept", taskId: review.job.taskId, payload: { review: review.id, commit, branch } });
    return {
      ok: true,
      commit,
      branch,
      pushable: runBranch && Boolean(review.job.repoUrl || review.job.continueFromJobId) && Boolean(head) && head !== review.initialHead,
    };
  });

  /**
   * Put the folder back the way the run found it, for the files the agent
   * changed. Commits the agent made are undone only on its own run branch.
   */
  app.post("/api/code/reviews/:id/discard", async (request) => {
    const { id } = request.params as { id: string };
    const { review, repo, trusted, runBranch, paths } = await agentReview(request.userId, id);
    const head = await trusted(["rev-parse", "HEAD"]).catch(() => "");
    const keptCommits = Boolean(review.initialHead && head && head !== review.initialHead && !runBranch);
    if (runBranch && review.initialHead && head !== review.initialHead) await trusted(["reset", "--quiet", "--mixed", review.initialHead]);
    for (const path of paths) {
      const existed = (await runTrustedGit({ userId: request.userId, cwd: repo, args: ["cat-file", "-e", `${review.startTree}:${path}`] })).exitCode === 0;
      if (existed) await trusted(["restore", `--source=${review.startTree}`, "--worktree", "--", path]);
      else await rm(join(repo, path), { force: true });
    }
    await prisma.codeReview.update({ where: { id: review.id }, data: { completedAt: new Date() } });
    if (review.job.task.owner === "agent" && ["waiting_approval", "done"].includes(review.job.task.status)) {
      await prisma.task.update({ where: { id: review.job.taskId }, data: { status: "todo", completedAt: null } });
    }
    await appendLedger({ userId: request.userId, actor: "me", action: "code.review.discard", taskId: review.job.taskId, payload: { review: review.id, paths, keptCommits } });
    return { ok: true, restored: paths.length, keptCommits };
  });

  /** The person's push: fast-forward, run branch only, to the URL the run was cloned from. */
  app.post("/api/code/reviews/:id/push", async (request) => {
    const { id } = request.params as { id: string };
    const { review, repo, branch } = await agentReview(request.userId, id);
    const pushed = await pushRunBranch({ prisma, userId: request.userId, job: review.job, root: repo, branch });
    await appendLedger({ userId: request.userId, actor: "me", action: "code.review.push", taskId: review.job.taskId, payload: { review: review.id, branch, exitCode: pushed.exitCode } });
    if (pushed.exitCode !== 0) throw new GitError(`The push was refused: ${pushed.output.trim().slice(-500)}`, 409);
    return { ok: true, branch, remote: pushed.remote };
  });

  /** The accepted-changes blob for a file of a review, if any. */
  function baselineSha(source: Awaited<ReturnType<typeof resolveSource>>, path: string): string | null {
    const row = source.review?.decisions.find((decision) => decision.path === path && decision.chunkKey === BASELINE);
    return row?.decision.startsWith("blob:") ? row.decision.slice(5) : null;
  }

  /**
   * The versions of one file the editor works from: before the run (`start`; for a checkout, the
   * index), the run's own (`agent`), what to compare against (`original`: before the run plus the
   * changes accepted so far; for a checkout, the index) and the file now (`current`). LF text.
   */
  app.get("/api/code/versions", async (request) => {
    const { path } = z.object({ path: z.string().min(1).max(1000) }).parse(request.query);
    const source = await resolveSource(request, request.query);
    const currentBytes = await readRepoBytes(source.repo, path).catch((error: unknown) => {
      if (error instanceof GitError && error.statusCode === 413) return Buffer.alloc(6 * 1024 * 1024);
      throw error;
    });
    const current = decode(currentBytes);
    let start = null;
    let agent = null;
    let original = null;
    if (source.review) {
      start = decode(await gitBlob(source.repo, `${source.review.startTree}:${path}`));
      agent = decode(await gitBlob(source.repo, `${source.review.endTree}:${path}`));
      const sha = baselineSha(source, path);
      original = sha ? decode(await gitBlob(source.repo, sha)) ?? start : start;
    } else {
      start = decode((await gitBlob(source.repo, `:${path}`)) ?? (await gitBlob(source.repo, `HEAD:${path}`)));
      original = start;
    }
    const all = [start, agent, original, current];
    return {
      path,
      kind: source.kind,
      start: start?.text ?? null,
      agent: agent?.text ?? null,
      original: original?.text ?? null,
      current: current?.text ?? null,
      exists: { start: Boolean(start), agent: Boolean(agent), current: Boolean(currentBytes) },
      binary: all.some((row) => row?.binary),
      tooLarge: all.some((row) => row?.tooLarge),
      eol: current?.eol ?? start?.eol ?? "lf",
      bom: current?.bom ?? false,
      hash: current?.tooLarge ? null : hashOf(currentBytes),
    };
  });

  /**
   * Keep changes. In a review the text they add up to becomes the file's new "compared against" (the
   * file on disk does not change); in a checkout it is staged, exactly as given.
   */
  app.post("/api/code/accept-content", async (request) => {
    const body = z
      .object({ review: z.string().uuid().optional(), repo: z.string().optional(), path: z.string().min(1).max(1000), content: z.string().max(5 * 1024 * 1024) })
      .parse(request.body);
    const source = await resolveSource(request, body);
    insideRepo(source.repo, body.path);
    if (source.review) {
      const sha = await writeBlob(source.repo, Buffer.from(body.content, "utf8"));
      await prisma.codeReviewDecision.upsert({
        where: { reviewId_path_chunkKey: { reviewId: source.review.id, path: body.path, chunkKey: BASELINE } },
        create: { reviewId: source.review.id, path: body.path, chunkKey: BASELINE, decision: `blob:${sha}` },
        update: { decision: `blob:${sha}`, at: new Date() },
      });
    } else {
      const like = decode(await readRepoBytes(source.repo, body.path));
      const sha = await writeBlob(source.repo, encode(body.content, like));
      const entry = (await git(source.repo, ["ls-files", "-s", "--", body.path]).catch(() => "")).trim();
      const mode = /^(\d{6}) /.exec(entry)?.[1] ?? "100644";
      await git(source.repo, ["update-index", "--add", "--cacheinfo", `${mode},${sha},${body.path}`]);
    }
    progressCache.clear();
    await appendLedger({ userId: request.userId, actor: "me", action: "code.accepted", payload: { repo: source.repo, path: body.path, review: source.review?.id ?? null } });
    return { ok: true };
  });

  /** Put one file back as the run left it: your edits and rejects in that file are dropped. */
  app.post("/api/code/restore", async (request) => {
    const body = z.object({ review: z.string().uuid(), path: z.string().min(1).max(1000) }).parse(request.body);
    const source = await resolveSource(request, body);
    if (!source.review) throw new GitError("Only a review has a run's version.");
    const bytes = await gitBlob(source.repo, `${source.review.endTree}:${body.path}`);
    if (bytes) await writeRepoBytes(source.repo, body.path, bytes);
    else await removeRepoFile(source.repo, body.path);
    await prisma.codeReviewDecision.deleteMany({ where: { reviewId: source.review.id, path: body.path } });
    progressCache.clear();
    await appendLedger({ userId: request.userId, actor: "me", action: "code.restore", payload: { repo: source.repo, path: body.path, review: source.review.id } });
    return { ok: true };
  });

  /** For each file of a review: the run's changes, those still to decide, and your own edits. */
  app.get("/api/code/progress", async (request) => {
    const source = await resolveSource(request, request.query);
    if (!source.review) return { files: [], total: 0, pending: 0, filesLeft: 0 };
    const review = source.review;
    const changed = await cachedChangedFiles(source.repo, review.startTree);
    const paths = [...new Set([...(review.agentPaths.length ? review.agentPaths : changed.map((file) => file.path))])].slice(0, 200);
    const files: Array<{ path: string; total: number; pending: number; yours: number }> = [];
    for (let index = 0; index < paths.length; index += 8) {
      const batch = await Promise.all(
        paths.slice(index, index + 8).map(async (path) => {
          const currentBytes = await readRepoBytes(source.repo, path).catch(() => null);
          const sha = baselineSha(source, path);
          const key = `${review.id}\0${path}\0${hashOf(currentBytes)}\0${sha ?? ""}`;
          const hit = readLru(progressCache, key);
          if (hit) return { path, ...hit.counts };
          const [start, end, baseline] = await Promise.all([
            gitBlob(source.repo, `${review.startTree}:${path}`),
            gitBlob(source.repo, `${review.endTree}:${path}`),
            sha ? gitBlob(source.repo, sha) : Promise.resolve(null),
          ]);
          const texts = [decode(start), decode(end), decode(baseline), decode(currentBytes)];
          const counts = texts.some((row) => row?.binary || row?.tooLarge)
            ? { total: 0, pending: 0, yours: 0 }
            : reviewCounts({ start: texts[0]?.text ?? null, end: texts[1]?.text ?? null, baseline: texts[2]?.text ?? null, current: texts[3]?.text ?? null });
          remember(progressCache, key, { at: Date.now(), counts }, 500);
          return { path, ...counts };
        }),
      );
      files.push(...batch);
    }
    const total = files.reduce((sum, file) => sum + file.total, 0);
    const pending = files.reduce((sum, file) => sum + file.pending, 0);
    return { files, total, pending, filesLeft: files.filter((file) => file.pending > 0).length };
  });

  /** One folder of the repository, for the explorer. Files of keys and secrets are flagged. */
  app.get("/api/code/tree", async (request) => {
    const query = z.object({ path: z.string().max(1000).default("") }).parse(request.query);
    const source = await resolveSource(request, request.query);
    const path = query.path.replace(/^\/+|\/+$/g, "");
    const listing = await listRepoFolder(source.repo, path);
    return {
      path,
      entries: listing.entries.map((entry) => ({ ...entry, secret: refusedPath(path ? `${path}/${entry.name}` : entry.name) !== null })),
      truncated: listing.truncated,
    };
  });

  /** Every file git knows here (tracked, and new ones not ignored), for "go to file". */
  app.get("/api/code/files", async (request) => {
    const source = await resolveSource(request, request.query);
    const raw = await git(source.repo, ["-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    const all = [...new Set(raw.split("\0").filter(Boolean))];
    return { files: all.slice(0, 20_000), truncated: all.length > 20_000 };
  });

  /** Find text in the repository's files (git grep: fixed text, tracked and new files, no binaries). */
  app.get("/api/code/search", async (request) => {
    const query = z.object({ q: z.string().min(1).max(200), case: z.enum(["0", "1"]).default("0") }).parse(request.query);
    const source = await resolveSource(request, request.query);
    const raw = await git(source.repo, ["-c", "core.fsmonitor=false", "grep", "-n", "-I", "--no-color", "-F", "--untracked", "-m", "20", ...(query.case === "1" ? [] : ["-i"]), "-e", query.q], { okCodes: [1] });
    const results: Array<{ path: string; line: number; text: string }> = [];
    for (const row of raw.split("\n")) {
      const match = /^(.*?):(\d+):(.*)$/.exec(row);
      if (!match) continue;
      results.push({ path: match[1]!, line: Number(match[2]), text: match[3]!.slice(0, 300) });
      if (results.length >= 500) break;
    }
    return { results, truncated: results.length >= 500 };
  });

  app.get("/api/code/file", async (request) => {
    const { path } = z.object({ path: z.string().min(1) }).parse(request.query);
    const source = await resolveSource(request, request.query);
    return { path, content: await readRepoFile(source.repo, path) };
  });

  /**
   * Save one file, keeping its own line endings and byte-order mark. With `expectedHash` (the file as
   * the editor last read it), a file that something else changed meanwhile is not overwritten: 409
   * with `conflict`, so the editor can offer to keep yours or use the one on disk.
   */
  app.put("/api/code/file", async (request, reply) => {
    const body = z
      .object({ review: z.string().uuid().optional(), repo: z.string().optional(), path: z.string().min(1), content: z.string(), expectedHash: z.string().nullable().optional() })
      .parse(request.body);
    const source = await resolveSource(request, body);
    const before = await readRepoBytes(source.repo, body.path);
    if (body.expectedHash !== undefined && hashOf(before) !== body.expectedHash) {
      return reply.code(409).send({ error: "The file changed on disk since you opened it.", conflict: true, hash: hashOf(before) });
    }
    const bytes = encode(body.content, decode(before));
    await writeRepoBytes(source.repo, body.path, bytes);
    progressCache.clear();
    await appendLedger({ userId: request.userId, actor: "me", action: "code.edit", payload: { repo: source.repo, path: body.path } });
    return { ok: true, hash: hashOf(bytes) };
  });

  // ── source control ──────────────────────────────────────────────────────

  const RepoBody = z.object({ repo: z.string().min(1) });

  app.get("/api/code/scm", async (request) => {
    const { repo } = RepoBody.parse(request.query);
    const allowed = await allowedRepo(repo, await roots(request.userId));
    const scm = await status(allowed);
    // Pushing straight to the default branch asks first (docs/16 §3).
    return { ...scm, defaultBranch: await defaultBranch(allowed, request.userId).catch(() => null) };
  });

  /**
   * What a commit from here would hold (docs/16 §3): in a review, the files this run changed (ticked)
   * and your own changes from before the run (not ticked); in a checkout, every changed file. Plus
   * what a pull request starts from: the repository's template, or the agent's own report.
   */
  app.get("/api/code/commit-plan", async (request) => {
    const source = await resolveSource(request, request.query);
    const scm = await status(source.repo);
    const changedNow = [...new Set([...scm.staged, ...scm.unstaged, ...scm.untracked].map((entry) => entry.path))].sort();
    let run: string[] = [];
    let before: string[] = [];
    if (source.review) {
      const review = source.review;
      const agentPaths = new Set(review.agentPaths);
      const priorRaw = review.initialHead
        ? await git(source.repo, ["diff", "--name-only", "--no-renames", review.initialHead, review.startTree]).catch(() => "")
        : "";
      const prior = new Set(priorRaw.split("\n").filter(Boolean));
      run = changedNow.filter((path) => agentPaths.has(path) || (!prior.has(path) && !agentPaths.size));
      before = changedNow.filter((path) => !run.includes(path));
    } else {
      before = changedNow;
    }
    const remote = scm.remote ?? "";
    return {
      branch: scm.branch,
      defaultBranch: await defaultBranch(source.repo, request.userId).catch(() => null),
      github: githubRepoOf(remote),
      run,
      before,
      model: source.review?.job.model ?? null,
      template: await pullRequestTemplate(source.repo),
      proposal: source.review?.job.summary?.slice(0, 20_000) ?? null,
    };
  });

  /** Commit exactly the ticked files, as they are on disk, in a throwaway index; hooks off. */
  app.post("/api/code/commit-paths", async (request) => {
    const body = z
      .object({ review: z.string().uuid().optional(), repo: z.string().optional(), paths: z.array(z.string().min(1).max(1000)).min(1).max(2000), message: z.string().min(1).max(20_000) })
      .parse(request.body);
    const source = await resolveSource(request, body);
    const settings = await loadSettings(prisma, request.userId);
    // Settings' commit author; else git's own; else the Ensemble account, so a computer without a git identity can still commit.
    let author = settings.terminal.commitAuthor || null;
    if (!author && !(await git(source.repo, ["config", "user.email"]).catch(() => "")).trim()) {
      const account = await prisma.user.findUnique({ where: { id: request.userId }, select: { name: true, email: true } });
      if (account?.email) author = `${account.name || account.email.split("@")[0]} <${account.email}>`;
    }
    const result = await commitPaths(source.repo, request.userId, { paths: body.paths, message: body.message, author, sign: settings.terminal.signCommits });
    progressCache.clear();
    await appendLedger({ userId: request.userId, actor: "me", action: "code.commit", payload: { repo: source.repo, commit: result.commit, paths: body.paths.slice(0, 50) } });
    return { ok: true, ...result };
  });

  /** Open a pull request on GitHub for this checkout's branch (pushed first). */
  app.post("/api/code/pull-request", async (request) => {
    const body = z
      .object({ review: z.string().uuid().optional(), repo: z.string().optional(), title: z.string().min(1).max(256), body: z.string().max(60_000).default(""), base: z.string().min(1).max(255), draft: z.boolean().default(false) })
      .parse(request.body);
    const source = await resolveSource(request, body);
    const scm = await status(source.repo);
    const github = githubRepoOf(scm.remote ?? "");
    if (!github) throw new GitError("This repository's origin is not on GitHub.");
    if (scm.branch === body.base) throw new GitError("Commit on a branch of its own to open a pull request; this is the base branch.");
    const token = await githubApiToken(prisma, request.userId);
    if (!token) throw new GitError(GITHUB_AUTH_HINT, 409);
    const opened = await openPullRequest({ token, owner: github.owner, repo: github.repo, head: scm.branch, base: body.base, title: body.title, body: body.body, draft: body.draft });
    await appendLedger({ userId: request.userId, actor: "me", action: "code.pull_request", payload: { repo: source.repo, url: opened.url, base: body.base, head: scm.branch } });
    return { ok: true, ...opened };
  });

  app.post("/api/code/scm/stage", async (request) => {
    const body = RepoBody.extend({ paths: z.array(z.string()).min(1) }).parse(request.body);
    const repo = await allowedRepo(body.repo, await roots(request.userId));
    await git(repo, ["add", "--", ...body.paths]);
    return { ok: true };
  });

  app.post("/api/code/scm/unstage", async (request) => {
    const body = RepoBody.extend({ paths: z.array(z.string()).min(1) }).parse(request.body);
    const repo = await allowedRepo(body.repo, await roots(request.userId));
    await git(repo, ["restore", "--staged", "--", ...body.paths]);
    return { ok: true };
  });

  app.post("/api/code/scm/discard", async (request) => {
    const body = RepoBody.extend({ paths: z.array(z.string()).min(1) }).parse(request.body);
    const repo = await allowedRepo(body.repo, await roots(request.userId));
    await git(repo, ["restore", "--", ...body.paths]);
    await appendLedger({ userId: request.userId, actor: "me", action: "code.discard", payload: { repo, paths: body.paths } });
    return { ok: true };
  });

  app.post("/api/code/scm/commit", async (request) => {
    const body = RepoBody.extend({ message: z.string().min(1), all: z.boolean().default(false) }).parse(request.body);
    const repo = await allowedRepo(body.repo, await roots(request.userId));
    const settings = await loadSettings(prisma, request.userId);
    const identity = settings.terminal.commitAuthor.match(/^(.+?)\s*<(.+)>$/);
    // Repository hooks do not run: a commit from the Code tab (here or from the web) runs no code from the folder.
    const args = [
      ...gitHardening(true),
      ...(identity ? ["-c", `user.name=${identity[1]}`, "-c", `user.email=${identity[2]}`] : []),
      "commit",
      ...(body.all ? ["-a"] : []),
      ...(settings.terminal.signCommits ? ["-S"] : []),
      "-m",
      body.message,
    ];
    const output = await git(repo, args);
    await appendLedger({ userId: request.userId, actor: "me", action: "code.commit", payload: { repo, message: body.message } });
    return { ok: true, output };
  });

  app.post("/api/code/scm/push", async (request) => {
    const { repo: raw } = RepoBody.parse(request.body);
    const repo = await allowedRepo(raw, await roots(request.userId));
    const output = await git(repo, [...gitHardening(true), "push", "-u", "origin", "HEAD"]);
    await appendLedger({ userId: request.userId, actor: "me", action: "code.push", payload: { repo } });
    return { ok: true, output };
  });

  app.post("/api/code/scm/pull", async (request) => {
    const { repo: raw } = RepoBody.parse(request.body);
    const repo = await allowedRepo(raw, await roots(request.userId));
    const output = await git(repo, [...gitHardening(true), "pull", "--ff-only"]);
    return { ok: true, output };
  });

  app.get("/api/code/actions", async (request) => {
    const { repo: raw } = RepoBody.parse(request.query);
    const repo = await allowedRepo(raw, await roots(request.userId));
    const scm = await status(repo);
    if (!scm.github) return { available: false, reason: "This repository has no GitHub remote." };
    return githubActions(scm.github, scm.branch);
  });
}
