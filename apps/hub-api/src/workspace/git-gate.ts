/**
 * Git operations that hold credentials. They run in the app, not in the sandbox.
 *
 * The agent never receives `ENSEMBLE_GIT_TOKEN`, an askpass script that can print
 * it, or an SSH agent socket. Clone, fetch, and push happen here. Push is
 * fast-forward only, and only to the run's own branch (`ensemble/<job-id>/<slug>`).
 * A push to `main`, a force-push, or a push of any other branch is refused
 * before git is started.
 */
import { spawn } from "node:child_process";
import { hostExecutable } from "./policy.js";
import { requireHostAccess } from "../lib/hosted-access.js";
import { redactSecrets } from "./sandbox/scrub.js";

export function runBranchName(jobId: string, slugSource: string): string {
  const slug = slugSource
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `ensemble/${jobId}/${slug || "task"}`;
}

/** A branch this job created: `ensemble/<job-id>/…`. */
export function isOwnRunBranch(branch: string, jobId: string): boolean {
  return branch === `ensemble/${jobId}` || branch.startsWith(`ensemble/${jobId}/`);
}

/** Any run branch, including one inherited from an earlier task in the chain. */
export function isRunBranch(branch: string): boolean {
  return /^ensemble\/[0-9a-fA-F-]{36}\/[A-Za-z0-9._-]{1,80}$/.test(branch);
}

export function pushRefused(branch: string, jobId: string, continued: boolean): string | null {
  if (isOwnRunBranch(branch, jobId)) return null;
  if (continued && isRunBranch(branch)) return null;
  return `The agent may only push its own branch (ensemble/${jobId}/…). Push is fast-forward and is done by Ensemble, not inside the sandbox.`;
}

/**
 * HEAD onto the run branch, fast-forward only. `git push` has no `--ff-only`;
 * without `--force` or a `+` refspec the remote refuses a non-fast-forward.
 * The full ref keeps git from guessing a tag or a different namespace.
 */
export function fastForwardPushArgs(branch: string, remote: string): string[] {
  if (!isRunBranch(branch) && !/^ensemble\/[0-9a-fA-F-]{36}$/.test(branch)) throw new Error(`Refusing to push ${branch}: not a run branch.`);
  if (remote.startsWith("-")) throw new Error("Refusing a remote that looks like an option.");
  return ["push", "--porcelain", remote, `HEAD:refs/heads/${branch}`];
}

export interface TrustedGitOptions {
  userId?: string;
  cwd: string;
  /** Arguments after the git binary. Hardening config is added in front. */
  args: string[];
  /** Present only for clone, fetch, and push. Never forwarded to an agent command. */
  credentialEnv?: Record<string, string>;
  credentialConfig?: string[];
  timeoutMs?: number;
}

export interface TrustedGitResult {
  exitCode: number;
  output: string;
}

/**
 * Run git in this process. This is not `startSandboxed`: the credential
 * environment would be stripped there, and it must not be visible to the agent.
 */
export async function runTrustedGit(options: TrustedGitOptions): Promise<TrustedGitResult> {
  await requireHostAccess(options.userId, "Host git commands");
  const bin = await hostExecutable("git");
  const args = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "credential.helper=",
    ...(options.credentialConfig ?? []),
    ...options.args,
  ];
  const credentialEnv = options.credentialEnv ?? {};
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...credentialEnv,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
  };
  const secrets = Object.values(credentialEnv);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const take = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 60_000) output = output.slice(-60_000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 120_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output: redactSecrets(output, secrets) });
    });
  });
}
