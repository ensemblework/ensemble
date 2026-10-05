/**
 * One delegated task, start to finish.
 *
 * hub-api drives the loop (the tools, the jail and the ledger live here);
 * agent-runtime owns the model key and answers one turn at a time. The job
 * stops on finish(), on a plain answer, at a limit, or the moment Stop or the
 * kill switch aborts its signal — including the command it is running.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { hasModule, type Settings } from "@ensemble/shared-types";
import { PageDocument } from "@ensemble/shared-types";
import { beginActivity, endActivity, heartbeat, isCancelled, isPaused, updateActivity } from "../lib/activity.js";
import { appendLedger } from "../lib/ledger.js";
import { recordMetric } from "../lib/metrics.js";
import { assistantEcho, askRuntime, toolResult, type ModelMessage } from "../lib/model-turn.js";
import { estimateUsd } from "../lib/pricing.js";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";
import { pageText, writeAgentBlock } from "../pages/markdown.js";
import { GITHUB_AUTH_HINT, githubCloneAuth } from "../lib/git-auth.js";
import { parseRuntimeBody } from "../lib/model-error.js";
import { truncateText } from "../lib/text.js";
import { isOwnRunBranch, runBranchName, runTrustedGit } from "./git-gate.js";
import { flagPlanted } from "./planted.js";
import { gitHardening, GuardError, resolveWorkFolder, sandboxAvailable, within, workspaceRoot } from "./guard.js";
import { capabilities } from "./sandbox/spawn.js";
import { runCommand } from "./runner.js";
import { interruptionMessage } from "./lifecycle.js";
import { appendLive, dropLive } from "./live-log.js";
import { checkUnattended, isFolderTrusted, pathCovers, PATH_RULE_SOURCE, PATH_RULE_TOOL, rulesForJob, UNATTENDED_MESSAGE, type SandboxStrength } from "./trust.js";
import { askPerson, chatSpecs, responsesSpecs, runTool, toolSpecs, type JobContext } from "./tools.js";

export interface JobControl {
  signal: AbortSignal;
  /** Frees the execution slot while a person answers; resolves when a slot is back. */
  waitForPerson: <T>(work: () => Promise<T>) => Promise<T>;
}

class LimitReached extends Error {}

const DANGEROUS_GIT_CONFIG = /\b(filter\.|textconv|external|fsmonitor|hookspath|sshcommand|askpass|pager|editor|gpg\.program|credential\.helper)|=\s*!/i;

function outcomeTone(kind: string) {
  return kind === "research" ? "research" : "workspace";
}

async function gitIn(
  ctx: Pick<JobContext, "root" | "sandboxed" | "signal" | "job">,
  args: string[],
  options: { network?: boolean; credentials?: boolean; env?: Record<string, string>; config?: string[]; timeoutMs?: number } = {},
) {
  return runCommand({
    argv: ["git", ...gitHardening(false), ...(options.config ?? []), ...args],
    cwd: ctx.root,
    root: ctx.root,
    sandboxed: ctx.sandboxed,
    network: options.network ?? false,
    useCredentials: false,
    who: "agent",
    readOnly: ctx.job.accessMode === "review" ? [ctx.root] : [],
    readWrite: ctx.job.accessMode === "review" ? [] : [ctx.root],
    timeoutMs: options.timeoutMs ?? 120_000,
    signal: ctx.signal,
    group: ctx.job.id,
    extraEnv: options.env,
  });
}

/** The folder as a git tree, through a throwaway index so the real staging area is untouched. */
async function snapshot(ctx: Pick<JobContext, "root" | "sandboxed" | "signal" | "job">): Promise<string | null> {
  const index = join(tmpdir(), `ensemble-index-${randomUUID()}`);
  try {
    await gitIn(ctx, ["read-tree", "HEAD"], { env: { GIT_INDEX_FILE: index } });
    const added = await gitIn(ctx, ["add", "-A"], { env: { GIT_INDEX_FILE: index } });
    if (added.exitCode !== 0) return null;
    const tree = await gitIn(ctx, ["write-tree"], { env: { GIT_INDEX_FILE: index } });
    return tree.exitCode === 0 ? tree.output.trim() : null;
  } finally {
    await rm(index, { force: true });
  }
}

async function isGitRepo(root: string): Promise<boolean> {
  return stat(join(root, ".git")).then(() => true).catch(() => false);
}

async function gitConfigHash(root: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(join(root, ".git", "config"))).digest("hex");
  } catch {
    return null;
  }
}

