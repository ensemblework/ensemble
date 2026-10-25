import type { WorkspaceJob } from "@prisma/client";
import { isCodeEngine } from "@ensemble/shared-types";
import { Assign } from "./assign.js";
import { contextTierOf, outsideAccessOf } from "./trust.js";
import { pullRequestOf } from "./pull-request.js";

export function repeatAssignment(old: WorkspaceJob) {
  const sameFolder = !old.deviceId && old.kind === "code" && !old.externalRoot && Boolean(old.repoPath);
  return Assign.parse({
        taskId: old.taskId,
        kind: old.kind,
        provider: old.provider ?? undefined,
        model: old.model,
        engine: isCodeEngine(old.provider) ? old.provider : "ensemble",
        ...(contextTierOf(old.context) ? { contextTier: "long_context" as const } : {}),
        ...(pullRequestOf(old.context) ? { pullRequest: pullRequestOf(old.context)! } : {}),
        outsideAccess: outsideAccessOf(old.context) ?? undefined,
        reasoningEffort: old.reasoningEffort ?? undefined,
        instructions: old.instructions,
        folder: old.deviceId ? undefined : old.externalRoot ?? undefined,
        folderLabel: old.deviceId ? old.folderLabel ?? undefined : undefined,
        deviceId: old.deviceId ?? undefined,
        continueFromJobId: old.deviceId || sameFolder ? old.id : old.continueFromJobId ?? undefined,
        repoUrl: old.deviceId || (!sameFolder && !old.externalRoot && !old.continueFromJobId) ? old.repoUrl ?? undefined : undefined,
        branchMode: sameFolder ? "as-is" : old.branchMode,
        branch: sameFolder || old.branchMode === "as-is" ? undefined : old.branch || undefined,
        delivery: old.delivery,
        askBeforePublish: old.askBeforePublish,
        useCredentials: old.useCredentials,
        sandbox: old.executionMode === "sandbox",
        network: old.networkAccess,
        markDone: old.markDone,
        mode: old.unattended ? "unattended" : old.accessMode === "auto" ? "review" : "ask",
        accessMode: old.accessMode === "review" ? "review" : "read-write",
        maxMinutes: old.maxMinutes,
        maxToolCalls: old.maxToolCalls,
        maxTurns: old.maxTurns,
      });
}

/** A run that carries on an interrupted one (the computer restarted, say): why, and which carry-on this is. */
export function resumeOf(context: unknown): { reason: string; attempt: number } | null {
  const value = typeof context === "object" && context !== null ? (context as { resumeOf?: unknown }).resumeOf : null;
  if (!value || typeof value !== "object") return null;
  const { reason, attempt } = value as { reason?: unknown; attempt?: unknown };
  return { reason: typeof reason === "string" && reason ? reason.slice(0, 300) : "the run was interrupted", attempt: typeof attempt === "number" ? attempt : 1 };
}
