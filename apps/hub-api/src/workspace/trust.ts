/**
 * Run modes and folder trust (docs/24 §4).
 *
 * Choosing a mode is the person's trust: no mode needs a folder trusted first, and nothing a mode
 * covers is refused. A tool call is refused only by the hard floor (`outsideRefusal`, the
 * never-run programs in guard.ts) or by a limit the person chose (Local only, Commit, the internet
 * off, a read-only folder, "No access" outside the workspace). Everything else goes ahead or asks.
 *
 * - Ask (`read-write`): commands and edits ask unless the folder is trusted (a saved path rule, or
 *   the workspace with "run without asking" on). Reads go ahead. Changing another folder asks once
 *   per folder.
 * - Review only (`auto`): commands and edits in the run's folder go ahead; only decision questions
 *   reach the person. Changing another folder, inside the Ensemble workspace or beyond it, asks
 *   once per folder; after that the run works there freely.
 * - Run unattended (`unattended` flag): nothing asks. The run may work anywhere the floor allows:
 *   its folder, the whole workspace and the person's own folders. Decisions are made by the agent
 *   and reported.
 * Reading outside the folder goes ahead in every mode (Settings → "Outside the Ensemble workspace": read,
 * the default, or read and write; "No access" asks first, and refuses when nobody answers).
 * Trust is a path, on this device, stored as a DecisionRule with toolName `path`; the workspace
 * root is trusted without a row. It quiets Ask and lets an engine load the folder's own config.
 * `review` is the read-only grant (no writes, no network), for a folder shared read-only from a
 * paired computer.
 */

export const PATH_RULE_SOURCE = "ensemble";
export const PATH_RULE_TOOL = "path";

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
/** `remote`: a program that opens a session on another computer (ssh, scp, nc). `escape`: a command run outside the OS sandbox. */
export type GateAction = "command" | "write" | "network" | "credential" | "outside" | "push" | "remote" | "escape";
export type GateResult = "allow" | "block" | "prompt";

/**
 * Where a path outside the run's folder lies: elsewhere in the Ensemble workspace, in the
 * computer's temporary folders, or beyond both. A folder the person let the run work in counts as
 * the run's own and never reaches the gate.
 */
export type OutsideZone = "workspace" | "temp" | "outside";

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
 * `strong`: the run's commands are inside the OS sandbox (Seatbelt, Landlock,
 * bubblewrap or the Windows sandbox account). `advisory`: the sandbox is off
 * for this run, so the judge's path checks and the floor apply. `ask`: kept
 * for runtimes that report no sandbox at all; Ask asks before every command.
 */
export type SandboxStrength = "strong" | "advisory" | "ask";

/**
 * What the run's mode does with one action. "block" comes only from a limit the person chose
 * (the read-only grant, "No access" with nobody to ask); the floor is checked before this.
 */
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
  /** For an outside path: whether it would be written, not only read. Unset means written. */
  outsideWrite?: boolean;
  /** Settings → outside the work folder (beyond the workspace). Unset means read only. */
  outsideAccess?: "none" | "read" | "read-write";
  /** For an outside path: where it lies. Unset means beyond the workspace. */
  zone?: OutsideZone;
}): GateResult {
  const strength = input.strength ?? "strong";
  const readOnly = input.accessMode === "review";
  if (!input.inside || input.action === "outside") {
    const write = input.outsideWrite ?? true;
    if (readOnly && write) return "block";
    if (!write) {
      // "No access" is the person's own limit; it covers reads beyond the workspace where the sandbox enforces it.
      if (input.zone !== "workspace" && input.zone !== "temp" && input.sandboxed !== false && input.outsideAccess === "none") return input.unattended ? "block" : "prompt";
      return "allow";
    }
    if (input.unattended) {
      return input.zone !== "workspace" && input.zone !== "temp" && input.sandboxed !== false && input.outsideAccess === "none" ? "block" : "allow";
    }
    if (input.zone === "temp") return input.accessMode === "auto" ? "allow" : "prompt";
    if (input.zone !== "workspace" && input.outsideAccess === "read-write") return "allow";
    return "prompt";
  }
  if (readOnly) {
    // Read-only: never a write, never the network. Commands run under a read-only grant.
    if (input.action === "write" || input.action === "network" || input.action === "push" || input.action === "credential" || input.action === "remote" || input.action === "escape") return "block";
    if (strength === "strong") return "allow";
    return input.unattended ? "block" : "prompt";
  }
  if (input.unattended) return "allow";
  // Another computer, or a command outside the OS sandbox: worth a question unless nobody is there to answer.
  if (input.action === "remote" || input.action === "escape") return "prompt";
  if (input.accessMode === "auto") return "allow";
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

/**
 * A run that changes the one it continues, which was interrupted for it (Ensemble Node's steer,
 * node/sessions.ts): the change, kept on the job's context. It goes to the agent on its own.
 */
export function steerOf(context: unknown): { update: string } | null {
  const steer = typeof context === "object" && context !== null ? (context as { steer?: unknown }).steer : undefined;
  const update = typeof steer === "object" && steer !== null ? (steer as { update?: unknown }).update : undefined;
  return typeof update === "string" && update.trim() ? { update } : null;
}

/** The model's fast mode chosen for the run (Claude Code, Codex), kept on the job's context. */
export function fastOf(context: unknown): boolean {
  return typeof context === "object" && context !== null && (context as { fast?: unknown }).fast === true;
}

/** The context window chosen for the run's model (GitHub Copilot's long_context), kept on the job's context. */
export function contextTierOf(context: unknown): "long_context" | null {
  return typeof context === "object" && context !== null && (context as { contextTier?: unknown }).contextTier === "long_context" ? "long_context" : null;
}
