export type RunTone = "green" | "red" | "yellow" | "gray" | "orange" | "blue";
export const RUN_OUTCOME: Record<string, { label: string; tone: RunTone }> = {
  success: { label: "Done", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  cancelled: { label: "Stopped", tone: "gray" },
  needs_info: { label: "Needs info", tone: "orange" },
  waiting_approval: { label: "Waiting for you", tone: "yellow" },
};

/**
 * Observing an unfinished job does not mean that it is currently executing. A finished run whose checks
 * Ensemble ran again is done only when they passed: failed, or finished, not verified.
 */
export function runPresentation({ outcome, endedAt, jobStatus, verified }: { outcome?: string | null; endedAt?: string | null; jobStatus?: string | null; verified?: string | null }): { label: string; tone: RunTone; active: boolean } {
  if (outcome === "success" && verified === "failed") return { label: "Checks failed", tone: "red", active: false };
  if (outcome === "success" && verified === "not_verified") return { label: "Not verified", tone: "yellow", active: false };
  if (outcome) return { ...(RUN_OUTCOME[outcome] ?? { label: outcome, tone: "gray" }), active: false };
  if (endedAt) return { label: "Ended", tone: "gray", active: false };
  if (jobStatus === "queued") return { label: "Queued", tone: "gray", active: false };
  if (jobStatus === "claimed") return { label: "Starting", tone: "gray", active: false };
  if (jobStatus === "waiting_approval") return { label: "Waiting for you", tone: "yellow", active: false };
  if (jobStatus === "stopping") return { label: "Stopping", tone: "gray", active: false };
  if (jobStatus === "paused") return { label: "Paused", tone: "gray", active: false };
  if (!jobStatus) return { label: "Open", tone: "gray", active: false };
  if (jobStatus === "running") return { label: "Running", tone: "blue", active: true };
  return { label: jobStatus === "interrupted" ? "Interrupted" : jobStatus === "failed" ? "Failed" : jobStatus === "cancelled" ? "Stopped" : "Ended", tone: jobStatus === "failed" ? "red" : "gray", active: false };
}
