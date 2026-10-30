/**
 * A node's `computer_git`: status, diff, log, show or the branch list in one folder, read only. The
 * same checks as an agent's git (`checkGit` must call it a read), Ensemble's git hardening, no
 * external diff or text conversion programs, under the OS sandbox with the folder read-only.
 */
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { checkGit, gitHardening, GuardError, sandboxAvailable } from "../workspace/guard.js";
import { runCommand } from "../workspace/runner.js";
import type { NodeToolRequest } from "../remote/contract.js";
import { cleanOutput, clipOutput } from "./run.js";
import { nodeToolDenies, type ToolFolder } from "./folders.js";

type GitRequest = Extract<NodeToolRequest, { tool: "git" }>;

/** Options a read may not take: they write a file, run a program, or read outside the repository. */
const UNSAFE = /^(?:--output|--ext-diff|--textconv|--exec|--upload-pack|--receive-pack|--git-dir|--work-tree|--no-index|--open-files-in-pager|--config-env)/;

const DEFAULTS: Record<GitRequest["op"], string[]> = {
  status: ["--short", "--branch"],
  diff: ["--stat", "--patch"],
  log: ["--oneline", "-n", "30"],
  show: ["--stat", "--patch"],
  branch: ["--list", "-vv"],
};

/** The argv for one read, refused when an argument could do more than read. */
export function gitArgv(request: Pick<GitRequest, "op" | "args">): string[] {
  for (const arg of request.args) {
    if (UNSAFE.test(arg)) throw new GuardError(`git ${request.op} ${arg.split("=")[0]} is not a read a node may run.`);
  }
  if (request.op === "branch" && request.args.some((arg) => !arg.startsWith("-"))) throw new GuardError("computer_git branch only lists branches. Use computer_run to change them.");
  const args = request.args.length ? request.args : DEFAULTS[request.op];
  const safety = request.op === "diff" || request.op === "show" || request.op === "log" ? ["--no-ext-diff", "--no-textconv"] : [];
  const argv = ["git", request.op, ...safety, ...args];
  const { action } = checkGit(argv, { delivery: "local", sandboxed: true });
  if (action !== "read") throw new GuardError(`git ${request.op} with those arguments changes the repository. Use computer_run for that.`);
  return argv;
}

export async function runNodeGit(request: GitRequest, folder: ToolFolder): Promise<{ status: number; body: Record<string, unknown> }> {
  const argv = gitArgv(request);
  const result = await runCommand({
    userId: env.ENSEMBLE_DEV_USER_ID,
    argv: ["git", ...gitHardening(false), ...argv.slice(1)],
    cwd: folder.path,
    root: folder.path,
    sandboxed: sandboxAvailable(),
    network: false,
    useCredentials: false,
    who: "agent",
    readOnly: [folder.path],
    readWrite: [],
    deny: await nodeToolDenies(),
    timeoutMs: 60_000,
    group: `node-git:${request.id}`,
  });
  const shown = clipOutput(cleanOutput(result.output));
  await appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "agent", action: "node.tool.git", payload: { nodeId: request.nodeId, op: request.op, folder: folder.label, exitCode: result.exitCode, operationId: request.operationId ?? null } }).catch(() => undefined);
  return { status: 200, body: { exitCode: result.exitCode, output: shown.text, truncated: shown.clipped || result.truncated } };
}
