/**
 * A claimed hosted job becomes one local job, through the same createJob path
 * as Assign. A spec the Mac will not run is recorded as failed, here and on
 * the hosted row, and nothing is started.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma, PrismaClient } from "@prisma/client";
import { env } from "../config.js";
import { requireHostAccess } from "../lib/hosted-access.js";
import { appendLedger } from "../lib/ledger.js";
import { saveFile } from "../files/store.js";
import { createTask } from "../services/tasks.js";
import { createJob } from "../workspace/assign.js";
import { workspaceRoot } from "../workspace/guard.js";
import { OUTSIDE_TOOL, RUN_RULE_SOURCE } from "../workspace/tools.js";
import { prepareWorktree, type MadeWorktree } from "../workspace/worktrees.js";
import { webContext } from "./origin.js";
import { agentProjectOf } from "../workspace/agent-projects.js";
import { parseConfig } from "../workspace/session-choice/config.js";
import { parseFacts } from "../workspace/session-choice/related.js";
import { isRefusal, planLocalJob, sharedFolder, type LocalPlan, type Refusal } from "./policy.js";
import { authRejected, type HostedClient } from "./client.js";
import { parseMission, type JobSpec, type MissionSpec, type ResultLink } from "./contract.js";
import { loadHeld, loadSettings, type HeldJob } from "./store.js";


type DownloadedAttachment = { attachment: NonNullable<JobSpec["attachments"]>[number]; bytes: Uint8Array };

/** The web's ids are not local file ids. Rewrite references while saving the copied originals. */
export async function attachClaimedFiles(prisma: PrismaClient, userId: string, taskId: string, hostedId: string, downloads: DownloadedAttachment[], page: string): Promise<string> {
  let notes = page;
  for (const { attachment, bytes } of downloads) {
    const file = await saveFile(prisma, userId, { filename: attachment.filename, mediaType: "application/octet-stream", bytes, source: { app: "ensemble", label: "Task attachment", externalId: `remote:${hostedId}:${attachment.id}` } }, { summarize: false, tags: { taskIds: [taskId] } });
    notes = notes.replaceAll(`ensemble://file/${attachment.id}`, `ensemble://file/${file.id}`);
    if (attachment.kind === "diagram") {
      notes = notes.replaceAll(`ensemble://diagram/${attachment.id}`, `ensemble://file/${file.id}`)
        .replaceAll(`diagram id ${attachment.id}`, `diagram source file id ${file.id}`)
        .replace(/\[Source truncated;[^\]]+\]/g, "[The full source is in the attached diagram source file; open it with view_attachment.]");
    }
  }
  return notes;
}

