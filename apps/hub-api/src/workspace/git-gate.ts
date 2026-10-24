/**
 * Git and GitHub calls that hold the person's sign-in. They run in the app, not in the sandbox, so the
 * agent never receives a token, an askpass script that can print one, or an SSH agent socket. What
 * they do (which branch, force, delete, which pull request) is the person's and their agent's call;
 * these functions only keep them from starting a program or touching a folder outside the run.
 */
import { spawn } from "node:child_process";
import { hostExecutable } from "./policy.js";
import { requireHostAccess } from "../lib/hosted-access.js";
import { redactSecrets } from "./sandbox/scrub.js";
import { GuardError } from "./guard.js";

export function runBranchName(jobId: string, slugSource: string): string {
  const slug = slugSource
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `ensemble/${jobId}/${slug || "task"}`;
}

/** Options of `git push` that run a program on this computer, outside the sandbox. */
const PUSH_RUNS_PROGRAM = /^--(receive-pack|exec)(=|$)/;

/**
 * Why an agent's `git push <rest>`, run by Ensemble with the person's sign-in, cannot run, or null.
 * Only options that would start a program outside the run are refused.
 */
export function trustedPushRefusal(rest: string[]): string | null {
  const option = rest.find((arg) => PUSH_RUNS_PROGRAM.test(arg));
  return option ? `git push ${option.split("=")[0]} starts a program on this computer, so Ensemble does not run it.` : null;
}

/** The remote a `git push <rest>` goes to: the first word that is not an option, else none (git's default). */
export function pushRemoteArg(rest: string[]): string | null {
  const valued = new Set(["-o", "--push-option", "--repo", "--signed", "--force-with-lease", "--recurse-submodules"]);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--") return rest[index + 1] ?? null;
    if (arg.startsWith("-")) {
      if (valued.has(arg)) index += 1;
      continue;
    }
    return arg;
  }
  return null;
}

/** `gh` commands that run a program or a shell on this computer, refused when the run is sandboxed (gh runs outside it). */
const GH_RUNS_PROGRAM = new Set(["extension", "extensions", "ext", "alias", "codespace", "cs"]);

export function ghSandboxRefusal(argv: string[]): string | null {
  const group = argv.slice(1).find((arg) => !arg.startsWith("-")) ?? "";
  return GH_RUNS_PROGRAM.has(group) ? `gh ${group} runs programs on this computer outside the sandbox. Turn the sandbox off for this run if you need it.` : null;
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

/**
 * `gh` with the person's GitHub sign-in, in the run's folder. Hooks and fsmonitor are off for the git
 * that gh runs itself, as for Ensemble's own git.
 */
export async function runTrustedGh(options: { userId?: string; cwd: string; args: string[]; token: string; timeoutMs?: number }): Promise<TrustedGitResult> {
  await requireHostAccess(options.userId, "Host GitHub commands");
  const bin = await hostExecutable("gh").catch(() => null);
  if (!bin) throw new GuardError("The GitHub CLI (gh) is not installed on this computer. Install it from https://cli.github.com.");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GH_TOKEN: options.token,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    GH_PAGER: "cat",
    PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
  };
  return new Promise((resolve, reject) => {
    const child = spawn(bin, options.args, { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const take = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 60_000) output = output.slice(-60_000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 300_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output: redactSecrets(output, [options.token]) });
    });
  });
}
