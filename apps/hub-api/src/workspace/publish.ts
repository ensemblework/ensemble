/**
 * The one push path. The app runs it, never the agent, and only after the
 * person confirmed: fast-forward, to the run's own branch, at the URL the
 * job was cloned from (not a remote the agent could have edited).
 */
import type { PrismaClient, WorkspaceJob } from "@prisma/client";
import { githubCloneAuth } from "../lib/git-auth.js";
import { GIT_GATE_PUSH, jobOrigin } from "../remote/origin.js";
import { loadSettings as loadRemoteSettings } from "../remote/store.js";
import { fastForwardPushArgs, isOwnRunBranch, isRunBranch, pushRefused, runTrustedGit, type TrustedGitResult } from "./git-gate.js";
import { GuardError } from "./guard.js";

/** The clone source, following Continue back to the job that cloned. */
export async function jobRemote(prisma: PrismaClient, job: Pick<WorkspaceJob, "repoUrl" | "continueFromJobId" | "externalRoot">): Promise<string | null> {
  if (job.externalRoot) return null;
  if (job.repoUrl) return job.repoUrl;
  let parent = job.continueFromJobId;
  for (let hops = 0; parent && hops < 50; hops += 1) {
    const row = await prisma.workspaceJob.findUnique({ where: { id: parent }, select: { repoUrl: true, continueFromJobId: true, externalRoot: true } });
    if (!row || row.externalRoot) return null;
    if (row.repoUrl) return row.repoUrl;
    parent = row.continueFromJobId;
  }
  return null;
}

/** A task from the web pushes only to a repository folder on this Mac until the Git gate lands. */
export async function remotePushRefused(prisma: PrismaClient, job: Pick<WorkspaceJob, "repoUrl" | "continueFromJobId" | "externalRoot" | "context">): Promise<string | null> {
  if (jobOrigin(job.context) !== "web") return null;
  const remote = await jobRemote(prisma, job);
  return remote && remote.startsWith("/") ? null : GIT_GATE_PUSH;
}

/**
 * §5.1. On, and only on, when this Mac allowed it: a fast-forward push to the
 * run's own branch of a trusted local repo does not wait for a confirmation.
 */
export async function remotePushSkipsPrompt(
  prisma: PrismaClient,
  job: Pick<WorkspaceJob, "id" | "repoUrl" | "continueFromJobId" | "externalRoot" | "context">,
  branch: string,
  trusted: boolean,
): Promise<boolean> {
  if (!trusted || jobOrigin(job.context) !== "web") return false;
  if (!loadRemoteSettings().runBranchPush) return false;
  const own = isOwnRunBranch(branch, job.id) || (Boolean(job.continueFromJobId) && isRunBranch(branch));
  if (!own) return false;
  const remote = await jobRemote(prisma, job);
  return Boolean(remote?.startsWith("/"));
}

export async function pushRunBranch(input: {
  prisma: PrismaClient;
  userId: string;
  job: WorkspaceJob;
  root: string;
  branch: string;
  timeoutMs?: number;
}): Promise<TrustedGitResult & { remote: string }> {
  const { job, branch } = input;
  const refused = pushRefused(branch, job.id, Boolean(job.continueFromJobId));
  if (refused) throw new GuardError(refused);
  const gated = await remotePushRefused(input.prisma, job);
  if (gated) throw new GuardError(gated);
  const remote = await jobRemote(input.prisma, job);
  if (!remote) throw new GuardError("This run was not cloned from a repository, so there is nowhere to push it.");
  const local = remote.startsWith("/");
  const auth =
    job.useCredentials && !local
      ? await githubCloneAuth(input.prisma, input.userId, remote)
      : { config: [] as string[], env: {} as Record<string, string> };
  const result = await runTrustedGit({
    cwd: input.root,
    args: fastForwardPushArgs(branch, remote),
    credentialEnv: auth.env,
    credentialConfig: auth.config,
    timeoutMs: input.timeoutMs ?? 300_000,
  });
  return { ...result, remote };
}
