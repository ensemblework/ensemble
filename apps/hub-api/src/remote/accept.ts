/**
 * A claimed hosted job becomes one local job, through the same createJob path
 * as Assign. A spec the Mac will not run is recorded as failed, here and on
 * the hosted row, and nothing is started.
 */
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { requireHostAccess } from "../lib/hosted-access.js";
import { appendLedger } from "../lib/ledger.js";
import { createTask } from "../services/tasks.js";
import { createJob } from "../workspace/assign.js";
import { runTrustedGit } from "../workspace/git-gate.js";
import { GIT_GATE_CLONE, GIT_GATE_CODE, webContext } from "./origin.js";
import { isRefusal, planLocalJob, type Refusal } from "./policy.js";
import { authRejected, type HostedClient } from "./client.js";
import type { JobSpec, ResultLink } from "./contract.js";
import { loadHeld, loadSettings, type HeldJob } from "./store.js";

const PRIVATE = /Authentication|could not read Username|Permission denied|Repository not found|terminal prompts disabled|Invalid username or password/i;

export async function repoVisibility(url: string, userId = env.ENSEMBLE_DEV_USER_ID): Promise<"public" | "private" | "unreachable"> {
  await requireHostAccess(userId, "Host repository probe");
  try {
    const result = await runTrustedGit({ userId, cwd: tmpdir(), args: ["ls-remote", "--heads", url], timeoutMs: 20_000 });
    if (result.exitCode === 0) return "public";
    if (PRIVATE.test(result.output)) return "private";
    return "unreachable";
  } catch {
    return "unreachable";
  }
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
  };
  const userId = env.ENSEMBLE_DEV_USER_ID;
  const plan = planLocalJob(spec, loadSettings(), (hostedId) => loadHeld()[hostedId]?.localJobId ?? null);
  // continueFrom is resolved against the database as well as the held file.
  const resolved = isRefusal(plan) ? plan : await withContinue(app, spec, plan);
  if (isRefusal(resolved)) {
    await refuse(app, client, userId, spec, held, resolved);
    return held;
  }
  if (resolved.publicCheck) {
    const visibility = await repoVisibility(resolved.publicCheck);
    if (visibility !== "public") {
      const refusal: Refusal =
        visibility === "private"
          ? { code: GIT_GATE_CODE, message: GIT_GATE_CLONE }
          : { code: "REPO_UNREACHABLE", message: `Could not confirm ${resolved.publicCheck} is a public repository, so it was not cloned.` };
      await refuse(app, client, userId, spec, held, refusal);
      return held;
    }
  }
  try {
    const task = await app.prisma.$transaction((tx) =>
      createTask(tx, userId, { title: resolved.title, description: resolved.description, status: "todo", owner: "agent", sourceKind: "other", sourceRef: "remote" }, "system"),
    );
    const created = await createJob(app.prisma, userId, { ...resolved.assign, taskId: task.id }, { context: webContext(spec.id), actor: "system" });
    if (!created) throw new Error("The task could not be queued.");
    held.localJobId = created.jobId;
    await appendLedger({ userId, actor: "system", action: "remote.claim", payload: { hostedJobId: spec.id, jobId: created.jobId } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string }).code ?? "REFUSED";
    await refuse(app, client, userId, spec, held, { code, message });
  }
  return held;
}

async function withContinue(app: FastifyInstance, spec: JobSpec, plan: Exclude<ReturnType<typeof planLocalJob>, Refusal>) {
  if (!spec.continueFromJobId || plan.assign.continueFromJobId) return plan;
  const rows = await app.prisma.workspaceJob.findMany({
    where: { userId: env.ENSEMBLE_DEV_USER_ID },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, context: true },
  });
  const local = rows.find((row) => {
    const context = row.context as { origin?: string; hostedJobId?: string } | null;
    return context?.origin === "web" && context.hostedJobId === spec.continueFromJobId;
  });
  if (local) {
    plan.assign.continueFromJobId = local.id;
    return plan;
  }
  if (plan.assign.folder || plan.assign.repoUrl) return plan;
  return { code: "CONTINUE_UNKNOWN", message: "This Mac does not have the earlier task's folder, so it cannot continue it." } as Refusal;
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
        model: spec.model || "remote",
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
