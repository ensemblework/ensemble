/**
 * Folder trust and unattended checks (doc 24 §5.8–5.11).
 *
 * Trust is a path, on this device, stored as a DecisionRule with toolName
 * `path`. The workspace root is trusted without a row. A folder
 * `resolveWorkFolder` refuses can never be trusted, because the caller has to
 * pass that check before a rule is saved. Trust does not cover domains.
 *
 * Inside a trusted folder, commands do not prompt. Outside, the choice is
 * Allow once, Allow for this run, Always, or Deny. Unattended work on an
 * untrusted folder is `UNATTENDED_REQUIRES_TRUST` at assignment and at run
 * time. Review only does not prompt per command; it prompts when the agent
 * asks for a write, the network, a credential, or a path outside the grant.
 */

export const PATH_RULE_SOURCE = "ensemble";
export const PATH_RULE_TOOL = "path";

export const UNATTENDED_CODE = "UNATTENDED_REQUIRES_TRUST";
export const UNATTENDED_MESSAGE =
  "Run unattended can't be used with a folder you haven't trusted. Trust this folder, or turn off Run unattended.";

export type AccessMode = "review" | "read-write";
export type GateAction = "command" | "write" | "network" | "credential" | "outside" | "push";
export type GateResult = "allow" | "block" | "prompt";

export class UnattendedTrustError extends Error {
  readonly statusCode = 400;
  readonly expose = true;
  readonly code = UNATTENDED_CODE;
  constructor() {
    super(UNATTENDED_MESSAGE);
    this.name = "UnattendedTrustError";
  }
}

export function rulesForJob(
  rows: Array<{ pattern: string; sessionId: string | null; decision: string; toolName: string; source?: string }>,
  jobId: string,
): string[] {
  return rows
    .filter((row) => row.toolName === PATH_RULE_TOOL && row.decision === "allow" && (row.source === undefined || row.source === PATH_RULE_SOURCE))
    .filter((row) => !row.sessionId || row.sessionId === jobId)
    .map((row) => row.pattern);
}

export function pathCovers(rulePath: string, folder: string): boolean {
  return folder === rulePath || folder.startsWith(rulePath.endsWith("/") ? rulePath : `${rulePath}/`);
}

export function isFolderTrusted(input: { folder: string; workspaceRoot: string; rules: string[]; grantingNow?: boolean }): boolean {
  if (input.grantingNow) return true;
  if (input.folder === input.workspaceRoot || pathCovers(input.workspaceRoot, input.folder)) return true;
  return input.rules.some((rule) => pathCovers(rule, input.folder));
}

/**
 * Assignment and run time share this. `when` is recorded by the caller;
 * the rejection is the same either way, so a revoked rule cannot slip through
 * by having been trusted at assignment.
 */
export function checkUnattended(input: { unattended: boolean; trusted: boolean }): UnattendedTrustError | null {
  if (input.unattended && !input.trusted) return new UnattendedTrustError();
  return null;
}

export const UNATTENDED_ASK_MODE =
  "Run unattended needs an OS sandbox, and this system runs agents in Ask mode. Choose Ask or Review only.";

export class UnattendedAskModeError extends Error {
  readonly statusCode = 400;
  readonly expose = true;
  readonly code = "UNATTENDED_NEEDS_SANDBOX";
  constructor() {
    super(UNATTENDED_ASK_MODE);
    this.name = "UnattendedAskModeError";
  }
}

/**
 * `strong` is an OS sandbox (Seatbelt). `advisory` (Linux) has only the argv
 * allow-list and folder jail, so nothing stops a command from writing: Review
 * only asks before each command there. `ask` (Windows) asks before every
 * command and write, and unattended is refused.
 */
export type SandboxStrength = "strong" | "advisory" | "ask";

export function commandGate(input: {
  trusted: boolean;
  /** `orchestration.runWithoutAsking`. An explicit path rule stays silent either way. */
  silentWorkspace: boolean;
  explicitTrust: boolean;
  unattended: boolean;
  accessMode: AccessMode;
  action: GateAction;
  inside: boolean;
  strength?: SandboxStrength;
}): GateResult {
  const strength = input.strength ?? "strong";
  if (input.unattended && (!input.trusted || strength === "ask")) return "block";
  if (!input.inside || input.action === "outside") return input.unattended ? "block" : "prompt";
  if (input.action === "push") return input.unattended ? "block" : "prompt";
  if (input.action === "credential") return input.unattended && input.trusted ? "allow" : "prompt";
  if (strength === "ask") return "prompt";
  if (input.accessMode === "review") {
    if (input.action === "command") return strength === "strong" ? "allow" : input.unattended ? "block" : "prompt";
    return input.unattended ? "block" : "prompt";
  }
  if (input.action === "network") return input.unattended && input.trusted ? "allow" : "prompt";
  const silent = input.explicitTrust || (input.trusted && input.silentWorkspace);
  if (input.unattended && input.trusted) return "allow";
  if (silent) return "allow";
  return "prompt";
}

/** Outside the workspace, review is read-only. "Review and fix" is the read-write grant. */
export function sandboxGrant(input: { folder: string; workspaceRoot: string; cache: string; accessMode: AccessMode }): {
  readWrite: string[];
  readOnly: string[];
} {
  const outside = !(input.folder === input.workspaceRoot || pathCovers(input.workspaceRoot, input.folder));
  if (outside && input.accessMode === "review") {
    return { readWrite: [input.cache], readOnly: [input.folder] };
  }
  return { readWrite: [input.folder, input.cache], readOnly: [] };
}
