/** Names for a paired computer. A missing device is "your computer", never a hardcoded Mac. */

export function computerName(name?: string | null): string {
  const trimmed = name?.trim();
  return trimmed || "your computer";
}

export function platformLabel(platform: string): string {
  if (platform === "macos") return "Mac";
  if (platform === "linux") return "Linux";
  if (platform === "windows") return "Windows";
  return platform;
}

export function folderPlace(name?: string | null): string {
  return `A folder on ${computerName(name)}`;
}

const GITHUB_PULL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/(\d+)(?:[/?#]|$)/;

/** A pull-request label only for github.com/<owner>/<repo>/pull/<number>. */
export function pullRequestNumber(url: string): string | null {
  return GITHUB_PULL.exec(url)?.[1] ?? null;
}

export function sandboxStay(name?: string | null): string {
  return `Sandbox and trust stay on ${computerName(name)}.`;
}

export function interruptedLabel(name?: string | null, revoked?: boolean): string {
  return `Interrupted · ${computerName(name)} ${revoked ? "removed" : "went offline"}`;
}

export function freshCloneHint(deviceName?: string | null, serverRoot?: string | null): string {
  const name = deviceName?.trim();
  if (name) return `A fresh clone on ${name}. Your own copy stays untouched.`;
  return `A fresh clone in ${serverRoot?.trim() || "ensemble-workspace"}/runs/… Your own copy stays untouched.`;
}

/**
 * How Needs me answers a question from a paired computer.
 * A question with options sends the chosen string as `reason`, which is the
 * field the computer reads; with `custom`, a typed answer is accepted too.
 * A plain Yes is only for a question with no options. A risky allow (a push,
 * a path outside the folder, trusting a folder) is confirmed first. A computer
 * that accepts such answers only on itself sends `high_risk`: no Yes here.
 * Scope is always once. There is no Always and no remember-for-this-session choice.
 */
export function deviceDecisionView(input: {
  tier?: string | null;
  event?: string | null;
  options?: readonly string[] | null;
  deviceName?: string | null;
  confirm?: boolean | null;
  allowCustom?: boolean | null;
  recommended?: string | null;
}): { scope: "once" } & (
  | { kind: "approve-on-computer"; message: string }
  | { kind: "choices"; options: string[]; recommended: string | null; custom: boolean; confirm: boolean }
  | { kind: "yes-no"; confirm: boolean }
) {
  if (input.tier === "run_branch_push" || input.tier === "high_risk") {
    return { scope: "once", kind: "approve-on-computer", message: `Approve this on ${computerName(input.deviceName)}.` };
  }
  const confirm = input.confirm === true;
  const options = (input.options ?? []).filter((option) => option.length > 0);
  if (input.event === "question" && options.length > 0) {
    const recommended = input.recommended && options.includes(input.recommended) ? input.recommended : null;
    return { scope: "once", kind: "choices", options, recommended, custom: input.allowCustom === true, confirm };
  }
  return { scope: "once", kind: "yes-no", confirm };
}

/** What the confirm step says before a risky allow. */
export function confirmCopy(toolName: string | null | undefined, deviceName: string | null | undefined): string {
  const where = computerName(deviceName);
  if (toolName === "git push") return `Allow pushing on ${where}?`;
  if (toolName === "outside") return `Allow the agent on ${where} to use a path outside its folder?`;
  if (toolName === "trust") return `Trust this folder on ${where}? Agents can then run commands there without asking.`;
  return `Allow this on ${where}?`;
}

/** True once a device id appears that was not in the list when the code was shown. */
export function pairingCodeConsumed(before: readonly string[], after: readonly string[]): boolean {
  const known = new Set(before);
  return after.some((id) => !known.has(id));
}

/** Settings Run again must send. Omitting one makes the server store its default. */
export type RerunSource = {
  id: string;
  taskId: string;
  kind: "research" | "code";
  deviceId?: string | null;
  delivery: "local" | "commit" | "push";
  repoUrl?: string | null;
  folderLabel?: string | null;
  instructions?: string;
  provider?: string | null;
  model?: string;
  reasoningEffort?: string | null;
  branchMode?: "as-is" | "existing" | "new";
  branch?: string;
  askBeforePublish?: boolean;
  useCredentials?: boolean;
  executionMode?: "sandbox" | "native";
  networkAccess?: boolean;
  markDone?: boolean;
  maxMinutes?: number;
  maxTurns?: number;
  maxToolCalls?: number;
};

export function rerunAssignInput(job: RerunSource) {
  const branchMode = job.branchMode ?? "as-is";
  return {
    taskId: job.taskId,
    kind: job.kind,
    deviceId: job.deviceId ?? undefined,
    continueFromJobId: job.id,
    delivery: job.delivery,
    repoUrl: job.repoUrl ?? undefined,
    folderLabel: job.folderLabel ?? undefined,
    instructions: job.instructions ?? "",
    provider: job.provider ?? undefined,
    model: job.model || undefined,
    reasoningEffort: job.reasoningEffort ?? undefined,
    branchMode,
    branch: branchMode === "as-is" ? undefined : job.branch || undefined,
    askBeforePublish: job.askBeforePublish,
    useCredentials: job.useCredentials,
    sandbox: job.executionMode !== "native",
    network: job.networkAccess,
    markDone: job.markDone,
    maxMinutes: job.maxMinutes,
    maxTurns: job.maxTurns,
    maxToolCalls: job.maxToolCalls,
  };
}
