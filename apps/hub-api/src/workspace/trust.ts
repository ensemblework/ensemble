/**
 * Folder trust and unattended checks (doc 24 §5.8–5.11).
 *
 * Trust is a path, on this device, stored as a DecisionRule with toolName
 * `path`. The workspace root is trusted without a row. A folder
 * `resolveWorkFolder` refuses can never be trusted, because the caller has to
 * pass that check before a rule is saved. Trust does not cover domains.
 *
 * Three run modes (the Assign dialog, the CLI and run profiles):
 * - Ask (`read-write`): commands and edits ask unless the folder is trusted.
 * - Review only (`auto`): commands and edits in the folder run without asking;
 *   only decision questions reach the person. Needs a trusted folder.
 * - Run unattended (`unattended` flag): nothing asks; decisions are made by the
 *   agent and reported. Needs a trusted folder.
 * Outside the folder, the sandbox and the person's setting decide. With the OS
 * sandbox on, Settings → "Outside the work folder" (read only by default, or
 * read and write, or no access) says what goes ahead without asking; the rest
 * asks in Ask and is refused back to the model in Review only and Run
 * unattended (the run continues). With the sandbox off the person chose to run
 * directly, so Review only and Run unattended use outside paths without
 * asking; Ask still asks. Secrets, app data and Ensemble's own code stay
 * refused either way (`outsideRefusal`).
 * `review` is the older read-only grant (no writes, no network), kept for a
 * folder shared read-only from a paired computer.
 */

export const PATH_RULE_SOURCE = "ensemble";
export const PATH_RULE_TOOL = "path";

export const UNATTENDED_CODE = "UNATTENDED_REQUIRES_TRUST";
export const UNATTENDED_MESSAGE =
  "Run unattended can't be used with a folder you haven't trusted. Trust this folder, or turn off Run unattended.";

/** `auto` is the dialog's "Review only". `review` is the read-only grant. */
export type AccessMode = "review" | "read-write" | "auto";
export type RunMode = "ask" | "review" | "unattended";

/** The stored pair for a run mode. A read-only folder keeps `review` whatever the mode. */
export function storedMode(mode: RunMode): { accessMode: "read-write" | "auto"; unattended: boolean } {
  if (mode === "unattended") return { accessMode: "read-write", unattended: true };
  if (mode === "review") return { accessMode: "auto", unattended: false };
  return { accessMode: "read-write", unattended: false };
}

export function runModeOf(job: { accessMode: string; unattended: boolean }): RunMode {
  if (job.unattended) return "unattended";
  return job.accessMode === "auto" ? "review" : "ask";
}
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

export const REVIEW_CODE = "REVIEW_REQUIRES_TRUST";
export const REVIEW_MESSAGE =
  "Review only runs commands without asking, so it needs a folder you trust. Trust this folder, or choose Ask.";

export class ReviewTrustError extends Error {
  readonly statusCode = 400;
  readonly expose = true;
  readonly code = REVIEW_CODE;
  constructor() {
    super(REVIEW_MESSAGE);
    this.name = "ReviewTrustError";
  }
}

/** Review only and Run unattended need a trusted folder; Ask works anywhere. */
export function checkModeTrust(input: { accessMode: string; unattended: boolean; trusted: boolean }): UnattendedTrustError | ReviewTrustError | null {
  if (input.trusted) return null;
  if (input.unattended) return new UnattendedTrustError();
  if (input.accessMode === "auto") return new ReviewTrustError();
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
 * `strong`: the run's commands are inside the OS sandbox (Seatbelt, Landlock,
 * bubblewrap or the Windows sandbox account). `advisory`: the sandbox is off
 * for this run, so only the argv allow-list and the folder jail apply. `ask`:
 * kept for runtimes that report no sandbox at all; every command asks and
 * unattended is refused.
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
  /** The OS sandbox is on for this run. Unset means on. */
  sandboxed?: boolean;
  /** For an outside path: whether it would be written, not only read. */
  outsideWrite?: boolean;
  /** Settings → outside the work folder, for sandboxed runs. Unset means no access. */
  outsideAccess?: "none" | "read" | "read-write";
}): GateResult {
  const strength = input.strength ?? "strong";
  if (input.unattended && (!input.trusted || strength === "ask")) return "block";
  const free = input.trusted && (input.unattended || input.accessMode === "auto");
  if (!input.inside || input.action === "outside") {
    if (input.accessMode === "review" && input.outsideWrite) return "block";
    // Unsandboxed, the person chose to run directly: Review only and Run unattended go ahead, Ask asks.
    if (input.sandboxed === false) return free ? "allow" : "prompt";
    // Sandboxed, the person's outside-folder setting says what goes ahead without asking.
    const access = input.outsideAccess ?? "none";
    if (access === "read-write" || (access === "read" && !input.outsideWrite)) return "allow";
    // Anything else asks in Ask, and is refused (the run continues) in Review only and Run unattended.
    return free ? "block" : "prompt";
  }
  if (input.accessMode === "review") {
    // Read-only: never a write, never the network. Commands run under a read-only grant.
    if (input.action === "write" || input.action === "network" || input.action === "push" || input.action === "credential") return "block";
    if (strength === "strong") return "allow";
    return input.unattended ? "block" : "prompt";
  }
  if (free) return strength === "ask" ? "prompt" : "allow";
  // A push the run's git permission allows goes ahead in a folder the person trusts.
  if (input.action === "push") return input.trusted && (input.explicitTrust || input.silentWorkspace) ? "allow" : "prompt";
  if (input.action === "credential" || input.action === "network") return "prompt";
  if (strength === "ask") return "prompt";
  const silent = input.explicitTrust || (input.trusted && input.silentWorkspace);
  return silent ? "allow" : "prompt";
}

/** The tool name on a "trust this folder?" question, so a phone answer to it is treated as a trust grant. */
export const TRUST_TOOL = "trust";

export type OutsideAccess = "none" | "read" | "read-write";

/** The outside-folder choice a run started with (kept on the job's context), if any. */
export function outsideAccessOf(context: unknown): OutsideAccess | null {
  const value = typeof context === "object" && context !== null ? (context as { outsideAccess?: unknown }).outsideAccess : undefined;
  return value === "none" || value === "read" || value === "read-write" ? value : null;
}

/** A turn of Chat with the person's own agent (`ensemble`'s Chat tab), not a task run: kept on the job's context. */
export function isChatTurn(context: unknown): boolean {
  return typeof context === "object" && context !== null && (context as { chat?: unknown }).chat === true;
}
