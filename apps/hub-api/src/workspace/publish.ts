/**
 * Pushes Ensemble runs for an agent or for the person's review: the `git push` they asked for, with the
 * person's sign-in, from outside the sandbox. Which branch, force or delete is theirs to choose.
 */
import { isAbsolute, resolve } from "node:path";
import type { PrismaClient, WorkspaceJob } from "@prisma/client";
import { githubCloneAuth } from "../lib/git-auth.js";
import { jobOrigin } from "../remote/origin.js";
import { loadSettings as loadRemoteSettings } from "../remote/store.js";
import { pushRemoteArg, runTrustedGit, trustedPushRefusal, type TrustedGitResult } from "./git-gate.js";
import { GuardError, within } from "./guard.js";

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

/**
 * A task from the web on a computer that keeps approvals to itself ("Accept approvals from the web"
 * off): its push asks on the computer, even in a trusted folder.
 */
export function webPushNeedsComputer(job: Pick<WorkspaceJob, "context">): boolean {
  return jobOrigin(job.context) === "web" && !loadRemoteSettings().acceptWebApprovals;
}

const LOCAL_REMOTE = /^(\/|\.|~|file:)/;

/** The URL a remote name or URL reaches from `root`: a URL as given, else the named remote, the branch's remote or origin. */
export async function remoteUrl(userId: string, root: string, named: string | null): Promise<string> {
  if (named && (named.includes("://") || named.includes("@") || LOCAL_REMOTE.test(named))) return named;
  const read = async (args: string[]) => {
    const ran = await runTrustedGit({ userId, cwd: root, args });
    return ran.exitCode === 0 ? ran.output.trim() : "";
  };
  let remote = named;
  if (!remote) {
    const branch = await read(["rev-parse", "--abbrev-ref", "HEAD"]);
    remote = (branch && ((await read(["config", "--get", `branch.${branch}.pushRemote`])) || (await read(["config", "--get", `branch.${branch}.remote`])))) || (await read(["config", "--get", "remote.pushDefault"])) || "origin";
  }
  return (await read(["remote", "get-url", "--push", remote])) || remote;
}

/**
 * `git push <rest>` in `root`, with the person's GitHub sign-in when the remote is on GitHub (else git's
 * own access, for example SSH keys). A sandboxed run may push into another folder on this computer only
 * when it is the folder the run was cloned from.
 */
export async function pushWithSignIn(input: {
  prisma: PrismaClient;
  userId: string;
  job: Pick<WorkspaceJob, "repoUrl" | "continueFromJobId" | "externalRoot">;
  root: string;
  rest: string[];
  sandboxed: boolean;
  timeoutMs?: number;
}): Promise<TrustedGitResult & { remote: string }> {
  const refused = trustedPushRefusal(input.rest);
  if (refused) throw new GuardError(refused);
  const url = await remoteUrl(input.userId, input.root, pushRemoteArg(input.rest));
  if (input.sandboxed && LOCAL_REMOTE.test(url)) {
    const path = resolve(input.root, url.replace(/^file:\/\//, ""));
    const source = await jobRemote(input.prisma, input.job);
    if (!within(input.root, path) && !(source && isAbsolute(source) && resolve(source) === path)) {
      throw new GuardError(`${url} is a folder outside this run. A sandboxed run pushes there only when it was cloned from it; turn the sandbox off to push into another folder.`);
    }
  }
  const auth = /github\.com/i.test(url)
    ? await githubCloneAuth(input.prisma, input.userId, url).catch(() => ({ config: [] as string[], env: {} as Record<string, string> }))
    : { config: [] as string[], env: {} as Record<string, string> };
  const result = await runTrustedGit({
    userId: input.userId,
    cwd: input.root,
    args: ["push", ...input.rest],
    credentialEnv: auth.env,
    credentialConfig: auth.config,
    timeoutMs: input.timeoutMs ?? 300_000,
  });
  return { ...result, remote: url };
}