function prompt(kind: string, ctx: JobContext, settings: Settings, name: string): string {
  void settings;
  const limits = `Budget: at most ${ctx.job.maxToolCalls} tool calls, ${ctx.job.maxTurns} model turns and ${ctx.job.maxMinutes} minutes. Plan so you finish inside it.`;
  if (kind === "research") {
    return `You are Ensemble's research agent, working for ${name} on one task from their board.

How to work:
- Work from real sources. Use search_papers for academic literature, web_search for everything else, and fetch_url to read a source before you rely on it.
- Never invent a paper, author, year, number, quote or URL. If you could not verify something, say so.
- Cite inline as [Author et al., Year](url). End with a short "Sources" list.
- Follow the structure the page asks for. If it lists subtopics, cover each under its own heading. Use tables to compare approaches when that helps.
- Save the deliverable with write_page, in Markdown. Call write_page again to replace it as it improves. Do not paste the deliverable into chat.
- If only the person can make a decision that blocks you, call ask_user with 2–5 concrete options. Otherwise choose sensibly and say what you chose.
- Stop searching once you have enough to answer well.
- End with finish(summary): what you produced, how thorough it is, and what is still open.

${limits}`;
  }
  const delivery =
    ctx.job.delivery === "push"
      ? `You may commit and push${ctx.chosenBranch ? ` to ${ctx.chosenBranch}` : " the current branch"}. Never force-push, never delete branches.`
      : ctx.job.delivery === "commit"
        ? "You may commit locally. You may not push."
        : "You may not commit or push. Leave your changes uncommitted in the folder.";
  return `You are Ensemble's coding agent, working for ${name} on one task from their board.

Where you work: ${ctx.root}
- File tools and commands only reach inside this folder. Paths are relative to it.
- ${ctx.sandboxed ? "Commands run in a macOS sandbox: writes outside the folder, reading keys and credentials, and connecting to localhost are blocked." : "Commands run directly on the person's computer, not in a sandbox. Stay inside the folder."}
- Network: ${ctx.network ? "on" : "off"}.
- Git: ${delivery}${ctx.job.askBeforePublish && ctx.job.delivery !== "local" ? " Each commit waits for approval on Needs me. A push is fast-forward only, to this run's own branch, and Ensemble performs it." : " A push, if this task allows one, is fast-forward only to this run's own branch, and Ensemble performs it."}
- Credentials: you have none. Ensemble may clone and push with the person's sign-in from outside the sandbox. You cannot read that token, and a command that prints the environment will not show it.

How to work:
- run_command takes one program and its arguments. No pipes, redirects, &&, or shell -c. Run scripts through their interpreter (python app.py, node x.js, bash run.sh).
- Look before you change: list_dir and read_file first. Use edit_file for small changes, write_file for new files.
- Verify once, then change the code if it is wrong. Do not run the same command again unless you edited a file first. \`python file.py\` only checks the test if that file calls the test under \`if __name__\`; use \`python -m pytest\` or \`python -m unittest\`.
- A refusal from a tool is policy, not a bug. Do not try another route to the same thing. Mention it in your summary.
- Do not touch anything outside the task. Do not change git config or remotes.
- If the task asks for an analysis or a report, save it with write_page as well.
- If only the person can make a decision that blocks you, call ask_user with 2–5 concrete options.
- End with finish(summary): what changed (files), what you ran and the results, and anything left open.

${limits}`;
}

