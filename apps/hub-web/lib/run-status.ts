export type RunTone = "green" | "red" | "yellow" | "gray" | "orange" | "blue";
export const RUN_OUTCOME: Record<string, { label: string; tone: RunTone }> = {
  success: { label: "Done", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  cancelled: { label: "Stopped", tone: "gray" },
  needs_info: { label: "Needs info", tone: "orange" },
  waiting_approval: { label: "Waiting for you", tone: "yellow" },
};

/** Observing an unfinished job does not mean that it is currently executing. */
export function runPresentation({ outcome, endedAt, jobStatus }: { outcome?: string | null; endedAt?: string | null; jobStatus?: string | null }): { label: string; tone: RunTone; active: boolean } {
  if (outcome) return { ...(RUN_OUTCOME[outcome] ?? { label: outcome, tone: "gray" }), active: false };
  if (endedAt) return { label: "Ended", tone: "gray", active: false };
  if (jobStatus === "queued") return { label: "Queued", tone: "gray", active: false };
  if (jobStatus === "claimed") return { label: "Starting", tone: "gray", active: false };
  if (jobStatus === "waiting_approval") return { label: "Waiting for you", tone: "yellow", active: false };
  if (jobStatus === "stopping") return { label: "Stopping", tone: "gray", active: false };
  if (jobStatus === "paused") return { label: "Paused", tone: "gray", active: false };
  if (!jobStatus || jobStatus === "running") return { label: "Running", tone: "blue", active: true };
  return { label: jobStatus === "interrupted" ? "Interrupted" : jobStatus === "failed" ? "Failed" : jobStatus === "cancelled" ? "Stopped" : "Ended", tone: jobStatus === "failed" ? "red" : "gray", active: false };
}