export async function acceptClaimed(app: FastifyInstance, client: HostedClient, spec: JobSpec): Promise<HeldJob> {
  await requireHostAccess(env.ENSEMBLE_DEV_USER_ID, "Host remote task execution");
  const held: HeldJob = {
    hostedId: spec.id,
    leaseToken: spec.leaseToken,
    localJobId: null,
    claimedAt: Date.now(),
    lastOkAt: Date.now(),
    phase: "active",
    sentStatus: null,
    sentProgress: null,
    sentAt: 0,
    eventSeq: "0",
    logOffset: 0,
    logBytes: 0,
    logSeq: 0,
    decisions: {},
    protocol: spec.protocol ?? 1,
    ...(spec.keepsFileText === false ? { keepsFileText: false } : {}),
  };
  const userId = env.ENSEMBLE_DEV_USER_ID;
  const plan = planLocalJob(spec, loadSettings(), (hostedId) => loadHeld()[hostedId]?.localJobId ?? null);
  // continueFrom is resolved against the database as well as the held file.
  const resolved = isRefusal(plan) ? plan : await withContinue(app, spec, plan);
  if (isRefusal(resolved)) {
    await refuse(app, client, userId, spec, held, resolved);
    return held;
  }
  try {
    let attachmentBytes = 0;
    const downloads: DownloadedAttachment[] = [];
    for (const attachment of spec.attachments ?? []) {
      attachmentBytes += attachment.byteSize;
      if (attachmentBytes > 100 * 1024 * 1024) throw new Error("The task attachments exceed the 100 MB transfer limit.");
      if (!client.downloadAttachment) throw new Error("This computer cannot download the task attachments. Update Ensemble and retry.");
      const bytes = await client.downloadAttachment(spec.id, spec.leaseToken, attachment.id, attachment.byteSize);
      if (bytes.byteLength !== attachment.byteSize) throw new Error("The attached file was incomplete. Retry this task.");
      downloads.push({ attachment, bytes });
    }
    const task = await app.prisma.$transaction((tx) =>
      createTask(tx, userId, { title: resolved.title, description: resolved.description, notes: resolved.page, status: "todo", owner: "agent", sourceKind: "other", sourceRef: "remote" }, "system"),
    );
    const notes = await attachClaimedFiles(app.prisma, userId, task.id, spec.id, downloads, resolved.page);
    if (notes !== resolved.page) await app.prisma.task.update({ where: { id: task.id }, data: { notes } });
    // A run carrying on one this computer lost when it restarted runs in that run's folder and agent session (agent.ts).
    // A secret scope from the web (an Ensemble Node run) limits the saved secrets the run gets (lib/run-secrets.ts).
    const mission = parseMission(spec.mission);
    const facts = parseFacts(spec.related);
    // An Ensemble Node build that works apart gets its own git worktree of the shared folder (B13).
    const tree = mission ? await intoWorktree(app, spec, resolved, mission) : null;
    const context = {
      ...webContext(spec.id),
      ...(spec.resume ? { resumeOf: spec.resume } : {}),
      ...(spec.steer ? { steer: spec.steer } : {}),
      ...(Array.isArray(spec.secrets) ? { secrets: spec.secrets } : {}),
      // The shared folder's path stays on this computer: for the folder claims (one mission's runs wait for each other) and removing worktrees.
      ...(mission ? { mission: { ...mission, ...(tree?.folder ? { root: tree.folder } : {}) } } : {}),
      // The project's brief: createJob puts a new session in the project's folder here (agent-projects.ts).
      ...(agentProjectOf(spec.project) ? { agentProject: agentProjectOf(spec.project) } : {}),
      // The task's facts as the web knows them, kept so later runs here can be matched against this one (session-choice).
      ...(facts ? { taskFacts: facts } : {}),
    } as Prisma.InputJsonValue;
    const choiceConfig = parseConfig(spec.sessionChoice);
    const created = await createJob(app.prisma, userId, { ...resolved.assign, taskId: task.id }, {
      context,
      actor: "system",
      ...(facts && choiceConfig ? { sessionChoice: { facts, config: choiceConfig, newSession: spec.newSession === true } } : {}),
    });
    if (!created) throw new Error("The task could not be queued.");
    held.localJobId = created.jobId;
    await reportChoice(app, client, spec, created.jobId).catch((error: unknown) => app.log.warn({ err: error, hostedJobId: spec.id }, "could not send how the agent session was chosen"));
    // Commits in a worktree land in the repository's own git folder, which every worktree shares.
    if (tree?.made) await app.prisma.decisionRule.create({ data: { userId, source: RUN_RULE_SOURCE, toolName: OUTSIDE_TOOL, pattern: tree.made.gitDir, decision: "allow", sessionId: created.jobId } });
    await appendLedger({ userId, actor: "system", action: "remote.claim", payload: { hostedJobId: spec.id, jobId: created.jobId, ...(tree?.made ? { worktree: tree.made.path, branch: tree.made.branch } : {}), ...(tree?.error ? { worktreeError: tree.error } : {}) } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string }).code ?? "REFUSED";
    await refuse(app, client, userId, spec, held, { code, message });
  }
  return held;
}

/**
 * How this computer chose the run's agent session, sent to the web in its ids (session-choice): the web
 * keeps it and links the run to the session it continues there too. Runs made here before are known to
 * the web by the ids they were claimed under (`context.hostedJobId`); one it never knew stays unnamed.
 */