async function brief(app: FastifyInstance, ctx: JobContext, settings: Settings): Promise<string> {
  const task = await app.prisma.task.findFirst({
    where: { id: ctx.taskId },
    include: { page: true, project: { select: { name: true, notes: true } }, repo: { select: { fullName: true } } },
  });
  const doc = task?.page?.content ? PageDocument.parse(task.page.content) : null;
  const owner = await app.prisma.user.findUnique({ where: { id: ctx.userId }, select: { moduleSet: true } });
  const skills = hasModule(owner?.moduleSet, "skills")
    ? await app.prisma.skill.findMany({
        where: { userId: ctx.userId, deletedAt: null, enabled: true, ...(task?.skillIds.length ? { id: { in: task.skillIds } } : {}) },
        select: { name: true, body: true },
        take: 6,
      })
    : [];
  const previous = ctx.job.continueFromJobId
    ? await app.prisma.workspaceJob.findUnique({ where: { id: ctx.job.continueFromJobId }, include: { task: { select: { title: true } } } })
    : null;
  const parts = [
    `# Task: ${task?.title ?? ctx.taskTitle}`,
    task?.description ? `Description: ${task.description}` : "",
    task?.project ? `Project: ${task.project.name}${task.project.notes ? `\n${task.project.notes.slice(0, 1500)}` : ""}` : "",
    task?.repo ? `Linked repository: ${task.repo.fullName}` : "",
    `## The task page\n${pageText(doc, task?.notes ?? "").slice(0, 12_000) || "(empty)"}`,
    ctx.job.instructions ? `## Instructions for this attempt\n${ctx.job.instructions}` : "",
    previous
      ? `## This continues an earlier task\n“${previous.task.title}” worked in this same folder and ended ${previous.status}.\n${previous.summary ?? ""}`
      : "",
    skills.length
      ? `## ${task?.skillIds.length ? "Skills picked for this task" : "Enabled skills"} (follow them where they apply)\n${skills.map((skill) => `### ${skill.name}\n${skill.body.slice(0, 900)}`).join("\n\n")}`
      : "",
    `Today is ${new Date().toISOString().slice(0, 10)} (${settings.timezone}).`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** Chooses and prepares the folder: a fresh checkout, a folder the person granted, or an earlier job's. */
async function prepareFolder(app: FastifyInstance, ctx: JobContext): Promise<{ root: string; git: boolean }> {
  const job = ctx.job;
  const base = await workspaceRoot();
  if (job.externalRoot) return { root: await resolveWorkFolder(job.externalRoot), git: await isGitRepo(job.externalRoot) };
  if (job.continueFromJobId) {
    const previous = await app.prisma.workspaceJob.findUnique({ where: { id: job.continueFromJobId }, select: { repoPath: true, externalRoot: true } });
    const folder = previous?.externalRoot ?? previous?.repoPath;
    if (!folder) throw new GuardError("The earlier task never got a folder, so there is nothing to continue from.");
    const root = previous?.externalRoot ? await resolveWorkFolder(folder) : folder;
    if (!previous?.externalRoot && !within(base, root)) throw new GuardError("The earlier task's folder is outside the workspace.");
    await stat(root).catch(() => {
      throw new GuardError("The earlier task's folder no longer exists.");
    });
    const git = await isGitRepo(root);
    // A Ensemble folder created before the empty-commit fix has a repo and no HEAD.
    // User-attached folders and clones (anything with a remote or an existing commit) stay as they are.
    if (git && !previous?.externalRoot) {
      const remote = await gitIn({ ...ctx, root }, ["remote"]);
      if (remote.exitCode !== 0 || !remote.output.trim()) await commitUnbornHead({ ...ctx, root });
    }
    return { root, git };
  }
  const root = join(base, "runs", job.id);
  await mkdir(root, { recursive: true });
  const prep = { ...ctx, root };
  if (job.repoUrl) {
    await ctx.progress(`Cloning ${job.repoUrl}`);
    const source = job.repoUrl.trim();
    const local = source.startsWith("/");
    if (local && !within(base, source) && !(await resolveWorkFolder(source).then(() => true).catch(() => false))) {
      throw new GuardError("That repository folder is not one Ensemble may read.");
    }
    const auth =
      job.useCredentials && !local
        ? await githubCloneAuth(ctx.prisma, ctx.userId, source)
        : { config: [] as string[], env: {} as Record<string, string>, missing: false };
    const cloned = await runTrustedGit({
      cwd: root,
      args: ["clone", "--quiet", "--template=", source, "."],
      credentialEnv: local ? undefined : auth.env,
      credentialConfig: auth.config,
      timeoutMs: 600_000,
    });
    if (cloned.exitCode !== 0) {
      const text = cloned.output.trim().slice(-600);
      const authFailed = /Authentication|could not read Username|Permission denied|Repository not found|terminal prompts disabled/i.test(text);
      throw new GuardError(
        authFailed
          ? job.useCredentials
            ? `${GITHUB_AUTH_HINT} (${text})`
            : `The clone was refused. If this repository is private, allow “Use my git sign-in” for this task. (${text})`
          : `The clone failed: ${text}`,
      );
    }
    return { root, git: true };
  }
  const entries = await readdir(root);
  // HEAD has to exist. Review diffs against it, and an unborn branch comes back as 409.
  // Only a brand-new empty folder is initialised. An existing checkout is left as it was.
  if (!entries.length) {
    const init = await gitIn(prep, ["init", "--quiet", "--template="]);
    if (init.exitCode !== 0) throw new GuardError(`Could not prepare the folder: ${init.output.trim().slice(-300)}`);
    await commitUnbornHead(prep);
  }
  return { root, git: true };
}

const INITIAL_COMMIT = ["-c", "user.name=Ensemble Agent", "-c", "user.email=agent@ensemble.local", "-c", "commit.gpgsign=false"];

/** One empty commit so review has a HEAD. Repos that already have commits are left alone. */
async function commitUnbornHead(ctx: Parameters<typeof gitIn>[0]): Promise<void> {
  const head = await gitIn(ctx, ["rev-parse", "--verify", "HEAD"]);
  if (head.exitCode === 0) return;
  const committed = await gitIn(ctx, ["commit", "--allow-empty", "--quiet", "--no-verify", "-m", "Initial empty commit"], {
    config: INITIAL_COMMIT,
  });
  if (committed.exitCode !== 0) throw new GuardError(`Could not prepare the folder: ${committed.output.trim().slice(-300)}`);
}

async function prepareBranch(ctx: JobContext): Promise<string> {
  const job = ctx.job;
  if (job.externalRoot) {
    if (job.branchMode !== "as-is") {
      throw new GuardError("A folder outside the workspace stays on its current branch. Switching and stashing are refused.");
    }
    const current = await gitIn(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return current.exitCode === 0 ? current.output.trim() : "";
  }
  if (!job.continueFromJobId) {
    const branch =
      job.branchMode === "existing" && job.branch && isOwnRunBranch(job.branch, job.id)
        ? job.branch
        : runBranchName(job.id, job.branchMode === "new" && job.branch ? job.branch : ctx.taskTitle);
    const made = await runTrustedGit({ cwd: ctx.root, args: ["checkout", "-B", branch] });
    if (made.exitCode !== 0) throw new GuardError(`Could not create branch ${branch}: ${made.output.trim().slice(-300)}`);
    return branch;
  }
  if (job.branchMode === "new" && job.branch) {
    const made = await gitIn(ctx, ["switch", "-c", job.branch]);
    if (made.exitCode !== 0) throw new GuardError(`Could not create branch ${job.branch}: ${made.output.trim().slice(-300)}`);
  } else if (job.branchMode === "existing" && job.branch) {
    let switched = await gitIn(ctx, ["switch", job.branch]);
    if (switched.exitCode !== 0 && ctx.network && job.useCredentials) {
      const auth = await githubCloneAuth(ctx.prisma, ctx.userId, job.repoUrl || "https://github.com/");
      await runTrustedGit({ cwd: ctx.root, args: ["fetch", "--quiet", "origin", job.branch], credentialEnv: auth.env, credentialConfig: auth.config });
      switched = await gitIn(ctx, ["switch", job.branch]);
    } else if (switched.exitCode !== 0 && ctx.network) {
      await gitIn(ctx, ["fetch", "--quiet", "origin", job.branch], { network: true });
      switched = await gitIn(ctx, ["switch", job.branch]);
    }
    if (switched.exitCode !== 0) throw new GuardError(`Branch ${job.branch} was not found: ${switched.output.trim().slice(-300)}`);
  }
  const current = await gitIn(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return current.exitCode === 0 ? current.output.trim() : job.branch;
}

export async function executeJob(app: FastifyInstance, jobId: string, control: JobControl): Promise<void> {
  const { prisma, redis } = app;
  const job = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: jobId }, include: { task: true } });
  const userId = job.userId;
  const settings = await loadSettings(prisma, userId);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const started = Date.now();
  const activityId = `job:${job.id}`;
  const deadline = started + job.maxMinutes * 60_000;

  const run = await prisma.run.create({
    data: {
      taskId: job.taskId,
      userId,
      worker: outcomeTone(job.kind),
      requestedModel: job.model,
      complexity: job.task.complexity,
      assignmentInstructions: job.instructions || null,
    },
  });
  await prisma.workspaceJob.update({ where: { id: job.id }, data: { runId: run.id, startedAt: new Date(), progress: "Starting" } });
  if (job.task.status !== "in_progress") {
    await prisma.task.update({ where: { id: job.taskId }, data: { status: "in_progress", owner: "agent" } });
    await prisma.taskTransition.create({
      data: { userId, taskId: job.taskId, fromStatus: job.task.status, toStatus: "in_progress", fromOwner: job.task.owner, toOwner: "agent", actor: "agent", reason: "Agent started", runId: run.id },
    });
  }
  const publish = () => {
    sseHub.publish(userId, { event: "workspace", data: { id: job.id } });
    sseHub.publish(userId, { event: "task", data: { id: job.taskId, action: "agent" } });
  };
  publish();
  await beginActivity(redis, userId, { id: activityId, kind: "workspace", label: job.task.title, detail: "Starting", model: job.model });

  let lastProgress = 0;
  const caps = capabilities();
  const sandboxed = job.executionMode === "sandbox" && sandboxAvailable;
  const strength: SandboxStrength = sandboxed ? "strong" : caps.strength === "ask" ? "ask" : "advisory";
  const ctx: JobContext = {
    prisma,
    job,
    userId,
    taskId: job.taskId,
    taskTitle: job.task.title,
    runId: run.id,
    root: "",
    sandboxed,
    strength,
    network: job.networkAccess,
    signal: control.signal,
    commitAuthor: settings.terminal.commitAuthor,
    chosenBranch: job.branchMode === "as-is" ? undefined : job.branch || undefined,
    trusted: true,
    explicitTrust: false,
    silentWorkspace: settings.orchestration.runWithoutAsking,
    accessMode: job.accessMode === "review" ? "review" : "read-write",
    runBranch: "",
    blockedOutside: [],
    touched: new Set(),
    wrotePage: false,
    finished: null,
    async progress(text) {
      appendLive(job.id, `· ${text}\n`);
      await prisma.workspaceJob.update({ where: { id: job.id }, data: { progress: text.slice(0, 200) } });
      await updateActivity(redis, userId, activityId, { detail: text.slice(0, 160) });
      if (Date.now() - lastProgress > 700) {
        lastProgress = Date.now();
        sseHub.publish(userId, { event: "workspace", data: { id: job.id, progress: text } });
      }
    },
    async event(kind, data) {
      await prisma.workspaceEvent.create({ data: { jobId: job.id, kind, data: data as never } });
    },
    waitForPerson: control.waitForPerson,
  };

  let outcome: "success" | "failed" | "cancelled" | "blocked" | "interrupted" = "failed";
  let error: string | null = null;
  let finalText = "";
  let startTree: string | null = null;
  let configHash: string | null = null;
  let git = false;
  let initialHead = "";
  const counts = { turns: 0, tools: 0, tokensIn: 0, tokensOut: 0 };
  const repeats = new Map<string, { outcome: string; count: number }>();

  const stopCheck = async () => {
    if (control.signal.aborted) throw new DOMException("Stopped", "AbortError");
    if ((await isPaused(redis, userId)) || (await isCancelled(redis, userId, activityId))) throw new DOMException("Stopped", "AbortError");
  };

  const readTrust = async () => {
    const base = await workspaceRoot();
    const trustRows = await prisma.decisionRule.findMany({
      where: { userId, source: PATH_RULE_SOURCE, toolName: PATH_RULE_TOOL, decision: "allow" },
    });
    const rules = rulesForJob(trustRows, job.id);
    ctx.explicitTrust = rules.some((rule) => pathCovers(rule, ctx.root));
    ctx.trusted = isFolderTrusted({ folder: ctx.root, workspaceRoot: base, rules });
  };
  ctx.refreshTrust = readTrust;
  /**
   * At start and before every turn. A trust rule revoked mid-run pauses an
   * unattended job on Needs me instead of letting it carry on unprompted.
   */
  const ensureTrust = async (starting: boolean) => {
    if (job.kind !== "code" || !ctx.root) return;
    const wasTrusted = ctx.trusted;
    await readTrust();
    const unattended = checkUnattended({ unattended: job.unattended, trusted: ctx.trusted });
    if (!unattended) return;
    if (!starting && wasTrusted) await ctx.event("trust_revoked", { root: ctx.root });
    await ctx.progress(starting ? "Waiting: this folder is not trusted" : "Paused: trust for this folder was removed");
    const answer = await askPerson(ctx, {
      event: "question",
      toolName: "Question",
      title: starting ? UNATTENDED_MESSAGE : `Trust for this folder was removed while the task ran unattended. ${UNATTENDED_MESSAGE}`,
      options: ["Trust this folder", "Turn off Run unattended"],
      allowCustom: false,
    });
    if (answer.answer === "Trust this folder") {
      const folder = within(await workspaceRoot(), ctx.root) ? ctx.root : await resolveWorkFolder(ctx.root);
      await prisma.decisionRule.create({
        data: { userId, source: PATH_RULE_SOURCE, toolName: PATH_RULE_TOOL, pattern: folder, decision: "allow", sessionId: null },
      });
      await readTrust();
    } else if (answer.answer === "Turn off Run unattended") {
      job.unattended = false;
      await prisma.workspaceJob.update({ where: { id: job.id }, data: { unattended: false } });
    } else {
      throw unattended;
    }
  };

  try {
    if (job.executionMode === "sandbox" && !sandboxAvailable && job.kind === "code") {
      await ctx.event("not_sandboxed", { reason: caps.reason, strength });
    }
    if (job.provider === "cursor") {
      throw new GuardError("Cursor runs its own cloud agents on GitHub, not local tasks. Pick a chat model (Gemini, OpenAI, Claude…) for work on this Mac.");
    }
    if (job.kind === "code") {
      if (ctx.accessMode === "review") ctx.network = false;
      const folder = await prepareFolder(app, ctx);
      ctx.root = folder.root;
      git = folder.git;
      const branch = git ? await prepareBranch(ctx) : "";
      ctx.runBranch = branch;
      await ensureTrust(true);
      if (git) {
        const head = await gitIn(ctx, ["rev-parse", "HEAD"]);
        initialHead = head.exitCode === 0 ? head.output.trim() : "";
        startTree = await snapshot(ctx);
        configHash = await gitConfigHash(ctx.root);
      }
      await prisma.workspaceJob.update({ where: { id: job.id }, data: { repoPath: ctx.root, branch } });
      await ctx.event("prepared", { root: ctx.root, branch, git, sandboxed: ctx.sandboxed });
      publish();
    }

    const specs = toolSpecs(job.kind, ctx.network);
    const messages: ModelMessage[] = [
      { role: "system", content: prompt(job.kind, ctx, settings, user?.name || "the person") },
      { role: "user", content: await brief(app, ctx, settings) },
    ];
    await ctx.progress("Thinking");

    for (let turn = 0; ; turn += 1) {
      await stopCheck();
      if (turn > 0) await ensureTrust(false);
      if (turn >= job.maxTurns) throw new LimitReached(`Reached the limit of ${job.maxTurns} model turns.`);
      if (Date.now() > deadline) throw new LimitReached(`Reached the ${job.maxMinutes}-minute limit.`);
      await heartbeat(redis, userId, activityId);
      const stepStarted = new Date();
      const ask = () =>
        askRuntime({
          messages,
          model: job.model,
          provider: job.provider ?? undefined,
          ollamaUrl: settings.models.ollamaUrl,
          ...(job.reasoningEffort && job.reasoningEffort !== "default" ? { reasoningEffort: job.reasoningEffort } : {}),
          userId,
          activityId,
          chatTools: chatSpecs(specs),
          responsesTools: responsesSpecs(specs),
          signal: control.signal,
          timeoutMs: 90_000,
        });
      let answer;
      try {
        answer = await ask();
      } catch (failure) {
        if (control.signal.aborted || !(failure instanceof Error)) throw failure;
        const parsed = parseRuntimeBody(0, failure.message);
        const retryable = parsed.kind === "unavailable" || parsed.kind === "rate_limit" || /timed out|\(5\d\d\)/.test(failure.message);
        if (!retryable || parsed.kind === "quota") throw failure;
        let last = failure;
        answer = undefined;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const wait = Math.round(((parsed.retryAfterSeconds ?? 1.5) * 1000) * 2 ** attempt + Math.random() * 400);
          await ctx.progress(parsed.kind === "rate_limit" ? "The model is rate-limiting. Waiting, then continuing." : "The model was busy. Continuing from this step.");
          await new Promise((resolve) => setTimeout(resolve, wait));
          try {
            answer = await ask();
            break;
          } catch (again) {
            last = again instanceof Error ? again : failure;
            const next = parseRuntimeBody(0, last.message);
            if (next.kind === "quota") throw last;
          }
        }
        if (!answer) throw last;
      }
      counts.turns += 1;
      counts.tokensIn += answer.tokensIn ?? 0;
      counts.tokensOut += answer.tokensOut ?? 0;
      await recordMetric(prisma, {
        userId,
        kind: "model.call",
        taskId: job.taskId,
        runId: run.id,
        meta: {
          provider: job.provider ?? null,
          model: answer.model || job.model,
          purpose: job.kind === "research" ? "Agent research" : "Agent coding",
          tokensIn: answer.tokensIn,
          tokensOut: answer.tokensOut,
          estimatedUsd: estimateUsd(answer.model || job.model, answer.tokensIn, answer.tokensOut),
          title: job.task.title,
        },
      });
      messages.push(assistantEcho(answer));

      const calls: Array<{ name: string; args: unknown; ok: boolean; summary: string }> = [];
      if (!answer.toolCalls.length) {
        finalText = answer.text.trim();
        await prisma.runStep.create({
          data: { runId: run.id, index: turn, title: "Answer", status: "done", output: truncateText(finalText, 8000), model: answer.model, tokensIn: answer.tokensIn, tokensOut: answer.tokensOut, startedAt: stepStarted, endedAt: new Date() },
        });
        break;
      }
      for (const call of answer.toolCalls) {
        await stopCheck();
        if (counts.tools >= job.maxToolCalls) throw new LimitReached(`Reached the limit of ${job.maxToolCalls} tool calls.`);
        counts.tools += 1;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
        } catch {
          messages.push(toolResult(call.id, call.name, { error: "Arguments were not valid JSON. Call again with valid JSON." }));
          continue;
        }
        const startedCall = Date.now();
        const signature = `${call.name}:${JSON.stringify(args)}`;
        const result = await runTool(ctx, call.name, args);
        const outcome = JSON.stringify(result.result).slice(0, 2000);
        const seen = repeats.get(signature);
        if (seen && seen.outcome === outcome) {
          seen.count += 1;
          if (seen.count >= 1 && result.result && typeof result.result === "object") {
            (result.result as Record<string, unknown>).note =
              "This exact call already returned the same result. Do not run it again. Edit the code, or finish and say what is blocking you.";
          }
        } else repeats.set(signature, { outcome, count: 0 });
        calls.push({ name: call.name, args: truncateArgs(args), ok: result.ok, summary: result.summary });
        await ctx.event("tool", { name: call.name, ok: result.ok, summary: result.summary, ms: Date.now() - startedCall });
        messages.push(toolResult(call.id, call.name, clip(result.result)));
        if (ctx.finished) break;
      }
      await prisma.runStep.create({
        data: {
          runId: run.id,
          index: turn,
          title: calls.map((call) => call.name).join(", ").slice(0, 120) || "Tools",
          status: calls.every((call) => call.ok) ? "done" : "failed",
          toolCalls: calls as never,
          output: truncateText(answer.text, 4000) || null,
          model: answer.model,
          tokensIn: answer.tokensIn,
          tokensOut: answer.tokensOut,
          startedAt: stepStarted,
          endedAt: new Date(),
        },
      });
      await prisma.workspaceJob.update({ where: { id: job.id }, data: { turns: counts.turns, toolCalls: counts.tools, tokensIn: counts.tokensIn, tokensOut: counts.tokensOut } });
      if (ctx.finished) {
        finalText = ctx.finished;
        break;
      }
    }
    outcome = "success";
  } catch (failure) {
    const interrupted = interruptionMessage(control.signal);
    if (interrupted) {
      outcome = "interrupted";
      error = interrupted;
    } else if (failure instanceof DOMException && failure.name === "AbortError") {
      outcome = "cancelled";
      error = (await isPaused(redis, userId)) ? "Stopped by the kill switch." : "Stopped.";
    } else if (control.signal.aborted) {
      outcome = "cancelled";
      error = "Stopped.";
    } else if (failure instanceof LimitReached) {
      outcome = "blocked";
      error = `${failure.message} Progress so far is kept.`;
    } else {
      outcome = "failed";
      const raw = failure instanceof Error ? failure.message : String(failure);
      const parsed = parseRuntimeBody(0, raw);
      error =
        parsed.kind === "quota"
          ? "The model provider refused the call: this key is out of quota. The work already done in the folder is kept."
          : parsed.kind === "rate_limit"
            ? "The model is rate-limiting this key. The work already done in the folder is kept — run the task again to continue."
            : parsed.kind === "unavailable"
              ? "The model was unavailable. The work already done in the folder is kept — run the task again to continue."
              : raw.slice(0, 500);
    }
  }

  // ── wrap up: evidence, page, task ───────────────────────────────────────
  const blockedNote = ctx.blockedOutside.length
    ? `Blocked outside the trusted folder: ${[...new Set(ctx.blockedOutside)].join(", ")}.`
    : "";
  const summary = [finalText || (outcome === "success" ? "Done." : error ?? ""), blockedNote].filter(Boolean).join("\n");
  let reviewId: string | null = null;
  let changes = "";
  const wrapCtx = { ...ctx, signal: new AbortController().signal };
  if (job.kind === "code" && git && startTree && ctx.root) {
    try {
      const endTree = await snapshot(wrapCtx);
      const newHash = await gitConfigHash(ctx.root);
      const configChanged = newHash !== configHash;
      const risky = configChanged && DANGEROUS_GIT_CONFIG.test(await readFile(join(ctx.root, ".git", "config"), "utf8").catch(() => ""));
      if (risky) {
        error = `${error ? `${error} ` : ""}The run changed .git/config in a way that could run code. Review it by hand before using git here.`;
        if (outcome === "success") outcome = "blocked";
      }
      if (endTree && endTree !== startTree) {
        const stat = await gitIn(wrapCtx, ["diff", "--no-ext-diff", "--no-textconv", "--stat", startTree, endTree]);
        const names = await gitIn(wrapCtx, ["diff", "--no-ext-diff", "--name-only", startTree, endTree]);
        const paths = names.output.split("\n").filter(Boolean);
        const planted = flagPlanted(
          await Promise.all(
            paths.map(async (path) => ({
              path,
              text: await readFile(join(ctx.root, path), "utf8").catch(() => undefined),
            })),
          ),
        );
        changes = stat.output.trim();
        if (planted.length) {
          changes += `\n\nFlagged — these can run later, outside the sandbox, when the folder is opened:\n${planted.map((hit) => `- ${hit.path}: ${hit.reason}`).join("\n")}`;
        }
        if (!risky) {
          const review = await prisma.codeReview.create({
            data: {
              userId,
              jobId: job.id,
              repoPath: ctx.root,
              initialHead,
              startTree,
              endTree,
              agentPaths: paths,
              attributed: true,
              expiresAt: new Date(Date.now() + 14 * 86_400_000),
            },
          });
          reviewId = review.id;
        }
      }
    } catch (failure) {
      app.log.warn({ err: failure }, "workspace snapshot failed");
    }
  }

  try {
    if (outcome === "success" || finalText) {
      if (job.kind === "research" && !ctx.wrotePage && finalText) {
        await writeAgentBlock(prisma, userId, job.taskId, finalText, { jobId: job.id, runId: run.id, model: job.model });
      } else if (job.kind === "code" && !ctx.wrotePage) {
        const report = [
          `**Result.** ${summary}`,
          changes ? `**Files changed**\n\n\`\`\`\n${changes}\n\`\`\`` : "No files changed.",
          reviewId ? `[Review the changes in the Code tab](/code/review?review=${reviewId})` : "",
        ].filter(Boolean).join("\n\n");
        await writeAgentBlock(prisma, userId, job.taskId, report, { jobId: job.id, runId: run.id, model: job.model, title: "Agent report" });
      }
    }
  } catch (failure) {
    app.log.warn({ err: failure }, "could not write agent output to the page");
  }

  const taskStatus =
    outcome === "success"
      ? job.markDone && !reviewId
        ? "done"
        : "waiting_approval"
      : outcome === "cancelled"
        ? "todo"
        : "blocked";
  const fresh = await prisma.task.findUnique({ where: { id: job.taskId }, select: { status: true, owner: true } });
  if (fresh && fresh.owner === "agent" && fresh.status !== taskStatus) {
    await prisma.task.update({
      where: { id: job.taskId },
      data: {
        status: taskStatus,
        completedAt: taskStatus === "done" ? new Date() : null,
        blockedQuestion: taskStatus === "blocked" ? ({ question: error ?? "The agent stopped.", options: [] } as never) : undefined,
      },
    });
    await prisma.taskTransition.create({
      data: { userId, taskId: job.taskId, fromStatus: fresh.status, toStatus: taskStatus, fromOwner: "agent", toOwner: "agent", actor: "agent", reason: error ?? "Agent finished", runId: run.id },
    });
  }
  await prisma.run.update({
    where: { id: run.id },
    data: {
      endedAt: new Date(),
      outcome: outcome === "success" ? "success" : outcome === "cancelled" || outcome === "interrupted" ? "cancelled" : outcome === "blocked" ? "needs_info" : "failed",
      error,
      result: truncateText(summary, 20_000) || null,
    },
  });
  await prisma.workspaceJob.update({
    where: { id: job.id },
    data: {
      status: outcome === "success" ? "succeeded" : outcome,
      finishedAt: new Date(),
      error,
      summary: truncateText(summary, 4000),
      progress: outcome === "success" ? "Finished" : outcome === "interrupted" ? "Interrupted" : error ? truncateText(error, 200) : "Stopped",
      turns: counts.turns,
      toolCalls: counts.tools,
      tokensIn: counts.tokensIn,
      tokensOut: counts.tokensOut,
      activeProcess: undefined,
    },
  });
  dropLive(job.id);
  await endActivity(redis, userId, activityId);
  await appendLedger({
    userId,
    actor: "agent",
    action: `workspace.job.${outcome}`,
    taskId: job.taskId,
    runId: run.id,
    payload: { jobId: job.id, kind: job.kind, model: job.model, turns: counts.turns, tools: counts.tools, ms: Date.now() - started, root: ctx.root || null, error },
  });
  await prisma.notification.create({
    data: {
      userId,
      kind: "agent",
      title:
        outcome === "success"
          ? `Agent finished: ${job.task.title}`
          : outcome === "interrupted"
            ? `Agent interrupted: ${job.task.title}`
            : `Agent ${outcome === "cancelled" ? "stopped" : "needs you"}: ${job.task.title}`,
      body: (error ?? summary).slice(0, 300),
      url: `/tasks/${job.taskId}`,
    },
  });
  publish();
  sseHub.publish(userId, { event: "page", data: { taskId: job.taskId } });
}

function truncateArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === "string" && value.length > 400 ? `${value.slice(0, 400)}…` : value]));
}

function clip(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text.length <= 24_000) return value;
  return { truncated: true, preview: text.slice(0, 24_000) };
}