async function reportChoice(app: FastifyInstance, client: HostedClient, spec: JobSpec, localJobId: string): Promise<void> {
  if (!client.sessionChoice) return;
  const row = await app.prisma.sessionChoice.findUnique({ where: { jobId: localJobId } });
  if (!row) return;
  const candidates = Array.isArray(row.candidates) ? (row.candidates as Array<Record<string, unknown>>) : [];
  const local = [row.continuedJobId, row.sessionId, ...candidates.flatMap((candidate) => [candidate.sessionId, candidate.lastJobId])].filter((value): value is string => typeof value === "string");
  const jobs = local.length ? await app.prisma.workspaceJob.findMany({ where: { id: { in: [...new Set(local)] } }, select: { id: true, context: true } }) : [];
  const hosted = new Map(jobs.map((job) => [job.id, (job.context as { hostedJobId?: unknown } | null)?.hostedJobId]).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const web = (value: unknown) => (typeof value === "string" ? (hosted.get(value) ?? null) : null);
  const context = (await app.prisma.workspaceJob.findUnique({ where: { id: localJobId }, select: { context: true } }))?.context as { sessionChoice?: { title?: unknown } } | null;
  await client.sessionChoice(spec.id, spec.leaseToken, {
    decision: row.decision === "continue" ? "continue" : "new",
    band: row.band === "confident" || row.band === "unsure" ? row.band : "none",
    continues: web(row.continuedJobId),
    sessionId: web(row.sessionId),
    score: row.score,
    title: typeof context?.sessionChoice?.title === "string" ? context.sessionChoice.title.slice(0, 500) : null,
    why: row.why?.slice(0, 600) ?? null,
    note: row.note?.slice(0, 40) ?? null,
    configVersion: row.configVersion,
    configHash: row.configHash,
    candidates: candidates.slice(0, 100).map((candidate) => ({ ...candidate, sessionId: web(candidate.sessionId), lastJobId: web(candidate.lastJobId) })),
    elapsedMs: row.elapsedMs,
  });
}

/**
 * An Ensemble Node build that works apart (the claim's `mission.worktree`, B13) works in its own git
 * worktree of the shared folder, and a check of it in the same worktree: the local job works in place
 * there, on the worktree's branch as it is. A continued run stays where its run was. When no worktree can
 * be made, the run works in the folder itself, and this computer's queue makes such runs take turns.
 */
async function intoWorktree(app: FastifyInstance, spec: JobSpec, plan: LocalPlan, mission: MissionSpec): Promise<{ folder: string; made: MadeWorktree | null; error: string | null } | null> {
  const label = (spec.folderLabel ?? spec.folder ?? "").trim();
  const shared = label ? sharedFolder(loadSettings(), label) : null;
  if (!shared || spec.kind !== "code") return null;
  if (!mission.worktree || plan.assign.continueFromJobId) return { folder: shared.path, made: null, error: null };
  try {
    const made = await prepareWorktree({ userId: env.ENSEMBLE_DEV_USER_ID, folder: shared.path, workspace: await workspaceRoot(), spec: mission.worktree });
    plan.assign.folder = made.path;
    delete plan.assign.repoUrl;
    plan.assign.accessMode = shared.access === "review" || spec.accessMode === "review" ? "review" : "read-write";
    // The worktree is on its branch already; the mission's integration step publishes, never this run.
    plan.assign.branchMode = "as-is";
    delete plan.assign.branch;
    delete plan.assign.pullRequest;
    plan.assign.delivery = spec.delivery;
    return { folder: shared.path, made, error: null };
  } catch (error) {
    app.log.warn({ err: error, hostedJobId: spec.id }, "could not make a worktree; the run works in the folder itself");
    return { folder: shared.path, made: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function withContinue(app: FastifyInstance, spec: JobSpec, plan: Exclude<ReturnType<typeof planLocalJob>, Refusal>) {
  if (!spec.continueFromJobId || plan.assign.continueFromJobId) return plan;
  // The run this computer made for that web run, however long ago.
  const local = await app.prisma.workspaceJob.findFirst({
    where: { userId: env.ENSEMBLE_DEV_USER_ID, context: { path: ["hostedJobId"], equals: spec.continueFromJobId } },
    orderBy: { createdAt: "desc" },
    select: { id: true, context: true },
  });
  if (local && (local.context as { origin?: string } | null)?.origin === "web") {
    plan.assign.continueFromJobId = local.id;
    return plan;
  }
  if (plan.assign.folder || plan.assign.repoUrl) return plan;
  return { code: "CONTINUE_UNKNOWN", message: "This computer does not have the earlier task's folder, so it cannot continue it." } as Refusal;
}

async function refuse(app: FastifyInstance, client: HostedClient, userId: string, spec: JobSpec, held: HeldJob, refusal: Refusal): Promise<void> {
  held.phase = "done";
  held.refusal = refusal;
  try {
    const task = await app.prisma.$transaction((tx) =>
      createTask(
        tx,
        userId,
        { title: (spec.task?.title ?? spec.title ?? "Task from Ensemble on the web").slice(0, 300), description: refusal.message, status: "blocked", owner: "agent", sourceKind: "other", sourceRef: "remote" },
        "system",
      ),
    );
    const job = await app.prisma.workspaceJob.create({
      data: {
        userId,
        taskId: task.id,
        kind: spec.kind,
        status: "failed",
        executionMode: "sandbox",
        model: spec.model || "",
        provider: spec.provider ?? null,
        instructions: (spec.instructions ?? "").slice(0, 8000),
        delivery: "local",
        error: refusal.message,
        progress: "Refused",
        finishedAt: new Date(),
        context: webContext(spec.id),
      },
    });
    held.localJobId = job.id;
  } catch (error) {
    app.log.warn({ err: error }, "could not record a refused remote task");
  }
  await client.complete(spec.id, spec.leaseToken, { outcome: "failed", summary: refusal.message, results: [] }).catch((error: unknown) => {
    if (authRejected(error)) throw error;
    app.log.warn({ err: error, hostedJobId: spec.id }, "could not report a refused remote task");
  });
  await appendLedger({ userId, actor: "system", action: "remote.refuse", payload: { hostedJobId: spec.id, code: refusal.code, message: refusal.message } });
}

/** The complete route takes only https links (#47). A local branch name is not a link, so it is not sent. */
export function resultLinks(job: { branch: string; summary: string | null }): ResultLink[] {
  if (!/^https:\/\//.test(job.branch)) return [];
  return [{ kind: "branch", url: job.branch }];
}
